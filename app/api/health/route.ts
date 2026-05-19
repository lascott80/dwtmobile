import { NextResponse } from "next/server";
import { DB_PATH } from "@/lib/config";
import { withApiTelemetry } from "@/lib/stats";

export function GET() {
  return withApiTelemetry("/api/health", "GET", () => {
    return NextResponse.json({
      ok: true,
      databasePath: DB_PATH,
      now: new Date().toISOString()
    });
  });
}
