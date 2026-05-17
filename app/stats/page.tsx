import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DB_PATH, PARKS } from "@/lib/config";
import { getStorageStats, getTrafficStats, getUsageStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value: string | null) {
  if (!value) return "No data yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function healthTone(ok: boolean) {
  return ok ? "healthy" : "warning";
}

export default function StatsPage() {
  const traffic = getTrafficStats();
  const usage = getUsageStats();
  const storage = existsSync(DB_PATH) ? getStorageStats() : null;
  const gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  const buildTime = new Date().toISOString();
  const allParksReporting = storage ? storage.health.parksWithData === storage.health.expectedParks : false;
  const dataFresh = storage ? (storage.health.latestSnapshotAgeMinutes ?? Number.MAX_SAFE_INTEGER) <= 20 : false;
  const noCollectorErrors = storage ? storage.health.parksWithErrors === 0 : false;
  const coverageHealthy = storage
    ? storage.coverageQuality.ridesMissingLand === 0 && storage.coverageQuality.ridesWithoutRecentData === 0
    : false;
  const overallHealthy = Boolean(storage && allParksReporting && dataFresh && noCollectorErrors && coverageHealthy);
  const rideNameMap = new Map(storage?.rideNames.map((ride) => [ride.id, ride.name]));
  const parkNameMap = new Map(PARKS.map((park) => [park.slug, park.shortName]));
  const alerts = storage
    ? [
        storage.health.staleParks > 0 ? `${storage.health.staleParks} park(s) stale` : null,
        storage.health.parksWithErrors > 0 ? `${storage.health.parksWithErrors} park(s) with collector errors` : null,
        storage.coverageQuality.ridesWithoutRecentData > 0
          ? `${storage.coverageQuality.ridesWithoutRecentData} rides without recent data`
          : null,
        storage.coverageQuality.ridesMissingLand > 0
          ? `${storage.coverageQuality.ridesMissingLand} rides missing land metadata`
          : null
      ].filter(Boolean)
    : ["Collector database unavailable"];

  return (
    <main className="noc-shell">
      <header className="noc-hero">
        <div>
          <p>Operations</p>
          <h1>Data Health</h1>
        </div>
        <strong className={`health-pill ${healthTone(overallHealthy)}`}>
          {overallHealthy ? "Healthy" : "Attention needed"}
        </strong>
      </header>

      {alerts.length > 0 && (
        <section className="alert-strip">
          {alerts.map((alert) => (
            <span key={alert}>{alert}</span>
          ))}
        </section>
      )}

      <section className="health-grid">
        <article className={`health-card ${healthTone(allParksReporting)}`}>
          <span>Park coverage</span>
          <strong>{storage ? `${storage.health.parksWithData}/${storage.health.expectedParks}` : "0/4"}</strong>
          <small>parks reporting</small>
        </article>
        <article className={`health-card ${healthTone(dataFresh)}`}>
          <span>Latest snapshot</span>
          <strong>{storage?.health.latestSnapshotAgeMinutes == null ? "n/a" : `${storage.health.latestSnapshotAgeMinutes}m`}</strong>
          <small>age</small>
        </article>
        <article className={`health-card ${healthTone(noCollectorErrors)}`}>
          <span>Collector errors</span>
          <strong>{storage ? storage.health.parksWithErrors : 0}</strong>
          <small>parks</small>
        </article>
        <article className={`health-card ${healthTone(coverageHealthy)}`}>
          <span>Coverage issues</span>
          <strong>{storage ? storage.coverageQuality.ridesWithoutRecentData + storage.coverageQuality.ridesMissingLand : 0}</strong>
          <small>rides</small>
        </article>
      </section>

      <section className="noc-metrics">
        <article><span>Unique visitors</span><strong>{formatNumber(traffic.uniqueVisitors)}</strong></article>
        <article><span>Page views</span><strong>{formatNumber(traffic.pageViews)}</strong></article>
        <article><span>Wait snapshots</span><strong>{formatNumber(storage?.totals.waitSnapshots ?? 0)}</strong></article>
        <article><span>Showtimes</span><strong>{formatNumber(storage?.totals.showtimes ?? 0)}</strong></article>
        <article><span>Days covered</span><strong>{storage?.retention.daysCovered ?? 0}</strong></article>
        <article><span>Days to full window</span><strong>{storage?.retention.daysUntilFullWindow ?? 60}</strong></article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Collector SLA</h2><span>Expected vs observed</span></div>
          <div className="mini-metrics">
            <span>Expected cycles / 24h <strong>{storage?.sla.expectedCyclesLast24h ?? 216}</strong></span>
            <span>Completed cycles / 24h <strong>{storage?.sla.completedCyclesLast24h ?? 0}</strong></span>
            <span>Completion rate <strong>{storage ? `${Math.round((storage.sla.completedCyclesLast24h / storage.sla.expectedCyclesLast24h) * 100)}%` : "0%"}</strong></span>
          </div>
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Deployment</h2><span>Current server context</span></div>
          <div className="mini-metrics">
            <span>Git SHA <strong>{gitSha}</strong></span>
            <span>Build time <strong>{formatDate(buildTime)}</strong></span>
            <span>DB footprint <strong>{formatBytes(storage?.storageFootprint.databaseBytes ?? 0)}</strong></span>
            <span>Schema tables <strong>10</strong></span>
          </div>
        </article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Polling Timeline</h2><span>Last 24 hours</span></div>
          <div className="timeline-list">
            {storage?.pollingTimeline.length ? storage.pollingTimeline.map((item) => (
              <div key={item.hour}><strong>{item.hour}</strong><span>{item.successes} ok</span><em>{item.failures} fail</em></div>
            )) : <p>No cycle telemetry yet.</p>}
          </div>
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Snapshot Growth</h2><span>Last 24 hours</span></div>
          <div className="timeline-list">
            {storage?.dataGrowth.map((item) => (
              <div key={item.hour}><strong>{item.hour}</strong><span>{formatNumber(item.snapshots)} snapshots</span></div>
            ))}
          </div>
        </article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>API Source Health</h2></div>
          <div className="source-list">
            {storage?.sourceHealth.length ? storage.sourceHealth.map((source) => (
              <div key={source.source}>
                <strong>{source.source}</strong>
                <span>{formatDate(source.checkedAt)}</span>
                <em className={source.success ? "healthy" : "warning"}>{source.success ? "Healthy" : "Failing"}</em>
              </div>
            )) : <p>No source checks recorded yet.</p>}
          </div>
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Collector Runtime</h2></div>
          <div className="mini-metrics">
            <span>Cycles / 24h <strong>{storage?.runtime.cyclesLast24h ?? 0}</strong></span>
            <span>Avg cycle <strong>{storage?.runtime.averageCycleSeconds ?? "n/a"}s</strong></span>
            <span>Last cycle <strong>{storage?.runtime.lastCycleSeconds ?? "n/a"}s</strong></span>
          </div>
        </article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Source Latency Trend</h2><span>Last 24 hours</span></div>
          <div className="source-list">
            {storage?.sourceLatencyTrend.length ? storage.sourceLatencyTrend.map((source) => (
              <div key={source.source}>
                <strong>{source.source}</strong>
                <span>{source.checks} checks</span>
                <em>{source.avgDurationMs ?? 0} ms avg</em>
              </div>
            )) : <p>No latency data yet.</p>}
          </div>
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Error History</h2><span>Last 7 days</span></div>
          <div className="source-list">
            {storage?.recentErrors.length ? storage.recentErrors.map((entry) => (
              <div key={`${entry.source}-${entry.error}`}>
                <strong>{entry.source}</strong>
                <span>{entry.occurrences}x, last {formatDate(entry.lastSeenAt)}</span>
                <em className="warning">Error</em>
              </div>
            )) : <p>No recent source errors.</p>}
          </div>
        </article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Top Movers Today</h2></div>
          <div className="source-list">
            {storage?.topMovers.map((ride) => (
              <div key={`${ride.parkName}-${ride.name}`}><strong>{ride.name}</strong><span>{ride.parkName}</span><em>{ride.swing} min</em></div>
            ))}
          </div>
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Data Anomalies</h2></div>
          <div className="mini-metrics">
            <span>Flatline rides <strong>{storage?.anomalies.flatlineRides.length ?? 0}</strong></span>
            <span>Parks with low snapshot coverage <strong>{storage?.anomalies.attractionCoverageDrops.length ?? 0}</strong></span>
          </div>
          {storage && storage.anomalies.flatlineRides.length > 0 && (
            <div className="metadata-list">
              {storage.anomalies.flatlineRides.map((ride) => (
                <span key={`${ride.parkName}-${ride.name}`}>
                  <strong>{ride.name}</strong>
                  {ride.parkName} flat for {ride.samples} samples
                </span>
              ))}
            </div>
          )}
          {storage && storage.anomalies.attractionCoverageDrops.length > 0 && (
            <div className="metadata-list">
              {storage.anomalies.attractionCoverageDrops.map((park) => (
                <span key={park.slug}>
                  <strong>{park.shortName}</strong>
                  low snapshot coverage vs attraction count
                </span>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Coverage Quality</h2></div>
          <div className="mini-metrics">
            <span>Missing land <strong>{storage?.coverageQuality.ridesMissingLand ?? 0}</strong></span>
            <span>Null waits <strong>{storage?.coverageQuality.ridesWithNullWait ?? 0}</strong></span>
            <span>No recent data <strong>{storage?.coverageQuality.ridesWithoutRecentData ?? 0}</strong></span>
          </div>
          {storage && storage.ridesMissingLandMetadata.length > 0 && (
            <div className="metadata-list">
              {storage.ridesMissingLandMetadata.map((ride) => (
                <span key={ride.id}>
                  <strong>{ride.name}</strong>
                  {ride.parkName}
                </span>
              ))}
            </div>
          )}
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Freshness Heatmap</h2><span>Snapshots in last 12 hours</span></div>
          <div className="heatmap-grid">
            {PARKS.map((park) => {
              const rows = storage?.freshnessHeatmap.filter((item) => item.parkSlug === park.slug) ?? [];
              return (
                <article key={park.slug}>
                  <strong>{park.shortName}</strong>
                  <div>{rows.map((row) => <span key={row.hour} title={`${row.hour}: ${row.snapshots}`}>{row.snapshots}</span>)}</div>
                </article>
              );
            })}
          </div>
        </article>
      </section>

      <section className="noc-columns">
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>Usage Shape</h2></div>
          <div className="usage-list">
            <span>Top parks: {usage.topParks.map((item) => `${parkNameMap.get(item.slug) ?? item.slug} (${item.views})`).join(", ") || "No data yet"}</span>
            <span>Top ride sheets: {usage.topRideSheets.map((item) => `${rideNameMap.get(item.rideId) ?? item.rideId} (${item.opens})`).join(", ") || "No data yet"}</span>
            <span>Top favorites: {usage.topFavorites.map((item) => `${rideNameMap.get(item.rideId) ?? item.rideId} (${item.toggles})`).join(", ") || "No data yet"}</span>
          </div>
        </article>
        <article className="noc-panel">
          <div className="noc-panel-head"><h2>By Park</h2><span>{storage && `Range: ${formatDate(storage.totals.firstSnapshotAt)} - ${formatDate(storage.totals.lastSnapshotAt)}`}</span></div>
          <div className="noc-table compact">
            {storage?.parks.map((park) => {
              const stale = !park.lastSuccessAt || Date.now() - new Date(park.lastSuccessAt).getTime() > 1000 * 60 * 20;
              return (
                <article key={park.slug}>
                  <strong>{park.shortName}</strong>
                  <span>{formatNumber(park.waitSnapshots)} snapshots</span>
                  <span>{formatDate(park.lastSuccessAt)}</span>
                  <em className={stale ? "warning" : "healthy"}>{stale ? "Stale" : "Fresh"}</em>
                </article>
              );
            })}
          </div>
        </article>
      </section>
    </main>
  );
}
