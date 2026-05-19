import { NextResponse } from "next/server";
import { savePreferenceSync, withApiTelemetry } from "@/lib/stats";

export async function POST(request: Request) {
  return withApiTelemetry("/api/preferences", "POST", async () => {
    const body = (await request.json().catch(() => null)) as { code?: string; payload?: unknown } | null;

    if (!body || typeof body.payload !== "object" || body.payload === null) {
      return NextResponse.json({ error: "Preference payload required" }, { status: 400 });
    }

    const code = savePreferenceSync(body.payload, body.code);
    return NextResponse.json({ code });
  });
}
