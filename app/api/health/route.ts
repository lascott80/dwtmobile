import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { DB_PATH } from "@/lib/config";
import { withApiTelemetry } from "@/lib/stats";

export function GET() {
  return withApiTelemetry("/api/health", "GET", () => {
    const productDataAvailable = existsSync(DB_PATH);
    return NextResponse.json({
      ok: productDataAvailable,
      productDataAvailable,
      now: new Date().toISOString()
    }, {
      status: productDataAvailable ? 200 : 503,
      headers: {
        "Cache-Control": "no-store"
      }
    });
  });
}
