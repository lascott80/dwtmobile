import { NextResponse } from "next/server";
import { recordVisit } from "@/lib/stats";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { visitorId?: string; path?: string } | null;
  const visitorId = body?.visitorId?.trim();
  const path = body?.path?.trim() || "/";

  if (!visitorId) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  recordVisit(visitorId, path);
  return NextResponse.json({ ok: true });
}
