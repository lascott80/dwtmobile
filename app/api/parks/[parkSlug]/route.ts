import { NextResponse } from "next/server";
import { getParkDetail } from "@/lib/db";
import { withApiTelemetry } from "@/lib/stats";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ parkSlug: string }> }
) {
  return withApiTelemetry("/api/parks/[parkSlug]", "GET", async () => {
    const { parkSlug } = await params;
    const data = getParkDetail(parkSlug);
    if (!data) {
      return NextResponse.json({ error: "Park not found" }, { status: 404 });
    }
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300"
      }
    });
  });
}
