import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, METRICS_DB_PATH, PARKS } from "@/lib/config";

const HIDDEN_RIDE_NAMES = [
  "Maharajah Jungle Trek",
  "Beauty and the Beast Sing-Along",
  "Impressions de France",
  "Reflections of China",
  "The American Adventure"
];

const SOURCE_IMPACT: Record<string, string> = {
  "queue-times": "Ride waits and land grouping",
  "themeparks-children": "Attractions, dining, and locations",
  "themeparks-live": "Live statuses, shows, and meet-and-greets",
  "themeparks-schedule": "Park hours and operating schedules"
};

let metricsDb: DatabaseSync | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const visitQueue: Array<{ visitorId: string; path: string; visitedAt: string }> = [];
const eventQueue: Array<{ visitorId: string; eventName: string; detail: string | null; createdAt: string }> = [];
const apiRequestQueue: Array<{
  route: string;
  method: string;
  status: number;
  durationMs: number;
  createdAt: string;
}> = [];
const MAX_QUEUE_SIZE = 2_000;
const FLUSH_DELAY_MS = 250;

function connectMetrics() {
  if (!metricsDb) {
    mkdirSync(dirname(METRICS_DB_PATH), { recursive: true });
    metricsDb = new DatabaseSync(METRICS_DB_PATH);
    metricsDb.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_id TEXT NOT NULL,
        path TEXT NOT NULL,
        visited_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_visits_visitor ON visits (visitor_id);
      CREATE INDEX IF NOT EXISTS idx_visits_time ON visits (visited_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_name_time ON events (event_name, created_at);
      CREATE TABLE IF NOT EXISTS preference_sync (
        code TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_preference_sync_updated ON preference_sync (updated_at);
      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route TEXT NOT NULL,
        method TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_requests_route_time ON api_requests (route, created_at);
    `);
  }
  return metricsDb;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushTelemetryQueues();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

function trimQueue<T>(queue: T[]) {
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }
}

function flushTelemetryQueues() {
  const visits = visitQueue.splice(0);
  const events = eventQueue.splice(0);
  const apiRequests = apiRequestQueue.splice(0);

  if (visits.length === 0 && events.length === 0 && apiRequests.length === 0) {
    return;
  }

  try {
    const database = connectMetrics();
    const insertVisit = database.prepare("INSERT INTO visits (visitor_id, path, visited_at) VALUES (?, ?, ?)");
    const insertEvent = database.prepare(
      "INSERT INTO events (visitor_id, event_name, detail, created_at) VALUES (?, ?, ?, ?)"
    );
    const insertApiRequest = database.prepare(
      "INSERT INTO api_requests (route, method, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)"
    );

    database.exec("BEGIN");
    try {
      for (const visit of visits) {
        insertVisit.run(visit.visitorId, visit.path, visit.visitedAt);
      }
      for (const event of events) {
        insertEvent.run(event.visitorId, event.eventName, event.detail, event.createdAt);
      }
      for (const request of apiRequests) {
        insertApiRequest.run(
          request.route,
          request.method,
          request.status,
          request.durationMs,
          request.createdAt
        );
      }
      database.exec("COMMIT");
    } catch {
      database.exec("ROLLBACK");
      throw new Error("Could not flush telemetry queues");
    }
  } catch {
    // Telemetry is best-effort; user-facing routes should not pay for storage failures.
  }
}

function normalizeSyncCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

function generateSyncCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function recordVisit(visitorId: string, path: string) {
  visitQueue.push({ visitorId, path, visitedAt: new Date().toISOString() });
  trimQueue(visitQueue);
  scheduleFlush();
}

export function recordEvent(visitorId: string, eventName: string, detail: string | null) {
  eventQueue.push({ visitorId, eventName, detail, createdAt: new Date().toISOString() });
  trimQueue(eventQueue);
  scheduleFlush();
}

export function recordApiRequest(route: string, method: string, status: number, durationMs: number) {
  apiRequestQueue.push({ route, method, status, durationMs, createdAt: new Date().toISOString() });
  trimQueue(apiRequestQueue);
  scheduleFlush();
}

export async function withApiTelemetry(route: string, method: string, handler: () => Response | Promise<Response>) {
  const started = Date.now();
  let status = 500;
  try {
    const response = await handler();
    status = response.status;
    return response;
  } finally {
    try {
      recordApiRequest(route, method, status, Date.now() - started);
    } catch {
      // Avoid failing user-facing API routes when telemetry storage is unavailable.
    }
  }
}

export function savePreferenceSync(payload: unknown, code?: string) {
  const database = connectMetrics();
  let syncCode = code ? normalizeSyncCode(code) : "";
  let attempts = 0;
  while (!syncCode || database.prepare("SELECT code FROM preference_sync WHERE code = ?").get(syncCode)) {
    if (code && attempts === 0) break;
    syncCode = generateSyncCode();
    attempts += 1;
  }
  const now = new Date().toISOString();
  database
    .prepare(
      `
        INSERT INTO preference_sync (code, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `
    )
    .run(syncCode, JSON.stringify(payload), now, now);
  return syncCode;
}

export function getPreferenceSync(code: string) {
  const syncCode = normalizeSyncCode(code);
  if (!syncCode) return null;
  const row = connectMetrics()
    .prepare("SELECT code, payload, updated_at AS updatedAt FROM preference_sync WHERE code = ?")
    .get(syncCode) as { code: string; payload: string; updatedAt: string } | undefined;
  if (!row) return null;
  return {
    code: row.code,
    payload: JSON.parse(row.payload) as unknown,
    updatedAt: row.updatedAt
  };
}

export function getTrafficStats() {
  flushTelemetryQueues();
  const database = connectMetrics();
  return database
    .prepare(
      `
        SELECT
          COUNT(*) AS pageViews,
          COUNT(DISTINCT visitor_id) AS uniqueVisitors,
          COUNT(DISTINCT CASE
            WHEN date(visited_at, 'localtime') = date('now', 'localtime') THEN visitor_id
          END) AS visitorsToday,
          COUNT(CASE
            WHEN date(visited_at, 'localtime') = date('now', 'localtime') THEN 1
          END) AS pageViewsToday
        FROM visits
      `
    )
    .get() as {
    pageViews: number;
    uniqueVisitors: number;
    visitorsToday: number;
    pageViewsToday: number;
  };
}

export function getUsageStats() {
  flushTelemetryQueues();
  const database = connectMetrics();
  return {
    topParks: database
      .prepare(
        `
          SELECT detail AS slug, COUNT(*) AS views
          FROM events
          WHERE event_name = 'park_view'
          GROUP BY detail
          ORDER BY views DESC
          LIMIT 4
        `
      )
      .all() as Array<{ slug: string; views: number }>,
    topRideSheets: database
      .prepare(
        `
          SELECT detail AS rideId, COUNT(*) AS opens
          FROM events
          WHERE event_name = 'ride_sheet_open'
          GROUP BY detail
          ORDER BY opens DESC
          LIMIT 5
        `
      )
      .all() as Array<{ rideId: string; opens: number }>,
    topFavorites: database
      .prepare(
        `
          SELECT detail AS rideId, COUNT(*) AS toggles
          FROM events
          WHERE event_name = 'favorite_toggle'
          GROUP BY detail
          ORDER BY toggles DESC
          LIMIT 5
        `
      )
      .all() as Array<{ rideId: string; toggles: number }>,
    recommendationEngagement: database
      .prepare(
        `
          SELECT event_name AS eventName, COUNT(*) AS count
          FROM events
          WHERE event_name IN (
            'ride_sheet_open',
            'snipe_created',
            'plan_item_add',
            'preference_profile',
            'no_go_toggle',
            'party_day_share',
            'preference_sync_save',
            'preference_sync_restore',
            'land_flow_start',
            'copilot_open'
          )
          GROUP BY event_name
          ORDER BY count DESC
        `
      )
      .all() as Array<{ eventName: string; count: number }>,
    preferenceSync: database
      .prepare(
        `
          SELECT
            COUNT(*) AS totalCodes,
            COUNT(CASE WHEN date(created_at, 'localtime') = date('now', 'localtime') THEN 1 END) AS codesCreatedToday,
            COUNT(CASE WHEN date(updated_at, 'localtime') = date('now', 'localtime') THEN 1 END) AS codesUpdatedToday,
            MAX(updated_at) AS lastUpdatedAt,
            ROUND(AVG(LENGTH(payload))) AS averagePayloadBytes,
            MAX(LENGTH(payload)) AS maxPayloadBytes
          FROM preference_sync
        `
      )
      .get() as {
      totalCodes: number;
      codesCreatedToday: number;
      codesUpdatedToday: number;
      lastUpdatedAt: string | null;
      averagePayloadBytes: number | null;
      maxPayloadBytes: number | null;
    },
    apiUsage: database
      .prepare(
        `
          SELECT
            route,
            COUNT(*) AS requests,
            ROUND(AVG(duration_ms)) AS averageDurationMs,
            SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
            MAX(created_at) AS lastSeenAt
          FROM api_requests
          WHERE datetime(created_at) >= datetime('now', '-24 hours')
          GROUP BY route
          ORDER BY requests DESC
        `
      )
      .all() as Array<{
      route: string;
      requests: number;
      averageDurationMs: number | null;
      errors: number;
      lastSeenAt: string;
    }>
  };
}

export function getMetricsStorageStats() {
  flushTelemetryQueues();
  try {
    return {
      databaseBytes: statSync(METRICS_DB_PATH).size,
      queuedVisits: visitQueue.length,
      queuedEvents: eventQueue.length,
      queuedApiRequests: apiRequestQueue.length
    };
  } catch {
    return {
      databaseBytes: 0,
      queuedVisits: visitQueue.length,
      queuedEvents: eventQueue.length,
      queuedApiRequests: apiRequestQueue.length
    };
  }
}

export function getStorageStats() {
  const database = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  try {
    const dbStats = statSync(DB_PATH);
    const totals = database
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM wait_snapshots) AS waitSnapshots,
            (SELECT COUNT(*) FROM attractions WHERE name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})) AS attractions,
            (SELECT COUNT(*) FROM showtimes) AS showtimes,
            (SELECT COUNT(*) FROM park_schedules) AS scheduleRows,
            (SELECT MIN(captured_at) FROM wait_snapshots) AS firstSnapshotAt,
            (SELECT MAX(captured_at) FROM wait_snapshots) AS lastSnapshotAt
        `
      )
      .get(...HIDDEN_RIDE_NAMES) as {
      waitSnapshots: number;
      attractions: number;
      showtimes: number;
      scheduleRows: number;
      firstSnapshotAt: string | null;
      lastSnapshotAt: string | null;
    };

    const parks = database
      .prepare(
        `
          SELECT
            p.slug,
            p.short_name AS shortName,
            COALESCE(a.attractions, 0) AS attractions,
            COALESCE(ws.waitSnapshots, 0) AS waitSnapshots,
            r.last_success_at AS lastSuccessAt,
            r.last_polled_at AS lastPolledAt,
            r.last_error AS lastError
          FROM parks p
          LEFT JOIN (
            SELECT park_slug, COUNT(*) AS attractions
            FROM attractions
            WHERE name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})
            GROUP BY park_slug
          ) a ON a.park_slug = p.slug
          LEFT JOIN (
            SELECT park_slug, COUNT(*) AS waitSnapshots
            FROM wait_snapshots
            GROUP BY park_slug
          ) ws ON ws.park_slug = p.slug
          LEFT JOIN refresh_state r ON r.park_slug = p.slug
          ORDER BY p.short_name
        `
      )
      .all(...HIDDEN_RIDE_NAMES) as Array<{
      slug: string;
      shortName: string;
      attractions: number;
      waitSnapshots: number;
      lastSuccessAt: string | null;
      lastPolledAt: string | null;
      lastError: string | null;
    }>;

    const now = Date.now();
    const staleParks = parks.filter(
      (park) => !park.lastSuccessAt || now - new Date(park.lastSuccessAt).getTime() > 1000 * 60 * 20
    ).length;
    const parksWithErrors = parks.filter((park) => Boolean(park.lastError)).length;
    const parksWithData = parks.filter((park) => park.waitSnapshots > 0).length;
    const latestSnapshotAgeMinutes = totals.lastSnapshotAt
      ? Math.max(0, Math.round((now - new Date(totals.lastSnapshotAt).getTime()) / 60000))
      : null;

    const sourceHealth = database
      .prepare(
        `
          WITH ranked AS (
            SELECT
              source,
              success,
              checked_at AS checkedAt,
              error,
              duration_ms AS durationMs,
              ROW_NUMBER() OVER (PARTITION BY source ORDER BY checked_at DESC) AS rowNum
            FROM source_checks
            WHERE source <> 'osm-overpass'
          )
          SELECT source, success, checkedAt, error, durationMs
          FROM ranked
          WHERE rowNum = 1
          ORDER BY source
        `
      )
      .all() as Array<{
      source: string;
      success: number;
      checkedAt: string;
      error: string | null;
      durationMs: number;
    }>;

    const pollingTimeline = database
      .prepare(
        `
          SELECT
            strftime('%H:00', started_at, 'localtime') AS hour,
            SUM(CASE WHEN failure_count = 0 THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN failure_count > 0 THEN 1 ELSE 0 END) AS failures
          FROM poll_cycles
          WHERE datetime(started_at) >= datetime('now', '-24 hours')
          GROUP BY hour
          ORDER BY hour
        `
      )
      .all() as Array<{ hour: string; successes: number; failures: number }>;

    const dataGrowth = database
      .prepare(
        `
          SELECT
            strftime('%H:00', captured_at, 'localtime') AS hour,
            COUNT(*) AS snapshots
          FROM wait_snapshots
          WHERE datetime(captured_at) >= datetime('now', '-24 hours')
          GROUP BY hour
          ORDER BY hour
        `
      )
      .all() as Array<{ hour: string; snapshots: number }>;

    const freshnessHeatmap = database
      .prepare(
        `
          SELECT
            park_slug AS parkSlug,
            strftime('%H:00', captured_at, 'localtime') AS hour,
            COUNT(*) AS snapshots
          FROM wait_snapshots
          WHERE datetime(captured_at) >= datetime('now', '-12 hours')
          GROUP BY park_slug, hour
          ORDER BY park_slug, hour
        `
      )
      .all() as Array<{ parkSlug: string; hour: string; snapshots: number }>;

    const topMovers = database
      .prepare(
        `
          SELECT
            a.name,
            p.short_name AS parkName,
            MAX(ws.wait_time) - MIN(ws.wait_time) AS swing
          FROM wait_snapshots ws
          JOIN attractions a ON a.id = ws.attraction_id
          JOIN parks p ON p.slug = ws.park_slug
          WHERE ws.wait_time IS NOT NULL
            AND ws.is_open = 1
            AND date(ws.captured_at, 'localtime') = date('now', 'localtime')
          GROUP BY ws.attraction_id
          HAVING COUNT(*) >= 2
          ORDER BY swing DESC
          LIMIT 5
        `
      )
      .all() as Array<{ name: string; parkName: string; swing: number }>;

    const coverageQuality = database
      .prepare(
        `
          SELECT
            SUM(CASE WHEN area_name IS NULL THEN 1 ELSE 0 END) AS ridesMissingLand,
            SUM(CASE WHEN latest.wait_time IS NULL THEN 1 ELSE 0 END) AS ridesWithNullWait,
            SUM(CASE WHEN latest.captured_at IS NULL OR datetime(latest.captured_at) < datetime('now', '-20 minutes') THEN 1 ELSE 0 END) AS ridesWithoutRecentData
          FROM attractions a
          LEFT JOIN (
            SELECT s1.*
            FROM wait_snapshots s1
            JOIN (
              SELECT attraction_id, MAX(captured_at) AS captured_at
              FROM wait_snapshots
              GROUP BY attraction_id
            ) s2 ON s1.attraction_id = s2.attraction_id AND s1.captured_at = s2.captured_at
          ) latest ON latest.attraction_id = a.id
          WHERE a.category = 'ride'
            AND a.name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})
            AND COALESCE(latest.status, '') <> 'REFURBISHMENT'
        `
      )
      .get(...HIDDEN_RIDE_NAMES) as {
      ridesMissingLand: number;
      ridesWithNullWait: number;
      ridesWithoutRecentData: number;
    };

    const ridesMissingLandMetadata = database
      .prepare(
        `
          SELECT
            a.id,
            a.name,
            p.short_name AS parkName
          FROM attractions a
          JOIN parks p ON p.slug = a.park_slug
          LEFT JOIN (
            SELECT s1.*
            FROM wait_snapshots s1
            JOIN (
              SELECT attraction_id, MAX(captured_at) AS captured_at
              FROM wait_snapshots
              GROUP BY attraction_id
            ) s2 ON s1.attraction_id = s2.attraction_id AND s1.captured_at = s2.captured_at
          ) latest ON latest.attraction_id = a.id
          WHERE a.category = 'ride'
            AND a.area_name IS NULL
            AND a.name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})
            AND COALESCE(latest.status, '') <> 'REFURBISHMENT'
          ORDER BY p.short_name, a.name
        `
      )
      .all(...HIDDEN_RIDE_NAMES) as Array<{
      id: string;
      name: string;
      parkName: string;
    }>;

    const runtime = database
      .prepare(
        `
          SELECT
            COUNT(*) AS cyclesLast24h,
            ROUND(AVG(duration_seconds)) AS averageCycleSeconds,
            (SELECT duration_seconds FROM poll_cycles ORDER BY started_at DESC LIMIT 1) AS lastCycleSeconds
          FROM poll_cycles
          WHERE datetime(started_at) >= datetime('now', '-24 hours')
        `
      )
      .get() as {
      cyclesLast24h: number;
      averageCycleSeconds: number | null;
      lastCycleSeconds: number | null;
    };

    const flatlineRides = database
      .prepare(
        `
          SELECT
            a.name,
            p.short_name AS parkName,
            COUNT(*) AS samples,
            MIN(ws.wait_time) AS minWait,
            MAX(ws.wait_time) AS maxWait
          FROM wait_snapshots ws
          JOIN attractions a ON a.id = ws.attraction_id
          JOIN parks p ON p.slug = ws.park_slug
          WHERE ws.wait_time IS NOT NULL
            AND ws.is_open = 1
            AND datetime(ws.captured_at) >= datetime('now', '-3 hours')
            AND a.category = 'ride'
            AND a.name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})
          GROUP BY ws.attraction_id
          HAVING COUNT(*) >= 6 AND MIN(ws.wait_time) = MAX(ws.wait_time)
          ORDER BY samples DESC, a.name
          LIMIT 5
        `
      )
      .all(...HIDDEN_RIDE_NAMES) as Array<{
      name: string;
      parkName: string;
      samples: number;
      minWait: number;
      maxWait: number;
    }>;

    const attractionCoverageDrops = parks.filter(
      (park) => park.attractions > 0 && park.waitSnapshots / park.attractions < 5
    );

    const sourceLatencyTrend = database
      .prepare(
        `
          SELECT
            source,
            ROUND(AVG(duration_ms)) AS avgDurationMs,
            MAX(duration_ms) AS maxDurationMs,
            COUNT(*) AS checks
          FROM source_checks
          WHERE datetime(checked_at) >= datetime('now', '-24 hours')
            AND source <> 'osm-overpass'
          GROUP BY source
          ORDER BY source
        `
      )
      .all() as Array<{
      source: string;
      avgDurationMs: number | null;
      maxDurationMs: number | null;
      checks: number;
    }>;

    const sourceImpact = database
      .prepare(
        `
          SELECT
            source,
            MAX(checked_at) AS lastCheckAt,
            MAX(CASE WHEN success = 1 THEN checked_at END) AS lastSuccessAt,
            MAX(CASE WHEN success = 0 THEN checked_at END) AS lastFailureAt,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failuresLast24h,
            COUNT(*) AS checksLast24h,
            ROUND(100.0 * SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) / COUNT(*)) AS failureRate
          FROM source_checks
          WHERE datetime(checked_at) >= datetime('now', '-24 hours')
            AND source <> 'osm-overpass'
          GROUP BY source
          ORDER BY source
        `
      )
      .all() as Array<{
      source: string;
      lastCheckAt: string;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      failuresLast24h: number;
      checksLast24h: number;
      failureRate: number;
    }>;

    const dataTypeFreshness = {
      waits: database
        .prepare("SELECT MAX(captured_at) AS lastUpdatedAt, COUNT(*) AS rows FROM wait_snapshots")
        .get() as { lastUpdatedAt: string | null; rows: number },
      schedules: database
        .prepare("SELECT MAX(captured_at) AS lastUpdatedAt, COUNT(*) AS rows FROM park_schedules")
        .get() as { lastUpdatedAt: string | null; rows: number },
      showtimes: database
        .prepare("SELECT MAX(captured_at) AS lastUpdatedAt, COUNT(*) AS rows FROM showtimes")
        .get() as { lastUpdatedAt: string | null; rows: number },
      restaurants: database
        .prepare("SELECT MAX(updated_at) AS lastUpdatedAt, COUNT(*) AS rows FROM restaurants")
        .get() as { lastUpdatedAt: string | null; rows: number }
    };

    const facilitiesByPark = database
      .prepare(
        `
          SELECT
            p.slug,
            p.short_name AS shortName,
            COUNT(f.id) AS total,
            SUM(CASE WHEN f.category = 'restroom' THEN 1 ELSE 0 END) AS restrooms,
            SUM(CASE WHEN f.category = 'water' THEN 1 ELSE 0 END) AS water,
            SUM(CASE WHEN f.category = 'first-aid' THEN 1 ELSE 0 END) AS firstAid,
            MAX(f.updated_at) AS lastUpdatedAt
          FROM parks p
          LEFT JOIN facilities f ON f.park_slug = p.slug
          GROUP BY p.slug, p.short_name
          ORDER BY p.short_name
        `
      )
      .all() as Array<{
      slug: string;
      shortName: string;
      total: number;
      restrooms: number;
      water: number;
      firstAid: number;
      lastUpdatedAt: string | null;
    }>;

    const impossibleWaitSwings = database
      .prepare(
        `
          WITH ordered AS (
            SELECT
              a.name,
              p.short_name AS parkName,
              ws.wait_time AS waitTime,
              LAG(ws.wait_time) OVER (PARTITION BY ws.attraction_id ORDER BY ws.captured_at) AS previousWaitTime,
              ws.captured_at AS capturedAt
            FROM wait_snapshots ws
            JOIN attractions a ON a.id = ws.attraction_id
            JOIN parks p ON p.slug = ws.park_slug
            WHERE ws.wait_time IS NOT NULL
              AND datetime(ws.captured_at) >= datetime('now', '-12 hours')
              AND a.category = 'ride'
          )
          SELECT name, parkName, ABS(waitTime - previousWaitTime) AS swing, capturedAt
          FROM ordered
          WHERE previousWaitTime IS NOT NULL
            AND ABS(waitTime - previousWaitTime) >= 60
          ORDER BY swing DESC, capturedAt DESC
          LIMIT 5
        `
      )
      .all() as Array<{ name: string; parkName: string; swing: number; capturedAt: string }>;

    const zeroOpenDuringHours = parks.filter((park) => {
      const row = database
        .prepare(
          `
            SELECT COUNT(*) AS openRides
            FROM wait_snapshots ws
            JOIN (
              SELECT attraction_id, MAX(captured_at) AS captured_at
              FROM wait_snapshots
              WHERE park_slug = ?
              GROUP BY attraction_id
            ) latest ON latest.attraction_id = ws.attraction_id AND latest.captured_at = ws.captured_at
            JOIN attractions a ON a.id = ws.attraction_id
            WHERE a.category = 'ride'
              AND ws.is_open = 1
          `
        )
        .get(park.slug) as { openRides: number };
      const openNow = database
        .prepare(
          `
            SELECT COUNT(*) AS openSchedules
            FROM park_schedules
            WHERE park_slug = ?
              AND datetime(opening_time) <= datetime('now')
              AND datetime(closing_time) >= datetime('now')
          `
        )
        .get(park.slug) as { openSchedules: number };
      return openNow.openSchedules > 0 && row.openRides === 0;
    });

    const recentErrors = database
      .prepare(
        `
          SELECT
            source,
            error,
            MIN(checked_at) AS firstSeenAt,
            MAX(checked_at) AS lastSeenAt,
            COUNT(*) AS occurrences
          FROM source_checks
          WHERE success = 0
            AND source <> 'osm-overpass'
            AND datetime(checked_at) >= datetime('now', '-7 days')
          GROUP BY source, error
          ORDER BY lastSeenAt DESC
          LIMIT 5
        `
      )
      .all() as Array<{
      source: string;
      error: string;
      firstSeenAt: string;
      lastSeenAt: string;
      occurrences: number;
    }>;

    const distinctSnapshotDays = database
      .prepare("SELECT COUNT(DISTINCT date(captured_at, 'localtime')) AS days FROM wait_snapshots")
      .get() as { days: number };

    const rideNames = database
      .prepare("SELECT id, name FROM attractions")
      .all() as Array<{ id: string; name: string }>;

    return {
      totals,
      parks,
      health: {
        expectedParks: PARKS.length,
        parksWithData,
        staleParks,
        parksWithErrors,
        latestSnapshotAgeMinutes
      },
      sourceHealth,
      sourceImpact: sourceImpact.map((source) => ({
        ...source,
        impact: SOURCE_IMPACT[source.source] ?? "Unknown app feature"
      })),
      pollingTimeline,
      dataGrowth,
      dataTypeFreshness,
      facilitiesByPark,
      freshnessHeatmap,
      topMovers,
      coverageQuality,
      ridesMissingLandMetadata,
      runtime,
      anomalies: {
        flatlineRides,
        attractionCoverageDrops,
        impossibleWaitSwings,
        zeroOpenDuringHours
      },
      sourceLatencyTrend,
      recentErrors,
      storageFootprint: {
        databaseBytes: dbStats.size
      },
      sla: {
        expectedCyclesLast24h: 216,
        completedCyclesLast24h: runtime.cyclesLast24h
      },
      retention: {
        daysCovered: distinctSnapshotDays.days,
        daysUntilFullWindow: Math.max(0, 60 - distinctSnapshotDays.days)
      },
      rideNames
    };
  } finally {
    database.close();
  }
}

export function getExpectedParks() {
  return PARKS.length;
}
