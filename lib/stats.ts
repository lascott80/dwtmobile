import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, PARKS } from "@/lib/config";

const METRICS_DB_PATH = join(dirname(DB_PATH), "app_metrics.db");
const HIDDEN_RIDE_NAMES = [
  "Maharajah Jungle Trek",
  "Beauty and the Beast Sing-Along",
  "Impressions de France",
  "Reflections of China",
  "The American Adventure"
];

let metricsDb: DatabaseSync | null = null;

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
    `);
  }
  return metricsDb;
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
  connectMetrics()
    .prepare("INSERT INTO visits (visitor_id, path, visited_at) VALUES (?, ?, ?)")
    .run(visitorId, path, new Date().toISOString());
}

export function recordEvent(visitorId: string, eventName: string, detail: string | null) {
  connectMetrics()
    .prepare("INSERT INTO events (visitor_id, event_name, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(visitorId, eventName, detail, new Date().toISOString());
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
      .all() as Array<{ rideId: string; toggles: number }>
  };
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
      pollingTimeline,
      dataGrowth,
      freshnessHeatmap,
      topMovers,
      coverageQuality,
      ridesMissingLandMetadata,
      runtime,
      anomalies: {
        flatlineRides,
        attractionCoverageDrops
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
