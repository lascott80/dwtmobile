import { NextResponse } from "next/server";
import { getParkMeta } from "@/lib/db";
import { withApiTelemetry } from "@/lib/stats";

export function GET() {
  return withApiTelemetry("/api/meta", "GET", () =>
    NextResponse.json(getParkMeta(), {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300"
      }
    })
  );
}
