import { NextResponse } from "next/server";
import { MAX_PREFERENCE_PAYLOAD_BYTES } from "@/lib/config";
import { getClientKey, isBodyTooLarge, isOverLimit, jsonByteLength } from "@/lib/request-guards";
import { savePreferenceSync, withApiTelemetry } from "@/lib/stats";

export async function POST(request: Request) {
  return withApiTelemetry("/api/preferences", "POST", async () => {
    if (isBodyTooLarge(request, MAX_PREFERENCE_PAYLOAD_BYTES + 1_024)) {
      return NextResponse.json({ error: "Preference payload too large" }, { status: 413 });
    }
    if (isOverLimit(`preferences:${getClientKey(request)}`, 20)) {
      return NextResponse.json({ error: "Too many preference sync requests" }, { status: 429 });
    }

    const body = (await request.json().catch(() => null)) as { code?: string; payload?: unknown } | null;

    if (!body || typeof body.payload !== "object" || body.payload === null) {
      return NextResponse.json({ error: "Preference payload required" }, { status: 400 });
    }
    if (jsonByteLength(body.payload) > MAX_PREFERENCE_PAYLOAD_BYTES) {
      return NextResponse.json({ error: "Preference payload too large" }, { status: 413 });
    }

    const code = savePreferenceSync(body.payload, body.code);
    return NextResponse.json({ code });
  });
}
