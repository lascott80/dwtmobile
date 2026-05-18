import { NextResponse } from "next/server";
import { getRideHistory } from "@/lib/db";

export async function GET(_: Request, { params }: { params: Promise<{ rideId: string }> }) {
  const { rideId } = await params;
  const data = getRideHistory(rideId);
  if (!data) {
    return NextResponse.json({ error: "Ride not found" }, { status: 404 });
  }
  return NextResponse.json(data);
}
