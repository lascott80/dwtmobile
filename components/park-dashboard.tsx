"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LandGroup, ParkDetailResponse, ParkMetaResponse, RideItem } from "@/lib/types";

const FAVORITES_KEY = "dwtmobile:favorites";
type RideSort = "land" | "wait-desc" | "wait-asc" | "alpha" | "favorites";

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
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [rideSort, setRideSort] = useState<RideSort>("land");
  const [selectedRide, setSelectedRide] = useState<RideItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chromeElevated, setChromeElevated] = useState(false);

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
      return next;
    });
  }

  function openRideDetails(ride: RideItem) {
    setSelectedRide(ride);
  }

  function closeRideDetails() {
    setSelectedRide(null);
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
  }, [favorites, favoritesOnly, parkData, rideSort]);

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
              <div>
                <h3>Ride Wait Times</h3>
                <p className="muted">
                  {refreshing
                    ? "Refreshing..."
                    : `Last data refresh: ${formatRelative(parkData.status.lastSuccessAt)}`}
                </p>
              </div>
            </div>
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
                              aria-haspopup="dialog"
                              className="ride-main"
                              onClick={() => openRideDetails(ride)}
                              type="button"
                            >
                              <div className="ride-copy">
                                <button
                                  aria-label={favorite ? "Remove favorite" : "Add favorite"}
                                  className={favorite ? "favorite active" : "favorite"}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleFavorite(ride.id);
                                  }}
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
                              <div className="ride-side">
                                <div className={`wait-pill ${pillVariant(ride)} ${waitTone(ride)}`}>
                                  {minutesLabel(ride.waitTime, ride.isOpen) ?? statusLabel(ride)}
                                </div>
                                <span className="ride-chevron">+</span>
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
          </section>
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
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
