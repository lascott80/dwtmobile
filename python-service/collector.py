#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

DB_PATH = Path(__file__).resolve().parent / "data" / "disney_wait_times.db"
EASTERN = ZoneInfo("America/New_York")
LOGGER = logging.getLogger("dwtmobile.collector")
FETCH_TIMEOUT_SECONDS = 15
FETCH_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
NON_RIDE_ATTRACTION_NAMES = {
    "maharajah jungle trek",
    "beauty and the beast sing-along",
    "impressions de france",
    "reflections of china",
    "the american adventure",
}


@dataclass(frozen=True)
class ParkConfig:
    slug: str
    name: str
    short_name: str
    queue_times_park_id: int
    themeparks_entity_id: str
    featured_show_keywords: tuple[str, ...]


PARKS: tuple[ParkConfig, ...] = (
    ParkConfig(
        slug="magic-kingdom",
        name="Magic Kingdom Park",
        short_name="Magic Kingdom",
        queue_times_park_id=6,
        themeparks_entity_id="75ea578a-adc8-4116-a54d-dccb60765ef9",
        featured_show_keywords=("happily ever after", "disney starlight"),
    ),
    ParkConfig(
        slug="epcot",
        name="EPCOT",
        short_name="EPCOT",
        queue_times_park_id=5,
        themeparks_entity_id="47f90d2c-e191-4239-a466-5892ef59a88b",
        featured_show_keywords=("luminous", "fireworks"),
    ),
    ParkConfig(
        slug="hollywood-studios",
        name="Disney's Hollywood Studios",
        short_name="Hollywood Studios",
        queue_times_park_id=7,
        themeparks_entity_id="288747d1-8b4f-4a64-867e-ea7c9b27bad8",
        featured_show_keywords=("fantasmic",),
    ),
    ParkConfig(
        slug="animal-kingdom",
        name="Disney's Animal Kingdom Theme Park",
        short_name="Animal Kingdom",
        queue_times_park_id=8,
        themeparks_entity_id="1c84a229-8862-4648-9c71-378ddd2c7693",
        featured_show_keywords=(),
    ),
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS parks (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            short_name TEXT NOT NULL,
            queue_times_park_id INTEGER NOT NULL,
            themeparks_entity_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attractions (
            id TEXT PRIMARY KEY,
            park_slug TEXT NOT NULL,
            name TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            category TEXT NOT NULL,
            area_name TEXT,
            area_sort INTEGER,
            queue_times_ride_id INTEGER,
            latitude REAL,
            longitude REAL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS restaurants (
            id TEXT PRIMARY KEY,
            park_slug TEXT NOT NULL,
            name TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS facilities (
            id TEXT PRIMARY KEY,
            park_slug TEXT NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            latitude REAL,
            longitude REAL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wait_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            park_slug TEXT NOT NULL,
            attraction_id TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            source_updated_at TEXT,
            wait_time INTEGER,
            status TEXT NOT NULL,
            is_open INTEGER NOT NULL,
            queue_type TEXT
        );

        CREATE TABLE IF NOT EXISTS park_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            park_slug TEXT NOT NULL,
            schedule_date TEXT NOT NULL,
            type TEXT NOT NULL,
            description TEXT,
            opening_time TEXT NOT NULL,
            closing_time TEXT NOT NULL,
            captured_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS showtimes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            park_slug TEXT NOT NULL,
            entertainment_id TEXT NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            status TEXT NOT NULL,
            captured_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS refresh_state (
            park_slug TEXT PRIMARY KEY,
            last_polled_at TEXT NOT NULL,
            last_success_at TEXT,
            last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS poll_cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL,
            success_count INTEGER NOT NULL,
            failure_count INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            park_slug TEXT NOT NULL,
            source TEXT NOT NULL,
            checked_at TEXT NOT NULL,
            success INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_wait_snapshots_park_time
            ON wait_snapshots (park_slug, captured_at);
        CREATE INDEX IF NOT EXISTS idx_wait_snapshots_attraction_time
            ON wait_snapshots (attraction_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_showtimes_park_category
            ON showtimes (park_slug, category);
        CREATE INDEX IF NOT EXISTS idx_park_schedules_park_date
            ON park_schedules (park_slug, schedule_date);
        CREATE INDEX IF NOT EXISTS idx_restaurants_park
            ON restaurants (park_slug);
        CREATE INDEX IF NOT EXISTS idx_facilities_park
            ON facilities (park_slug);
        CREATE INDEX IF NOT EXISTS idx_poll_cycles_started
            ON poll_cycles (started_at);
        CREATE INDEX IF NOT EXISTS idx_source_checks_source_time
            ON source_checks (source, checked_at);
        """
    )
    existing_attraction_columns = {
        row[1] for row in connection.execute("PRAGMA table_info(attractions)").fetchall()
    }
    if "latitude" not in existing_attraction_columns:
        connection.execute("ALTER TABLE attractions ADD COLUMN latitude REAL")
    if "longitude" not in existing_attraction_columns:
        connection.execute("ALTER TABLE attractions ADD COLUMN longitude REAL")

    connection.executemany(
        """
        INSERT INTO parks (slug, name, short_name, queue_times_park_id, themeparks_entity_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
            name = excluded.name,
            short_name = excluded.short_name,
            queue_times_park_id = excluded.queue_times_park_id,
            themeparks_entity_id = excluded.themeparks_entity_id
        """,
        [
            (
                park.slug,
                park.name,
                park.short_name,
                park.queue_times_park_id,
                park.themeparks_entity_id,
            )
            for park in PARKS
        ],
    )
    connection.commit()


def normalize_name(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def is_retryable_fetch_error(exc: Exception) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in RETRYABLE_STATUS_CODES
    return isinstance(exc, (TimeoutError, urllib.error.URLError))


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "DisneyWaitTimesMobile/0.1 (+https://queue-times.com/)",
            "Accept": "application/json",
        },
    )
    last_error: Optional[Exception] = None
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
            if attempt >= FETCH_ATTEMPTS or not is_retryable_fetch_error(exc):
                raise
            sleep_for = min(6.0, 0.5 * (2 ** (attempt - 1))) + random.uniform(0, 0.35)
            LOGGER.debug("Retrying %s after %s: attempt %s/%s", url, exc, attempt + 1, FETCH_ATTEMPTS)
            time.sleep(sleep_for)

    raise last_error or RuntimeError("Fetch failed without an exception")


def fetch_json_with_telemetry(
    connection: sqlite3.Connection,
    *,
    park_slug: str,
    source: str,
    url: str,
) -> dict[str, Any]:
    started = time.monotonic()
    checked_at = utc_now().isoformat()
    try:
        payload = fetch_json(url)
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        connection.execute(
            """
            INSERT INTO source_checks (park_slug, source, checked_at, success, duration_ms, error)
            VALUES (?, ?, ?, 0, ?, ?)
            """,
            (park_slug, source, checked_at, duration_ms, str(exc)),
        )
        raise

    duration_ms = int((time.monotonic() - started) * 1000)
    connection.execute(
        """
        INSERT INTO source_checks (park_slug, source, checked_at, success, duration_ms, error)
        VALUES (?, ?, ?, 1, ?, NULL)
        """,
        (park_slug, source, checked_at, duration_ms),
    )
    return payload


def fetch_optional_json_with_telemetry(
    connection: sqlite3.Connection,
    *,
    park_slug: str,
    source: str,
    url: str,
    errors: list[str],
) -> Optional[dict[str, Any]]:
    try:
        return fetch_json_with_telemetry(
            connection,
            park_slug=park_slug,
            source=source,
            url=url,
        )
    except Exception as exc:
        errors.append(f"{source}: {exc}")
        LOGGER.warning("Optional source failed for %s (%s): %s", park_slug, source, exc)
        return None


def build_queue_times_map(queue_times_payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    matches: dict[str, dict[str, Any]] = {}
    for area_sort, land in enumerate(queue_times_payload.get("lands", []), start=1):
        land_name = land.get("name") or "Other Experiences"
        for ride in land.get("rides", []):
            key = normalize_name(ride.get("name", ""))
            if key:
                matches[key] = {
                    "area_name": land_name,
                    "area_sort": area_sort,
                    "queue_times_ride_id": ride.get("id"),
                    "wait_time": ride.get("wait_time"),
                    "is_open": 1 if ride.get("is_open") else 0,
                    "last_updated": ride.get("last_updated"),
                }
    return matches


def is_meet_greet(name: str) -> bool:
    lowered = name.lower()
    return "meet " in lowered or "greet" in lowered or "fairytale hall" in lowered


def is_featured_show(name: str, park: ParkConfig) -> bool:
    lowered = name.lower()
    return any(keyword in lowered for keyword in park.featured_show_keywords)


def sleep_seconds_for_current_window(now_eastern: datetime) -> int:
    if 0 <= now_eastern.hour < 6:
        return 30 * 60
    return 5 * 60


def prune_old_data(connection: sqlite3.Connection, now: datetime) -> None:
    cutoff = (now - timedelta(days=60)).isoformat()
    connection.execute("DELETE FROM wait_snapshots WHERE captured_at < ?", (cutoff,))
    connection.commit()


def replace_schedule(connection: sqlite3.Connection, park_slug: str, captured_at: str, payload: dict[str, Any]) -> None:
    today = datetime.now(EASTERN).date().isoformat()
    connection.execute("DELETE FROM park_schedules WHERE park_slug = ? AND schedule_date >= ?", (park_slug, today))
    rows = []
    for item in payload.get("schedule", []):
        rows.append(
            (
                park_slug,
                item.get("date"),
                item.get("type", "UNKNOWN"),
                item.get("description"),
                item.get("openingTime"),
                item.get("closingTime"),
                captured_at,
            )
        )
    connection.executemany(
        """
        INSERT INTO park_schedules (
            park_slug, schedule_date, type, description, opening_time, closing_time, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def replace_showtimes(
    connection: sqlite3.Connection,
    park: ParkConfig,
    captured_at: str,
    live_payload: dict[str, Any],
) -> None:
    connection.execute("DELETE FROM showtimes WHERE park_slug = ?", (park.slug,))
    rows: list[tuple[Any, ...]] = []
    for item in live_payload.get("liveData", []):
        if item.get("entityType") != "SHOW":
            continue

        name = item.get("name", "")
        if is_meet_greet(name):
            category = "meet-greet"
        elif is_featured_show(name, park):
            category = "featured"
        else:
            continue

        showtimes = item.get("showtimes") or []
        if not showtimes and category == "meet-greet":
            showtimes = item.get("operatingHours") or []

        for showtime in showtimes:
            rows.append(
                (
                    park.slug,
                    item.get("id"),
                    name,
                    category,
                    showtime.get("startTime"),
                    showtime.get("endTime"),
                    item.get("status", "UNKNOWN"),
                    captured_at,
                )
            )

    connection.executemany(
        """
        INSERT INTO showtimes (
            park_slug, entertainment_id, name, category, start_time, end_time, status, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def upsert_attraction(
    connection: sqlite3.Connection,
    *,
    attraction_id: str,
    park_slug: str,
    name: str,
    entity_type: str,
    category: str,
    area_name: str | None,
    area_sort: int | None,
    queue_times_ride_id: int | None,
    latitude: float | None,
    longitude: float | None,
    updated_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO attractions (
            id, park_slug, name, entity_type, category, area_name, area_sort, queue_times_ride_id, latitude, longitude, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            park_slug = excluded.park_slug,
            name = excluded.name,
            entity_type = excluded.entity_type,
            category = excluded.category,
            area_name = excluded.area_name,
            area_sort = excluded.area_sort,
            queue_times_ride_id = excluded.queue_times_ride_id,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            updated_at = excluded.updated_at
        """,
        (
            attraction_id,
            park_slug,
            name,
            entity_type,
            category,
            area_name,
            area_sort,
            queue_times_ride_id,
            latitude,
            longitude,
            updated_at,
        ),
    )


def replace_restaurants(connection: sqlite3.Connection, park: ParkConfig, captured_at: str, children_payload: dict[str, Any]) -> None:
    connection.execute("DELETE FROM restaurants WHERE park_slug = ?", (park.slug,))
    rows = []
    for item in children_payload.get("children", []):
        if item.get("entityType") != "RESTAURANT":
            continue
        location = item.get("location") or {}
        rows.append(
            (
                item.get("id"),
                park.slug,
                item.get("name"),
                location.get("latitude"),
                location.get("longitude"),
                captured_at,
            )
        )
    connection.executemany(
        """
        INSERT INTO restaurants (id, park_slug, name, latitude, longitude, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def fetch_osm_facilities(
    connection: sqlite3.Connection,
    park: ParkConfig,
    children_payload: dict[str, Any],
) -> Optional[dict[str, Any]]:
    points = [
        item.get("location")
        for item in children_payload.get("children", [])
        if item.get("location")
    ]
    if not points:
        return {"elements": []}
    min_lat = min(point["latitude"] for point in points) - 0.002
    max_lat = max(point["latitude"] for point in points) + 0.002
    min_lon = min(point["longitude"] for point in points) - 0.002
    max_lon = max(point["longitude"] for point in points) + 0.002
    query = f"""
    [out:json][timeout:25];
    (
      node["amenity"="toilets"]({min_lat},{min_lon},{max_lat},{max_lon});
      node["amenity"="drinking_water"]({min_lat},{min_lon},{max_lat},{max_lon});
      node["amenity"="first_aid"]({min_lat},{min_lon},{max_lat},{max_lon});
      node["healthcare"="first_aid"]({min_lat},{min_lon},{max_lat},{max_lon});
    );
    out body;
    """
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    started = time.monotonic()
    checked_at = utc_now().isoformat()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        connection.execute(
            """
            INSERT INTO source_checks (park_slug, source, checked_at, success, duration_ms, error)
            VALUES (?, 'osm-overpass', ?, 0, ?, ?)
            """,
            (park.slug, checked_at, duration_ms, str(exc)),
        )
        LOGGER.warning("Optional source failed for %s (osm-overpass): %s", park.slug, exc)
        return None
    duration_ms = int((time.monotonic() - started) * 1000)
    connection.execute(
        """
        INSERT INTO source_checks (park_slug, source, checked_at, success, duration_ms, error)
        VALUES (?, 'osm-overpass', ?, 1, ?, NULL)
        """,
        (park.slug, checked_at, duration_ms),
    )
    return payload


def replace_facilities(connection: sqlite3.Connection, park: ParkConfig, captured_at: str, osm_payload: dict[str, Any]) -> None:
    connection.execute("DELETE FROM facilities WHERE park_slug = ?", (park.slug,))
    rows = []
    for item in osm_payload.get("elements", []):
        tags = item.get("tags") or {}
        if tags.get("amenity") == "toilets":
            category = "restroom"
        elif tags.get("amenity") == "drinking_water":
            category = "water"
        elif tags.get("amenity") == "first_aid" or tags.get("healthcare") == "first_aid":
            category = "first-aid"
        else:
            continue
        rows.append(
            (
                f"osm-{item.get('type', 'node')}-{item.get('id')}",
                park.slug,
                tags.get("name") or category.replace("-", " ").title(),
                category,
                item.get("lat"),
                item.get("lon"),
                captured_at,
            )
        )
    connection.executemany(
        """
        INSERT INTO facilities (id, park_slug, name, category, latitude, longitude, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )


def insert_wait_snapshot(
    connection: sqlite3.Connection,
    *,
    park_slug: str,
    attraction_id: str,
    captured_at: str,
    source_updated_at: str | None,
    wait_time: int | None,
    status: str,
    is_open: bool,
    queue_type: str | None,
) -> None:
    connection.execute(
        """
        INSERT INTO wait_snapshots (
            park_slug, attraction_id, captured_at, source_updated_at, wait_time, status, is_open, queue_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            park_slug,
            attraction_id,
            captured_at,
            source_updated_at,
            wait_time,
            status,
            1 if is_open else 0,
            queue_type,
        ),
    )


def process_park(connection: sqlite3.Connection, park: ParkConfig) -> bool:
    polled_at = utc_now()
    captured_at = polled_at.isoformat()
    ride_count = 0
    meet_greet_count = 0
    optional_errors: list[str] = []

    LOGGER.info("Polling %s", park.short_name)

    connection.execute(
        """
        INSERT INTO refresh_state (park_slug, last_polled_at, last_success_at, last_error)
        VALUES (?, ?, NULL, NULL)
        ON CONFLICT(park_slug) DO UPDATE SET last_polled_at = excluded.last_polled_at
        """,
        (park.slug, captured_at),
    )
    connection.commit()

    try:
        themeparks_live = fetch_json_with_telemetry(
            connection,
            park_slug=park.slug,
            source="themeparks-live",
            url=f"https://api.themeparks.wiki/v1/entity/{park.themeparks_entity_id}/live",
        )
        if not isinstance(themeparks_live.get("liveData"), list):
            raise ValueError("themeparks-live response did not include liveData")
        queue_times_payload = fetch_optional_json_with_telemetry(
            connection,
            park_slug=park.slug,
            source="queue-times",
            url=f"https://queue-times.com/parks/{park.queue_times_park_id}/queue_times.json",
            errors=optional_errors,
        )
        themeparks_schedule = fetch_optional_json_with_telemetry(
            connection,
            park_slug=park.slug,
            source="themeparks-schedule",
            url=f"https://api.themeparks.wiki/v1/entity/{park.themeparks_entity_id}/schedule",
            errors=optional_errors,
        )
        themeparks_children = fetch_optional_json_with_telemetry(
            connection,
            park_slug=park.slug,
            source="themeparks-children",
            url=f"https://api.themeparks.wiki/v1/entity/{park.themeparks_entity_id}/children",
            errors=optional_errors,
        )
        osm_facilities = None
        if themeparks_children is not None:
            osm_facilities = fetch_osm_facilities(connection, park, themeparks_children)
            if osm_facilities is None:
                optional_errors.append("osm-overpass: unavailable")
        connection.commit()

        qt_by_name = build_queue_times_map(queue_times_payload or {})
        children_by_id = {item.get("id"): item for item in (themeparks_children or {}).get("children", [])}

        connection.execute("SAVEPOINT park_refresh")
        for item in themeparks_live.get("liveData", []):
            entity_type = item.get("entityType", "UNKNOWN")
            name = item.get("name", "")
            if not name:
                continue

            normalized = normalize_name(name)
            queue_match = qt_by_name.get(normalized, {})
            status = item.get("status", "UNKNOWN")
            is_open = status == "OPERATING"
            last_updated = item.get("lastUpdated") or queue_match.get("last_updated")

            if entity_type == "ATTRACTION":
                if name.lower() in NON_RIDE_ATTRACTION_NAMES:
                    continue
                standby = (item.get("queue") or {}).get("STANDBY") or {}
                wait_time = standby.get("waitTime")
                if wait_time is None:
                    wait_time = queue_match.get("wait_time")

                upsert_attraction(
                    connection,
                    attraction_id=item["id"],
                    park_slug=park.slug,
                    name=name,
                    entity_type=entity_type,
                    category="ride",
                    area_name=queue_match.get("area_name"),
                    area_sort=queue_match.get("area_sort"),
                    queue_times_ride_id=queue_match.get("queue_times_ride_id"),
                    latitude=(children_by_id.get(item["id"], {}).get("location") or {}).get("latitude"),
                    longitude=(children_by_id.get(item["id"], {}).get("location") or {}).get("longitude"),
                    updated_at=captured_at,
                )
                insert_wait_snapshot(
                    connection,
                    park_slug=park.slug,
                    attraction_id=item["id"],
                    captured_at=captured_at,
                    source_updated_at=last_updated,
                    wait_time=wait_time,
                    status=status,
                    is_open=is_open,
                    queue_type="STANDBY",
                )
                ride_count += 1

            elif entity_type == "SHOW" and is_meet_greet(name):
                standby = (item.get("queue") or {}).get("STANDBY") or {}
                upsert_attraction(
                    connection,
                    attraction_id=item["id"],
                    park_slug=park.slug,
                    name=name,
                    entity_type=entity_type,
                    category="meet-greet",
                    area_name=queue_match.get("area_name"),
                    area_sort=queue_match.get("area_sort"),
                    queue_times_ride_id=queue_match.get("queue_times_ride_id"),
                    latitude=(children_by_id.get(item["id"], {}).get("location") or {}).get("latitude"),
                    longitude=(children_by_id.get(item["id"], {}).get("location") or {}).get("longitude"),
                    updated_at=captured_at,
                )
                insert_wait_snapshot(
                    connection,
                    park_slug=park.slug,
                    attraction_id=item["id"],
                    captured_at=captured_at,
                    source_updated_at=last_updated,
                    wait_time=standby.get("waitTime"),
                    status=status,
                    is_open=is_open,
                    queue_type="STANDBY",
                )
                meet_greet_count += 1

        if themeparks_schedule is not None:
            replace_schedule(connection, park.slug, captured_at, themeparks_schedule)
        replace_showtimes(connection, park, captured_at, themeparks_live)
        if themeparks_children is not None:
            replace_restaurants(connection, park, captured_at, themeparks_children)
            if osm_facilities is not None:
                replace_facilities(connection, park, captured_at, osm_facilities)

        last_error = "; ".join(optional_errors)[:500] if optional_errors else None
        connection.execute(
            """
            UPDATE refresh_state
            SET last_success_at = ?, last_error = ?
            WHERE park_slug = ?
            """,
            (captured_at, last_error, park.slug),
        )
        connection.execute("RELEASE SAVEPOINT park_refresh")
        connection.commit()
        LOGGER.info(
            "Updated %s: %s rides, %s meet-and-greets%s",
            park.short_name,
            ride_count,
            meet_greet_count,
            " with optional source failures" if optional_errors else "",
        )
        return True

    except Exception as exc:
        try:
            connection.execute("ROLLBACK TO SAVEPOINT park_refresh")
            connection.execute("RELEASE SAVEPOINT park_refresh")
        except sqlite3.Error:
            pass
        connection.execute(
            "UPDATE refresh_state SET last_error = ? WHERE park_slug = ?",
            (str(exc), park.slug),
        )
        connection.commit()
        LOGGER.warning("Polling failed for %s: %s", park.short_name, exc)
        return False


def run_once(connection: sqlite3.Connection) -> None:
    started_at = utc_now()
    started = time.monotonic()
    success_count = 0
    failure_count = 0
    LOGGER.info("Starting poll cycle")
    for park in PARKS:
        if process_park(connection, park):
            success_count += 1
        else:
            failure_count += 1
    prune_old_data(connection, utc_now())
    finished_at = utc_now()
    connection.execute(
        """
        INSERT INTO poll_cycles (
            started_at, finished_at, duration_seconds, success_count, failure_count
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            started_at.isoformat(),
            finished_at.isoformat(),
            int(time.monotonic() - started),
            success_count,
            failure_count,
        ),
    )
    connection.commit()
    LOGGER.info("Finished poll cycle")


def main() -> int:
    parser = argparse.ArgumentParser(description="Poll Walt Disney World wait times into SQLite.")
    parser.add_argument("--once", action="store_true", help="Run one poll cycle and exit.")
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="Set collector log verbosity.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(message)s",
    )

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    ensure_schema(connection)

    if args.once:
        run_once(connection)
        return 0

    while True:
        started = time.monotonic()
        run_once(connection)
        now_eastern = datetime.now(EASTERN)
        target_sleep = sleep_seconds_for_current_window(now_eastern)
        elapsed = max(0, int(time.monotonic() - started))
        sleep_for = max(30, target_sleep - elapsed)
        LOGGER.info("Sleeping %s seconds before next cycle", sleep_for)
        time.sleep(sleep_for)


if __name__ == "__main__":
    sys.exit(main())
