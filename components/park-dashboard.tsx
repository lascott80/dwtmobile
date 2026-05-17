"use client";

import { useEffect, useMemo, useState } from "react";
import type { LandGroup, ParkDetailResponse, ParkHoursEntry, ParkMetaResponse, RideItem } from "@/lib/types";

const FAVORITES_KEY = "dwtmobile:favorites";
type RideSort = "land" | "wait-desc" | "wait-asc" | "alpha" | "favorites";

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

function isCurrent(entry: ParkHoursEntry, now: Date) {
  return new Date(entry.openingTime) <= now && now <= new Date(entry.closingTime);
}

function currentOperatingHours(hours: ParkHoursEntry[]) {
  return hours.find((entry) => entry.type === "OPERATING") ?? null;
}

function buildParkChips(hours: ParkHoursEntry[]) {
  const chips: string[] = [];
  const now = new Date();
  const operating = currentOperatingHours(hours);

  if (operating) {
    const openNow = isCurrent(operating, now);
    chips.push(openNow ? "Open now" : now < new Date(operating.openingTime) ? "Opens later" : "Closed");
    chips.push(`${openNow ? "Closes" : "Hours"} ${formatTime(operating.closingTime)}`);
  } else {
    chips.push("Hours unavailable");
  }

  for (const entry of hours) {
    const label = entry.description ?? entry.type.replaceAll("_", " ");
    if (entry.type !== "OPERATING") {
      chips.push(label);
    }
  }

  return chips;
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
  const [meta, setMeta] = useState<ParkMetaResponse | null>(null);
  const [activePark, setActivePark] = useState<string>("magic-kingdom");
  const [parkData, setParkData] = useState<ParkDetailResponse | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [rideSort, setRideSort] = useState<RideSort>("land");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
        setParkData(park);
        setMeta(parkMeta);
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
    const intervalId = window.setInterval(() => {
      void fetchPark(activePark, true);
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, [activePark]);

  function toggleFavorite(attractionId: string) {
    setFavorites((current) => {
      const next = current.includes(attractionId)
        ? current.filter((id) => id !== attractionId)
        : [...current, attractionId];
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }

  const filteredLands = useMemo<LandGroup[]>(() => {
    if (!parkData) return [];
    const baseLands = !favoritesOnly
      ? parkData.lands
      : parkData.lands
      .map((land) => ({
        ...land,
        rides: land.rides.filter((ride) => favorites.includes(ride.id))
      }))
      .filter((land) => land.rides.length > 0);

    if (rideSort === "land") {
      return baseLands;
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
  }, [favorites, favoritesOnly, parkData, rideSort]);

  const parkChips = useMemo(() => (parkData ? buildParkChips(parkData.hours) : []), [parkData]);

  return (
    <main className="shell">
      <section className="hero-card">
        <h1>Disney Wait Times Mobile</h1>
      </section>

      <nav className="park-tabs" aria-label="Walt Disney World parks">
        {meta?.parks.map((park) => (
          <button
            key={park.slug}
            className={park.slug === activePark ? "park-tab active" : "park-tab"}
            onClick={() => setActivePark(park.slug)}
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
          <section className="panel panel-stack meta-tile">
            <div className="meta-row">
              <p className="muted">
                {refreshing
                  ? "Refreshing..."
                  : `Last cached update: ${formatRelative(parkData.status.lastSuccessAt)}`}
              </p>
              <label className="favorites-toggle">
                <input
                  checked={favoritesOnly}
                  onChange={(event) => setFavoritesOnly(event.target.checked)}
                  type="checkbox"
                />
                Favorites only
              </label>
            </div>

            {parkChips.length > 0 && (
              <div className="chip-row">
                {parkChips.map((chip) => (
                  <span className="status-chip" key={chip}>
                    {chip}
                  </span>
                ))}
              </div>
            )}

            {!parkData.status.hasData && (
              <div className="notice">
                No cached data is available yet. Start the Python collector to begin polling.
              </div>
            )}

            {parkData.status.stale && parkData.status.hasData && (
              <div className="notice">
                Cached data is older than 20 minutes, so some values may be stale.
              </div>
            )}

            {parkData.status.lastError && (
              <div className="notice subtle">
                Latest polling note: {parkData.status.lastError}
              </div>
            )}
          </section>

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

          <section className="panel">
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
          </section>

          <section className="panel">
            <div className="section-head">
              <h3>Ride Wait Times</h3>
              <p className="muted">Grouped by land with high-contrast wait indicators.</p>
            </div>
            <div className="sort-bar" role="group" aria-label="Sort ride wait times">
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
            </div>
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
                          <article className="ride-row" key={ride.id}>
                            <div className="ride-copy">
                              <button
                                aria-label={favorite ? "Remove favorite" : "Add favorite"}
                                className={favorite ? "favorite active" : "favorite"}
                                onClick={() => toggleFavorite(ride.id)}
                                type="button"
                              >
                                {favorite ? "★" : "☆"}
                              </button>
                              <div className="ride-text">
                                <strong>{ride.name}</strong>
                                {trendLabel(ride.trendMinutes) && (
                                  <span className="ride-trend">{trendLabel(ride.trendMinutes)}</span>
                                )}
                              </div>
                            </div>
                            <div className={`wait-pill ${waitTone(ride)}`}>
                              {minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <footer className="footer-note">
        <a href="https://queue-times.com/" rel="noreferrer" target="_blank">
          Powered by Queue-Times.com
        </a>
      </footer>
    </main>
  );
}
