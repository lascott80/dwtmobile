import { NextResponse } from "next/server";
import { MAX_ANALYTICS_DETAIL_LENGTH } from "@/lib/config";
import { getClientKey, isBodyTooLarge, isOverLimit } from "@/lib/request-guards";
import { recordVisit, withApiTelemetry } from "@/lib/stats";

export async function POST(request: Request) {
  return withApiTelemetry("/api/visit", "POST", async () => {
    if (isBodyTooLarge(request, 2_048)) {
      return NextResponse.json({ ok: false }, { status: 413 });
    }
    if (isOverLimit(`visit:${getClientKey(request)}`, 90)) {
      return NextResponse.json({ ok: false }, { status: 429 });
    }

    const body = (await request.json().catch(() => null)) as { visitorId?: string; path?: string } | null;
    const visitorId = body?.visitorId?.trim().slice(0, MAX_ANALYTICS_DETAIL_LENGTH);
    const path = body?.path?.trim().slice(0, MAX_ANALYTICS_DETAIL_LENGTH) || "/";

    if (!visitorId) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    recordVisit(visitorId, path);
    return NextResponse.json({ ok: true });
  });
}
