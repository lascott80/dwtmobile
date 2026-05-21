"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock3,
  EyeOff,
  Filter,
  ListFilter,
  MapPinned,
  Navigation,
  Sparkles,
  Star,
  Ticket,
  UsersRound
} from "lucide-react";
import type {
  CrowdPulse,
  LandGroup,
  ParkDetailResponse,
  ParkMetaResponse,
  RideHistoryBaselinePoint,
  RideHistoryOperatingWindow,
  RideHistoryPoint,
  RideHistoryResponse,
  RideItem,
  ShowTimeItem
} from "@/lib/types";
import { VISITOR_KEY } from "@/components/visit-tracker";

const FAVORITES_KEY = "dwtmobile:favorites";
const PARK_CACHE_KEY = "dwtmobile:park-cache";
const ALERTS_KEY = "dwtmobile:alerts";
const ONBOARDING_KEY = "dwtmobile:onboarding-dismissed";
const DAY_STATE_KEY = "dwtmobile:day-state";
const SNIPES_KEY = "dwtmobile:snipes";
const PARTY_KEY = "dwtmobile:party-day";
const PLAN_ITEMS_KEY = "dwtmobile:plan-items";
const PUSH_ALERTS_KEY = "dwtmobile:push-alerts-enabled";
const NO_GO_KEY = "dwtmobile:no-go-rides";
const PREFERENCE_PROFILE_KEY = "dwtmobile:preference-profile";
const TRIP_MEMORY_KEY = "dwtmobile:trip-memory";
const SYNC_CODE_KEY = "dwtmobile:sync-code";
const API_FETCH_TIMEOUT_MS = 10_000;
const NON_RECOMMENDED_RIDE_NAMES = new Set([
  "A Pirate's Adventure ~ Treasures of the Seven Seas",
  "Swiss Family Treehouse",
  "Cinderella Castle",
  "Vacation Fun - An Original Animated Short with Mickey & Minnie"
]);
type RideSort = "land" | "wait-desc" | "wait-asc" | "alpha" | "favorites";
type DashboardMode = "today" | "map" | "my-day" | "rides";
type PreferenceProfile = "balanced" | "low-stress" | "max-rides" | "shows-snacks" | "kids" | "adults" | "headliners-done";
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type WeatherResponse = {
  current?: { temperature_2m?: number; precipitation?: number; weather_code?: number };
  hourly?: { time?: string[]; precipitation_probability?: number[]; precipitation?: number[] };
};
type RidePrediction = ReturnType<typeof predictionForRide>;
type SignalTag = { label: string; tone: "good" | "watch" | "alert" | "info" };
type SmartMove =
  | { key: string; label: string; title: string; detail: string; ride: RideItem; tone: "ride" | "land" }
  | { key: string; label: string; title: string; detail: string; show: ShowTimeItem; tone: "show" | "character" };
type PartyDay = { name: string; sharedAt: string };
type PlanItem = {
  id: string;
  rideId: string | null;
  name: string;
  type: "lightning-lane" | "virtual-queue" | "reservation";
  startTime: string;
  endTime?: string | null;
};
type TripMemory = {
  completedRideIds: Record<string, number>;
  skippedRideIds: Record<string, number>;
  parksVisited: Record<string, number>;
  lastVisitAt: string | null;
};
type PreferenceSyncPayload = {
  favorites: string[];
  alertThresholds: Record<string, number>;
  dayState: Record<string, "must-do" | "done" | "skip">;
  snipes: Array<{ id: string; rideId: string; name: string; message: string; createdAt: string }>;
  partyDay: PartyDay | null;
  planItems: PlanItem[];
  noGoRideIds: string[];
  preferenceProfile: PreferenceProfile;
  tripMemory: TripMemory;
  savedAt: string;
};

const PROFILE_LABELS: Record<PreferenceProfile, string> = {
  balanced: "Balanced",
  "low-stress": "Low-stress",
  "max-rides": "Max rides",
  "shows-snacks": "Shows/snacks",
  kids: "Kids trip",
  adults: "Adults-only",
  "headliners-done": "Headliners done"
};

const DEFAULT_TRIP_MEMORY: TripMemory = {
  completedRideIds: {},
  skippedRideIds: {},
  parksVisited: {},
  lastVisitAt: null
};

function pinFavoritesFirst(rides: RideItem[], favorites: string[]) {
  const favoriteSet = new Set(favorites);
  return [...rides].sort((a, b) => {
    const favoriteDiff = Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id));
    if (favoriteDiff !== 0) return favoriteDiff;
    return a.name.localeCompare(b.name);
  });
}

function statusLabel(ride: RideItem) {
  if (ride.isOpen) {
    return ride.status;
  }

  switch (ride.status) {
    case "DOWN":
      return "DOWN";
    case "REFURBISHMENT":
      return "REFURB";
    case "CLOSED":
      return "CLOSED";
    default:
      return "TEMP CLOSED";
  }
}

function minutesLabel(waitTime: number | null, isOpen: boolean) {
  if (!isOpen) {
    return null;
  }
  if (waitTime === null || Number.isNaN(waitTime)) {
    return "No wait";
  }
  if (waitTime === 0) {
    return "Walk on";
  }
  return `${waitTime} min`;
}

function waitTone(ride: RideItem) {
  if (!ride.isOpen) {
    return ride.status === "DOWN" ? "tone-high" : "tone-closed";
  }
  const waitTime = ride.waitTime;
  if (waitTime === null) return "tone-muted";
  if (waitTime <= 15) return "tone-low";
  if (waitTime <= 35) return "tone-mid";
  return "tone-high";
}

function waitCue(ride: RideItem) {
  if (!ride.isOpen) return "×";
  if (ride.waitTime === null) return "•";
  if (ride.waitTime <= 15) return "↓";
  if (ride.waitTime <= 35) return "–";
  return "↑";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatHourRange(openingTime: string, closingTime: string) {
  return `${formatTime(openingTime)} - ${formatTime(closingTime)}`;
}

function formatRelative(value: string | null) {
  if (!value) return "No successful sync yet";
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatFreshness(value: string | null) {
  if (!value) return "No sync yet";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return formatRelative(value);
}

function timeInputValue(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function localTimeToday(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  const date = new Date();
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date.toISOString();
}

function trendLabel(trendMinutes: number | null) {
  if (trendMinutes === null || trendMinutes === 0) {
    return null;
  }
  const prefix = trendMinutes > 0 ? "+" : "";
  return `${prefix}${trendMinutes} vs 1 hr`;
}

function forecastLabel(ride: RideItem) {
  if (!ride.isOpen || ride.waitTime === null || ride.forecastWaitTime === null) return null;
  if (ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes >= 10) {
    return `Likely climbs toward ${ride.forecastWaitTime} min`;
  }
  if (ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes <= -10) {
    return `Likely eases toward ${ride.forecastWaitTime} min`;
  }
  const range =
    ride.forecastLowWaitTime !== null &&
    ride.forecastHighWaitTime !== null &&
    ride.forecastHighWaitTime - ride.forecastLowWaitTime >= 10
      ? `${ride.forecastLowWaitTime}-${ride.forecastHighWaitTime} min`
      : `${ride.forecastWaitTime} min`;
  return `Likely holds near ${range}`;
}

function forecastTone(ride: RideItem) {
  if (ride.forecastTrendMinutes === null) return "steady";
  if (ride.forecastTrendMinutes >= 10) return "rising";
  if (ride.forecastTrendMinutes <= -10) return "falling";
  return "steady";
}

function dropLabel(ride: RideItem) {
  if (!ride.isOpen || ride.waitTime === null) return null;
  if (ride.dropMinutes !== null) return `Dropped ${ride.dropMinutes} min in the last hour`;
  if (ride.waitTime !== null && ride.normalWaitTime !== null && ride.normalWaitTime - ride.waitTime >= 15) {
    return `${ride.normalWaitTime - ride.waitTime} min below baseline`;
  }
  return null;
}

function signalTagsForRide(ride: RideItem, limit = 4): SignalTag[] {
  const tags: SignalTag[] = [];
  if (ride.waitTime !== null && ride.isOpen && ride.waitTime <= 20) {
    tags.push({ label: "Short wait", tone: "good" });
  }
  if (ride.dropMinutes !== null) {
    tags.push({ label: `Dropped ${ride.dropMinutes}m`, tone: "alert" });
  }
  if (ride.waitTime !== null && ride.normalWaitTime !== null && ride.normalWaitTime - ride.waitTime >= 10) {
    tags.push({ label: `${ride.normalWaitTime - ride.waitTime}m below baseline`, tone: "good" });
  }
  if (ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes >= 10) {
    tags.push({ label: "Forecast rising", tone: "watch" });
  }
  if (ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes <= -10) {
    tags.push({ label: "May ease soon", tone: "info" });
  }
  return tags.slice(0, limit);
}

function SignalTags({ tags }: { tags: SignalTag[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="signal-tags">
      {tags.map((tag) => (
        <span className={`signal-tag signal-${tag.tone}`} key={`${tag.tone}-${tag.label}`}>{tag.label}</span>
      ))}
    </div>
  );
}

function momentumScoreLabel(score: number) {
  return `${score}/10`;
}

function momentumDetailLabel(momentum: CrowdPulse["momentum"]) {
  if (momentum.direction === "learning") return "Learning";
  return `${momentum.improvingCount} easing, ${momentum.worseningCount} rising`;
}

function CrowdLevelMeter({ score }: { score: number }) {
  const normalized = Math.max(1, Math.min(10, score));
  return (
    <div className={`crowd-meter momentum-score-${normalized}`} aria-label={`Crowd Level ${normalized} out of 10`}>
      <div>
        <span>Crowd Level</span>
        <strong>{normalized}/10</strong>
      </div>
      <ol aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => (
          <li className={index < normalized ? "active" : ""} key={index} />
        ))}
      </ol>
    </div>
  );
}

function fallbackCrowdPulse() {
  return {
    level: "building" as const,
    headline: "Building baseline",
    detail: "Not enough live ride data yet to read the park pulse.",
    averageWaitTime: null,
    deltaFromNormal: null,
    sampleSize: 0,
    momentum: {
      direction: "learning" as const,
      score: 5,
      headline: "Momentum building",
      detail: "Need a few more trend samples to read park movement.",
      improvingCount: 0,
      worseningCount: 0,
      dropCount: 0
    }
  };
}

function normalizeParkData(park: Partial<ParkDetailResponse>): ParkDetailResponse {
  const crowdPulse = park.crowdPulse ?? fallbackCrowdPulse();
  return {
    park: park.park ?? {
      slug: "unknown",
      name: "Unknown park",
      shortName: "Unknown",
      summary: "Hours unavailable"
    },
    status: park.status ?? {
      hasData: false,
      stale: true,
      lastSuccessAt: null,
      lastError: null
    },
    hours: park.hours ?? [],
    featuredShows: park.featuredShows ?? [],
    meetGreets: park.meetGreets ?? [],
    crowdPulse: {
      ...crowdPulse,
      momentum: {
        ...fallbackCrowdPulse().momentum,
        ...(crowdPulse.momentum ?? {}),
        score: crowdPulse.momentum?.score ?? fallbackCrowdPulse().momentum.score
      }
    },
    restaurants: park.restaurants ?? [],
    facilities: park.facilities ?? [],
    lands: (park.lands ?? []).map((land) => ({
      ...land,
      rides: land.rides.map((ride) => ({
        ...ride,
        forecastWaitTime: ride.forecastWaitTime ?? null,
        forecastLowWaitTime: ride.forecastLowWaitTime ?? null,
        forecastHighWaitTime: ride.forecastHighWaitTime ?? null,
        forecastSampleSize: ride.forecastSampleSize ?? 0,
        forecastTrendMinutes: ride.forecastTrendMinutes ?? null,
        dropMinutes: ride.dropMinutes ?? null
      }))
    }))
  };
}

function normalizeParkMeta(meta: ParkMetaResponse): ParkMetaResponse {
  return {
    ...meta,
    defaultHiddenRideIds: Array.isArray(meta.defaultHiddenRideIds) ? meta.defaultHiddenRideIds : [],
    featureFlags: {
      recommendations: meta.featureFlags?.recommendations !== false,
      map: meta.featureFlags?.map !== false,
      weather: meta.featureFlags?.weather !== false
    }
  };
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = API_FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isParkMetaResponse(value: unknown): value is ParkMetaResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as ParkMetaResponse).parks) &&
      typeof (value as ParkMetaResponse).generatedAt === "string"
  );
}

function isParkDetailResponse(value: unknown): value is ParkDetailResponse {
  const maybePark = value as Partial<ParkDetailResponse> | null;
  return Boolean(
    maybePark &&
      typeof maybePark === "object" &&
      maybePark.park &&
      typeof maybePark.park.slug === "string" &&
      maybePark.status &&
      Array.isArray(maybePark.lands)
  );
}

function comparedWithNormalLabel(ride: RideItem) {
  if (ride.waitTime === null || ride.normalWaitTime === null) {
    return null;
  }
  const delta = ride.waitTime - ride.normalWaitTime;
  if (Math.abs(delta) < 5) {
    return `Near normal (${ride.normalWaitTime} min)`;
  }
  return `${Math.abs(delta)} min ${delta < 0 ? "below" : "above"} normal`;
}

function compactNormalLabel(ride: RideItem) {
  if (ride.waitTime === null || ride.normalWaitTime === null) return null;
  const delta = ride.waitTime - ride.normalWaitTime;
  if (Math.abs(delta) < 5) return "near normal";
  return `${Math.abs(delta)}m ${delta < 0 ? "under" : "over"} usual`;
}

function predictionForRide(ride: RideItem, points: RideHistoryPoint[] = []) {
  if (!ride.isOpen) {
    return { headline: "Closed", detail: statusLabel(ride), tone: "closed" };
  }
  if (ride.waitTime === null) {
    return { headline: "Watch", detail: "No posted wait yet. Wait for a fresh update before walking over.", tone: "watch" };
  }

  const usable = points.filter((point) => point.waitTime !== null);
  const recentLow = usable.length ? Math.min(...usable.slice(-8).map((point) => point.waitTime as number)) : null;
  const normalDelta = ride.normalWaitTime === null ? 0 : ride.waitTime - ride.normalWaitTime;
  const trend = ride.trendMinutes ?? 0;

  if (ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes >= 10 && ride.waitTime <= 35) {
    return {
      headline: "Go before it climbs",
      detail: `Next 2 hours look closer to ${ride.forecastWaitTime} min.`,
      tone: "now"
    };
  }

  if (normalDelta <= -10 || trend <= -10 || (recentLow !== null && ride.waitTime <= recentLow + 5)) {
    return {
      headline: "Go now",
      detail: ride.normalWaitTime === null ? `${ride.waitTime} min and trending favorably.` : `${Math.abs(normalDelta)} min below its usual wait.`,
      tone: "now"
    };
  }

  if (ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes <= -10) {
    return {
      headline: "Wait it out",
      detail: `History suggests it may ease toward ${ride.forecastWaitTime} min in the next 2 hours.`,
      tone: "later"
    };
  }

  if (normalDelta >= 10 || trend >= 10) {
    return {
      headline: "Later",
      detail: trend > 0 ? `Up ${trend} min vs an hour ago. Recheck after the rush moves.` : `${normalDelta} min above normal right now.`,
      tone: "later"
    };
  }

  if (ride.waitTime <= 20) {
    return { headline: "Go now", detail: `${ride.waitTime} min is still an easy fit.`, tone: "now" };
  }

  return { headline: "Watch", detail: "No strong signal yet. Save an alert if this is a must-do.", tone: "watch" };
}

function recommendationClass(prediction: RidePrediction) {
  return `recommendation-chip recommendation-${prediction.tone}`;
}

function parkThemeClass(slug: string) {
  if (slug.includes("epcot")) return "park-theme-epcot";
  if (slug.includes("hollywood")) return "park-theme-hollywood";
  if (slug.includes("animal")) return "park-theme-animal";
  return "park-theme-magic";
}

function modeIcon(mode: DashboardMode) {
  if (mode === "today") return <Sparkles size={14} strokeWidth={2.4} />;
  if (mode === "map") return <MapPinned size={14} strokeWidth={2.4} />;
  if (mode === "my-day") return <CheckCircle2 size={14} strokeWidth={2.4} />;
  return <ListFilter size={14} strokeWidth={2.4} />;
}

function rideVisualClass(ride: RideItem, prediction: RidePrediction) {
  const tone = waitTone(ride).replace("tone-", "");
  const recommendation = prediction.tone;
  return `ride-tone-${tone} ride-rec-${recommendation}`;
}

function isLikelyHeadliner(name: string) {
  return [
    "seven dwarfs",
    "tron",
    "space mountain",
    "big thunder",
    "tiana",
    "guardians",
    "ratatouille",
    "frozen ever after",
    "rise of the resistance",
    "slinky dog",
    "flight of passage",
    "everest"
  ].some((keyword) => name.toLowerCase().includes(keyword));
}

function isKidFriendlyName(name: string) {
  return [
    "dumbo",
    "small world",
    "winnie the pooh",
    "barnstormer",
    "little mermaid",
    "buzz lightyear",
    "peoplemover",
    "laugh floor",
    "carousel",
    "philharmagic",
    "mad tea party"
  ].some((keyword) => name.toLowerCase().includes(keyword));
}

function isRecommendableRide(ride: RideItem, noGoRideIds: string[] = []) {
  return !NON_RECOMMENDED_RIDE_NAMES.has(ride.name) && !noGoRideIds.includes(ride.id);
}

function profileScoreAdjustment(ride: RideItem, profile: PreferenceProfile) {
  if (profile === "max-rides") return (ride.waitTime ?? 999) <= 15 ? 14 : 0;
  if (profile === "low-stress") return (ride.waitTime ?? 999) <= 25 && !isLikelyHeadliner(ride.name) ? 12 : -4;
  if (profile === "shows-snacks") return isLikelyIndoor(ride.name) ? 8 : -6;
  if (profile === "kids") return isKidFriendlyName(ride.name) ? 16 : isLikelyHeadliner(ride.name) ? -10 : 0;
  if (profile === "adults") return isLikelyHeadliner(ride.name) || isLikelyIndoor(ride.name) ? 8 : 0;
  if (profile === "headliners-done") return isLikelyHeadliner(ride.name) ? -18 : 8;
  return 0;
}

function planItemTypeLabel(type: PlanItem["type"]) {
  if (type === "lightning-lane") return "Lightning Lane";
  if (type === "virtual-queue") return "Virtual queue";
  return "Reservation";
}

function formatPlanItemTime(item: PlanItem) {
  return `${planItemTypeLabel(item.type)} · ${formatTime(item.startTime)}${item.endTime ? `-${formatTime(item.endTime)}` : ""}`;
}

function meetGreetDetail(show: ShowTimeItem) {
  const time = formatHourRange(show.startTime, show.endTime ?? show.startTime);
  if (typeof show.waitTime === "number") return `${time} · ${show.waitTime === 0 ? "Walk on" : `${show.waitTime} min`}`;
  if (show.isOpen === false || show.status === "CLOSED") return `${time} · Closed`;
  return time;
}

function meetGreetWaitLabel(show: ShowTimeItem) {
  if (typeof show.waitTime === "number") return show.waitTime === 0 ? "Walk on" : `${show.waitTime} min`;
  if (show.isOpen === false || show.status === "CLOSED") return "Closed";
  return null;
}

function LoadingDashboard() {
  return (
    <section className="panel skeleton-panel" aria-label="Loading park dashboard">
      <div className="skeleton-line skeleton-title" />
      <div className="skeleton-grid">
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </div>
      <div className="skeleton-hero" />
      <div className="skeleton-list">
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </div>
    </section>
  );
}

function rangesOverlap(first: PlanItem, second: PlanItem) {
  const firstStart = new Date(first.startTime).getTime();
  const firstEnd = new Date(first.endTime ?? first.startTime).getTime() + (first.endTime ? 0 : 30 * 60 * 1000);
  const secondStart = new Date(second.startTime).getTime();
  const secondEnd = new Date(second.endTime ?? second.startTime).getTime() + (second.endTime ? 0 : 30 * 60 * 1000);
  return firstStart < secondEnd && secondStart < firstEnd;
}

function encodePartyPayload(payload: { party: PartyDay; favorites: string[]; dayState: Record<string, "must-do" | "done" | "skip">; planItems: PlanItem[] }) {
  return btoa(encodeURIComponent(JSON.stringify(payload)));
}

function decodePartyPayload(value: string) {
  return JSON.parse(decodeURIComponent(atob(value))) as {
    party?: PartyDay;
    favorites?: string[];
    dayState?: Record<string, "must-do" | "done" | "skip">;
    planItems?: PlanItem[];
  };
}

function normalizeSyncCodeInput(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function changeLabel(ride: RideItem) {
  if (ride.isOpen && ride.previousIsOpen === false) {
    return "Just reopened";
  }
  if (!ride.isOpen && ride.previousIsOpen === true) {
    return "Just closed";
  }
  return trendLabel(ride.trendMinutes);
}

function pillVariant(ride: RideItem) {
  if (!ride.isOpen) {
    return "wait-pill-status";
  }
  if (ride.waitTime === null) {
    return "wait-pill-soft";
  }
  return "wait-pill-live";
}

function sortRideList(rides: RideItem[], sortMode: RideSort, favorites: string[]) {
  const favoriteSet = new Set(favorites);
  return [...rides].sort((a, b) => {
    if (sortMode === "favorites") {
      const favDiff = Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id));
      if (favDiff !== 0) return favDiff;
    }

    if (sortMode === "wait-desc") {
      return (b.waitTime ?? -1) - (a.waitTime ?? -1) || a.name.localeCompare(b.name);
    }

    if (sortMode === "wait-asc") {
      return (a.waitTime ?? Number.MAX_SAFE_INTEGER) - (b.waitTime ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
    }

    return a.name.localeCompare(b.name);
  });
}

export function ParkDashboard() {
  const shellRef = useRef<HTMLElement | null>(null);
  const parkTabsRef = useRef<HTMLElement | null>(null);
  const [meta, setMeta] = useState<ParkMetaResponse | null>(null);
  const [activePark, setActivePark] = useState<string>("magic-kingdom");
  const [parkData, setParkData] = useState<ParkDetailResponse | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [alertThresholds, setAlertThresholds] = useState<Record<string, number>>({});
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showHiddenRides, setShowHiddenRides] = useState(false);
  const [denseRideRows, setDenseRideRows] = useState(true);
  const [rideSort, setRideSort] = useState<RideSort>("land");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRide, setSelectedRide] = useState<RideItem | null>(null);
  const [rideHistory, setRideHistory] = useState<RideHistoryPoint[]>([]);
  const [rideHistoryBaseline, setRideHistoryBaseline] = useState<RideHistoryBaselinePoint[]>([]);
  const [rideHistoryWindow, setRideHistoryWindow] = useState<RideHistoryOperatingWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chromeElevated, setChromeElevated] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [parkMode, setParkMode] = useState<"overview" | "nearby">("overview");
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [partyFilter, setPartyFilter] = useState<"all" | "open" | "favorites" | "short">("all");
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>("today");
  const [dayState, setDayState] = useState<Record<string, "must-do" | "done" | "skip">>({});
  const [snipes, setSnipes] = useState<Array<{ id: string; rideId: string; name: string; message: string; createdAt: string }>>([]);
  const [partyDay, setPartyDay] = useState<PartyDay | null>(null);
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [pushAlertsEnabled, setPushAlertsEnabled] = useState(false);
  const [noGoRideIds, setNoGoRideIds] = useState<string[]>([]);
  const [preferenceProfile, setPreferenceProfile] = useState<PreferenceProfile>("balanced");
  const [tripMemory, setTripMemory] = useState<TripMemory>(DEFAULT_TRIP_MEMORY);
  const [syncCode, setSyncCode] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [sharingRecap, setSharingRecap] = useState(false);
  const [showWhyThis, setShowWhyThis] = useState(false);
  const previousRidesRef = useRef<Map<string, RideItem>>(new Map());
  const favoritesRef = useRef<string[]>([]);
  const alertThresholdsRef = useRef<Record<string, number>>({});
  const pushAlertsEnabledRef = useRef(false);
  const selectedRideRef = useRef<RideItem | null>(null);
  const rideSheetHistoryRef = useRef(false);

  useEffect(() => {
    favoritesRef.current = favorites;
  }, [favorites]);

  useEffect(() => {
    alertThresholdsRef.current = alertThresholds;
  }, [alertThresholds]);

  useEffect(() => {
    pushAlertsEnabledRef.current = pushAlertsEnabled;
  }, [pushAlertsEnabled]);

  useEffect(() => {
    const raw = window.localStorage.getItem(FAVORITES_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setFavorites(parsed);
      }
    } catch {
      // Ignore corrupted localStorage data.
    }
  }, []);

  useEffect(() => {
    const rawAlerts = window.localStorage.getItem(ALERTS_KEY);
    if (rawAlerts) {
      try {
        const parsed = JSON.parse(rawAlerts);
        if (parsed && typeof parsed === "object") {
          setAlertThresholds(parsed);
        }
      } catch {
        // Ignore corrupted localStorage data.
      }
    }
    const rawDayState = window.localStorage.getItem(DAY_STATE_KEY);
    if (rawDayState) {
      try {
        setDayState(JSON.parse(rawDayState));
      } catch {
        // Ignore corrupted state.
      }
    }
    const rawSnipes = window.localStorage.getItem(SNIPES_KEY);
    if (rawSnipes) {
      try {
        setSnipes(JSON.parse(rawSnipes));
      } catch {
        // Ignore corrupted state.
      }
    }
    const rawParty = window.localStorage.getItem(PARTY_KEY);
    if (rawParty) {
      try {
        setPartyDay(JSON.parse(rawParty));
      } catch {
        // Ignore corrupted state.
      }
    }
    const rawPlanItems = window.localStorage.getItem(PLAN_ITEMS_KEY);
    if (rawPlanItems) {
      try {
        setPlanItems(JSON.parse(rawPlanItems));
      } catch {
        // Ignore corrupted state.
      }
    }
    const rawNoGo = window.localStorage.getItem(NO_GO_KEY);
    if (rawNoGo) {
      try {
        const parsed = JSON.parse(rawNoGo);
        if (Array.isArray(parsed)) setNoGoRideIds(parsed);
      } catch {
        // Ignore corrupted state.
      }
    }
    const rawProfile = window.localStorage.getItem(PREFERENCE_PROFILE_KEY) as PreferenceProfile | null;
    if (rawProfile && rawProfile in PROFILE_LABELS) {
      setPreferenceProfile(rawProfile);
    }
    const rawTripMemory = window.localStorage.getItem(TRIP_MEMORY_KEY);
    if (rawTripMemory) {
      try {
        setTripMemory({ ...DEFAULT_TRIP_MEMORY, ...JSON.parse(rawTripMemory) });
      } catch {
        // Ignore corrupted state.
      }
    }
    const rawSyncCode = window.localStorage.getItem(SYNC_CODE_KEY);
    if (rawSyncCode) setSyncCode(rawSyncCode);
    setPushAlertsEnabled(window.localStorage.getItem(PUSH_ALERTS_KEY) === "true");
    const hasExistingPreferences = Boolean(
      window.localStorage.getItem(FAVORITES_KEY) ||
        rawAlerts ||
        rawDayState ||
        rawSnipes ||
        rawParty ||
        rawPlanItems ||
        rawNoGo ||
        rawProfile ||
        rawTripMemory ||
        rawSyncCode
    );
    setShowOnboarding(window.localStorage.getItem(ONBOARDING_KEY) !== "true" && !hasExistingPreferences);
    const restoreCode = new URLSearchParams(window.location.search).get("sync");
    if (restoreCode) {
      void restorePreferenceSync(restoreCode).then((restored) => {
        if (restored) window.history.replaceState({}, "", window.location.pathname);
      });
    }
    const sharedParty = new URLSearchParams(window.location.search).get("party");
    if (sharedParty) {
      try {
        const payload = decodePartyPayload(sharedParty);
        if (payload.party) {
          setPartyDay(payload.party);
          window.localStorage.setItem(PARTY_KEY, JSON.stringify(payload.party));
        }
        if (Array.isArray(payload.favorites)) {
          setFavorites(payload.favorites);
          window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(payload.favorites));
        }
        if (payload.dayState) {
          setDayState(payload.dayState);
          window.localStorage.setItem(DAY_STATE_KEY, JSON.stringify(payload.dayState));
        }
        if (Array.isArray(payload.planItems)) {
          setPlanItems(payload.planItems);
          window.localStorage.setItem(PLAN_ITEMS_KEY, JSON.stringify(payload.planItems));
        }
        window.history.replaceState({}, "", window.location.pathname);
      } catch {
        // Ignore malformed party links.
      }
    }
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    fetchJsonWithTimeout<unknown>("/api/meta")
      .then((data) => {
        if (!isParkMetaResponse(data)) throw new Error("Invalid park meta response");
        const normalizedMeta = normalizeParkMeta(data);
        setMeta(normalizedMeta);
        seedDefaultHiddenRideIds(normalizedMeta.defaultHiddenRideIds);
        if (!normalizedMeta.parks.find((park) => park.slug === activePark) && normalizedMeta.parks[0]) {
          setActivePark(normalizedMeta.parks[0].slug);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  function fetchPark(slug: string, quiet = false) {
    if (quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    return Promise.all([
      fetchJsonWithTimeout<unknown>(`/api/parks/${slug}`),
      fetchJsonWithTimeout<unknown>("/api/meta")
    ])
      .then(([park, parkMeta]) => {
        if (!isParkDetailResponse(park) || !isParkMetaResponse(parkMeta)) {
          throw new Error("Invalid park API response");
        }
        const normalizedPark = normalizeParkData(park);
        const normalizedMeta = normalizeParkMeta(parkMeta);
        notifyFavoriteChanges(previousRidesRef.current, normalizedPark);
        setParkData(normalizedPark);
        setMeta(normalizedMeta);
        seedDefaultHiddenRideIds(normalizedMeta.defaultHiddenRideIds);
        setOfflineMode(false);
        try {
          window.localStorage.setItem(
            `${PARK_CACHE_KEY}:${slug}`,
            JSON.stringify({
              park: normalizedPark,
              meta: normalizedMeta,
              cachedAt: new Date().toISOString()
            })
          );
        } catch {
          // Keep the live UI usable even if browser storage is full or unavailable.
        }
      })
      .catch(() => {
        if (quiet && parkData?.park.slug === slug) {
          setOfflineMode(true);
          return;
        }
        const raw = window.localStorage.getItem(`${PARK_CACHE_KEY}:${slug}`);
        if (!raw) return;
        try {
          const cached = JSON.parse(raw) as {
            park: Partial<ParkDetailResponse>;
            meta: ParkMetaResponse;
          };
          if (!isParkMetaResponse(cached.meta)) throw new Error("Invalid cached meta");
          const normalizedMeta = normalizeParkMeta(cached.meta);
          setParkData(normalizeParkData(cached.park));
          setMeta(normalizedMeta);
          seedDefaultHiddenRideIds(normalizedMeta.defaultHiddenRideIds);
          setOfflineMode(true);
        } catch {
          // Ignore corrupted cache data.
        }
      })
      .finally(() => {
        if (quiet) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      });
  }

  useEffect(() => {
    void fetchPark(activePark);
  }, [activePark]);

  useEffect(() => {
    if (meta?.featureFlags.weather === false) {
      setWeather(null);
      return;
    }
    void fetchJsonWithTimeout<WeatherResponse>(`/api/weather?parkSlug=${activePark}`, 6_000)
      .then((data: WeatherResponse) => setWeather(data))
      .catch(() => setWeather(null));
  }, [activePark, meta?.featureFlags.weather]);

  useEffect(() => {
    if (dashboardMode === "map" && meta?.featureFlags.map === false) {
      setDashboardMode("today");
    }
  }, [dashboardMode, meta?.featureFlags.map]);

  useEffect(() => {
    if (!parkData?.status.hasData) return;
    setTripMemory((current) => {
      const today = new Date().toDateString();
      if (current.lastVisitAt && new Date(current.lastVisitAt).toDateString() === today) {
        return current;
      }
      const next = {
        ...current,
        parksVisited: {
          ...current.parksVisited,
          [parkData.park.slug]: (current.parksVisited[parkData.park.slug] ?? 0) + 1
        },
        lastVisitAt: new Date().toISOString()
      };
      window.localStorage.setItem(TRIP_MEMORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [parkData]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void fetchPark(activePark, true);
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, [activePark]);

  useEffect(() => {
    const shell = shellRef.current;
    const parkTabs = parkTabsRef.current;
    if (!shell || !parkTabs) return;

    const updateStickyMetrics = () => {
      const shellStyles = window.getComputedStyle(shell);
      const topPadding = Number.parseFloat(shellStyles.paddingTop || "0");
      const tabsHeight = parkTabs.getBoundingClientRect().height;
      shell.style.setProperty("--park-tabs-sticky-top", `${topPadding}px`);
      shell.style.setProperty("--park-tabs-sticky-height", `${tabsHeight}px`);
      shell.style.setProperty("--land-head-sticky-top", `${topPadding + tabsHeight + 8}px`);
    };

    updateStickyMetrics();

    const resizeObserver = new ResizeObserver(() => updateStickyMetrics());
    resizeObserver.observe(parkTabs);

    window.addEventListener("resize", updateStickyMetrics);
    window.addEventListener("orientationchange", updateStickyMetrics);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateStickyMetrics);
      window.removeEventListener("orientationchange", updateStickyMetrics);
    };
  }, [meta]);

  useEffect(() => {
    const updateChrome = () => setChromeElevated(window.scrollY > 18);
    updateChrome();
    window.addEventListener("scroll", updateChrome, { passive: true });
    return () => window.removeEventListener("scroll", updateChrome);
  }, []);

  useEffect(() => {
    document.body.style.overflow = selectedRide ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [selectedRide]);

  useEffect(() => {
    selectedRideRef.current = selectedRide;
  }, [selectedRide]);

  useEffect(() => {
    const handlePopState = () => {
      if (!rideSheetHistoryRef.current) return;
      rideSheetHistoryRef.current = false;
      setSelectedRide(null);
      setRideHistory([]);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function toggleFavorite(attractionId: string) {
    completeOnboarding();
    setFavorites((current) => {
      const next = current.includes(attractionId)
        ? current.filter((id) => id !== attractionId)
        : [...current, attractionId];
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      trackEvent("favorite_toggle", attractionId);
      return next;
    });
  }

  function openRideDetails(ride: RideItem) {
    completeOnboarding();
    if (!selectedRideRef.current) {
      window.history.pushState({ dwtRideSheet: ride.id }, "", window.location.href);
      rideSheetHistoryRef.current = true;
    }
    setSelectedRide(ride);
    setRideHistory([]);
    setRideHistoryBaseline([]);
    setRideHistoryWindow(null);
    void fetch(`/api/rides/${ride.id}/history`)
      .then((response) => response.json())
      .then((data: Partial<RideHistoryResponse>) => {
        setRideHistory(data.points ?? []);
        setRideHistoryBaseline(data.baselinePoints ?? []);
        setRideHistoryWindow(data.operatingWindow ?? null);
      })
      .catch(() => {
        setRideHistory([]);
        setRideHistoryBaseline([]);
        setRideHistoryWindow(null);
      });
    trackEvent("ride_sheet_open", ride.id);
  }

  function closeRideDetails() {
    if (rideSheetHistoryRef.current && window.history.state?.dwtRideSheet) {
      window.history.back();
      return;
    }
    rideSheetHistoryRef.current = false;
    setSelectedRide(null);
    setRideHistory([]);
    setRideHistoryBaseline([]);
    setRideHistoryWindow(null);
  }

  function trackEvent(eventName: string, detail: string) {
    const visitorId = window.localStorage.getItem(VISITOR_KEY);
    if (!visitorId) return;
    void fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorId, eventName, detail }),
      keepalive: true
    });
  }

  function seedDefaultHiddenRideIds(defaultHiddenRideIds: string[]) {
    if (defaultHiddenRideIds.length === 0 || window.localStorage.getItem(NO_GO_KEY) !== null) return;
    setNoGoRideIds(defaultHiddenRideIds);
    window.localStorage.setItem(NO_GO_KEY, JSON.stringify(defaultHiddenRideIds));
  }

  function currentPreferencePayload(): PreferenceSyncPayload {
    return {
      favorites,
      alertThresholds,
      dayState,
      snipes,
      partyDay,
      planItems,
      noGoRideIds,
      preferenceProfile,
      tripMemory,
      savedAt: new Date().toISOString()
    };
  }

  function applyPreferencePayload(payload: Partial<PreferenceSyncPayload>) {
    if (Array.isArray(payload.favorites)) {
      setFavorites(payload.favorites);
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(payload.favorites));
    }
    if (payload.alertThresholds && typeof payload.alertThresholds === "object") {
      setAlertThresholds(payload.alertThresholds);
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(payload.alertThresholds));
    }
    if (payload.dayState && typeof payload.dayState === "object") {
      setDayState(payload.dayState);
      window.localStorage.setItem(DAY_STATE_KEY, JSON.stringify(payload.dayState));
    }
    if (Array.isArray(payload.snipes)) {
      setSnipes(payload.snipes);
      window.localStorage.setItem(SNIPES_KEY, JSON.stringify(payload.snipes));
    }
    if (payload.partyDay === null || (payload.partyDay && typeof payload.partyDay === "object")) {
      setPartyDay(payload.partyDay);
      if (payload.partyDay) {
        window.localStorage.setItem(PARTY_KEY, JSON.stringify(payload.partyDay));
      } else {
        window.localStorage.removeItem(PARTY_KEY);
      }
    }
    if (Array.isArray(payload.planItems)) {
      setPlanItems(payload.planItems);
      window.localStorage.setItem(PLAN_ITEMS_KEY, JSON.stringify(payload.planItems));
    }
    if (Array.isArray(payload.noGoRideIds)) {
      setNoGoRideIds(payload.noGoRideIds);
      window.localStorage.setItem(NO_GO_KEY, JSON.stringify(payload.noGoRideIds));
    }
    if (payload.preferenceProfile && payload.preferenceProfile in PROFILE_LABELS) {
      setPreferenceProfile(payload.preferenceProfile);
      window.localStorage.setItem(PREFERENCE_PROFILE_KEY, payload.preferenceProfile);
    }
    if (payload.tripMemory && typeof payload.tripMemory === "object") {
      const nextMemory = { ...DEFAULT_TRIP_MEMORY, ...payload.tripMemory };
      setTripMemory(nextMemory);
      window.localStorage.setItem(TRIP_MEMORY_KEY, JSON.stringify(nextMemory));
    }
  }

  async function savePreferenceSync() {
    setSyncStatus("Saving preferences...");
    try {
      const response = await fetch("/api/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: syncCode, payload: currentPreferencePayload() })
      });
      if (!response.ok) throw new Error("Sync save failed");
      const data = (await response.json()) as { code: string };
      window.localStorage.setItem(SYNC_CODE_KEY, data.code);
      setSyncCode(data.code);
      setSyncStatus(`Saved sync code ${data.code}`);
      trackEvent("preference_sync_save", data.code);
    } catch {
      setSyncStatus("Could not save sync code.");
    }
  }

  async function restorePreferenceSync(codeInput?: string) {
    const entered = codeInput ?? window.prompt("Enter sync code") ?? "";
    const code = normalizeSyncCodeInput(entered);
    if (!code) return false;
    setSyncStatus("Restoring preferences...");
    try {
      const response = await fetch(`/api/preferences/${code}`);
      if (!response.ok) throw new Error("Sync code not found");
      const data = (await response.json()) as { code: string; payload: PreferenceSyncPayload };
      applyPreferencePayload(data.payload);
      window.localStorage.setItem(SYNC_CODE_KEY, data.code);
      setSyncCode(data.code);
      setSyncStatus(`Restored sync code ${data.code}`);
      trackEvent("preference_sync_restore", data.code);
      return true;
    } catch {
      setSyncStatus("Sync code not found.");
      return false;
    }
  }

  async function sharePreferenceSync() {
    let code = syncCode;
    if (!code) {
      await savePreferenceSync();
      code = window.localStorage.getItem(SYNC_CODE_KEY);
    }
    if (!code) return;
    const url = new URL(window.location.href);
    url.searchParams.set("sync", code);
    const text = `Restore my Disney Wait Times preferences with sync code ${code}.`;
    if (navigator.share) {
      await navigator.share({ title: "Disney Wait Times sync", text, url: url.toString() });
    } else {
      await navigator.clipboard?.writeText(url.toString());
      setSyncStatus(`Copied sync link for ${code}`);
    }
  }

  function completeOnboarding() {
    window.localStorage.setItem(ONBOARDING_KEY, "true");
    setShowOnboarding(false);
  }

  function dismissOnboarding() {
    completeOnboarding();
  }

  async function installApp() {
    if (!installPrompt) return;
    completeOnboarding();
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  async function enableAlert(rideId: string, threshold = 30) {
    completeOnboarding();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    setAlertThresholds((current) => {
      const next = { ...current, [rideId]: threshold };
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function enableRideAlerts(rides: RideItem[], threshold = 25) {
    completeOnboarding();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    const alertableRideIds = rides
      .filter((ride) => isRecommendableRide(ride, noGoRideIds) && ride.isOpen)
      .map((ride) => ride.id);
    if (alertableRideIds.length === 0) return;
    setAlertThresholds((current) => {
      const next = { ...current };
      for (const rideId of alertableRideIds) {
        next[rideId] = threshold;
      }
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function enablePushAlerts() {
    if (!("Notification" in window)) return;
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return;
    if ("serviceWorker" in navigator) {
      await navigator.serviceWorker.ready;
    }
    window.localStorage.setItem(PUSH_ALERTS_KEY, "true");
    setPushAlertsEnabled(true);
    await sendLocalPush("Park alerts are on", "We will surface favorite drops and reopenings while the app is active.");
  }

  async function sendLocalPush(title: string, body: string) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      if (registration) {
        await registration.showNotification(title, {
          body,
          icon: "/icon.svg",
          badge: "/icon.svg"
        });
        return;
      }
    }
    new Notification(title, { body });
  }

  function disableAlert(rideId: string) {
    setAlertThresholds((current) => {
      const next = { ...current };
      delete next[rideId];
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function clearParkAlerts() {
    setAlertThresholds((current) => {
      const parkRideIds = new Set(allRides.map((ride) => ride.id));
      const next = { ...current };
      for (const rideId of parkRideIds) {
        delete next[rideId];
      }
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function setRideDayState(rideId: string, state: "must-do" | "done" | "skip") {
    completeOnboarding();
    setDayState((current) => {
      const next = { ...current, [rideId]: state };
      window.localStorage.setItem(DAY_STATE_KEY, JSON.stringify(next));
      return next;
    });
    if (state === "done" || state === "skip") {
      rememberRideState(rideId, state);
    }
  }

  function saveTripMemory(next: TripMemory) {
    setTripMemory(next);
    window.localStorage.setItem(TRIP_MEMORY_KEY, JSON.stringify(next));
  }

  function rememberRideState(rideId: string, state: "done" | "skip") {
    setTripMemory((current) => {
      const next: TripMemory = {
        completedRideIds: { ...current.completedRideIds },
        skippedRideIds: { ...current.skippedRideIds },
        parksVisited: { ...current.parksVisited },
        lastVisitAt: new Date().toISOString()
      };
      if (state === "done") {
        next.completedRideIds[rideId] = (next.completedRideIds[rideId] ?? 0) + 1;
      } else {
        next.skippedRideIds[rideId] = (next.skippedRideIds[rideId] ?? 0) + 1;
      }
      window.localStorage.setItem(TRIP_MEMORY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function savePreferenceProfile(profile: PreferenceProfile) {
    setPreferenceProfile(profile);
    window.localStorage.setItem(PREFERENCE_PROFILE_KEY, profile);
    trackEvent("preference_profile", profile);
  }

  function toggleNoGoRide(rideId: string) {
    setNoGoRideIds((current) => {
      const next = current.includes(rideId) ? current.filter((id) => id !== rideId) : [...current, rideId];
      window.localStorage.setItem(NO_GO_KEY, JSON.stringify(next));
      trackEvent("no_go_toggle", rideId);
      return next;
    });
  }

  function savePlanItems(next: PlanItem[]) {
    setPlanItems(next);
    window.localStorage.setItem(PLAN_ITEMS_KEY, JSON.stringify(next));
  }

  function addPlanItem(ride: RideItem, type: PlanItem["type"]) {
    const defaultStart = new Date(Date.now() + 60 * 60 * 1000);
    const startInput = window.prompt(
      type === "virtual-queue" ? "Boarding or callback time? Use HH:MM." : "Return window start? Use HH:MM.",
      timeInputValue(defaultStart)
    );
    if (!startInput) return;
    const endInput =
      type === "lightning-lane"
        ? window.prompt("Return window end? Use HH:MM.", timeInputValue(new Date(defaultStart.getTime() + 60 * 60 * 1000)))
        : null;
    const next: PlanItem = {
      id: `${type}:${ride.id}:${Date.now()}`,
      rideId: ride.id,
      name: ride.name,
      type,
      startTime: localTimeToday(startInput),
      endTime: endInput ? localTimeToday(endInput) : null
    };
    savePlanItems([...planItems, next].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()));
    trackEvent("plan_item_add", `${type}:${ride.id}`);
  }

  function removePlanItem(itemId: string) {
    savePlanItems(planItems.filter((item) => item.id !== itemId));
  }

  function startPartyDay() {
    const name = window.prompt("Party name", partyDay?.name ?? "Our Park Day");
    if (!name) return;
    const next = { name, sharedAt: new Date().toISOString() };
    setPartyDay(next);
    window.localStorage.setItem(PARTY_KEY, JSON.stringify(next));
    trackEvent("party_day_start", activePark);
  }

  async function sharePartyDay() {
    const party = partyDay ?? { name: "Our Park Day", sharedAt: new Date().toISOString() };
    if (!partyDay) {
      setPartyDay(party);
      window.localStorage.setItem(PARTY_KEY, JSON.stringify(party));
    }
    const url = new URL(window.location.href);
    url.searchParams.set("party", encodePartyPayload({ party, favorites, dayState, planItems }));
    const text = `${party.name}: favorites, must-dos, and return windows for today.`;
    if (navigator.share) {
      await navigator.share({ title: party.name, text, url: url.toString() });
    } else {
      await navigator.clipboard?.writeText(url.toString());
    }
    trackEvent("party_day_share", activePark);
  }

  function addSnipe(ride: RideItem, park: ParkDetailResponse) {
    if (ride.waitTime === null || ride.normalWaitTime === null) return;
    const advantage = ride.normalWaitTime - ride.waitTime;
    if (advantage < 15) return;
    const snipe = {
      id: `${ride.id}:${ride.waitTime}:${ride.lastUpdated}`,
      rideId: ride.id,
      name: ride.name,
      message: `${ride.waitTime} min now — about ${advantage} min below normal`,
      createdAt: new Date().toISOString()
    };
    setSnipes((current) => {
      if (current.some((item) => item.id === snipe.id)) return current;
      const next = [snipe, ...current].slice(0, 8);
      window.localStorage.setItem(SNIPES_KEY, JSON.stringify(next));
      trackEvent("snipe_created", `${park.park.slug}:${ride.id}`);
      return next;
    });
  }

  function notifyFavoriteChanges(previousRides: Map<string, RideItem>, park: ParkDetailResponse) {
    const nextRides = new Map(park.lands.flatMap((land) => land.rides.map((ride) => [ride.id, ride])));
    if ("Notification" in window && Notification.permission === "granted") {
      const watchedRideIds = new Set([
        ...Object.keys(alertThresholdsRef.current),
        ...(pushAlertsEnabledRef.current ? favoritesRef.current : [])
      ]);
      for (const rideId of watchedRideIds) {
        const threshold = alertThresholdsRef.current[rideId] ?? 30;
        const previous = previousRides.get(rideId);
        const current = nextRides.get(rideId);
        if (!previous || !current) continue;
        if (!previous.isOpen && current.isOpen) {
          void sendLocalPush(`${current.name} reopened`, `${park.park.shortName} is operating again.`);
        } else if (
          previous.waitTime !== null &&
          current.waitTime !== null &&
          previous.waitTime > threshold &&
          current.waitTime <= threshold
        ) {
          void sendLocalPush(`${current.name} is down to ${current.waitTime} min`, `${park.park.shortName} crossed your ${threshold}-minute alert.`);
        } else if (
          pushAlertsEnabledRef.current &&
          current.waitTime !== null &&
          current.dropMinutes !== null &&
          current.dropMinutes >= 15 &&
          previous.waitTime !== current.waitTime
        ) {
          void sendLocalPush(
            `${current.name} just dropped ${current.dropMinutes} min`,
            `${park.park.shortName}: ${current.waitTime} min now.`
          );
          addSnipe(current, park);
        } else if (
          pushAlertsEnabledRef.current &&
          current.waitTime !== null &&
          current.normalWaitTime !== null &&
          current.normalWaitTime - current.waitTime >= 10 &&
          previous.waitTime !== current.waitTime
        ) {
          void sendLocalPush(
            `${current.name} is unusually good right now`,
            `${park.park.shortName}: ${current.waitTime} min, about ${current.normalWaitTime - current.waitTime} min below normal.`
          );
          addSnipe(current, park);
        }
      }
    }
    previousRidesRef.current = nextRides;
  }

  const filteredLands = useMemo<LandGroup[]>(() => {
    if (!parkData) return [];
    const search = searchQuery.trim().toLowerCase();
    const searchedLands = !search
      ? parkData.lands
      : parkData.lands
          .map((land) => ({
            ...land,
            rides: land.rides.filter((ride) => ride.name.toLowerCase().includes(search))
          }))
          .filter((land) => land.rides.length > 0);
    const baseLands = !favoritesOnly
      ? searchedLands
      : searchedLands
          .map((land) => ({
            ...land,
            rides: land.rides.filter((ride) => favorites.includes(ride.id))
          }))
          .filter((land) => land.rides.length > 0);
    const visibleLands = showHiddenRides
      ? baseLands
      : baseLands
          .map((land) => ({
            ...land,
            rides: land.rides.filter((ride) => !noGoRideIds.includes(ride.id))
          }))
          .filter((land) => land.rides.length > 0);

    if (rideSort === "land") {
      return visibleLands.map((land) => ({
        ...land,
        rides: pinFavoritesFirst(land.rides, favorites)
      }));
    }

    if (rideSort === "alpha" || rideSort === "wait-desc" || rideSort === "wait-asc" || rideSort === "favorites") {
      const allRides = visibleLands.flatMap((land) => land.rides);
      return [
        {
          name: rideSort === "favorites" ? "Favorites First" : "All Attractions",
          rides: sortRideList(allRides, rideSort, favorites)
        }
      ];
    }

    return visibleLands;
  }, [favorites, favoritesOnly, noGoRideIds, parkData, rideSort, searchQuery, showHiddenRides]);

  const allRides = useMemo(() => parkData?.lands.flatMap((land) => land.rides) ?? [], [parkData]);
  const recommendableRideIds = useMemo(
    () => new Set(allRides.filter((ride) => isRecommendableRide(ride, noGoRideIds)).map((ride) => ride.id)),
    [allRides, noGoRideIds]
  );
  const openRides = useMemo(() => allRides.filter((ride) => ride.isOpen), [allRides]);
  const openRecommendableRides = useMemo(
    () => openRides.filter((ride) => isRecommendableRide(ride, noGoRideIds)),
    [noGoRideIds, openRides]
  );
  const shortWaitRides = useMemo(
    () => openRecommendableRides.filter((ride) => ride.waitTime !== null && ride.waitTime <= 20),
    [openRecommendableRides]
  );
  const visibleWaits = useMemo(
    () => openRides.map((ride) => ride.waitTime).filter((waitTime): waitTime is number => waitTime !== null),
    [openRides]
  );
  const medianWait = useMemo(() => {
    if (visibleWaits.length === 0) return null;
    const sorted = [...visibleWaits].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [visibleWaits]);
  const ridePredictions = useMemo(
    () => new Map(allRides.map((ride) => [ride.id, predictionForRide(ride)])),
    [allRides]
  );
  const getRidePrediction = (ride: RideItem) => ridePredictions.get(ride.id) ?? predictionForRide(ride);
  const favoriteRides = useMemo(
    () =>
      allRides
        .filter((ride) => favorites.includes(ride.id) && isRecommendableRide(ride, noGoRideIds))
        .sort((a, b) => {
          const aAdvantage =
            a.waitTime === null || a.normalWaitTime === null ? Number.MAX_SAFE_INTEGER : a.waitTime - a.normalWaitTime;
          const bAdvantage =
            b.waitTime === null || b.normalWaitTime === null ? Number.MAX_SAFE_INTEGER : b.waitTime - b.normalWaitTime;
          return aAdvantage - bAdvantage || (a.waitTime ?? Number.MAX_SAFE_INTEGER) - (b.waitTime ?? Number.MAX_SAFE_INTEGER);
        }),
    [allRides, favorites, noGoRideIds]
  );
  const notableChanges = useMemo(
    () =>
      allRides
        .filter(
          (ride) =>
            isRecommendableRide(ride, noGoRideIds) &&
            ((ride.isOpen && ride.previousIsOpen === false) ||
              (!ride.isOpen && ride.previousIsOpen === true) ||
              Math.abs(ride.trendMinutes ?? 0) >= 5)
        )
        .sort((a, b) => {
          const aReopen = Number(a.isOpen && a.previousIsOpen === false);
          const bReopen = Number(b.isOpen && b.previousIsOpen === false);
          if (aReopen !== bReopen) return bReopen - aReopen;
          return Math.abs(b.trendMinutes ?? 0) - Math.abs(a.trendMinutes ?? 0);
        })
        .slice(0, 3),
    [allRides, noGoRideIds]
  );
  const bestBets = useMemo(
    () =>
      allRides
        .filter((ride) => isRecommendableRide(ride, noGoRideIds) && ride.isOpen && ride.waitTime !== null && ride.normalWaitTime !== null)
        .map((ride) => ({
          ride,
          advantage: (ride.normalWaitTime as number) - (ride.waitTime as number)
        }))
        .filter(({ advantage }) => advantage >= 5)
        .sort((a, b) => b.advantage - a.advantage || (a.ride.waitTime ?? 999) - (b.ride.waitTime ?? 999))
        .slice(0, 3),
    [allRides, noGoRideIds]
  );
  const dropAlerts = useMemo(
    () =>
      allRides
        .filter((ride) => isRecommendableRide(ride, noGoRideIds) && ride.isOpen && ride.waitTime !== null && dropLabel(ride))
        .sort((a, b) => {
          const aDrop = a.dropMinutes ?? Math.max(0, (a.normalWaitTime ?? 0) - (a.waitTime ?? 0));
          const bDrop = b.dropMinutes ?? Math.max(0, (b.normalWaitTime ?? 0) - (b.waitTime ?? 0));
          return bDrop - aDrop || (a.waitTime ?? 999) - (b.waitTime ?? 999);
        })
        .slice(0, 3),
    [allRides, noGoRideIds]
  );
  const forecastOpportunities = useMemo(
    () =>
      allRides
        .filter(
          (ride) =>
            isRecommendableRide(ride, noGoRideIds) &&
            ride.isOpen &&
            ride.waitTime !== null &&
            ride.forecastWaitTime !== null
        )
        .sort((a, b) => {
          const aUrgency = a.forecastTrendMinutes ?? 0;
          const bUrgency = b.forecastTrendMinutes ?? 0;
          return bUrgency - aUrgency || (a.waitTime ?? 999) - (b.waitTime ?? 999);
        })
        .slice(0, 3),
    [allRides, noGoRideIds]
  );
  const nextFeaturedShow = useMemo(() => {
    if (!parkData) return null;
    const now = Date.now();
    return parkData.featuredShows.find((show) => new Date(show.startTime).getTime() >= now) ?? null;
  }, [parkData]);
  const personalChanges = useMemo(
    () => notableChanges.filter((ride) => favorites.includes(ride.id) && isRecommendableRide(ride, noGoRideIds)).slice(0, 2),
    [favorites, noGoRideIds, notableChanges]
  );
  const mustDoRides = useMemo(() => allRides.filter((ride) => dayState[ride.id] === "must-do"), [allRides, dayState]);
  const doneRides = useMemo(() => allRides.filter((ride) => dayState[ride.id] === "done"), [allRides, dayState]);
  const skippedRides = useMemo(() => allRides.filter((ride) => dayState[ride.id] === "skip"), [allRides, dayState]);
  const hiddenRides = useMemo(() => allRides.filter((ride) => noGoRideIds.includes(ride.id)), [allRides, noGoRideIds]);
  const recommendationsEnabled = meta?.featureFlags.recommendations !== false;
  const mapEnabled = meta?.featureFlags.map !== false;
  const activeParkAlerts = useMemo(
    () => allRides.filter((ride) => alertThresholds[ride.id]).length,
    [alertThresholds, allRides]
  );
  const bestFavorite = favoriteRides[0] ?? null;
  const recap = useMemo(() => {
    const estimatedWaitAvoided = doneRides.reduce((sum, ride) => {
      if (ride.normalWaitTime === null || ride.waitTime === null) return sum;
      return sum + Math.max(0, ride.normalWaitTime - ride.waitTime);
    }, 0);
    return {
      ridesCompleted: doneRides.length,
      mustDosRemaining: mustDoRides.length,
      snipesCaught: snipes.length,
      estimatedWaitAvoided
    };
  }, [doneRides, mustDoRides, snipes]);
  const parkCopilot = useMemo(() => {
    if (!recommendationsEnabled) return null;
    const rainLikely = nextHourRainChance(weather) >= 40;
    const candidates = allRides
      .filter(
        (ride) =>
          isRecommendableRide(ride, noGoRideIds) &&
          ride.isOpen &&
          ride.waitTime !== null &&
          dayState[ride.id] !== "done" &&
          dayState[ride.id] !== "skip"
      )
      .map((ride) => {
        const advantage =
          ride.normalWaitTime === null || ride.waitTime === null ? 0 : Math.max(0, ride.normalWaitTime - ride.waitTime);
        const mustDoBonus = dayState[ride.id] === "must-do" ? 20 : 0;
        const favoriteBonus = favorites.includes(ride.id) ? 10 : 0;
        const indoorBonus = rainLikely && isLikelyIndoor(ride.name) ? 14 : 0;
        const shortWaitBonus = (ride.waitTime ?? Number.MAX_SAFE_INTEGER) <= 20 ? 8 : 0;
        const forecastBonus = ride.forecastTrendMinutes !== null && ride.forecastTrendMinutes >= 10 ? 8 : 0;
        const dropBonus = ride.dropMinutes !== null ? Math.min(12, ride.dropMinutes / 2) : 0;
        const profileBonus = profileScoreAdjustment(ride, preferenceProfile);
        const memoryPenalty =
          (tripMemory.skippedRideIds[ride.id] ?? 0) * 8 +
          (preferenceProfile === "headliners-done" ? (tripMemory.completedRideIds[ride.id] ?? 0) * 4 : 0);
        return {
          ride,
          advantage,
          rainLikely,
          score:
            advantage +
            mustDoBonus +
            favoriteBonus +
            indoorBonus +
            shortWaitBonus +
            forecastBonus +
            dropBonus +
            profileBonus -
            memoryPenalty
        };
      })
      .sort((a, b) => b.score - a.score || (a.ride.waitTime ?? 999) - (b.ride.waitTime ?? 999));
    const top = candidates[0];
    if (!top) return null;
    const reasons = [
      top.advantage >= 10 ? `${top.advantage} min below normal` : null,
      top.ride.dropMinutes !== null ? `just dropped ${top.ride.dropMinutes} min` : null,
      top.ride.forecastTrendMinutes !== null && top.ride.forecastTrendMinutes >= 10 ? "forecast rising" : null,
      dayState[top.ride.id] === "must-do" ? "on your must-do list" : null,
      rainLikely && isLikelyIndoor(top.ride.name) ? "rain-friendly" : null,
      top.ride.waitTime !== null && top.ride.waitTime <= 20 ? "short wait" : null
    ].filter(Boolean);
    const why = [
      top.advantage >= 10
        ? { label: "Below usual", detail: `${top.advantage} min better than this ride's same-hour baseline.` }
        : null,
      top.ride.waitTime !== null && top.ride.waitTime <= 20
        ? { label: "Easy fit", detail: `${top.ride.waitTime} min is short enough to act on without much planning.` }
        : null,
      top.ride.dropMinutes !== null
        ? { label: "Fresh drop", detail: `It fell ${top.ride.dropMinutes} min compared with about an hour ago.` }
        : null,
      top.ride.forecastTrendMinutes !== null && top.ride.forecastTrendMinutes >= 10
        ? { label: "Forecast rising", detail: `Prior days suggest the next 2 hours average around ${top.ride.forecastWaitTime} min.` }
        : null,
      favorites.includes(top.ride.id)
        ? { label: "Saved by you", detail: "This ride is in your favorites, so it gets extra priority." }
        : null,
      dayState[top.ride.id] === "must-do"
        ? { label: "Must-do", detail: "You marked this as a priority for today." }
        : null,
      rainLikely && isLikelyIndoor(top.ride.name)
        ? { label: "Weather fit", detail: "Rain risk is elevated and this looks like an indoor-friendly option." }
        : null,
      top.ride.trendMinutes !== null && top.ride.trendMinutes < 0
        ? { label: "Trending down", detail: `Posted wait is down ${Math.abs(top.ride.trendMinutes)} min vs an hour ago.` }
        : null,
      { label: "Enough signal", detail: `${openRides.length} open rides are reporting, so the comparison is useful.` }
    ].filter((item): item is { label: string; detail: string } => Boolean(item));
    return {
      ride: top.ride,
      headline: `Go to ${top.ride.name}`,
      detail: `${minutesLabel(top.ride.waitTime, top.ride.isOpen)}${reasons.length ? ` · ${reasons.join(" · ")}` : ""}`,
      rainLikely,
      why
    };
  }, [allRides, dayState, favorites, noGoRideIds, openRides.length, preferenceProfile, recommendationsEnabled, tripMemory, weather]);
  const decisionBrief = useMemo(() => {
    if (!parkData) return [];
    return [
      {
        label: "Freshness",
        value: formatFreshness(parkData.status.lastSuccessAt),
        tone: parkData.status.stale ? "warning" : "good"
      },
      {
        label: "Weather",
        value: weatherDecisionLabel(weather),
        tone: nextHourRainChance(weather) >= 40 ? "warning" : "neutral"
      },
      {
        label: "Ride supply",
        value: `${openRides.length}/${allRides.length} open`,
        tone: openRides.length > 0 ? "good" : "warning"
      }
    ];
  }, [allRides.length, openRides.length, parkData, weather]);
  const mappedRides = useMemo(
    () => (dashboardMode === "map" ? allRides.filter((ride) => ride.latitude !== null && ride.longitude !== null) : []),
    [allRides, dashboardMode]
  );
  const usefulMapRides = useMemo(() => {
    const useful = mappedRides.filter((ride) => {
      const prediction = ridePredictions.get(ride.id) ?? predictionForRide(ride);
      return (
        isRecommendableRide(ride, noGoRideIds) &&
        ride.isOpen &&
        ride.waitTime !== null &&
        (prediction.tone === "now" || ride.waitTime <= 25 || favorites.includes(ride.id))
      );
    });
    return filterMapOutliers(useful.length >= 3 ? useful : mappedRides.filter((ride) => ride.isOpen).slice(0, 12));
  }, [favorites, mappedRides, noGoRideIds, ridePredictions]);
  const nearbyRides = useMemo(() => {
    if (dashboardMode !== "map" || !userLocation) return [];
    return mappedRides
      .map((ride) => ({
        ride,
        distance: distanceMiles(userLocation.latitude, userLocation.longitude, ride.latitude as number, ride.longitude as number)
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  }, [dashboardMode, mappedRides, userLocation]);
  const partyFilteredRides = useMemo(() => {
    if (partyFilter === "open") return allRides.filter((ride) => ride.isOpen);
    if (partyFilter === "favorites") return allRides.filter((ride) => favorites.includes(ride.id));
    if (partyFilter === "short") return allRides.filter((ride) => ride.isOpen && (ride.waitTime ?? 999) <= 20);
    return allRides;
  }, [allRides, favorites, partyFilter]);
  const timelineItems = useMemo(() => {
    const items = [
      ...planItems
        .filter((item) => !item.rideId || recommendableRideIds.has(item.rideId))
        .map((item) => ({
          key: `plan-${item.id}`,
          time: item.startTime,
          label: item.name,
          detail: formatPlanItemTime(item)
        })),
      ...favoriteRides.slice(0, 3).map((ride) => ({
        key: `ride-${ride.id}`,
        time: ride.lastUpdated,
        label: ride.name,
        detail: minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)
      })),
      ...(parkData?.featuredShows ?? []).slice(0, 3).map((show) => ({
        key: `show-${show.id}-${show.startTime}`,
        time: show.startTime,
        label: show.name,
        detail: formatTime(show.startTime)
      }))
    ];
    return items
      .filter((item) => item.time)
      .sort((a, b) => new Date(a.time as string).getTime() - new Date(b.time as string).getTime());
  }, [favoriteRides, parkData, planItems, recommendableRideIds]);
  const predictionWindows = useMemo(
    () =>
      recommendationsEnabled ? allRides
        .filter((ride) => recommendableRideIds.has(ride.id) && ride.isOpen && ride.waitTime !== null)
        .map((ride) => ({ ride, prediction: ridePredictions.get(ride.id) ?? predictionForRide(ride) }))
        .filter(({ prediction }) => prediction.tone === "now" || prediction.tone === "later")
        .sort((a, b) => {
          const aScore = a.prediction.tone === "now" ? 0 : 1;
          const bScore = b.prediction.tone === "now" ? 0 : 1;
          return aScore - bScore || (a.ride.waitTime ?? 999) - (b.ride.waitTime ?? 999);
        })
        .slice(0, 4) : [],
    [allRides, recommendableRideIds, recommendationsEnabled, ridePredictions]
  );
  const upcomingPlanItems = useMemo(
    () =>
      planItems
        .filter((item) => new Date(item.startTime).getTime() >= Date.now() - 15 * 60 * 1000)
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
        .slice(0, 4),
    [planItems]
  );
  const nextAgendaItem = timelineItems[0] ?? null;
  const planWarnings = useMemo(() => {
    const warnings: string[] = [];
    for (let index = 0; index < upcomingPlanItems.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < upcomingPlanItems.length; nextIndex += 1) {
        if (rangesOverlap(upcomingPlanItems[index], upcomingPlanItems[nextIndex])) {
          warnings.push(`${upcomingPlanItems[index].name} overlaps ${upcomingPlanItems[nextIndex].name}`);
        }
      }
    }
    const nextItem = upcomingPlanItems[0];
    if (nextItem) {
      const minutesUntil = Math.round((new Date(nextItem.startTime).getTime() - Date.now()) / 60000);
      if (minutesUntil >= 0 && minutesUntil <= 25) {
        warnings.push(`${nextItem.name} starts in ${minutesUntil} min`);
      }
    }
    return warnings.slice(0, 2);
  }, [upcomingPlanItems]);
  const landFlowRecommendations = useMemo(() => {
    if (!parkData || !recommendationsEnabled) return [];
    return parkData.lands
      .map((land) => {
        const rides = land.rides
          .filter(
            (ride) =>
              isRecommendableRide(ride, noGoRideIds) &&
              ride.isOpen &&
              ride.waitTime !== null &&
              dayState[ride.id] !== "done" &&
              dayState[ride.id] !== "skip"
          )
          .map((ride) => ({
            ride,
            score:
              Math.max(0, 35 - (ride.waitTime ?? 35)) +
              (favorites.includes(ride.id) ? 12 : 0) +
              (dayState[ride.id] === "must-do" ? 16 : 0) +
              profileScoreAdjustment(ride, preferenceProfile) -
              (tripMemory.skippedRideIds[ride.id] ?? 0) * 6
          }))
          .sort((a, b) => b.score - a.score || (a.ride.waitTime ?? 999) - (b.ride.waitTime ?? 999))
          .slice(0, 3);
        return {
          landName: land.name,
          rides: rides.map((item) => item.ride),
          score: rides.reduce((sum, item) => sum + item.score, 0)
        };
      })
      .filter((land) => land.rides.length >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
  }, [dayState, favorites, noGoRideIds, parkData, preferenceProfile, recommendationsEnabled, tripMemory]);
  const bestCharacterMeet = useMemo(() => {
    const now = Date.now();
    return (parkData?.meetGreets ?? [])
      .filter((show) => new Date(show.endTime ?? show.startTime).getTime() >= now)
      .filter((show) => show.isOpen !== false && show.status !== "CLOSED")
      .sort((a, b) => {
        const waitA = typeof a.waitTime === "number" ? a.waitTime : Number.MAX_SAFE_INTEGER;
        const waitB = typeof b.waitTime === "number" ? b.waitTime : Number.MAX_SAFE_INTEGER;
        return waitA - waitB || new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
      })[0] ?? null;
  }, [parkData]);
  const smartMoves = useMemo<SmartMove[]>(() => {
    const moves: SmartMove[] = [];
    if (parkCopilot) {
      moves.push({
        key: `ride-${parkCopilot.ride.id}`,
        label: "Best ride",
        title: parkCopilot.ride.name,
        detail: parkCopilot.detail,
        ride: parkCopilot.ride,
        tone: "ride"
      });
    }
    if (landFlowRecommendations[0]) {
      const flow = landFlowRecommendations[0];
      moves.push({
        key: `land-${flow.landName}`,
        label: "Best cluster",
        title: flow.landName,
        detail: flow.rides.map((ride) => ride.name).join(" -> "),
        ride: flow.rides[0],
        tone: "land"
      });
    }
    if (bestCharacterMeet) {
      const wait = meetGreetWaitLabel(bestCharacterMeet);
      moves.push({
        key: `character-${bestCharacterMeet.id}-${bestCharacterMeet.startTime}`,
        label: "Character",
        title: bestCharacterMeet.name,
        detail: `${formatHourRange(bestCharacterMeet.startTime, bestCharacterMeet.endTime ?? bestCharacterMeet.startTime)}${wait ? ` · ${wait}` : ""}`,
        show: bestCharacterMeet,
        tone: "character"
      });
    }
    if (nextFeaturedShow) {
      moves.push({
        key: `show-${nextFeaturedShow.id}-${nextFeaturedShow.startTime}`,
        label: "Next show",
        title: nextFeaturedShow.name,
        detail: formatTime(nextFeaturedShow.startTime),
        show: nextFeaturedShow,
        tone: "show"
      });
    }
    return moves.slice(0, 4);
  }, [bestCharacterMeet, landFlowRecommendations, nextFeaturedShow, parkCopilot]);
  const tripMemoryStats = useMemo(() => {
    const completed = Object.values(tripMemory.completedRideIds).reduce((sum, count) => sum + count, 0);
    const skipped = Object.values(tripMemory.skippedRideIds).reduce((sum, count) => sum + count, 0);
    const visitedParks = Object.values(tripMemory.parksVisited).reduce((sum, count) => sum + count, 0);
    return { completed, skipped, visitedParks };
  }, [tripMemory]);

  function requestNearbyMode() {
    setParkMode("nearby");
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        }),
      () => setUserLocation(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function shareRecap() {
    if (!parkData) return;
    setSharingRecap(true);
    try {
      const blob = await renderRecapImage({
        parkName: parkData.park.shortName,
        date: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date()),
        ridesCompleted: recap.ridesCompleted,
        estimatedWaitAvoided: recap.estimatedWaitAvoided,
        snipesCaught: recap.snipesCaught,
        favoriteMoment: doneRides[0]?.name ?? bestFavorite?.name ?? "A great park day"
      });
      const file = new File([blob], "park-day-recap.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: `${parkData.park.shortName} recap`,
          text: "My park day recap",
          files: [file]
        });
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "park-day-recap.png";
        link.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setSharingRecap(false);
    }
  }

  const selectedRidePrediction = selectedRide ? predictionForRide(selectedRide, rideHistory) : null;

  return (
    <main className={`shell mode-${dashboardMode} ${parkThemeClass(activePark)}`} ref={shellRef}>
      <header className="app-bar">
        <div>
          <span>Disney Wait Times</span>
          <strong>{parkData?.park.shortName ?? "WDW"}</strong>
        </div>
        <div className="app-bar-status">
          {parkData?.status.stale ? "Stale" : parkData?.status.hasData ? "Live" : "Loading"}
        </div>
      </header>

      <nav
        aria-label="Walt Disney World parks"
        className="park-tabs"
        data-scrolled={chromeElevated ? "true" : "false"}
        ref={parkTabsRef}
      >
        {meta?.parks.map((park) => (
          <button
            key={park.slug}
            className={park.slug === activePark ? "park-tab active" : "park-tab"}
            onClick={() => {
              completeOnboarding();
              setActivePark(park.slug);
              trackEvent("park_view", park.slug);
            }}
            type="button"
          >
            <span>{park.shortName}</span>
            <small>{park.summary}</small>
          </button>
        ))}
      </nav>

      {loading && <LoadingDashboard />}

      {!loading && parkData && (
        <>
          {showOnboarding && (
            <section className="panel onboarding-card">
              <div>
                <p>Welcome</p>
                <strong>Fast reads for better park decisions.</strong>
              </div>
              <span>Save favorites, watch crowd pulse, and install the app for quick return trips.</span>
              <div className="onboarding-actions">
                {installPrompt && <button onClick={installApp} type="button">Install app</button>}
                <button onClick={dismissOnboarding} type="button">Got it</button>
              </div>
            </section>
          )}
          {!parkData.status.hasData && (
            <section className="panel">
              <div className="notice state-card">
                <strong>Waiting for the first sync</strong>
                <p>The local cache is empty right now. Start the Python collector to load park data.</p>
              </div>
            </section>
          )}

          {parkData.status.stale && parkData.status.hasData && (
            <section className="panel compact-notice">
              <details>
                <summary>Data may be stale</summary>
                <div className="details-body notice state-card">
                  <p>This park hasn&apos;t refreshed in the last 20 minutes, so some waits may be out of date.</p>
                </div>
              </details>
            </section>
          )}

          {parkData.status.lastError && (
            <section className="panel compact-notice">
              <details>
                <summary>Polling note</summary>
                <div className="details-body notice subtle state-card">
                  <p>{parkData.status.lastError}</p>
                </div>
              </details>
            </section>
          )}

          {offlineMode && (
            <section className="panel compact-notice">
              <details>
                <summary>Offline cache in use</summary>
                <div className="details-body notice subtle state-card">
                  <p>You&apos;re viewing the last saved park snapshot until a fresh connection returns.</p>
                </div>
              </details>
            </section>
          )}

          {dashboardMode === "today" && <section className={`panel command-card pulse-${parkData.crowdPulse.level}`}>
            <div className="command-head">
              <div>
                <p>Today in {parkData.park.shortName}</p>
                <strong>{parkData.crowdPulse.headline}</strong>
              </div>
              <CrowdLevelMeter score={parkData.crowdPulse.momentum.score} />
            </div>
            <div className="park-status-line">
              <span>{medianWait !== null ? `${medianWait}m median` : parkData.crowdPulse.averageWaitTime !== null ? `${parkData.crowdPulse.averageWaitTime}m avg` : "Learning"}</span>
              <span>{momentumDetailLabel(parkData.crowdPulse.momentum)}</span>
            </div>
            <div className="decision-brief" aria-label="Current park confidence signals">
              {decisionBrief.map((item) => (
                <article className={`decision-chip decision-${item.tone}`} key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </article>
              ))}
            </div>
            {parkCopilot ? (
              <button
                className="command-primary"
                onClick={() => {
                  trackEvent("copilot_open", parkCopilot.ride.id);
                  openRideDetails(parkCopilot.ride);
                }}
                type="button"
              >
                <span className="with-icon icon-next"><Navigation size={15} strokeWidth={2.5} />{parkCopilot.rainLikely ? "Weather-aware next move" : "Next move"}</span>
                <strong>{parkCopilot.headline}</strong>
                <small>{parkCopilot.detail}</small>
                <SignalTags tags={signalTagsForRide(parkCopilot.ride, 3)} />
                <div className="command-reason">
                  <em>{shortWaitRides.length} rides at 20 min or less</em>
                  <i aria-hidden="true" />
                </div>
              </button>
            ) : recommendationsEnabled ? (
              <div className="command-primary static">
                <span>Next move</span>
                <strong>Building recommendations</strong>
                <small>{parkData.crowdPulse.detail}</small>
                <div className="command-reason">
                  <em>{openRides.length} open rides in view</em>
                  <i aria-hidden="true" />
                </div>
              </div>
            ) : (
              <div className="command-primary static">
                <span>Park pulse</span>
                <strong>{parkData.crowdPulse.headline}</strong>
                <small>{parkData.crowdPulse.detail}</small>
                <div className="command-reason">
                  <em>{openRides.length} open rides in view</em>
                  <i aria-hidden="true" />
                </div>
              </div>
            )}
            {parkCopilot && (
              <div className="command-actions" aria-label="Quick actions for next move">
                <button onClick={() => setRideDayState(parkCopilot.ride.id, "done")} type="button">
                  Done
                </button>
                <button onClick={() => openRideDetails(parkCopilot.ride)} type="button">
                  Details
                </button>
              </div>
            )}
            {parkCopilot && (
              <div className="why-this">
                <button
                  aria-expanded={showWhyThis}
                  onClick={() => setShowWhyThis((current) => !current)}
                  type="button"
                >
                  Why this recommendation?
                </button>
                {showWhyThis && (
                  <div className="why-this-panel">
                    {parkCopilot.why.map((reason) => (
                      <article key={reason.label}>
                        <strong>{reason.label}</strong>
                        <span>{reason.detail}</span>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            )}
            {(dropAlerts[0] || forecastOpportunities[0]) && (
              <div className="command-signal-strip" aria-label="Priority park signals">
                {dropAlerts[0] && (
                  <button onClick={() => openRideDetails(dropAlerts[0])} type="button">
                    <span>Best drop</span>
                    <strong>{dropAlerts[0].name}</strong>
                    <small>{dropLabel(dropAlerts[0])}</small>
                  </button>
                )}
                {forecastOpportunities[0] && (
                  <button onClick={() => openRideDetails(forecastOpportunities[0])} type="button">
                    <span>Forecast</span>
                    <strong>{forecastOpportunities[0].name}</strong>
                    <small>{forecastLabel(forecastOpportunities[0])}</small>
                  </button>
                )}
              </div>
            )}
          </section>}

          <nav className="mode-tabs" aria-label="Dashboard sections">
            {(["today", ...(mapEnabled ? ["map" as const] : []), "my-day", "rides"] as const).map((mode) => (
              <button
                className={dashboardMode === mode ? "active" : ""}
                key={mode}
                onClick={() => {
                  completeOnboarding();
                  setDashboardMode(mode);
                }}
                type="button"
              >
                <span aria-hidden="true" className="mode-icon">
                  {modeIcon(mode)}
                </span>
                <span>{mode === "my-day" ? "My Day" : mode[0].toUpperCase() + mode.slice(1)}</span>
              </button>
            ))}
          </nav>

          {dashboardMode === "today" && (
            <div className="today-content">
              {smartMoves.length > 0 && (
                <section className="panel today-options">
                  <div className="utility-head">
                    <p>Good options</p>
                    <strong>Pick from a short list</strong>
                  </div>
                  <div className="smart-move-grid" aria-label="Smart options for today">
                    {smartMoves.map((move) =>
                      "ride" in move ? (
                        <button className={`smart-move smart-${move.tone}`} key={move.key} onClick={() => openRideDetails(move.ride)} type="button">
                          <span className={`with-icon icon-${move.tone}`}>
                            {move.tone === "ride" ? <Navigation size={13} /> : <MapPinned size={13} />}
                            {move.label}
                          </span>
                          <strong>{move.title}</strong>
                          <small>{move.detail}</small>
                          <SignalTags tags={signalTagsForRide(move.ride, 2)} />
                        </button>
                      ) : (
                        <article className={`smart-move smart-${move.tone}`} key={move.key}>
                          <span className={`with-icon icon-${move.tone}`}>
                            {move.tone === "character" ? <UsersRound size={13} /> : <Ticket size={13} />}
                            {move.label}
                          </span>
                          <strong>{move.title}</strong>
                          <small>{move.detail}</small>
                        </article>
                      )
                    )}
                  </div>
                </section>
              )}
              {(bestBets.length > 0 || shortWaitRides.length > 0 || nextFeaturedShow) && (
                <section className="panel today-quicklook">
                  <div className="utility-head">
                    <p>Quick read</p>
                    <strong>Best signals right now</strong>
                  </div>
                  <div className="quick-groups">
                    <section className="quick-group quick-now">
                      <p>Now</p>
                      <div className="command-grid">
                        <article className="quick-feature">
                          <small>Best value</small>
                          <strong>{bestFavorite?.name ?? bestBets[0]?.ride.name ?? shortWaitRides[0]?.name ?? "Building"}</strong>
                          <span>
                            {bestFavorite
                              ? minutesLabel(bestFavorite.waitTime, bestFavorite.isOpen) ?? statusLabel(bestFavorite)
                              : bestBets[0]
                                ? `${bestBets[0].advantage} min below normal`
                                : shortWaitRides[0]
                                  ? minutesLabel(shortWaitRides[0].waitTime, shortWaitRides[0].isOpen)
                                  : "More history needed"}
                          </span>
                        </article>
                        <article>
                          <small>Drop detector</small>
                          <strong>{dropAlerts[0]?.name ?? "Watching"}</strong>
                          <span>{dropAlerts[0] ? dropLabel(dropAlerts[0]) : "No major drops yet"}</span>
                        </article>
                      </div>
                    </section>
                    <section className="quick-group quick-trend">
                      <p>Trend</p>
                      <div className="command-grid">
                        <article>
                          <small>Crowd Level</small>
                          <strong>{momentumScoreLabel(parkData.crowdPulse.momentum.score)}</strong>
                          <span>{momentumDetailLabel(parkData.crowdPulse.momentum)}</span>
                        </article>
                        <article>
                          <small>2 hr forecast</small>
                          <strong>{forecastOpportunities[0]?.name ?? "Learning"}</strong>
                          <span>{forecastOpportunities[0] ? forecastLabel(forecastOpportunities[0]) : "More history needed"}</span>
                        </article>
                      </div>
                    </section>
                    <section className="quick-group quick-plan">
                      <p>Plan</p>
                      <div className="command-grid">
                        <article>
                          <small>Short waits</small>
                          <strong>{shortWaitRides.length}</strong>
                          <span>20 min or less</span>
                        </article>
                        <article>
                          <small>Next show</small>
                          <strong>{nextFeaturedShow?.name ?? "No show ahead"}</strong>
                          <span>{nextFeaturedShow ? formatTime(nextFeaturedShow.startTime) : "—"}</span>
                        </article>
                      </div>
                    </section>
                  </div>
                </section>
              )}
              {snipes.length > 0 && (
                <section className="panel snipe-card">
                  <div className="utility-head">
                    <p>Snipe alert</p>
                    <strong>{snipes.length} caught</strong>
                  </div>
                  {snipes.slice(0, 2).map((snipe) => (
                    <article key={snipe.id}>
                      <strong>{snipe.name}</strong>
                      <span>{snipe.message}</span>
                    </article>
                  ))}
                </section>
              )}
              {dropAlerts.length > 0 && (
                <section className="panel snipe-card">
                  <div className="utility-head">
                    <p>Drop detector</p>
                    <strong>{dropAlerts.length} live</strong>
                  </div>
                  {dropAlerts.slice(0, 2).map((ride) => (
                    <button className="drop-alert-row" key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                      <strong>{ride.name}</strong>
                      <span>{dropLabel(ride)}</span>
                    </button>
                  ))}
                </section>
              )}
              {parkData.hours.length > 0 && <section className="panel compact-info-panel info-hours">
                <details>
                  <summary><span className="with-icon icon-clock"><Clock3 size={14} />Park Hours Today</span></summary>
                  <div className="details-body">
                    <div className="hour-list">
                      {parkData.hours.map((entry) => (
                        <article className="hour-chip" key={`${entry.type}-${entry.openingTime}`}>
                          <strong>{entry.description ?? entry.type.replaceAll("_", " ")}</strong>
                          <span>{formatHourRange(entry.openingTime, entry.closingTime)}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                </details>
              </section>}
              {parkData.featuredShows.length > 0 && (
                <section className="panel compact-info-panel info-shows">
                  <details>
                    <summary><span className="with-icon icon-show"><Ticket size={14} />Featured Showtimes</span></summary>
                    <div className="details-body">
                      <div className="show-grid">
                        {parkData.featuredShows.map((show) => (
                          <article className="show-card" key={`${show.id}-${show.startTime}`}>
                            <strong>{show.name}</strong>
                            <span>{formatTime(show.startTime)}</span>
                          </article>
                        ))}
                      </div>
                    </div>
                  </details>
                </section>
              )}
              {parkData.meetGreets.length > 0 && <section className="panel compact-info-panel info-characters">
                <details>
                  <summary><span className="with-icon icon-character"><UsersRound size={14} />Character Meet &amp; Greet Times</span></summary>
                  <div className="details-body">
                    <div className="show-grid">
                      {parkData.meetGreets.map((show) => (
                        <article className="show-card" key={`${show.id}-${show.startTime}`}>
                          <strong>{show.name}</strong>
                          <span>{meetGreetDetail(show)}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                </details>
              </section>}
            </div>
          )}

          {dashboardMode === "my-day" && <section className="panel agenda-card">
            <div className="agenda-hero">
              <div>
                <p>My Day</p>
                <strong>{partyDay?.name ?? "Build the plan"}</strong>
                <span>{partyDay ? "Shared party mode" : "Favorites, returns, and must-dos in one place"}</span>
              </div>
              <button onClick={sharePartyDay} type="button">Share</button>
            </div>
            <div className="agenda-actions">
              <button onClick={startPartyDay} type="button">{partyDay ? "Rename party" : "Start party"}</button>
              <button onClick={shareRecap} disabled={sharingRecap} type="button">{sharingRecap ? "Preparing" : "Share recap"}</button>
              <button onClick={enablePushAlerts} type="button">Push alerts {pushAlertsEnabled ? "on" : "off"}</button>
            </div>
            <div className="preference-strip" aria-label="Trip style">
              {(Object.keys(PROFILE_LABELS) as PreferenceProfile[]).map((profile) => (
                <button
                  className={preferenceProfile === profile ? "active" : ""}
                  key={profile}
                  onClick={() => savePreferenceProfile(profile)}
                  type="button"
                >
                  {PROFILE_LABELS[profile]}
                </button>
              ))}
            </div>
            <div className="sync-card">
              <div>
                <span>Preference sync</span>
                <strong>{syncCode ? syncCode : "No sync code yet"}</strong>
                {syncStatus && <small>{syncStatus}</small>}
              </div>
              <div>
                <button onClick={savePreferenceSync} type="button">Save</button>
                <button onClick={() => void restorePreferenceSync()} type="button">Restore</button>
                <button onClick={sharePreferenceSync} type="button">Share</button>
              </div>
            </div>
            <div className="agenda-next">
              <span>Next</span>
              {nextAgendaItem ? (
                <div>
                  <strong>{nextAgendaItem.label}</strong>
                  <small>{nextAgendaItem.detail}</small>
                </div>
              ) : bestFavorite ? (
                <button onClick={() => openRideDetails(bestFavorite)} type="button">
                  <strong>{bestFavorite.name}</strong>
                  <small>{minutesLabel(bestFavorite.waitTime, bestFavorite.isOpen) ?? statusLabel(bestFavorite)}</small>
                </button>
              ) : (
                <em>Save a few rides or add a return window to shape the day.</em>
              )}
            </div>
            <div className="agenda-stats">
              <article><span>Must-do</span><strong>{mustDoRides.length}</strong></article>
              <article><span>Done</span><strong>{doneRides.length}</strong></article>
              <article><span>Wait saved</span><strong>{recap.estimatedWaitAvoided}m</strong></article>
            </div>
            <div className="agenda-section">
              <div className="agenda-section-head">
                <span>Park alerts</span>
                <strong>{activeParkAlerts}</strong>
              </div>
              <div className="alert-preset-grid">
                <button onClick={() => void enableRideAlerts(favoriteRides, 25)} type="button"><Bell size={14} />Favorites under 25</button>
                <button onClick={() => void enableRideAlerts(mustDoRides, 30)} type="button"><Star size={14} />Must-do under 30</button>
                <button onClick={() => void enableRideAlerts(bestBets.map(({ ride }) => ride), 25)} type="button"><Sparkles size={14} />Best bets under 25</button>
                {parkCopilot && (
                  <button onClick={() => enableAlert(parkCopilot.ride.id)} type="button">
                    <Navigation size={14} />Next move alert
                  </button>
                )}
                <button onClick={clearParkAlerts} type="button"><Filter size={14} />Clear park alerts</button>
              </div>
            </div>
            {hiddenRides.length > 0 && (
              <div className="agenda-section">
                <div className="agenda-section-head">
                  <span>Hidden rides</span>
                  <strong>{hiddenRides.length}</strong>
                </div>
                {hiddenRides.map((ride) => (
                  <article className="agenda-row" key={ride.id}>
                    <div>
                      <strong>{ride.name}</strong>
                      <span>{minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)}</span>
                    </div>
                    <button onClick={() => toggleNoGoRide(ride.id)} type="button"><EyeOff size={14} />Show</button>
                  </article>
                ))}
              </div>
            )}
            <div className="agenda-section">
              <div className="agenda-section-head">
                <span>Returns and queues</span>
                <strong>{upcomingPlanItems.length}</strong>
              </div>
              {planWarnings.length > 0 && (
                <div className="planner-warnings">
                  {planWarnings.map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              )}
              {upcomingPlanItems.length > 0 ? (
                upcomingPlanItems.map((item) => (
                  <article className="agenda-row" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <span>{formatPlanItemTime(item)}</span>
                    </div>
                    <button onClick={() => removePlanItem(item.id)} type="button">Done</button>
                  </article>
                ))
              ) : (
                <em>Add Lightning Lane returns or virtual queue times from any ride sheet.</em>
              )}
            </div>
            {landFlowRecommendations.length > 0 && (
              <div className="agenda-section">
                <div className="agenda-section-head">
                  <span>Land flow</span>
                  <strong>{landFlowRecommendations.length}</strong>
                </div>
                {landFlowRecommendations.map((flow) => (
                  <article className="flow-card" key={flow.landName}>
                    <div>
                      <strong>{flow.landName}</strong>
                      <span>{flow.rides.map((ride) => ride.name).join(" -> ")}</span>
                    </div>
                    <button
                      onClick={() => {
                        trackEvent("land_flow_start", flow.landName);
                        openRideDetails(flow.rides[0]);
                      }}
                      type="button"
                    >
                      Start
                    </button>
                  </article>
                ))}
              </div>
            )}
            <div className="agenda-section">
              <div className="agenda-section-head">
                <span>For you</span>
                <strong>{personalChanges.length || timelineItems.length}</strong>
              </div>
              {personalChanges.length > 0 ? (
                personalChanges.map((ride) => {
                  const prediction = getRidePrediction(ride);
                  return (
                    <button className="agenda-row" key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                      <div>
                        <strong>{ride.name}</strong>
                        <span>{changeLabel(ride)}</span>
                      </div>
                      <span className={recommendationClass(prediction)}>{prediction.headline}</span>
                    </button>
                  );
                })
              ) : timelineItems.length > 0 ? (
                timelineItems.slice(0, 3).map((item) => (
                  <div className="agenda-row" key={item.key}>
                    <div>
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                    </div>
                  </div>
                ))
              ) : (
                <em>Useful changes and timeline items will gather here.</em>
              )}
            </div>
            <div className="recap-preview">
              <span>{parkData.park.shortName}</span>
              <strong>{recap.ridesCompleted} rides today · {tripMemoryStats.completed} remembered</strong>
              <em>{noGoRideIds.length} hidden · {tripMemoryStats.visitedParks} park check-ins · {PROFILE_LABELS[preferenceProfile]}</em>
            </div>
          </section>}

          {dashboardMode === "map" && <section className="panel in-park-card">
            <div className="in-park-head">
              <div>
                <p>In the park</p>
                <strong>{parkMode === "nearby" ? "Nearby mode" : "Park map"}</strong>
              </div>
              <div className="in-park-actions">
                <button onClick={() => setParkMode("overview")} type="button">Map</button>
                <button onClick={requestNearbyMode} type="button">Nearby</button>
              </div>
            </div>
            <ParkMap
              onRideSelect={openRideDetails}
              predictions={ridePredictions}
              rides={usefulMapRides}
            />
            {parkMode === "nearby" && (
              <div className="nearby-list">
                {nearbyRides.length > 0 ? nearbyRides.map(({ ride, distance }) => (
                  <button key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                    <strong>{ride.name}</strong>
                    <span>{distance.toFixed(2)} mi · {minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)}</span>
                  </button>
                )) : <em>Allow location to see the closest mapped rides.</em>}
              </div>
            )}
          </section>}

          {dashboardMode === "map" && <section className="panel utility-card">
            <div className="utility-head">
              <p>Park utilities</p>
              <strong>Food, fit, and flow</strong>
            </div>
            <div className="party-filters">
              {(["all", "open", "favorites", "short"] as const).map((filter) => (
                <button
                  className={partyFilter === filter ? "active" : ""}
                  key={filter}
                  onClick={() => setPartyFilter(filter)}
                  type="button"
                >
                  {filter === "all" ? "All rides" : filter === "short" ? "≤20 min" : filter}
                </button>
              ))}
            </div>
            <div className="utility-grid">
              <article>
                <span>Filtered rides</span>
                <strong>{partyFilteredRides.length}</strong>
              </article>
              <article>
                <span>Dining spots</span>
                <strong>{parkData.restaurants.length}</strong>
              </article>
              <article>
                <span>Restrooms</span>
                <strong>{parkData.facilities.filter((facility) => facility.category === "restroom").length}</strong>
              </article>
            </div>
            <div className="restaurant-strip">
              {parkData.restaurants.slice(0, 4).map((restaurant) => <span key={restaurant.id}>{restaurant.name}</span>)}
            </div>
            <div className="restaurant-strip">
              {parkData.facilities.slice(0, 4).map((facility) => <span key={facility.id}>{facility.name}</span>)}
            </div>
          </section>}

          {dashboardMode === "rides" && <section className={denseRideRows ? "panel ride-panel dense-rides" : "panel ride-panel"}>
            <div className="section-head">
              <div>
                <h3>Ride Wait Times</h3>
                <p className="muted">
                  {refreshing
                    ? "Refreshing..."
                    : `Last data refresh: ${formatRelative(parkData.status.lastSuccessAt)}`}
                </p>
              </div>
            </div>
            <div className="wait-controls">
              <label className="search-field">
                <span>Search rides</span>
                <input
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search attractions"
                  type="search"
                  value={searchQuery}
                />
              </label>
              <div className="sort-strip" role="group" aria-label="Sort and filter ride wait times">
                <button
                  className={rideSort === "land" ? "sort-pill active" : "sort-pill"}
                  onClick={() => setRideSort("land")}
                  type="button"
                >
                  By land
                </button>
                <button
                  className={rideSort === "wait-asc" ? "sort-pill active" : "sort-pill"}
                  onClick={() => setRideSort("wait-asc")}
                  type="button"
                >
                  Short waits
                </button>
                <button
                  className={rideSort === "wait-desc" ? "sort-pill active" : "sort-pill"}
                  onClick={() => setRideSort("wait-desc")}
                  type="button"
                >
                  Long waits
                </button>
                <button
                  className={rideSort === "alpha" ? "sort-pill active" : "sort-pill"}
                  onClick={() => setRideSort("alpha")}
                  type="button"
                >
                  A-Z
                </button>
                <button
                  className={rideSort === "favorites" ? "sort-pill active" : "sort-pill"}
                  onClick={() => setRideSort("favorites")}
                  type="button"
                >
                  Favorites first
                </button>
                <button
                  className={favoritesOnly ? "sort-pill active filter-pill" : "sort-pill filter-pill"}
                  onClick={() => setFavoritesOnly((current) => !current)}
                  type="button"
                >
                  Favorites only
                </button>
                <button
                  aria-pressed={showHiddenRides}
                  className={showHiddenRides ? "sort-pill active filter-pill" : "sort-pill filter-pill"}
                  onClick={() => setShowHiddenRides((current) => !current)}
                  type="button"
                >
                  Hide {noGoRideIds.length > 0 ? `(${noGoRideIds.length})` : ""}
                </button>
                <button
                  aria-pressed={denseRideRows}
                  className={denseRideRows ? "sort-pill active filter-pill" : "sort-pill filter-pill"}
                  onClick={() => setDenseRideRows((current) => !current)}
                  type="button"
                >
                  Dense
                </button>
              </div>
            </div>
            <details className="ride-insights">
              <summary>
                <span>Insights</span>
                <strong>
                  {favoriteRides.length + landFlowRecommendations.length + predictionWindows.length + bestBets.length + notableChanges.length}
                </strong>
              </summary>
              <div className="ride-insights-body">
                {favoriteRides.length > 0 && (
                  <section className="insight-block">
                    <div className="insight-head">
                      <h4>Your Favorites Right Now</h4>
                      <span>{favoriteRides.length} saved</span>
                    </div>
                    <div className="favorite-dashboard">
                      {favoriteRides.slice(0, 3).map((ride) => (
                        <button className="insight-card" key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                          <strong>{ride.name}</strong>
                          <span>{minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)}</span>
                          {comparedWithNormalLabel(ride) && <small>{comparedWithNormalLabel(ride)}</small>}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {landFlowRecommendations.length > 0 && (
                  <section className="insight-block">
                    <div className="insight-head">
                      <h4>Best Land Flow</h4>
                      <span>Stay nearby</span>
                    </div>
                    <div className="flow-grid">
                      {landFlowRecommendations.map((flow) => (
                        <button
                          className="flow-card"
                          key={flow.landName}
                          onClick={() => {
                            trackEvent("land_flow_start", flow.landName);
                            openRideDetails(flow.rides[0]);
                          }}
                          type="button"
                        >
                          <strong>{flow.landName}</strong>
                          <span>{flow.rides.map((ride) => ride.name).join(" -> ")}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <section className="insight-block">
                  <div className="insight-head">
                    <h4>Predictive Wait Windows</h4>
                    <span>{predictionWindows.length > 0 ? "Now vs later" : "Learning"}</span>
                  </div>
                  {predictionWindows.length > 0 ? (
                    <div className="favorite-dashboard">
                      {predictionWindows.map(({ ride, prediction }) => (
                        <button className={`insight-card insight-${prediction.tone}`} key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                          <strong>{ride.name}</strong>
                          <span>{prediction.headline}</span>
                          <small>{prediction.detail}</small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">Prediction windows appear after the app has enough same-hour movement to compare.</p>
                  )}
                </section>
                <section className="insight-block">
                  <div className="insight-head">
                    <h4>Best Bets Right Now</h4>
                    <span>{bestBets.length > 0 ? "Below normal" : "Learning"}</span>
                  </div>
                  {bestBets.length > 0 ? (
                    <div className="favorite-dashboard">
                      {bestBets.map(({ ride, advantage }) => (
                        <button className="insight-card" key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                          <strong>{ride.name}</strong>
                          <span>{minutesLabel(ride.waitTime, ride.isOpen)}</span>
                          <small>{advantage} min below normal</small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">Best bets will appear once the app has enough same-hour history to compare rides fairly.</p>
                  )}
                </section>
                {notableChanges.length > 0 && (
                  <section className="insight-block">
                    <div className="insight-head">
                      <h4>What Changed</h4>
                      <span>Last hour</span>
                    </div>
                    <div className="change-list">
                      {notableChanges.map((ride) => (
                        <button className="change-chip" key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                          <strong>{ride.name}</strong>
                          <span>{changeLabel(ride)}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </details>
            {filteredLands.length === 0 ? (
              <p className="muted">
                {favoritesOnly
                  ? "No favorites match this park yet."
                  : "Ride data is unavailable right now."}
              </p>
            ) : (
              <div className="land-stack">
                {filteredLands.map((land) => (
                  <section className="land-card" key={land.name}>
                    <div className="land-head">
                      <h4>{land.name}</h4>
                      <span>{land.rides.length} attractions</span>
                    </div>
                    <div className="ride-list">
                      {land.rides.map((ride) => {
                        const favorite = favorites.includes(ride.id);
                        const prediction = getRidePrediction(ride);
                        const hidden = noGoRideIds.includes(ride.id);
                        return (
                          <article
                            className={`${favorite ? "ride-row favorite-row" : "ride-row"} ${hidden ? "no-go-row" : ""} ${changeLabel(ride) ? "ride-live-change" : ""} ${rideVisualClass(ride, prediction)}`}
                            key={ride.id}
                          >
                            <button
                              aria-label={favorite ? "Remove favorite" : "Add favorite"}
                              className={favorite ? "favorite ride-favorite active" : "favorite ride-favorite"}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                toggleFavorite(ride.id);
                              }}
                              onPointerDown={(event) => event.stopPropagation()}
                              type="button"
                            >
                              {favorite ? "★" : "☆"}
                            </button>
                            <button
                              aria-haspopup="dialog"
                              className="ride-main"
                              onClick={() => openRideDetails(ride)}
                              type="button"
                            >
                              <div className="ride-copy">
                                <div className="ride-text">
                                  <strong>{ride.name}</strong>
                                  <div className="ride-intel">
                                    <span className={recommendationClass(prediction)}>{prediction.headline}</span>
                                    {hidden && <small>Hidden</small>}
                                    {changeLabel(ride) && <small>{changeLabel(ride)}</small>}
                                    {signalTagsForRide(ride, 2).map((tag) => (
                                      <small className={`ride-signal signal-${tag.tone}`} key={`${ride.id}-${tag.label}`}>{tag.label}</small>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              <div className="ride-side">
                                {trendLabel(ride.trendMinutes) && (
                                  <span className="ride-trend">{trendLabel(ride.trendMinutes)}</span>
                                )}
                                <div className={`wait-pill ${pillVariant(ride)} ${waitTone(ride)}`}>
                                  <span aria-hidden="true">{waitCue(ride)}</span>
                                  {minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)}
                                </div>
                              </div>
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>}
        </>
      )}

      <footer className="footer-note">
        <a href="https://queue-times.com/" rel="noreferrer" target="_blank">
          Powered by Queue-Times.com
        </a>
      </footer>

      {selectedRide && (
        <div aria-modal="true" className="sheet-backdrop" onClick={closeRideDetails} role="dialog">
          <section className="ride-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div>
                <p className="sheet-label">Ride details</p>
                <h3>{selectedRide.name}</h3>
              </div>
              <button
                aria-label="Close ride details"
                className="sheet-close"
                onClick={closeRideDetails}
                type="button"
              >
                Back
              </button>
            </div>

            <section className={`sheet-summary prediction-${selectedRidePrediction?.tone ?? "watch"}`}>
              <div className={`wait-pill ${pillVariant(selectedRide)} ${waitTone(selectedRide)}`}>
                <span aria-hidden="true">{waitCue(selectedRide)}</span>
                {minutesLabel(selectedRide.waitTime, selectedRide.isOpen) ?? statusLabel(selectedRide)}
              </div>
              <div>
                <span>Should we go?</span>
                <strong>{selectedRidePrediction?.headline}</strong>
                <p>{selectedRidePrediction?.detail}</p>
              </div>
              <button
                className={favorites.includes(selectedRide.id) ? "sheet-favorite active" : "sheet-favorite"}
                onClick={() => toggleFavorite(selectedRide.id)}
                type="button"
              >
                {favorites.includes(selectedRide.id) ? "★ Favorited" : "☆ Add favorite"}
              </button>
            </section>
            <SignalTags tags={signalTagsForRide(selectedRide)} />

            <div className="sheet-details">
              <article className="sheet-card">
                <span className="sheet-card-label">Status</span>
                <strong>{selectedRide.isOpen ? "Operating" : statusLabel(selectedRide)}</strong>
              </article>
              <article className="sheet-card">
                <span className="sheet-card-label">Last updated</span>
                <strong>{formatRelative(selectedRide.lastUpdated)}</strong>
              </article>
              {trendLabel(selectedRide.trendMinutes) && (
                <article className="sheet-card">
                  <span className="sheet-card-label">Trend</span>
                  <strong>{trendLabel(selectedRide.trendMinutes)}</strong>
                </article>
              )}
              {comparedWithNormalLabel(selectedRide) && (
                <article className="sheet-card">
                  <span className="sheet-card-label">Compared with normal</span>
                  <strong>{comparedWithNormalLabel(selectedRide)}</strong>
                </article>
              )}
              {forecastLabel(selectedRide) && (
                <article className={`sheet-card forecast-${forecastTone(selectedRide)}`}>
                  <span className="sheet-card-label">Next 2 hours</span>
                  <strong>{forecastLabel(selectedRide)}</strong>
                </article>
              )}
              {dropLabel(selectedRide) && (
                <article className="sheet-card">
                  <span className="sheet-card-label">Drop detector</span>
                  <strong>{dropLabel(selectedRide)}</strong>
                </article>
              )}
            </div>
            <section className="history-card">
              <div>
                <span>Today&apos;s wait history</span>
                <strong>{rideHistorySummary(rideHistory, rideHistoryBaseline)}</strong>
              </div>
              <div className="chart-legend" aria-hidden="true">
                <span><i className="legend-live" />Today</span>
                <span><i className="legend-baseline" />Prior days</span>
              </div>
              <RideHistoryChart
                baselinePoints={rideHistoryBaseline}
                normalWaitTime={selectedRide.normalWaitTime}
                operatingWindow={rideHistoryWindow}
                points={rideHistory}
              />
            </section>
            <div className="sheet-action-zone">
              <div className="sheet-alert-row">
                {alertThresholds[selectedRide.id] ? (
                  <>
                  <span><Bell size={15} /> Alert below {alertThresholds[selectedRide.id]} min</span>
                    <button onClick={() => disableAlert(selectedRide.id)} type="button">Turn off</button>
                  </>
                ) : (
                  <>
                    <span><Bell size={15} /> Favorite alert</span>
                    <button onClick={() => enableAlert(selectedRide.id)} type="button">Notify below 30 min</button>
                  </>
                )}
              </div>

              <div className="sheet-day-actions">
                {(["must-do", "done", "skip"] as const).map((state) => (
                  <button
                    className={dayState[selectedRide.id] === state ? "active" : ""}
                    key={state}
                    onClick={() => setRideDayState(selectedRide.id, state)}
                    type="button"
                  >
                    {state === "must-do" ? "Must-do" : state[0].toUpperCase() + state.slice(1)}
                  </button>
                ))}
              </div>

              <div className="sheet-day-actions">
                <button onClick={() => addPlanItem(selectedRide, "lightning-lane")} type="button"><CalendarClock size={14} />Add LL return</button>
                <button onClick={() => addPlanItem(selectedRide, "virtual-queue")} type="button"><Clock3 size={14} />Add VQ time</button>
                <button
                  className={noGoRideIds.includes(selectedRide.id) ? "active" : ""}
                  onClick={() => toggleNoGoRide(selectedRide.id)}
                  type="button"
                >
                  {noGoRideIds.includes(selectedRide.id) ? "Show" : "Hide"}
                </button>
              </div>
            </div>
            <section className="official-links">
              <span>Official Disney</span>
              <a href="https://disneyworld.disney.go.com/dining/" rel="noreferrer" target="_blank">Dining</a>
              <a href="https://disneyworld.disney.go.com/guest-services/my-disney-experience/mobile-apps/" rel="noreferrer" target="_blank">App tools</a>
              <a href="https://disneyworld.disney.go.com/guest-services/virtual-queue/" rel="noreferrer" target="_blank">Virtual queues</a>
            </section>
          </section>
        </div>
      )}
    </main>
  );
}

function minutesSinceMidnight(value: string) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function formatChartTime(totalMinutes: number) {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const date = new Date();
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric" }).format(date).replace(" ", "");
}

function normalizeChartMinute(minute: number, startMinute: number, endMinute: number) {
  if (endMinute > 1440 && minute < startMinute) return minute + 1440;
  return minute;
}

function rideHistorySummary(points: RideHistoryPoint[], baselinePoints: RideHistoryBaselinePoint[]) {
  const openSamples = points.filter((point) => point.waitTime !== null && point.isOpen).length;
  if (openSamples > 1) return `${openSamples} samples`;
  if (baselinePoints.length > 1) return `${baselinePoints.length} avg buckets`;
  return "Building";
}

function RideHistoryChart({
  baselinePoints,
  normalWaitTime,
  operatingWindow,
  points
}: {
  baselinePoints: RideHistoryBaselinePoint[];
  normalWaitTime: number | null;
  operatingWindow: RideHistoryOperatingWindow | null;
  points: RideHistoryPoint[];
}) {
  const livePoints = points
    .filter((point) => point.waitTime !== null && point.isOpen)
    .map((point) => ({
      minuteOfDay: minutesSinceMidnight(point.capturedAt),
      waitTime: point.waitTime as number
    }));

  if (livePoints.length < 2 && baselinePoints.length < 2) {
    return <p className="muted">More open-hour samples are needed before a trend line appears.</p>;
  }

  const liveMinutes = livePoints.map((point) => point.minuteOfDay);
  const baselineMinutes = baselinePoints.map((point) => point.minuteOfDay);
  const openingMinute = operatingWindow ? minutesSinceMidnight(operatingWindow.openingTime) : Math.min(...liveMinutes, ...baselineMinutes);
  const rawClosingMinute = operatingWindow ? minutesSinceMidnight(operatingWindow.closingTime) : Math.max(...liveMinutes, ...baselineMinutes);
  const closingMinute = rawClosingMinute <= openingMinute ? rawClosingMinute + 1440 : rawClosingMinute;
  const chartStart = Number.isFinite(openingMinute) ? openingMinute : Math.min(...liveMinutes, ...baselineMinutes);
  const chartEnd = Number.isFinite(closingMinute) && closingMinute > chartStart ? closingMinute : Math.max(...liveMinutes, ...baselineMinutes);
  const normalizedLive = livePoints
    .map((point) => ({ ...point, chartMinute: normalizeChartMinute(point.minuteOfDay, chartStart, chartEnd) }))
    .filter((point) => point.chartMinute >= chartStart && point.chartMinute <= chartEnd);
  const normalizedBaseline = baselinePoints
    .map((point) => ({ ...point, chartMinute: normalizeChartMinute(point.minuteOfDay, chartStart, chartEnd) }))
    .filter((point) => point.chartMinute >= chartStart && point.chartMinute <= chartEnd);
  const waits = [
    ...normalizedLive.map((point) => point.waitTime),
    ...normalizedBaseline.map((point) => point.waitTime),
    ...(normalWaitTime === null ? [] : [normalWaitTime])
  ];
  const maxWait = Math.max(...waits, 1);
  const yMax = Math.max(15, Math.ceil(maxWait / 15) * 15);
  const chartLeft = 34;
  const chartRight = 288;
  const chartTop = 14;
  const chartBottom = 92;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;
  const chartX = (minute: number) => chartLeft + ((minute - chartStart) / Math.max(1, chartEnd - chartStart)) * chartWidth;
  const chartY = (waitTime: number) => chartBottom - (waitTime / yMax) * chartHeight;
  const liveLine = normalizedLive.map((point) => `${chartX(point.chartMinute)},${chartY(point.waitTime)}`).join(" ");
  const baselineLine = normalizedBaseline.map((point) => `${chartX(point.chartMinute)},${chartY(point.waitTime)}`).join(" ");
  const current = normalizedLive[normalizedLive.length - 1];
  const normalY = normalWaitTime === null ? null : chartY(normalWaitTime);
  const waitTicks = [0, Math.round(yMax / 2), yMax];
  const hourStep = chartEnd - chartStart > 600 ? 180 : 120;
  const firstHourTick = Math.ceil(chartStart / 60) * 60;
  const hourTicks = Array.from(
    { length: Math.max(0, Math.floor((chartEnd - firstHourTick) / hourStep) + 1) },
    (_, index) => firstHourTick + index * hourStep
  ).filter((minute) => minute >= chartStart && minute <= chartEnd);

  return (
    <svg aria-label="Ride wait history chart" className="history-chart" role="img" viewBox="0 0 300 126">
      {waitTicks.map((tick) => {
        const y = chartY(tick);
        return (
          <g key={tick}>
            <line className="history-grid" x1={chartLeft} x2={chartRight} y1={y} y2={y} />
            <text className="history-label history-axis-label history-label-end" x={chartLeft - 6} y={y + 3}>{tick}m</text>
          </g>
        );
      })}
      {hourTicks.map((tick) => (
        <g key={tick}>
          <line className="history-grid history-hour-grid" x1={chartX(tick)} x2={chartX(tick)} y1={chartTop} y2={chartBottom} />
          <text className="history-label history-axis-label history-label-middle" x={chartX(tick)} y="112">{formatChartTime(tick)}</text>
        </g>
      ))}
      {normalY !== null && (
        <>
          <line className="history-normal" x1={chartLeft} x2={chartRight} y1={normalY} y2={normalY} />
          <text className="history-label history-label-end" x={chartRight} y={Math.max(12, normalY - 4)}>normal {normalWaitTime}m</text>
        </>
      )}
      {baselineLine && <polyline className="history-line-baseline" points={baselineLine} />}
      {liveLine && <polyline className="history-line-live" points={liveLine} />}
      {current && <circle className="history-current" cx={chartX(current.chartMinute)} cy={chartY(current.waitTime)} r="4" />}
      {baselineLine && <text className="history-label" x={chartLeft} y="123">avg</text>}
      {liveLine && <text className="history-label history-label-end" x={chartRight} y="123">today</text>}
    </svg>
  );
}

function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const radius = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function filterMapOutliers(rides: RideItem[]) {
  if (rides.length < 4) return rides;
  const centerLat = median(rides.map((ride) => ride.latitude).filter((value): value is number => value !== null));
  const centerLon = median(rides.map((ride) => ride.longitude).filter((value): value is number => value !== null));
  if (centerLat === null || centerLon === null) return rides;
  const nearby = rides.filter(
    (ride) =>
      ride.latitude !== null &&
      ride.longitude !== null &&
      distanceMiles(centerLat, centerLon, ride.latitude, ride.longitude) <= 1.4
  );
  return nearby.length >= 3 ? nearby : rides;
}

function nextHourRainChance(weather: WeatherResponse | null) {
  const times = weather?.hourly?.time ?? [];
  const chances = weather?.hourly?.precipitation_probability ?? [];
  const now = Date.now();
  const index = times.findIndex((time) => new Date(time).getTime() >= now);
  return index >= 0 ? chances[index] ?? 0 : 0;
}

function weatherDecisionLabel(weather: WeatherResponse | null) {
  const chance = nextHourRainChance(weather);
  const temperature = weather?.current?.temperature_2m;
  if (chance >= 50) return `${chance}% rain soon`;
  if (chance >= 25) return `${chance}% rain watch`;
  if (typeof temperature === "number") return `${Math.round(temperature)}°F now`;
  return "Weather loading";
}

function isLikelyIndoor(name: string) {
  return [
    "haunted mansion",
    "space mountain",
    "pirates",
    "philharmagic",
    "carousel of progress",
    "laugh floor",
    "small world",
    "buzz lightyear",
    "tower of terror",
    "mickey & minnie",
    "remy's",
    "frozen ever after",
    "soarin",
    "living with the land",
    "spaceship earth"
  ].some((keyword) => name.toLowerCase().includes(keyword));
}

async function renderRecapImage(input: {
  parkName: string;
  date: string;
  ridesCompleted: number;
  estimatedWaitAvoided: number;
  snipesCaught: number;
  favoriteMoment: string;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  const gradient = ctx.createLinearGradient(0, 0, 1080, 1350);
  gradient.addColorStop(0, "#fbfbfc");
  gradient.addColorStop(1, "#ececf2");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1350);

  ctx.fillStyle = "#1d1d1f";
  ctx.font = "700 42px system-ui";
  ctx.fillText("PARK DAY RECAP", 72, 120);
  ctx.font = "800 76px system-ui";
  ctx.fillText(input.parkName, 72, 220);
  ctx.fillStyle = "#56565c";
  ctx.font = "500 34px system-ui";
  ctx.fillText(input.date, 72, 274);

  drawMetric(ctx, 72, 380, `${input.ridesCompleted}`, "rides completed");
  drawMetric(ctx, 72, 570, `${input.estimatedWaitAvoided}m`, "estimated wait saved");
  drawMetric(ctx, 72, 760, `${input.snipesCaught}`, "great snipes caught");

  ctx.fillStyle = "#ffffff";
  roundRect(ctx, 72, 970, 936, 230, 28);
  ctx.fill();
  ctx.fillStyle = "#56565c";
  ctx.font = "700 28px system-ui";
  ctx.fillText("Favorite moment", 108, 1030);
  ctx.fillStyle = "#1d1d1f";
  ctx.font = "800 44px system-ui";
  wrapCanvasText(ctx, input.favoriteMoment, 108, 1094, 828, 54);

  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image export failed"))), "image/png")
  );
}

function drawMetric(ctx: CanvasRenderingContext2D, x: number, y: number, value: string, label: string) {
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, 936, 138, 28);
  ctx.fill();
  ctx.fillStyle = "#1d1d1f";
  ctx.font = "800 58px system-ui";
  ctx.fillText(value, x + 34, y + 72);
  ctx.fillStyle = "#56565c";
  ctx.font = "700 28px system-ui";
  ctx.fillText(label, x + 34, y + 112);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const words = text.split(" ");
  let line = "";
  let currentY = y;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, currentY);
      line = word;
      currentY += lineHeight;
    } else {
      line = next;
    }
  }
  ctx.fillText(line, x, currentY);
}

function ParkMap({
  onRideSelect,
  predictions,
  rides
}: {
  onRideSelect: (ride: RideItem) => void;
  predictions: Map<string, RidePrediction>;
  rides: RideItem[];
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<import("leaflet").Map | null>(null);
  const [expanded, setExpanded] = useState(false);
  const ridesRef = useRef(rides);

  useEffect(() => {
    ridesRef.current = rides;
  }, [rides]);

  useEffect(() => {
    if (!mapRef.current || rides.length === 0) return;
    let disposed = false;
    let map: import("leaflet").Map | null = null;

    void import("leaflet").then((L) => {
      if (disposed || !mapRef.current) return;
      map = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: true,
        dragging: true,
        scrollWheelZoom: false
      });
      leafletMapRef.current = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        className: "park-map-tiles",
        maxZoom: 19
      }).addTo(map);
      const bounds = L.latLngBounds([]);
      for (const ride of rides) {
        const latLng = [ride.latitude as number, ride.longitude as number] as [number, number];
        bounds.extend(latLng);
        const waitText = minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride);
        const prediction = predictions.get(ride.id) ?? predictionForRide(ride);
        L.marker(latLng, {
          icon: L.divIcon({
            className: "",
            html: `<button type="button" data-ride-id="${ride.id}" class="map-bubble ${waitTone(ride)} recommendation-${prediction.tone}"><span aria-hidden="true">${waitCue(ride)}</span><strong>${waitText}</strong></button>`
          })
        })
          .bindTooltip(ride.name)
          .addTo(map);
      }
      map.fitBounds(bounds, {
        maxZoom: expanded ? 17 : 16,
        padding: expanded ? [42, 42] : [24, 24]
      });
      map.on("click", (event) => {
        const target = event.originalEvent.target as HTMLElement | null;
        const bubble = target?.closest?.("[data-ride-id]") as HTMLElement | null;
        const rideId = bubble?.dataset.rideId;
        const ride = ridesRef.current.find((item) => item.id === rideId);
        if (ride) onRideSelect(ride);
      });
    });

    return () => {
      disposed = true;
      leafletMapRef.current = null;
      map?.remove();
    };
  }, [expanded, onRideSelect, predictions, rides]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const map = leafletMapRef.current;
      if (!map || ridesRef.current.length === 0) return;
      map.invalidateSize();
      const L = (window as unknown as { L?: typeof import("leaflet") }).L;
      if (!L) return;
      const bounds = L.latLngBounds(
        ridesRef.current.map((ride) => [ride.latitude as number, ride.longitude as number] as [number, number])
      );
      map.fitBounds(bounds, {
        maxZoom: expanded ? 17 : 16,
        padding: expanded ? [42, 42] : [24, 24]
      });
    }, 180);
    return () => window.clearTimeout(timeoutId);
  }, [expanded]);

  if (rides.length === 0) {
    return <p className="muted">Map points will appear after the next collector refresh.</p>;
  }
  return (
    <div className={expanded ? "park-map-shell expanded" : "park-map-shell"}>
      <button onClick={() => setExpanded((current) => !current)} type="button">
        {expanded ? "Collapse map" : "Expand map"}
      </button>
      <div aria-label="Park attraction map" className="park-map" ref={mapRef} />
    </div>
  );
}
