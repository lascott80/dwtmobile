"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LandGroup, ParkDetailResponse, ParkMetaResponse, RideHistoryPoint, RideItem } from "@/lib/types";
import { VISITOR_KEY } from "@/components/visit-tracker";

const FAVORITES_KEY = "dwtmobile:favorites";
const PARK_CACHE_KEY = "dwtmobile:park-cache";
const ALERTS_KEY = "dwtmobile:alerts";
const ONBOARDING_KEY = "dwtmobile:onboarding-dismissed";
const DAY_STATE_KEY = "dwtmobile:day-state";
const SNIPES_KEY = "dwtmobile:snipes";
type RideSort = "land" | "wait-desc" | "wait-asc" | "alpha" | "favorites";
type DashboardMode = "today" | "map" | "my-day" | "rides";
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type WeatherResponse = {
  current?: { temperature_2m?: number; precipitation?: number; weather_code?: number };
  hourly?: { time?: string[]; precipitation_probability?: number[]; precipitation?: number[] };
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

function trendLabel(trendMinutes: number | null) {
  if (trendMinutes === null || trendMinutes === 0) {
    return null;
  }
  const prefix = trendMinutes > 0 ? "+" : "";
  return `${prefix}${trendMinutes} vs 1 hr`;
}

function fallbackCrowdPulse() {
  return {
    level: "building" as const,
    headline: "Building baseline",
    detail: "Not enough live ride data yet to read the park pulse.",
    averageWaitTime: null,
    deltaFromNormal: null,
    sampleSize: 0
  };
}

function normalizeParkData(park: Partial<ParkDetailResponse>): ParkDetailResponse {
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
    crowdPulse: park.crowdPulse ?? fallbackCrowdPulse(),
    restaurants: park.restaurants ?? [],
    facilities: park.facilities ?? [],
    lands: park.lands ?? []
  };
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
  const [rideSort, setRideSort] = useState<RideSort>("land");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRide, setSelectedRide] = useState<RideItem | null>(null);
  const [rideHistory, setRideHistory] = useState<RideHistoryPoint[]>([]);
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
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const previousRidesRef = useRef<Map<string, RideItem>>(new Map());

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
    setShowOnboarding(window.localStorage.getItem(ONBOARDING_KEY) !== "true");
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
    fetch("/api/meta")
      .then((response) => response.json())
      .then((data: ParkMetaResponse) => {
        setMeta(data);
        if (!data.parks.find((park) => park.slug === activePark) && data.parks[0]) {
          setActivePark(data.parks[0].slug);
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
      fetch(`/api/parks/${slug}`).then((response) => response.json()),
      fetch("/api/meta").then((response) => response.json())
    ])
      .then(([park, parkMeta]: [ParkDetailResponse, ParkMetaResponse]) => {
        const normalizedPark = normalizeParkData(park);
        notifyFavoriteChanges(previousRidesRef.current, normalizedPark);
        setParkData(normalizedPark);
        setMeta(parkMeta);
        setOfflineMode(false);
        window.localStorage.setItem(
          `${PARK_CACHE_KEY}:${slug}`,
          JSON.stringify({
            park: normalizedPark,
            meta: parkMeta,
            cachedAt: new Date().toISOString()
          })
        );
      })
      .catch(() => {
        const raw = window.localStorage.getItem(`${PARK_CACHE_KEY}:${slug}`);
        if (!raw) return;
        try {
          const cached = JSON.parse(raw) as {
            park: Partial<ParkDetailResponse>;
            meta: ParkMetaResponse;
          };
          setParkData(normalizeParkData(cached.park));
          setMeta(cached.meta);
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
    void fetch(`/api/weather?parkSlug=${activePark}`)
      .then((response) => response.json())
      .then((data: WeatherResponse) => setWeather(data))
      .catch(() => setWeather(null));
  }, [activePark]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void fetchPark(activePark, true);
    }, 60_000);

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

  function toggleFavorite(attractionId: string) {
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
    setSelectedRide(ride);
    setRideHistory([]);
    void fetch(`/api/rides/${ride.id}/history`)
      .then((response) => response.json())
      .then((data: { points?: RideHistoryPoint[] }) => setRideHistory(data.points ?? []))
      .catch(() => setRideHistory([]));
    trackEvent("ride_sheet_open", ride.id);
  }

  function closeRideDetails() {
    setSelectedRide(null);
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

  function dismissOnboarding() {
    window.localStorage.setItem(ONBOARDING_KEY, "true");
    setShowOnboarding(false);
  }

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  async function enableAlert(rideId: string, threshold = 30) {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    setAlertThresholds((current) => {
      const next = { ...current, [rideId]: threshold };
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function disableAlert(rideId: string) {
    setAlertThresholds((current) => {
      const next = { ...current };
      delete next[rideId];
      window.localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function setRideDayState(rideId: string, state: "must-do" | "done" | "skip") {
    setDayState((current) => {
      const next = { ...current, [rideId]: state };
      window.localStorage.setItem(DAY_STATE_KEY, JSON.stringify(next));
      return next;
    });
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
      for (const [rideId, threshold] of Object.entries(alertThresholds)) {
        const previous = previousRides.get(rideId);
        const current = nextRides.get(rideId);
        if (!previous || !current) continue;
        if (!previous.isOpen && current.isOpen) {
          new Notification(`${current.name} reopened`, { body: `${park.park.shortName} is operating again.` });
        } else if (
          previous.waitTime !== null &&
          current.waitTime !== null &&
          previous.waitTime > threshold &&
          current.waitTime <= threshold
        ) {
          new Notification(`${current.name} is down to ${current.waitTime} min`, {
            body: `${park.park.shortName} crossed your ${threshold}-minute alert.`
          });
        } else if (
          current.waitTime !== null &&
          current.normalWaitTime !== null &&
          current.normalWaitTime - current.waitTime >= 10 &&
          previous.waitTime !== current.waitTime
        ) {
          new Notification(`${current.name} is unusually good right now`, {
            body: `${park.park.shortName}: ${current.waitTime} min, about ${current.normalWaitTime - current.waitTime} min below normal.`
          });
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

    if (rideSort === "land") {
      return baseLands.map((land) => ({
        ...land,
        rides: pinFavoritesFirst(land.rides, favorites)
      }));
    }

    if (rideSort === "alpha" || rideSort === "wait-desc" || rideSort === "wait-asc" || rideSort === "favorites") {
      const allRides = baseLands.flatMap((land) => land.rides);
      return [
        {
          name: rideSort === "favorites" ? "Favorites First" : "All Attractions",
          rides: sortRideList(allRides, rideSort, favorites)
        }
      ];
    }

    return baseLands;
  }, [favorites, favoritesOnly, parkData, rideSort, searchQuery]);

  const allRides = useMemo(() => parkData?.lands.flatMap((land) => land.rides) ?? [], [parkData]);
  const favoriteRides = useMemo(
    () =>
      allRides
        .filter((ride) => favorites.includes(ride.id))
        .sort((a, b) => {
          const aAdvantage =
            a.waitTime === null || a.normalWaitTime === null ? Number.MAX_SAFE_INTEGER : a.waitTime - a.normalWaitTime;
          const bAdvantage =
            b.waitTime === null || b.normalWaitTime === null ? Number.MAX_SAFE_INTEGER : b.waitTime - b.normalWaitTime;
          return aAdvantage - bAdvantage || (a.waitTime ?? Number.MAX_SAFE_INTEGER) - (b.waitTime ?? Number.MAX_SAFE_INTEGER);
        }),
    [allRides, favorites]
  );
  const notableChanges = useMemo(
    () =>
      allRides
        .filter(
          (ride) =>
            (ride.isOpen && ride.previousIsOpen === false) ||
            (!ride.isOpen && ride.previousIsOpen === true) ||
            Math.abs(ride.trendMinutes ?? 0) >= 5
        )
        .sort((a, b) => {
          const aReopen = Number(a.isOpen && a.previousIsOpen === false);
          const bReopen = Number(b.isOpen && b.previousIsOpen === false);
          if (aReopen !== bReopen) return bReopen - aReopen;
          return Math.abs(b.trendMinutes ?? 0) - Math.abs(a.trendMinutes ?? 0);
        })
        .slice(0, 3),
    [allRides]
  );
  const bestBets = useMemo(
    () =>
      allRides
        .filter((ride) => ride.isOpen && ride.waitTime !== null && ride.normalWaitTime !== null)
        .map((ride) => ({
          ride,
          advantage: (ride.normalWaitTime as number) - (ride.waitTime as number)
        }))
        .filter(({ advantage }) => advantage >= 5)
        .sort((a, b) => b.advantage - a.advantage || (a.ride.waitTime ?? 999) - (b.ride.waitTime ?? 999))
        .slice(0, 3),
    [allRides]
  );
  const nextFeaturedShow = useMemo(() => {
    if (!parkData) return null;
    const now = Date.now();
    return parkData.featuredShows.find((show) => new Date(show.startTime).getTime() >= now) ?? null;
  }, [parkData]);
  const personalChanges = useMemo(
    () => notableChanges.filter((ride) => favorites.includes(ride.id)).slice(0, 2),
    [favorites, notableChanges]
  );
  const mustDoRides = useMemo(() => allRides.filter((ride) => dayState[ride.id] === "must-do"), [allRides, dayState]);
  const doneRides = useMemo(() => allRides.filter((ride) => dayState[ride.id] === "done"), [allRides, dayState]);
  const skippedRides = useMemo(() => allRides.filter((ride) => dayState[ride.id] === "skip"), [allRides, dayState]);
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
    const rainLikely = nextHourRainChance(weather) >= 40;
    const candidates = allRides
      .filter((ride) => ride.isOpen && ride.waitTime !== null && dayState[ride.id] !== "done" && dayState[ride.id] !== "skip")
      .map((ride) => {
        const advantage =
          ride.normalWaitTime === null || ride.waitTime === null ? 0 : Math.max(0, ride.normalWaitTime - ride.waitTime);
        const mustDoBonus = dayState[ride.id] === "must-do" ? 20 : 0;
        const favoriteBonus = favorites.includes(ride.id) ? 10 : 0;
        const indoorBonus = rainLikely && isLikelyIndoor(ride.name) ? 14 : 0;
        const shortWaitBonus = (ride.waitTime ?? Number.MAX_SAFE_INTEGER) <= 20 ? 8 : 0;
        return {
          ride,
          advantage,
          rainLikely,
          score: advantage + mustDoBonus + favoriteBonus + indoorBonus + shortWaitBonus
        };
      })
      .sort((a, b) => b.score - a.score || (a.ride.waitTime ?? 999) - (b.ride.waitTime ?? 999));
    const top = candidates[0];
    if (!top) return null;
    const reasons = [
      top.advantage >= 10 ? `${top.advantage} min below normal` : null,
      dayState[top.ride.id] === "must-do" ? "on your must-do list" : null,
      rainLikely && isLikelyIndoor(top.ride.name) ? "rain-friendly" : null,
      top.ride.waitTime !== null && top.ride.waitTime <= 20 ? "short wait" : null
    ].filter(Boolean);
    return {
      ride: top.ride,
      headline: `Go to ${top.ride.name}`,
      detail: `${minutesLabel(top.ride.waitTime, top.ride.isOpen)}${reasons.length ? ` · ${reasons.join(" · ")}` : ""}`,
      rainLikely
    };
  }, [allRides, dayState, favorites, weather]);
  const mappedRides = useMemo(() => allRides.filter((ride) => ride.latitude !== null && ride.longitude !== null), [allRides]);
  const nearbyRides = useMemo(() => {
    if (!userLocation) return [];
    return mappedRides
      .map((ride) => ({
        ride,
        distance: distanceMiles(userLocation.latitude, userLocation.longitude, ride.latitude as number, ride.longitude as number)
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
  }, [mappedRides, userLocation]);
  const partyFilteredRides = useMemo(() => {
    if (partyFilter === "open") return allRides.filter((ride) => ride.isOpen);
    if (partyFilter === "favorites") return allRides.filter((ride) => favorites.includes(ride.id));
    if (partyFilter === "short") return allRides.filter((ride) => ride.isOpen && (ride.waitTime ?? 999) <= 20);
    return allRides;
  }, [allRides, favorites, partyFilter]);
  const timelineItems = useMemo(() => {
    const items = [
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
  }, [favoriteRides, parkData]);

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

  return (
    <main className="shell" ref={shellRef}>
      <section className="hero-card">
        <h1>Disney Wait Times Mobile</h1>
      </section>

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

      {loading && <section className="panel">Loading cached park data...</section>}

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
            <section className="panel">
              <div className="notice state-card">
                <strong>Data may be stale</strong>
                <p>This park hasn&apos;t refreshed in the last 20 minutes, so some waits may be out of date.</p>
              </div>
            </section>
          )}

          {parkData.status.lastError && (
            <section className="panel">
              <div className="notice subtle state-card">
                <strong>Polling note</strong>
                <p>{parkData.status.lastError}</p>
              </div>
            </section>
          )}

          {offlineMode && (
            <section className="panel">
              <div className="notice subtle state-card">
                <strong>Offline cache in use</strong>
                <p>You&apos;re viewing the last saved park snapshot until a fresh connection returns.</p>
              </div>
            </section>
          )}

          <section className={`panel today-card pulse-${parkData.crowdPulse.level}`}>
            <div>
              <p>Today in {parkData.park.shortName}</p>
              <strong>{parkData.crowdPulse.headline}</strong>
            </div>
            <span>{parkData.crowdPulse.detail}</span>
            <div className="today-grid">
              <article>
                <small>Best now</small>
                <strong>{bestFavorite?.name ?? bestBets[0]?.ride.name ?? "Building"}</strong>
                <span>
                  {bestFavorite
                    ? minutesLabel(bestFavorite.waitTime, bestFavorite.isOpen) ?? statusLabel(bestFavorite)
                    : bestBets[0]
                      ? `${bestBets[0].advantage} min below normal`
                      : "More history needed"}
                </span>
              </article>
              <article>
                <small>Next show</small>
                <strong>{nextFeaturedShow?.name ?? "No show ahead"}</strong>
                <span>{nextFeaturedShow ? formatTime(nextFeaturedShow.startTime) : "—"}</span>
              </article>
            </div>
          </section>

          {parkCopilot && (
            <section className="panel copilot-card">
              <div className="utility-head">
                <p>Park Copilot</p>
                <strong>{parkCopilot.rainLikely ? "Weather-aware" : "Right now"}</strong>
              </div>
              <button onClick={() => openRideDetails(parkCopilot.ride)} type="button">
                <strong>{parkCopilot.headline}</strong>
                <span>{parkCopilot.detail}</span>
              </button>
            </section>
          )}

          <nav className="mode-tabs" aria-label="Dashboard sections">
            {(["today", "map", "my-day", "rides"] as const).map((mode) => (
              <button
                className={dashboardMode === mode ? "active" : ""}
                key={mode}
                onClick={() => setDashboardMode(mode)}
                type="button"
              >
                {mode === "my-day" ? "My Day" : mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </nav>

          {dashboardMode === "today" && (
            <>
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
              <section className="panel">
                <details>
                  <summary>Park Hours Today</summary>
                  <div className="details-body">
                    {parkData.hours.length === 0 ? (
                      <p className="muted">Hours are unavailable right now.</p>
                    ) : (
                      <div className="hour-list">
                        {parkData.hours.map((entry) => (
                          <article className="hour-chip" key={`${entry.type}-${entry.openingTime}`}>
                            <strong>{entry.description ?? entry.type.replaceAll("_", " ")}</strong>
                            <span>{formatHourRange(entry.openingTime, entry.closingTime)}</span>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              </section>
              {parkData.featuredShows.length > 0 && (
                <section className="panel">
                  <details>
                    <summary>Featured Showtimes</summary>
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
            </>
          )}

          {dashboardMode === "my-day" && <section className="panel my-day-card">
            <div className="my-day-head">
              <p>My Park Day</p>
              <strong>{favorites.length > 0 ? `${favorites.length} saved` : "Not personalized yet"}</strong>
            </div>
            <div className="my-day-grid">
              <article>
                <span>Best favorite</span>
                {bestFavorite ? (
                  <button onClick={() => openRideDetails(bestFavorite)} type="button">
                    <strong>{bestFavorite.name}</strong>
                    <small>{minutesLabel(bestFavorite.waitTime, bestFavorite.isOpen) ?? statusLabel(bestFavorite)}</small>
                  </button>
                ) : (
                  <em>Save a ride to start shaping your day.</em>
                )}
              </article>
              <article>
                <span>Next show</span>
                {nextFeaturedShow ? (
                  <>
                    <strong>{nextFeaturedShow.name}</strong>
                    <small>{formatTime(nextFeaturedShow.startTime)}</small>
                  </>
                ) : (
                  <em>No featured show ahead right now.</em>
                )}
              </article>
            </div>
            <div className="my-day-changes">
              <span>For you</span>
              {personalChanges.length > 0 ? (
                personalChanges.map((ride) => (
                  <button key={ride.id} onClick={() => openRideDetails(ride)} type="button">
                    <strong>{ride.name}</strong>
                    <small>{changeLabel(ride)}</small>
                  </button>
                ))
              ) : (
                <em>Favorite a few rides and the useful changes will gather here.</em>
              )}
            </div>
          </section>}

          {dashboardMode === "my-day" && <section className="panel day-state-card">
            <div className="utility-head">
              <p>Plan state</p>
              <strong>{doneRides.length} done</strong>
            </div>
            <div className="day-state-grid">
              <article><span>Must-do</span><strong>{mustDoRides.length}</strong></article>
              <article><span>Done</span><strong>{doneRides.length}</strong></article>
              <article><span>Skip</span><strong>{skippedRides.length}</strong></article>
            </div>
          </section>}

          {dashboardMode === "my-day" && <section className="panel recap-card">
            <div className="utility-head">
              <p>Park day recap</p>
              <strong>So far</strong>
            </div>
            <div className="recap-grid">
              <article><span>Completed</span><strong>{recap.ridesCompleted}</strong></article>
              <article><span>Wait saved</span><strong>{recap.estimatedWaitAvoided}m</strong></article>
              <article><span>Snipes</span><strong>{recap.snipesCaught}</strong></article>
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
            <ParkMap rides={mappedRides} />
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

          {dashboardMode === "my-day" && <section className="panel timeline-card">
            <div className="utility-head">
              <p>My Day timeline</p>
              <strong>{timelineItems.length} items</strong>
            </div>
            {timelineItems.length > 0 ? timelineItems.map((item) => (
              <div key={item.key}>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </div>
            )) : <em>Save rides to begin a personal timeline.</em>}
          </section>}

          {dashboardMode === "today" && <section className="panel">
            <details>
              <summary>Character Meet &amp; Greet Times</summary>
              <div className="details-body">
                {parkData.meetGreets.length === 0 ? (
                  <p className="muted">No character meeting times are posted right now.</p>
                ) : (
                  <div className="show-grid">
                    {parkData.meetGreets.map((show) => (
                      <article className="show-card" key={`${show.id}-${show.startTime}`}>
                        <strong>{show.name}</strong>
                        <span>{formatHourRange(show.startTime, show.endTime ?? show.startTime)}</span>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </section>}

          {dashboardMode === "rides" && <section className="panel ride-panel">
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
            </div>
            <label className="search-field">
              <span>Search rides</span>
              <input
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search attractions"
                type="search"
                value={searchQuery}
              />
            </label>
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
                        return (
                          <article className={favorite ? "ride-row favorite-row" : "ride-row"} key={ride.id}>
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
                                  {trendLabel(ride.trendMinutes) && (
                                    <span className="ride-trend">{trendLabel(ride.trendMinutes)}</span>
                                  )}
                                </div>
                              </div>
                              <div className="ride-side">
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
                ×
              </button>
            </div>

            <div className="sheet-meta">
              <div className={`wait-pill ${pillVariant(selectedRide)} ${waitTone(selectedRide)}`}>
                <span aria-hidden="true">{waitCue(selectedRide)}</span>
                {minutesLabel(selectedRide.waitTime, selectedRide.isOpen) ?? statusLabel(selectedRide)}
              </div>
              <button
                className={favorites.includes(selectedRide.id) ? "sheet-favorite active" : "sheet-favorite"}
                onClick={() => toggleFavorite(selectedRide.id)}
                type="button"
              >
                {favorites.includes(selectedRide.id) ? "★ Favorited" : "☆ Add favorite"}
              </button>
            </div>

            <div className="sheet-alert-row">
              {alertThresholds[selectedRide.id] ? (
                <>
                  <span>Alert below {alertThresholds[selectedRide.id]} min</span>
                  <button onClick={() => disableAlert(selectedRide.id)} type="button">Turn off</button>
                </>
              ) : (
                <>
                  <span>Favorite alert</span>
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
            </div>
            <section className="history-card">
              <div>
                <span>Today&apos;s wait history</span>
                <strong>{rideHistory.length > 1 ? `${rideHistory.length} samples` : "Building"}</strong>
              </div>
              <RideHistoryChart points={rideHistory} />
            </section>
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

function RideHistoryChart({ points }: { points: RideHistoryPoint[] }) {
  const usable = points.filter((point) => point.waitTime !== null);
  if (usable.length < 2) {
    return <p className="muted">More samples are needed before a trend line appears.</p>;
  }
  const maxWait = Math.max(...usable.map((point) => point.waitTime as number), 1);
  const polyline = usable
    .map((point, index) => {
      const x = (index / Math.max(usable.length - 1, 1)) * 100;
      const y = 44 - ((point.waitTime as number) / maxWait) * 36;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg aria-label="Ride wait history chart" className="history-chart" role="img" viewBox="0 0 100 48">
      <polyline points={polyline} />
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

function nextHourRainChance(weather: WeatherResponse | null) {
  const times = weather?.hourly?.time ?? [];
  const chances = weather?.hourly?.precipitation_probability ?? [];
  const now = Date.now();
  const index = times.findIndex((time) => new Date(time).getTime() >= now);
  return index >= 0 ? chances[index] ?? 0 : 0;
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

function ParkMap({ rides }: { rides: RideItem[] }) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<import("leaflet").Map | null>(null);
  const [expanded, setExpanded] = useState(false);

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
        maxZoom: 19
      }).addTo(map);
      const bounds = L.latLngBounds([]);
      for (const ride of rides) {
        const latLng = [ride.latitude as number, ride.longitude as number] as [number, number];
        bounds.extend(latLng);
        const waitText = minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride);
        L.marker(latLng, {
          icon: L.divIcon({
            className: "",
            html: `<span class="map-bubble ${waitTone(ride)}"><span aria-hidden="true">${waitCue(ride)}</span>${waitText}</span>`
          })
        })
          .bindTooltip(ride.name)
          .addTo(map);
      }
      map.fitBounds(bounds.pad(0.18));
    });

    return () => {
      disposed = true;
      leafletMapRef.current = null;
      map?.remove();
    };
  }, [rides]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => leafletMapRef.current?.invalidateSize(), 180);
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
