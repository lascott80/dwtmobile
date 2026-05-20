import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getDefaultHiddenRideIds, getFeatureFlags, getGlobalHiddenRideIds } from "@/lib/admin-settings";
import { DB_PATH, PARKS } from "@/lib/config";
import type {
  CrowdPulse,
  FacilityItem,
  LandGroup,
  ParkDetailResponse,
  ParkHoursEntry,
  RestaurantItem,
  RideHistoryResponse,
  ShowTimeItem
} from "@/lib/types";

let db: DatabaseSync | null = null;
const HIDDEN_RIDE_NAMES = [
  "Maharajah Jungle Trek",
  "Beauty and the Beast Sing-Along",
  "Impressions de France",
  "Reflections of China",
  "The American Adventure"
];

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

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildCrowdPulse(
  rides: Array<{
    waitTime: number | null;
    isOpen: number | null;
    normalWaitTime: number | null;
  }>
): CrowdPulse {
  const openWaits = rides
    .filter((ride) => Boolean(ride.isOpen) && ride.waitTime !== null)
    .map((ride) => ride.waitTime as number);
  const comparableRides = rides.filter(
    (ride) => Boolean(ride.isOpen) && ride.waitTime !== null && ride.normalWaitTime !== null
  );
  const averageWaitTime = average(openWaits);
  const averageDelta = average(
    comparableRides.map((ride) => (ride.waitTime as number) - (ride.normalWaitTime as number))
  );

  if (comparableRides.length >= 5 && averageDelta !== null) {
    if (averageDelta <= -10) {
      return {
        level: "lighter",
        headline: "Lighter than usual",
        detail: `Open rides are averaging ${Math.abs(averageDelta)} min below normal right now.`,
        averageWaitTime,
        deltaFromNormal: averageDelta,
        sampleSize: comparableRides.length
      };
    }

    if (averageDelta >= 10) {
      return {
        level: "busier",
        headline: "Busier than usual",
        detail: `Open rides are averaging ${averageDelta} min above normal right now.`,
        averageWaitTime,
        deltaFromNormal: averageDelta,
        sampleSize: comparableRides.length
      };
    }

    return {
      level: "typical",
      headline: "Near normal",
      detail: `Open rides are tracking close to their usual waits for this hour.`,
      averageWaitTime,
      deltaFromNormal: averageDelta,
      sampleSize: comparableRides.length
    };
  }

  if (averageWaitTime !== null) {
    return {
      level: "building",
      headline: "Building baseline",
      detail: `Current open rides average ${averageWaitTime} min while more history accumulates.`,
      averageWaitTime,
      deltaFromNormal: null,
      sampleSize: openWaits.length
    };
  }

  return {
    level: "building",
    headline: "Building baseline",
    detail: "Not enough live ride data yet to read the park pulse.",
    averageWaitTime: null,
    deltaFromNormal: null,
    sampleSize: 0
  };
}

export function getParkMeta() {
  const database = connect();
  return {
    generatedAt: new Date().toISOString(),
    defaultHiddenRideIds: getDefaultHiddenRideIds(),
    featureFlags: getFeatureFlags(),
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
      crowdPulse: {
        level: "building",
        headline: "Building baseline",
        detail: "Not enough live ride data yet to read the park pulse.",
        averageWaitTime: null,
        deltaFromNormal: null,
        sampleSize: 0
      },
      restaurants: [],
      facilities: [],
      lands: []
    };
  }
  try {
    const globalHiddenRideIds = getGlobalHiddenRideIds();
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

    const meetGreets = (database
      .prepare(
        `
          SELECT
            s.entertainment_id AS id,
            s.name,
            s.start_time AS startTime,
            s.end_time AS endTime,
            s.status,
            latest.wait_time AS waitTime,
            latest.is_open AS isOpen
          FROM showtimes s
          LEFT JOIN wait_snapshots latest
            ON latest.attraction_id = s.entertainment_id
            AND latest.park_slug = s.park_slug
            AND latest.captured_at = (
              SELECT MAX(ws.captured_at)
              FROM wait_snapshots ws
              WHERE ws.attraction_id = s.entertainment_id
                AND ws.park_slug = s.park_slug
            )
          WHERE s.park_slug = ? AND s.category = 'meet-greet'
          ORDER BY startTime, name
        `
      )
      .all(park.slug) as Array<ShowTimeItem & { isOpen: number | null }>)
      .map((show) => ({
        ...show,
        isOpen: show.isOpen === null ? null : Boolean(show.isOpen)
      }));

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
            a.latitude,
            a.longitude,
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
          WHERE a.park_slug = ?
            AND a.category = 'ride'
            AND a.name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})
            AND a.id NOT IN (${globalHiddenRideIds.length ? globalHiddenRideIds.map(() => "?").join(", ") : "''"})
          ORDER BY areaSort, a.name
        `
      )
      .all(park.slug, park.slug, park.slug, park.slug, ...HIDDEN_RIDE_NAMES, ...globalHiddenRideIds) as Array<{
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
        latitude: number | null;
        longitude: number | null;
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
        previousIsOpen: ride.previousIsOpen === null ? null : Boolean(ride.previousIsOpen),
        latitude: ride.latitude,
        longitude: ride.longitude
      });
    }

    const restaurants = database
      .prepare(
        `
          SELECT id, name, latitude, longitude
          FROM restaurants
          WHERE park_slug = ?
          ORDER BY name
        `
      )
      .all(park.slug) as RestaurantItem[];
    const facilities = database
      .prepare(
        `
          SELECT id, name, category, latitude, longitude
          FROM facilities
          WHERE park_slug = ?
          ORDER BY category, name
        `
      )
      .all(park.slug) as FacilityItem[];

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
      crowdPulse: buildCrowdPulse(rides),
      restaurants,
      facilities,
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
      crowdPulse: {
        level: "building",
        headline: "Building baseline",
        detail: "Not enough live ride data yet to read the park pulse.",
        averageWaitTime: null,
        deltaFromNormal: null,
        sampleSize: 0
      },
      restaurants: [],
      facilities: [],
      lands: []
    };
  }
}

export function getRideHistory(rideId: string): RideHistoryResponse | null {
  const database = connect();
  if (!database) return null;

  const ride = database
    .prepare("SELECT id FROM attractions WHERE id = ? AND category = 'ride'")
    .get(rideId) as { id: string } | undefined;
  if (!ride) return null;

  const points = database
    .prepare(
      `
        SELECT
          captured_at AS capturedAt,
          wait_time AS waitTime,
          is_open AS isOpen
        FROM wait_snapshots
        WHERE attraction_id = ?
          AND datetime(captured_at) >= datetime('now', '-12 hours')
        ORDER BY datetime(captured_at)
      `
    )
    .all(rideId) as Array<{ capturedAt: string; waitTime: number | null; isOpen: number }>;

  return {
    rideId,
    points: points.map((point) => ({
      capturedAt: point.capturedAt,
      waitTime: point.waitTime,
      isOpen: Boolean(point.isOpen)
    }))
  };
}
