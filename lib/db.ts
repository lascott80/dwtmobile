import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, PARKS } from "@/lib/config";
import type { LandGroup, ParkDetailResponse, ParkHoursEntry, ShowTimeItem } from "@/lib/types";

let db: DatabaseSync | null = null;

function connect() {
  if (!existsSync(DB_PATH)) {
    return null;
  }
  if (!db) {
    db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  }
  return db;
}

function getTodayHours(database: DatabaseSync, parkSlug: string) {
  return database
    .prepare(
      `
        SELECT type, description, opening_time AS openingTime, closing_time AS closingTime
        FROM park_schedules
        WHERE park_slug = ? AND schedule_date = date('now', 'localtime')
        ORDER BY opening_time
      `
    )
    .all(parkSlug) as ParkHoursEntry[];
}

function getOperatingSummary(hours: ParkHoursEntry[]) {
  const operating = hours.find((entry) => entry.type === "OPERATING");
  if (!operating) {
    return "Hours unavailable";
  }

  const now = new Date();
  const opening = new Date(operating.openingTime);
  const closing = new Date(operating.closingTime);
  const formattedClosing = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(closing);

  if (now < opening) {
    return `Opens ${new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(opening)}`;
  }

  if (now <= closing) {
    return `Open until ${formattedClosing}`;
  }

  return "Closed";
}

export function getParkMeta() {
  const database = connect();
  return {
    generatedAt: new Date().toISOString(),
    parks: PARKS.map(({ slug, name, shortName }) => ({
      slug,
      name,
      shortName,
      summary: database ? getOperatingSummary(getTodayHours(database, slug)) : "Hours unavailable"
    }))
  };
}

export function getParkDetail(parkSlug: string): ParkDetailResponse | null {
  const park = PARKS.find((entry) => entry.slug === parkSlug);
  if (!park) {
    return null;
  }

  const database = connect();
  if (!database) {
    return {
      park: {
        slug: park.slug,
        name: park.name,
        shortName: park.shortName,
        summary: "Hours unavailable"
      },
      status: {
        hasData: false,
        stale: true,
        lastSuccessAt: null,
        lastError: null
      },
      hours: [],
      featuredShows: [],
      meetGreets: [],
      lands: []
    };
  }
  try {
    const refresh = database
      .prepare(
        `
          SELECT last_success_at AS lastSuccessAt, last_error AS lastError
          FROM refresh_state
          WHERE park_slug = ?
        `
      )
      .get(park.slug) as { lastSuccessAt: string | null; lastError: string | null } | undefined;

    const hours = getTodayHours(database, park.slug);

    const featuredShows = database
      .prepare(
        `
          SELECT entertainment_id AS id, name, start_time AS startTime, end_time AS endTime, status
          FROM showtimes
          WHERE park_slug = ? AND category = 'featured'
          ORDER BY start_time
        `
      )
      .all(park.slug) as ShowTimeItem[];

    const meetGreets = database
      .prepare(
        `
          SELECT entertainment_id AS id, name, start_time AS startTime, end_time AS endTime, status
          FROM showtimes
          WHERE park_slug = ? AND category = 'meet-greet'
          ORDER BY start_time, name
        `
      )
      .all(park.slug) as ShowTimeItem[];

    const rides = database
      .prepare(
        `
          SELECT
            a.id,
            a.name,
            COALESCE(a.area_name, 'Other Experiences') AS areaName,
            COALESCE(a.area_sort, 999) AS areaSort,
            ws.wait_time AS waitTime,
            ws.status,
            ws.is_open AS isOpen,
            ws.source_updated_at AS lastUpdated,
            previous.wait_time AS trendWaitTime,
            previous.is_open AS previousIsOpen,
            (
              SELECT ROUND(AVG(s3.wait_time))
              FROM wait_snapshots s3
              WHERE s3.attraction_id = a.id
                AND s3.park_slug = ?
                AND s3.wait_time IS NOT NULL
                AND s3.is_open = 1
                AND date(s3.captured_at, 'localtime') < date('now', 'localtime')
                AND strftime('%H', s3.captured_at, 'localtime') = strftime('%H', 'now', 'localtime')
            ) AS normalWaitTime
          FROM attractions a
          LEFT JOIN (
            SELECT s1.*
            FROM wait_snapshots s1
            INNER JOIN (
              SELECT attraction_id, MAX(captured_at) AS captured_at
              FROM wait_snapshots
              WHERE park_slug = ?
              GROUP BY attraction_id
            ) latest
              ON latest.attraction_id = s1.attraction_id
             AND latest.captured_at = s1.captured_at
          ) ws ON ws.attraction_id = a.id
          LEFT JOIN wait_snapshots previous
            ON previous.id = (
              SELECT s2.id
              FROM wait_snapshots s2
              WHERE s2.attraction_id = a.id
                AND s2.park_slug = ?
                AND datetime(s2.captured_at) <= datetime('now', '-55 minutes')
              ORDER BY datetime(s2.captured_at) DESC
              LIMIT 1
            )
          WHERE a.park_slug = ? AND a.category = 'ride'
          ORDER BY areaSort, a.name
        `
      )
      .all(park.slug, park.slug, park.slug, park.slug) as Array<{
        id: string;
        name: string;
        areaName: string;
        areaSort: number;
        waitTime: number | null;
        status: string | null;
        isOpen: number | null;
        lastUpdated: string | null;
        trendWaitTime: number | null;
        previousIsOpen: number | null;
        normalWaitTime: number | null;
      }>;

    const grouped = new Map<string, LandGroup>();
    for (const ride of rides) {
      if (!grouped.has(ride.areaName)) {
        grouped.set(ride.areaName, { name: ride.areaName, rides: [] });
      }
      grouped.get(ride.areaName)!.rides.push({
        id: ride.id,
        name: ride.name,
        status: ride.status ?? "UNKNOWN",
        waitTime: ride.waitTime,
        isOpen: Boolean(ride.isOpen),
        lastUpdated: ride.lastUpdated,
        trendMinutes:
          ride.waitTime === null || ride.trendWaitTime === null ? null : ride.waitTime - ride.trendWaitTime,
        normalWaitTime: ride.normalWaitTime,
        previousIsOpen: ride.previousIsOpen === null ? null : Boolean(ride.previousIsOpen)
      });
    }

    const hasData =
      rides.length > 0 || hours.length > 0 || featuredShows.length > 0 || meetGreets.length > 0;
    const lastSuccessAt = refresh?.lastSuccessAt ?? null;
    const stale =
      !lastSuccessAt || Date.now() - new Date(lastSuccessAt).getTime() > 1000 * 60 * 20;

    return {
      park: {
        slug: park.slug,
        name: park.name,
        shortName: park.shortName,
        summary: getOperatingSummary(hours)
      },
      status: {
        hasData,
        stale,
        lastSuccessAt,
        lastError: refresh?.lastError ?? null
      },
      hours,
      featuredShows,
      meetGreets,
      lands: Array.from(grouped.values())
    };
  } catch {
    return {
      park: {
        slug: park.slug,
        name: park.name,
        shortName: park.shortName,
        summary: "Hours unavailable"
      },
      status: {
        hasData: false,
        stale: true,
        lastSuccessAt: null,
        lastError: "The local cache exists but is not ready yet."
      },
      hours: [],
      featuredShows: [],
      meetGreets: [],
      lands: []
    };
  }
}
