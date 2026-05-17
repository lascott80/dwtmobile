import { NextResponse } from "next/server";
import { getParkDetail } from "@/lib/db";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ parkSlug: string }> }
) {
  const { parkSlug } = await params;
  const data = getParkDetail(parkSlug);
  if (!data) {
    return NextResponse.json({ error: "Park not found" }, { status: 404 });
  }
  return NextResponse.json(data);
}
