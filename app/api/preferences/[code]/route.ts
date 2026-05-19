import { NextResponse } from "next/server";
import { getPreferenceSync } from "@/lib/stats";

export async function GET(_: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const sync = getPreferenceSync(code);

  if (!sync) {
    return NextResponse.json({ error: "Sync code not found" }, { status: 404 });
  }

  return NextResponse.json(sync);
}
