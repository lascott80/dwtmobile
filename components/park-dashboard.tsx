"use client";

import { useEffect, useMemo, useState } from "react";
import type { ParkDetailResponse, ParkMetaResponse } from "@/lib/types";

const FAVORITES_KEY = "dwtmobile:favorites";

function minutesLabel(waitTime: number | null) {
  if (waitTime === null || Number.isNaN(waitTime)) {
    return "No posted wait";
  }
  if (waitTime === 0) {
    return "Walk on";
  }
  return `${waitTime} min`;
}

function waitTone(waitTime: number | null, isOpen: boolean) {
  if (!isOpen) return "tone-closed";
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

export function ParkDashboard() {
  const [meta, setMeta] = useState<ParkMetaResponse | null>(null);
  const [activePark, setActivePark] = useState<string>("magic-kingdom");
  const [parkData, setParkData] = useState<ParkDetailResponse | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    setLoading(true);
    fetch(`/api/parks/${activePark}`)
      .then((response) => response.json())
      .then((data: ParkDetailResponse) => {
        setParkData(data);
      })
      .finally(() => setLoading(false));
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

  const filteredLands = useMemo(() => {
    if (!parkData) return [];
    if (!favoritesOnly) return parkData.lands;
    return parkData.lands
      .map((land) => ({
        ...land,
        rides: land.rides.filter((ride) => favorites.includes(ride.id))
      }))
      .filter((land) => land.rides.length > 0);
  }, [favorites, favoritesOnly, parkData]);

  return (
    <main className="shell">
      <section className="hero-card">
        <p className="eyebrow">Disney Wait Times Mobile</p>
        <h1>Four parks, one bright-and-readable view.</h1>
        <p className="hero-copy">
          Live wait times, today&apos;s hours, featured nighttime entertainment, and
          character greetings backed by cached SQLite data.
        </p>
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
          </button>
        ))}
      </nav>

      {loading && <section className="panel">Loading cached park data...</section>}

      {!loading && parkData && (
        <>
          <section className="panel panel-stack">
            <div className="panel-head">
              <div>
                <h2>{parkData.park.shortName}</h2>
                <p className="muted">
                  Last cached update: {formatRelative(parkData.status.lastSuccessAt)}
                </p>
              </div>
              <label className="favorites-toggle">
                <input
                  checked={favoritesOnly}
                  onChange={(event) => setFavoritesOnly(event.target.checked)}
                  type="checkbox"
                />
                Favorites only
              </label>
            </div>

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
            <div className="section-head">
              <h3>Park Hours Today</h3>
            </div>
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
          </section>

          {parkData.featuredShows.length > 0 && (
            <section className="panel">
              <div className="section-head">
                <h3>Featured Showtimes</h3>
              </div>
              <div className="show-grid">
                {parkData.featuredShows.map((show) => (
                  <article className="show-card" key={`${show.id}-${show.startTime}`}>
                    <strong>{show.name}</strong>
                    <span>{formatTime(show.startTime)}</span>
                  </article>
                ))}
              </div>
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
                              <div>
                                <strong>{ride.name}</strong>
                                <p className="muted">
                                  {ride.isOpen ? ride.status : "Temporarily unavailable"}
                                </p>
                              </div>
                            </div>
                            <div className={`wait-pill ${waitTone(ride.waitTime, ride.isOpen)}`}>
                              {minutesLabel(ride.waitTime)}
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
