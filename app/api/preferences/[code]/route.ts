import { NextResponse } from "next/server";
import { getClientKey, isOverLimit } from "@/lib/request-guards";
import { getPreferenceSync, withApiTelemetry } from "@/lib/stats";

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  return withApiTelemetry("/api/preferences/[code]", "GET", async () => {
    if (isOverLimit(`preferences-read:${getClientKey(request)}`, 60)) {
      return NextResponse.json({ error: "Too many preference sync requests" }, { status: 429 });
    }

    const { code } = await params;
    const sync = getPreferenceSync(code);

    if (!sync) {
      return NextResponse.json({ error: "Sync code not found" }, { status: 404 });
    }

    return NextResponse.json(sync);
  });
}
