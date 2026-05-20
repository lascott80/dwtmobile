import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, METRICS_DB_PATH } from "@/lib/config";

const DEFAULT_HIDDEN_RIDES_KEY = "defaultHiddenRideIds";
const GLOBAL_HIDDEN_RIDES_KEY = "globalHiddenRideIds";
const SOURCE_CONTROLS_KEY = "sourceControls";
const FEATURE_FLAGS_KEY = "featureFlags";
const HIDDEN_RIDE_NAMES = [
  "Maharajah Jungle Trek",
  "Beauty and the Beast Sing-Along",
  "Impressions de France",
  "Reflections of China",
  "The American Adventure"
];

export const ADMIN_SOURCES = [
  { id: "queue-times", label: "Queue-Times", detail: "Ride land grouping and fallback waits" },
  { id: "themeparks-schedule", label: "ThemeParks schedule", detail: "Park hours and operating windows" },
  { id: "themeparks-children", label: "ThemeParks children", detail: "Attractions, restaurants, and locations" },
  { id: "osm-overpass", label: "OSM Overpass", detail: "Facilities, currently disabled in collector code" }
] as const;

export const ADMIN_FEATURE_FLAGS = [
  { id: "recommendations", label: "Recommendations", detail: "Next move, good options, best bets, and prediction windows" },
  { id: "map", label: "Map mode", detail: "Attraction map and nearby mode" },
  { id: "weather", label: "Weather", detail: "Weather-aware decision hints" }
] as const;

export type AdminFeatureFlag = (typeof ADMIN_FEATURE_FLAGS)[number]["id"];
export type AdminFeatureFlags = Record<AdminFeatureFlag, boolean>;
export type SourceControls = {
  disabledSourceIds: string[];
};

export type AdminActivity = {
  id: number;
  action: string;
  detail: string;
  createdAt: string;
};

export type CollectorStatus = {
  lastCycle: {
    startedAt: string;
    finishedAt: string;
    durationSeconds: number;
    successCount: number;
    failureCount: number;
  } | null;
  parks: Array<{
    slug: string;
    shortName: string;
    lastPolledAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  }>;
};

export type AdminRide = {
  id: string;
  name: string;
  parkSlug: string;
  parkName: string;
  areaName: string;
};

function connectSettings() {
  mkdirSync(dirname(METRICS_DB_PATH), { recursive: true });
  const database = new DatabaseSync(METRICS_DB_PATH);
  database.exec(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_activity_created
      ON admin_activity (created_at);
  `);
  return database;
}

function readSetting(database: DatabaseSync, key: string) {
  const row = database
    .prepare("SELECT value FROM admin_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(database: DatabaseSync, key: string, value: unknown) {
  database
    .prepare(
      `
        INSERT INTO admin_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}

export function recordAdminActivity(action: string, detail: string) {
  const database = connectSettings();
  try {
    insertAdminActivity(database, action, detail);
  } finally {
    database.close();
  }
}

function insertAdminActivity(database: DatabaseSync, action: string, detail: string) {
  database
    .prepare("INSERT INTO admin_activity (action, detail, created_at) VALUES (?, ?, ?)")
    .run(action, detail, new Date().toISOString());
}

export function getAdminActivity(limit = 8) {
  const database = connectSettings();
  try {
    return database
      .prepare(
        `
          SELECT id, action, detail, created_at AS createdAt
          FROM admin_activity
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?
        `
      )
      .all(limit) as AdminActivity[];
  } finally {
    database.close();
  }
}

function parseRideIds(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseDisabledSourceIds(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Partial<SourceControls>;
    if (!Array.isArray(parsed.disabledSourceIds)) return [];
    const knownSourceIds = new Set(ADMIN_SOURCES.map((source) => source.id));
    return parsed.disabledSourceIds.filter((sourceId): sourceId is string => knownSourceIds.has(sourceId as never));
  } catch {
    return [];
  }
}

function parseFeatureFlags(value: string | null | undefined): AdminFeatureFlags {
  const defaults = Object.fromEntries(ADMIN_FEATURE_FLAGS.map((flag) => [flag.id, true])) as AdminFeatureFlags;
  if (!value) return defaults;
  try {
    const parsed = JSON.parse(value) as Partial<AdminFeatureFlags>;
    return Object.fromEntries(
      ADMIN_FEATURE_FLAGS.map((flag) => [flag.id, typeof parsed[flag.id] === "boolean" ? parsed[flag.id] : true])
    ) as AdminFeatureFlags;
  } catch {
    return defaults;
  }
}

export function getDefaultHiddenRideIds() {
  const database = connectSettings();
  try {
    return parseRideIds(readSetting(database, DEFAULT_HIDDEN_RIDES_KEY));
  } finally {
    database.close();
  }
}

export function saveDefaultHiddenRideIds(rideIds: string[]) {
  saveRideIds(DEFAULT_HIDDEN_RIDES_KEY, rideIds);
  recordAdminActivity("Ride defaults", `${rideIds.length} ride(s) hidden by default`);
}

function saveRideIds(key: string, rideIds: string[]) {
  const uniqueRideIds = Array.from(new Set(rideIds.filter(Boolean))).sort();
  const database = connectSettings();
  try {
    writeSetting(database, key, uniqueRideIds);
  } finally {
    database.close();
  }
}

export function getGlobalHiddenRideIds() {
  const database = connectSettings();
  try {
    return parseRideIds(readSetting(database, GLOBAL_HIDDEN_RIDES_KEY));
  } finally {
    database.close();
  }
}

export function saveGlobalHiddenRideIds(rideIds: string[]) {
  saveRideIds(GLOBAL_HIDDEN_RIDES_KEY, rideIds);
  recordAdminActivity("Global hard hide", `${rideIds.length} ride(s) removed for everyone`);
}

export function getSourceControls(): SourceControls {
  const database = connectSettings();
  try {
    return { disabledSourceIds: parseDisabledSourceIds(readSetting(database, SOURCE_CONTROLS_KEY)) };
  } finally {
    database.close();
  }
}

export function saveSourceControls(disabledSourceIds: string[]) {
  const knownSourceIds = new Set(ADMIN_SOURCES.map((source) => source.id));
  const database = connectSettings();
  try {
    writeSetting(database, SOURCE_CONTROLS_KEY, {
      disabledSourceIds: Array.from(new Set(disabledSourceIds.filter((sourceId) => knownSourceIds.has(sourceId as never)))).sort()
    });
    insertAdminActivity(database, "Source toggles", `${disabledSourceIds.length} source(s) paused`);
  } finally {
    database.close();
  }
}

export function getFeatureFlags() {
  const database = connectSettings();
  try {
    return parseFeatureFlags(readSetting(database, FEATURE_FLAGS_KEY));
  } finally {
    database.close();
  }
}

export function saveFeatureFlags(flags: Partial<AdminFeatureFlags>) {
  const current = getFeatureFlags();
  const next = Object.fromEntries(
    ADMIN_FEATURE_FLAGS.map((flag) => [flag.id, typeof flags[flag.id] === "boolean" ? flags[flag.id] : current[flag.id]])
  ) as AdminFeatureFlags;
  const database = connectSettings();
  try {
    writeSetting(database, FEATURE_FLAGS_KEY, next);
    const disabledFlags = ADMIN_FEATURE_FLAGS.filter((flag) => !next[flag.id]).map((flag) => flag.label);
    insertAdminActivity(database, "Feature flags", disabledFlags.length ? `Disabled ${disabledFlags.join(", ")}` : "All features enabled");
  } finally {
    database.close();
  }
}

export function saveRideVisibility(defaultHiddenRideIds: string[], globalHiddenRideIds: string[]) {
  saveRideIds(DEFAULT_HIDDEN_RIDES_KEY, defaultHiddenRideIds);
  saveRideIds(GLOBAL_HIDDEN_RIDES_KEY, globalHiddenRideIds);
  recordAdminActivity(
    "Ride visibility",
    `${defaultHiddenRideIds.length} default hidden, ${globalHiddenRideIds.length} hard hidden`
  );
}

export function getAdminRideCatalog() {
  try {
    statSync(DB_PATH);
  } catch {
    return [];
  }

  const database = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  try {
    return database
      .prepare(
        `
          SELECT
            a.id,
            a.name,
            a.park_slug AS parkSlug,
            p.short_name AS parkName,
            COALESCE(a.area_name, 'Other Experiences') AS areaName
          FROM attractions a
          JOIN parks p ON p.slug = a.park_slug
          WHERE a.category = 'ride'
            AND a.name NOT IN (${HIDDEN_RIDE_NAMES.map(() => "?").join(", ")})
          ORDER BY p.short_name, COALESCE(a.area_sort, 999), a.name
        `
      )
      .all(...HIDDEN_RIDE_NAMES) as AdminRide[];
  } finally {
    database.close();
  }
}

export function getCollectorStatus(): CollectorStatus {
  try {
    statSync(DB_PATH);
  } catch {
    return { lastCycle: null, parks: [] };
  }

  const database = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  try {
    const lastCycle = database
      .prepare(
        `
          SELECT
            started_at AS startedAt,
            finished_at AS finishedAt,
            duration_seconds AS durationSeconds,
            success_count AS successCount,
            failure_count AS failureCount
          FROM poll_cycles
          ORDER BY datetime(started_at) DESC
          LIMIT 1
        `
      )
      .get() as CollectorStatus["lastCycle"] | undefined;
    const parks = database
      .prepare(
        `
          SELECT
            p.slug,
            p.short_name AS shortName,
            r.last_polled_at AS lastPolledAt,
            r.last_success_at AS lastSuccessAt,
            r.last_error AS lastError
          FROM parks p
          LEFT JOIN refresh_state r ON r.park_slug = p.slug
          ORDER BY p.short_name
        `
      )
      .all() as CollectorStatus["parks"];
    return {
      lastCycle: lastCycle ?? null,
      parks
    };
  } finally {
    database.close();
  }
}
