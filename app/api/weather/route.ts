import { NextResponse } from "next/server";
import { PARK_BY_SLUG } from "@/lib/config";
import { withApiTelemetry } from "@/lib/stats";

export async function GET(request: Request) {
  return withApiTelemetry("/api/weather", "GET", async () => {
    const slug = new URL(request.url).searchParams.get("parkSlug") ?? "magic-kingdom";
    const park = PARK_BY_SLUG[slug];
    if (!park) return NextResponse.json({ error: "Park not found" }, { status: 404 });

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(park.latitude));
    url.searchParams.set("longitude", String(park.longitude));
    url.searchParams.set("current", "temperature_2m,precipitation,weather_code");
    url.searchParams.set("hourly", "precipitation_probability,precipitation");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("timezone", "America/New_York");

    const response = await fetch(url, { next: { revalidate: 900 } });
    if (!response.ok) return NextResponse.json({ error: "Weather unavailable" }, { status: 502 });
    const data = await response.json();
    return NextResponse.json(data);
  });
}
