import { NextResponse } from "next/server";
import { getRideHistory } from "@/lib/db";
import { withApiTelemetry } from "@/lib/stats";

export async function GET(_: Request, { params }: { params: Promise<{ rideId: string }> }) {
  return withApiTelemetry("/api/rides/[rideId]/history", "GET", async () => {
    const { rideId } = await params;
    const data = getRideHistory(rideId);
    if (!data) {
      return NextResponse.json({ error: "Ride not found" }, { status: 404 });
    }
    return NextResponse.json(data);
  });
}
