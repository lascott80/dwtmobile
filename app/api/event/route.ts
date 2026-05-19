import { NextResponse } from "next/server";
import { MAX_ANALYTICS_DETAIL_LENGTH, MAX_ANALYTICS_NAME_LENGTH } from "@/lib/config";
import { getClientKey, isBodyTooLarge, isOverLimit } from "@/lib/request-guards";
import { recordEvent, withApiTelemetry } from "@/lib/stats";

export async function POST(request: Request) {
  return withApiTelemetry("/api/event", "POST", async () => {
    if (isBodyTooLarge(request, 4_096)) {
      return NextResponse.json({ ok: false }, { status: 413 });
    }
    if (isOverLimit(`event:${getClientKey(request)}`, 120)) {
      return NextResponse.json({ ok: false }, { status: 429 });
    }

    const body = (await request.json().catch(() => null)) as
      | { visitorId?: string; eventName?: string; detail?: string }
      | null;
    const visitorId = body?.visitorId?.trim().slice(0, MAX_ANALYTICS_DETAIL_LENGTH);
    const eventName = body?.eventName?.trim().slice(0, MAX_ANALYTICS_NAME_LENGTH);
    const detail = body?.detail?.trim().slice(0, MAX_ANALYTICS_DETAIL_LENGTH) || null;

    if (!visitorId || !eventName) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    recordEvent(visitorId, eventName, detail);
    return NextResponse.json({ ok: true });
  });
}
