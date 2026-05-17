import { NextResponse } from "next/server";
import { getParkMeta } from "@/lib/db";

export function GET() {
  return NextResponse.json(getParkMeta());
}

