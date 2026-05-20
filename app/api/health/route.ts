import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";
import { DB_PATH } from "@/lib/config";
import { withApiTelemetry } from "@/lib/stats";

const FRESHNESS_SLA_MS = 25 * 60 * 1000;

export function GET() {
  return withApiTelemetry("/api/health", "GET", () => {
    const productDataAvailable = existsSync(DB_PATH);
    if (!productDataAvailable) {
      return NextResponse.json({
        ok: false,
        productDataAvailable,
        staleParkCount: null,
        oldestSuccessAt: null,
        newestSuccessAt: null,
        lastPoll: null,
        now: new Date().toISOString()
      }, {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      });
    }

    try {
      const database = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
      const parks = database
        .prepare(
          `
            SELECT park_slug AS parkSlug, last_success_at AS lastSuccessAt, last_error AS lastError
            FROM refresh_state
          `
        )
        .all() as Array<{ parkSlug: string; lastSuccessAt: string | null; lastError: string | null }>;
      const lastPoll = database
        .prepare(
          `
            SELECT started_at AS startedAt, finished_at AS finishedAt, success_count AS successCount, failure_count AS failureCount
            FROM poll_cycles
            ORDER BY datetime(started_at) DESC
            LIMIT 1
          `
        )
        .get() as
        | { startedAt: string; finishedAt: string; successCount: number; failureCount: number }
        | undefined;
      database.close();

      const now = Date.now();
      const staleParks = parks.filter(
        (park) => !park.lastSuccessAt || now - new Date(park.lastSuccessAt).getTime() > FRESHNESS_SLA_MS
      );
      const successTimes = parks
        .map((park) => park.lastSuccessAt)
        .filter((value): value is string => Boolean(value))
        .sort();
      const ok = parks.length > 0 && staleParks.length === 0 && Boolean(lastPoll);

      return NextResponse.json({
        ok,
        productDataAvailable,
        freshnessSlaMinutes: FRESHNESS_SLA_MS / 60_000,
        staleParkCount: staleParks.length,
        staleParks,
        oldestSuccessAt: successTimes[0] ?? null,
        newestSuccessAt: successTimes.at(-1) ?? null,
        lastPoll: lastPoll ?? null,
        now: new Date().toISOString()
      }, {
        status: ok ? 200 : 503,
        headers: {
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      return NextResponse.json({
        ok: false,
        productDataAvailable,
        error: error instanceof Error ? error.message : "Health check failed",
        now: new Date().toISOString()
      }, {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      });
    }
  });
}
