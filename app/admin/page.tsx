import { execFileSync } from "node:child_process";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Activity, RefreshCw, Save, Settings2, SlidersHorizontal } from "lucide-react";
import {
  ADMIN_FEATURE_FLAGS,
  ADMIN_SOURCES,
  getAdminActivity,
  getAdminRideCatalog,
  getCollectorStatus,
  getDefaultHiddenRideIds,
  getFeatureFlags,
  getGlobalHiddenRideIds,
  getSourceControls,
  saveFeatureFlags,
  recordAdminActivity,
  saveRideVisibility,
  saveSourceControls
} from "@/lib/admin-settings";
import { PARKS } from "@/lib/config";

export const dynamic = "force-dynamic";

async function saveRideControls(formData: FormData) {
  "use server";

  const defaultRideIds = formData
    .getAll("defaultRideId")
    .filter((value): value is string => typeof value === "string");
  const globalRideIds = formData
    .getAll("globalRideId")
    .filter((value): value is string => typeof value === "string");
  saveRideVisibility(defaultRideIds, globalRideIds);
  revalidatePath("/admin");
  revalidatePath("/api/meta");
  revalidatePath("/api/parks/[parkSlug]");
  redirect(`/admin?notice=${encodeURIComponent("Ride visibility saved")}`);
}

async function saveSources(formData: FormData) {
  "use server";

  const disabledSourceIds = formData
    .getAll("disabledSourceId")
    .filter((value): value is string => typeof value === "string");
  saveSourceControls(disabledSourceIds);
  revalidatePath("/admin");
  redirect(`/admin?notice=${encodeURIComponent("Source toggles saved")}`);
}

async function saveFeatures(formData: FormData) {
  "use server";

  saveFeatureFlags({
    recommendations: formData.get("feature:recommendations") === "on",
    map: formData.get("feature:map") === "on",
    weather: formData.get("feature:weather") === "on"
  });
  revalidatePath("/admin");
  revalidatePath("/api/meta");
  redirect(`/admin?notice=${encodeURIComponent("Feature flags saved")}`);
}

async function refreshCollector(formData: FormData) {
  "use server";

  const parkSlug = formData.get("parkSlug");
  const args = ["python-service/collector.py", "--once"];
  if (typeof parkSlug === "string" && parkSlug) {
    args.push("--park", parkSlug);
  }
  const label = typeof parkSlug === "string" && parkSlug ? PARKS.find((park) => park.slug === parkSlug)?.shortName ?? parkSlug : "all parks";
  try {
    execFileSync("python3", args, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 120_000,
      stdio: "pipe"
    });
    recordAdminActivity("Force refresh", `Completed refresh for ${label}`);
  } catch (error) {
    recordAdminActivity("Force refresh failed", `Could not refresh ${label}`);
    redirect(`/admin?notice=${encodeURIComponent(`Refresh failed for ${label}`)}`);
  }
  revalidatePath("/admin");
  revalidatePath("/stats");
  revalidatePath("/api/meta");
  revalidatePath("/api/parks/[parkSlug]");
  redirect(`/admin?notice=${encodeURIComponent(`Refresh completed for ${label}`)}`);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "No data yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAge(value: string | null | undefined) {
  if (!value) return "No data";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export default async function AdminPage({
  searchParams
}: {
  searchParams?: Promise<{ notice?: string }>;
}) {
  const params = await searchParams;
  const rides = getAdminRideCatalog();
  const defaultHiddenRideIds = new Set(getDefaultHiddenRideIds());
  const globalHiddenRideIds = new Set(getGlobalHiddenRideIds());
  const sourceControls = getSourceControls();
  const disabledSourceIds = new Set(sourceControls.disabledSourceIds);
  const featureFlags = getFeatureFlags();
  const collectorStatus = getCollectorStatus();
  const activity = getAdminActivity();
  const ridesByPark = rides.reduce<Record<string, typeof rides>>((groups, ride) => {
    groups[ride.parkName] = groups[ride.parkName] ?? [];
    groups[ride.parkName].push(ride);
    return groups;
  }, {});

  return (
    <main className="noc-shell admin-shell">
      <header className="noc-hero">
        <div>
          <p>Admin</p>
          <h1>Control Room</h1>
        </div>
        <strong className="health-pill healthy">
          <Settings2 size={16} />
          {disabledSourceIds.size} source toggles active
        </strong>
      </header>

      {params?.notice && (
        <section className="admin-feedback">
          <Activity size={16} />
          <span>{params.notice}</span>
        </section>
      )}

      <section className="noc-columns">
        <form action={refreshCollector} className="noc-panel admin-form">
          <div className="noc-panel-head">
            <h2>Force Refresh</h2>
            <span>Runs the collector immediately</span>
          </div>
          <div className="admin-control-row">
            <select name="parkSlug" defaultValue="">
              <option value="">All parks</option>
              {PARKS.map((park) => (
                <option key={park.slug} value={park.slug}>
                  {park.shortName}
                </option>
              ))}
            </select>
            <button type="submit">
              <RefreshCw size={16} />
              Refresh now
            </button>
          </div>
        </form>

        <section className="noc-panel admin-form">
          <div className="noc-panel-head">
            <h2>Collector Status</h2>
            <span>{collectorStatus.lastCycle ? `Last run ${formatAge(collectorStatus.lastCycle.finishedAt)}` : "No cycles yet"}</span>
          </div>
          <div className="admin-status-grid">
            <article>
              <span>Last cycle</span>
              <strong>{collectorStatus.lastCycle ? `${collectorStatus.lastCycle.durationSeconds}s` : "n/a"}</strong>
              <em>
                {collectorStatus.lastCycle
                  ? `${collectorStatus.lastCycle.successCount} ok, ${collectorStatus.lastCycle.failureCount} fail`
                  : "waiting"}
              </em>
            </article>
            {collectorStatus.parks.map((park) => (
              <article key={park.slug}>
                <span>{park.shortName}</span>
                <strong>{formatAge(park.lastSuccessAt)}</strong>
                <em className={park.lastError ? "warning" : "healthy"}>{park.lastError ? "Error" : formatDate(park.lastSuccessAt)}</em>
              </article>
            ))}
          </div>
        </section>
      </section>

      <section className="noc-columns">
        <form action={saveFeatures} className="noc-panel admin-form">
          <div className="noc-panel-head">
            <h2>Feature Flags</h2>
            <span>Client experience toggles</span>
          </div>
          <div className="admin-toggle-list">
            {ADMIN_FEATURE_FLAGS.map((flag) => (
              <label key={flag.id} className="admin-toggle-row">
                <input name={`feature:${flag.id}`} type="checkbox" defaultChecked={featureFlags[flag.id]} />
                <span>
                  <strong>{flag.label}</strong>
                  <em>{flag.detail}</em>
                </span>
              </label>
            ))}
          </div>
          <div className="admin-actions inline">
            <button type="submit">
              <Save size={16} />
              Save flags
            </button>
          </div>
        </form>

        <section className="noc-panel admin-form">
          <div className="noc-panel-head">
            <h2>Recent Activity</h2>
            <span>Last admin changes</span>
          </div>
          <div className="admin-activity-list">
            {activity.length ? (
              activity.map((item) => (
                <article key={item.id}>
                  <span>
                    <strong>{item.action}</strong>
                    <em>{item.detail}</em>
                  </span>
                  <time>{formatAge(item.createdAt)}</time>
                </article>
              ))
            ) : (
              <p className="admin-empty">No admin activity yet.</p>
            )}
          </div>
        </section>
      </section>

      <form action={saveSources} className="noc-panel admin-form">
        <div className="noc-panel-head">
          <h2>Source Toggles</h2>
          <span>Checked sources are paused for future collector runs</span>
        </div>
        <div className="admin-toggle-list split">
          {ADMIN_SOURCES.map((source) => (
            <label key={source.id} className="admin-toggle-row">
              <input
                name="disabledSourceId"
                type="checkbox"
                value={source.id}
                defaultChecked={disabledSourceIds.has(source.id)}
              />
              <span>
                <strong>{source.label}</strong>
                <em>{source.detail}</em>
              </span>
            </label>
          ))}
        </div>
        <div className="admin-actions inline">
          <button type="submit">
            <SlidersHorizontal size={16} />
            Save source toggles
          </button>
        </div>
      </form>

      <form action={saveRideControls} className="noc-panel admin-form">
        <div className="noc-panel-head">
          <h2>Ride Visibility</h2>
          <span>{defaultHiddenRideIds.size} default hidden, {globalHiddenRideIds.size} hard hidden</span>
        </div>

        {rides.length === 0 ? (
          <p className="admin-empty">No ride data is available yet.</p>
        ) : (
          <div className="admin-park-list">
            {Object.entries(ridesByPark).map(([parkName, parkRides]) => (
              <section key={parkName} className="admin-park-group">
                <h3>{parkName}</h3>
                <div className="admin-ride-table">
                  <div className="admin-ride-table-head">
                    <span>Ride</span>
                    <span>Default hide</span>
                    <span>Hard hide</span>
                  </div>
                  {parkRides.map((ride) => (
                    <div key={ride.id} className="admin-ride-table-row">
                      <span className="admin-ride-name">
                        <strong>{ride.name}</strong>
                        <em>{ride.areaName}</em>
                      </span>
                      <label>
                        <input
                          aria-label={`Hide ${ride.name} by default`}
                          name="defaultRideId"
                          type="checkbox"
                          value={ride.id}
                          defaultChecked={defaultHiddenRideIds.has(ride.id)}
                        />
                      </label>
                      <label>
                        <input
                          aria-label={`Hard hide ${ride.name}`}
                          name="globalRideId"
                          type="checkbox"
                          value={ride.id}
                          defaultChecked={globalHiddenRideIds.has(ride.id)}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <div className="admin-actions">
          <button type="submit">
            <Save size={16} />
            Save ride visibility
          </button>
        </div>
      </form>
    </main>
  );
}
