import { NextResponse } from "next/server";
import { DB_PATH } from "@/lib/config";

export function GET() {
  return NextResponse.json({
    ok: true,
    databasePath: DB_PATH,
    now: new Date().toISOString()
  });
}

