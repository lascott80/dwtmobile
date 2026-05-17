#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

DB_PATH = Path(__file__).resolve().parent / "data" / "disney_wait_times.db"
EASTERN = ZoneInfo("America/New_York")


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

        CREATE INDEX IF NOT EXISTS idx_wait_snapshots_park_time
            ON wait_snapshots (park_slug, captured_at);
        CREATE INDEX IF NOT EXISTS idx_wait_snapshots_attraction_time
            ON wait_snapshots (attraction_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_showtimes_park_category
            ON showtimes (park_slug, category);
        CREATE INDEX IF NOT EXISTS idx_park_schedules_park_date
            ON park_schedules (park_slug, schedule_date);
        """
    )

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


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "DisneyWaitTimesMobile/0.1 (+https://queue-times.com/)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


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
    updated_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO attractions (
            id, park_slug, name, entity_type, category, area_name, area_sort, queue_times_ride_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            park_slug = excluded.park_slug,
            name = excluded.name,
            entity_type = excluded.entity_type,
            category = excluded.category,
            area_name = excluded.area_name,
            area_sort = excluded.area_sort,
            queue_times_ride_id = excluded.queue_times_ride_id,
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
            updated_at,
        ),
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


def process_park(connection: sqlite3.Connection, park: ParkConfig) -> None:
    polled_at = utc_now()
    captured_at = polled_at.isoformat()

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
        queue_times_payload = fetch_json(
            f"https://queue-times.com/parks/{park.queue_times_park_id}/queue_times.json"
        )
        themeparks_live = fetch_json(
            f"https://api.themeparks.wiki/v1/entity/{park.themeparks_entity_id}/live"
        )
        themeparks_schedule = fetch_json(
            f"https://api.themeparks.wiki/v1/entity/{park.themeparks_entity_id}/schedule"
        )

        qt_by_name = build_queue_times_map(queue_times_payload)

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

        replace_schedule(connection, park.slug, captured_at, themeparks_schedule)
        replace_showtimes(connection, park, captured_at, themeparks_live)

        connection.execute(
            """
            UPDATE refresh_state
            SET last_success_at = ?, last_error = NULL
            WHERE park_slug = ?
            """,
            (captured_at, park.slug),
        )
        connection.commit()

    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
        connection.execute(
            "UPDATE refresh_state SET last_error = ? WHERE park_slug = ?",
            (str(exc), park.slug),
        )
        connection.commit()


def run_once(connection: sqlite3.Connection) -> None:
    for park in PARKS:
        process_park(connection, park)
    prune_old_data(connection, utc_now())


def main() -> int:
    parser = argparse.ArgumentParser(description="Poll Walt Disney World wait times into SQLite.")
    parser.add_argument("--once", action="store_true", help="Run one poll cycle and exit.")
    args = parser.parse_args()

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
        time.sleep(max(30, target_sleep - elapsed))


if __name__ == "__main__":
    sys.exit(main())
