import { NextResponse } from "next/server";
import { recordEvent } from "@/lib/stats";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { visitorId?: string; eventName?: string; detail?: string }
    | null;
  const visitorId = body?.visitorId?.trim();
  const eventName = body?.eventName?.trim();

  if (!visitorId || !eventName) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  recordEvent(visitorId, eventName, body?.detail?.trim() || null);
  return NextResponse.json({ ok: true });
}
