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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildCrowdPulse(
  rides: Array<{
    waitTime: number | null;
    isOpen: number | null;
    normalWaitTime: number | null;
    trendWaitTime: number | null;
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
  const trendingRides = rides
    .filter((ride) => Boolean(ride.isOpen) && ride.waitTime !== null && ride.trendWaitTime !== null)
    .map((ride) => (ride.waitTime as number) - (ride.trendWaitTime as number));
  const improvingCount = trendingRides.filter((delta) => delta <= -10).length;
  const worseningCount = trendingRides.filter((delta) => delta >= 10).length;
  const dropCount = trendingRides.filter((delta) => delta <= -15).length;
  const momentumAverage = average(trendingRides);
  const momentumScore =
    trendingRides.length < 5 || momentumAverage === null
      ? 5
      : clamp(Math.round(5 + momentumAverage / 5 + (worseningCount - improvingCount) / 3), 1, 10);
  const momentum =
    trendingRides.length < 5 || momentumAverage === null
      ? {
          direction: "learning" as const,
          score: momentumScore,
          headline: "Momentum building",
          detail: "Need a few more trend samples to read park movement.",
          improvingCount,
          worseningCount,
          dropCount
        }
      : momentumAverage <= -6 || improvingCount >= worseningCount + 3
        ? {
            direction: "easing" as const,
            score: momentumScore,
            headline: "Crowds easing",
            detail: `${improvingCount} rides are dropping while ${worseningCount} are climbing.`,
            improvingCount,
            worseningCount,
            dropCount
          }
        : momentumAverage >= 6 || worseningCount >= improvingCount + 3
          ? {
              direction: "building" as const,
              score: momentumScore,
              headline: "Crowds building",
              detail: `${worseningCount} rides are climbing while ${improvingCount} are dropping.`,
              improvingCount,
              worseningCount,
              dropCount
            }
          : {
              direction: "steady" as const,
              score: momentumScore,
              headline: "Holding steady",
              detail: "Most posted waits are moving within a small range.",
              improvingCount,
              worseningCount,
              dropCount
            };

  if (comparableRides.length >= 5 && averageDelta !== null) {
    if (averageDelta <= -10) {
      return {
        level: "lighter",
        headline: "Lighter than usual",
        detail: `Open rides are averaging ${Math.abs(averageDelta)} min below normal right now.`,
        averageWaitTime,
        deltaFromNormal: averageDelta,
        sampleSize: comparableRides.length,
        momentum
      };
    }

    if (averageDelta >= 10) {
      return {
        level: "busier",
        headline: "Busier than usual",
        detail: `Open rides are averaging ${averageDelta} min above normal right now.`,
        averageWaitTime,
        deltaFromNormal: averageDelta,
        sampleSize: comparableRides.length,
        momentum
      };
    }

    return {
      level: "typical",
      headline: "Near normal",
      detail: `Open rides are tracking close to their usual waits for this hour.`,
      averageWaitTime,
      deltaFromNormal: averageDelta,
      sampleSize: comparableRides.length,
      momentum
    };
  }

  if (averageWaitTime !== null) {
    return {
      level: "building",
      headline: "Building baseline",
      detail: `Current open rides average ${averageWaitTime} min while more history accumulates.`,
      averageWaitTime,
      deltaFromNormal: null,
      sampleSize: openWaits.length,
      momentum
    };
  }

  return {
    level: "building",
    headline: "Building baseline",
    detail: "Not enough live ride data yet to read the park pulse.",
    averageWaitTime: null,
    deltaFromNormal: null,
    sampleSize: 0,
    momentum
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
        sampleSize: 0,
        momentum: {
          direction: "learning",
          score: 5,
          headline: "Momentum building",
          detail: "Need a few more trend samples to read park movement.",
          improvingCount: 0,
          worseningCount: 0,
          dropCount: 0
        }
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
            CASE
              WHEN ws.wait_time IS NOT NULL AND previous.wait_time IS NOT NULL AND previous.wait_time - ws.wait_time >= 15
              THEN previous.wait_time - ws.wait_time
              ELSE NULL
            END AS dropMinutes,
            (
              SELECT ROUND(AVG(s3.wait_time))
              FROM wait_snapshots s3
              WHERE s3.attraction_id = a.id
                AND s3.park_slug = ?
                AND s3.wait_time IS NOT NULL
                AND s3.is_open = 1
                AND date(s3.captured_at, 'localtime') < date('now', 'localtime')
                AND strftime('%H', s3.captured_at, 'localtime') = strftime('%H', 'now', 'localtime')
            ) AS normalWaitTime,
            (
              SELECT ROUND(AVG(s4.wait_time))
              FROM wait_snapshots s4
              WHERE s4.attraction_id = a.id
                AND s4.park_slug = ?
                AND s4.wait_time IS NOT NULL
                AND s4.is_open = 1
                AND date(s4.captured_at, 'localtime') < date('now', 'localtime')
                AND (
                  (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) <= 1320
                    AND (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                      BETWEEN (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      AND (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120)
                  )
                  OR (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) > 1320
                    AND (
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        >= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      OR
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        <= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120 - 1440)
                    )
                  )
                )
            ) AS forecastWaitTime,
            (
              SELECT MIN(s4.wait_time)
              FROM wait_snapshots s4
              WHERE s4.attraction_id = a.id
                AND s4.park_slug = ?
                AND s4.wait_time IS NOT NULL
                AND s4.is_open = 1
                AND date(s4.captured_at, 'localtime') < date('now', 'localtime')
                AND (
                  (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) <= 1320
                    AND (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                      BETWEEN (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      AND (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120)
                  )
                  OR (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) > 1320
                    AND (
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        >= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      OR
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        <= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120 - 1440)
                    )
                  )
                )
            ) AS forecastLowWaitTime,
            (
              SELECT MAX(s4.wait_time)
              FROM wait_snapshots s4
              WHERE s4.attraction_id = a.id
                AND s4.park_slug = ?
                AND s4.wait_time IS NOT NULL
                AND s4.is_open = 1
                AND date(s4.captured_at, 'localtime') < date('now', 'localtime')
                AND (
                  (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) <= 1320
                    AND (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                      BETWEEN (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      AND (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120)
                  )
                  OR (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) > 1320
                    AND (
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        >= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      OR
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        <= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120 - 1440)
                    )
                  )
                )
            ) AS forecastHighWaitTime,
            (
              SELECT COUNT(*)
              FROM wait_snapshots s4
              WHERE s4.attraction_id = a.id
                AND s4.park_slug = ?
                AND s4.wait_time IS NOT NULL
                AND s4.is_open = 1
                AND date(s4.captured_at, 'localtime') < date('now', 'localtime')
                AND (
                  (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) <= 1320
                    AND (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                      BETWEEN (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      AND (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120)
                  )
                  OR (
                    (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER)) > 1320
                    AND (
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        >= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER))
                      OR
                      (CAST(strftime('%H', s4.captured_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s4.captured_at, 'localtime') AS INTEGER))
                        <= (CAST(strftime('%H', 'now', 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', 'now', 'localtime') AS INTEGER) + 120 - 1440)
                    )
                  )
                )
            ) AS forecastSampleSize
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
      .all(
        park.slug,
        park.slug,
        park.slug,
        park.slug,
        park.slug,
        park.slug,
        park.slug,
        park.slug,
        ...HIDDEN_RIDE_NAMES,
        ...globalHiddenRideIds
      ) as Array<{
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
        forecastWaitTime: number | null;
        forecastLowWaitTime: number | null;
        forecastHighWaitTime: number | null;
        forecastSampleSize: number | null;
        dropMinutes: number | null;
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
        forecastWaitTime: ride.forecastSampleSize && ride.forecastSampleSize >= 3 ? ride.forecastWaitTime : null,
        forecastLowWaitTime: ride.forecastSampleSize && ride.forecastSampleSize >= 3 ? ride.forecastLowWaitTime : null,
        forecastHighWaitTime: ride.forecastSampleSize && ride.forecastSampleSize >= 3 ? ride.forecastHighWaitTime : null,
        forecastSampleSize: ride.forecastSampleSize ?? 0,
        forecastTrendMinutes:
          ride.waitTime === null || !ride.forecastSampleSize || ride.forecastSampleSize < 3 || ride.forecastWaitTime === null
            ? null
            : ride.forecastWaitTime - ride.waitTime,
        dropMinutes: ride.dropMinutes,
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
        sampleSize: 0,
        momentum: {
          direction: "learning",
          score: 5,
          headline: "Momentum building",
          detail: "Need a few more trend samples to read park movement.",
          improvingCount: 0,
          worseningCount: 0,
          dropCount: 0
        }
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
    .prepare("SELECT id, park_slug AS parkSlug FROM attractions WHERE id = ? AND category = 'ride'")
    .get(rideId) as { id: string; parkSlug: string } | undefined;
  if (!ride) return null;

  const operatingWindow = database
    .prepare(
      `
        SELECT opening_time AS openingTime, closing_time AS closingTime
        FROM park_schedules
        WHERE park_slug = ?
          AND schedule_date = date('now', 'localtime')
          AND type = 'OPERATING'
        ORDER BY opening_time
        LIMIT 1
      `
    )
    .get(ride.parkSlug) as { openingTime: string; closingTime: string } | undefined;

  const points = database
    .prepare(
      `
        SELECT
          ws.captured_at AS capturedAt,
          ws.wait_time AS waitTime,
          ws.is_open AS isOpen
        FROM wait_snapshots ws
        WHERE ws.attraction_id = ?
          AND date(ws.captured_at, 'localtime') = date('now', 'localtime')
          AND (
            EXISTS (
              SELECT 1
              FROM park_schedules ps
              WHERE ps.park_slug = ws.park_slug
                AND ps.schedule_date = date(ws.captured_at, 'localtime')
                AND ps.type = 'OPERATING'
                AND datetime(ws.captured_at) BETWEEN datetime(ps.opening_time) AND datetime(ps.closing_time)
            )
            OR NOT EXISTS (
              SELECT 1
              FROM park_schedules ps
              WHERE ps.park_slug = ws.park_slug
                AND ps.schedule_date = date(ws.captured_at, 'localtime')
                AND ps.type = 'OPERATING'
            )
          )
        ORDER BY datetime(ws.captured_at)
      `
    )
    .all(rideId) as Array<{ capturedAt: string; waitTime: number | null; isOpen: number }>;

  const baselinePoints = database
    .prepare(
      `
        SELECT minuteOfDay, ROUND(AVG(waitTime)) AS waitTime, COUNT(*) AS sampleSize
        FROM (
          SELECT
            CAST((
              (
                CAST(strftime('%H', ws.captured_at, 'localtime') AS INTEGER) * 60 +
                CAST(strftime('%M', ws.captured_at, 'localtime') AS INTEGER)
              ) / 30
            ) AS INTEGER) * 30 AS minuteOfDay,
            ws.wait_time AS waitTime
          FROM wait_snapshots ws
          JOIN park_schedules ps
            ON ps.park_slug = ws.park_slug
            AND ps.schedule_date = date(ws.captured_at, 'localtime')
            AND ps.type = 'OPERATING'
            AND datetime(ws.captured_at) BETWEEN datetime(ps.opening_time) AND datetime(ps.closing_time)
          WHERE ws.attraction_id = ?
            AND ws.wait_time IS NOT NULL
            AND ws.is_open = 1
            AND date(ws.captured_at, 'localtime') < date('now', 'localtime')
        )
        GROUP BY minuteOfDay
        HAVING COUNT(*) >= 2
        ORDER BY minuteOfDay
      `
    )
    .all(rideId) as Array<{ minuteOfDay: number; waitTime: number; sampleSize: number }>;

  return {
    rideId,
    points: points.map((point) => ({
      capturedAt: point.capturedAt,
      waitTime: point.waitTime,
      isOpen: Boolean(point.isOpen)
    })),
    baselinePoints,
    operatingWindow: operatingWindow ?? null
  };
}
