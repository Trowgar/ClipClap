import { auth } from "@/lib/auth";
import { cookies } from "next/headers";
import {
  getFunnel,
  getPulse,
  getRefusals,
  getTotals,
  getTraffic,
  isAdminTelegramId,
  isAdminUser,
  verifyAdminCookie,
  type FunnelSurface,
} from "@clipclap/shared";
import { MiniAppGate } from "./mini-app-gate";

export const dynamic = "force-dynamic";

const SURFACES = [
  { key: "", label: "Combined" },
  { key: "bot", label: "Telegram" },
  { key: "web", label: "Web" },
] as const;

function PulseColumn({
  title,
  dominant,
  newUsers,
  jobs,
  clips,
}: {
  title: string;
  dominant?: boolean;
  newUsers: number;
  jobs: number;
  clips: number;
}) {
  return (
    <div className="flex-1 rounded-lg border border-white/10 p-4">
      <p className="text-xs uppercase tracking-wide opacity-60">{title}</p>
      <p
        className={
          dominant
            ? "mt-1 text-4xl font-bold tabular-nums"
            : "mt-1 text-2xl font-semibold tabular-nums"
        }
      >
        {newUsers}
      </p>
      <p className="text-xs opacity-60">new users</p>
      <p className="mt-3 text-sm opacity-80">
        {jobs} job{jobs === 1 ? "" : "s"} · {clips} clip{clips === 1 ? "" : "s"}
      </p>
    </div>
  );
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string }>;
}) {
  // Two independent ways in: a normal admin session (desktop), or the signed
  // cookie that /api/admin/enter sets after validating Telegram initData.
  const session = await auth();
  const cookieTelegramId = verifyAdminCookie(
    (await cookies()).get("cc_admin")?.value,
    process.env.NEXTAUTH_SECRET
  );
  // A well-signed cookie is not enough on its own: it says nothing about
  // whether the id is STILL an admin, so a revoked id would otherwise keep
  // access for up to an hour (the cookie TTL). Re-check against the live list.
  const cookieOk =
    cookieTelegramId !== null &&
    isAdminTelegramId(cookieTelegramId, process.env.REFERRAL_ADMIN_TELEGRAM_IDS);
  const emailOk = await isAdminUser(
    session?.user?.id,
    session?.user?.email,
    process.env.ADMIN_EMAILS
  );
  if (!emailOk && !cookieOk) {
    // Render only the Mini App gate: inside Telegram it posts initData and
    // reloads; in a plain browser it renders nothing, which is the
    // 404-equivalent we want (no hint that this route matters).
    return <MiniAppGate />;
  }

  const { surface: raw } = await searchParams;
  const surface: FunnelSurface | undefined =
    raw === "bot" || raw === "web" ? raw : undefined;
  const ownAccounts = process.env.ANALYTICS_OWN_ACCOUNTS;

  const [pulse, funnel, refusals, totals, traffic] = await Promise.all([
    getPulse(surface, ownAccounts),
    getFunnel(surface),
    getRefusals(surface),
    getTotals(surface, ownAccounts),
    surface === "bot" ? Promise.resolve(null) : getTraffic(30),
  ]);

  const noExternalPaying = totals.externalPayingActive === 0;

  return (
    <div className="mx-auto max-w-xl space-y-10 p-5 pb-16">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <div className="mt-3 flex gap-2">
          {SURFACES.map((s) => (
            <a
              key={s.key}
              href={s.key ? `?surface=${s.key}` : "?"}
              className={`rounded-md border px-3 py-1 text-sm ${
                (raw ?? "") === s.key ? "bg-white text-black" : "opacity-70"
              }`}
            >
              {s.label}
            </a>
          ))}
        </div>
      </div>

      {/* 1. Pulse - the headline. Today is what he actually asks about. */}
      <section>
        <h2 className="mb-3 font-semibold">Pulse</h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <PulseColumn title="Today" dominant {...pulse.today} />
          <PulseColumn title="7 days" {...pulse.last7} />
          <PulseColumn title="30 days" {...pulse.last30} />
        </div>
      </section>

      {/* 2. Reality check - the number that must never flatter him. */}
      <section>
        <h2 className="mb-2 font-semibold">Reality check</h2>
        <p
          className={
            noExternalPaying
              ? "text-2xl font-bold text-red-400/90"
              : "text-2xl font-bold text-emerald-400"
          }
        >
          External paying customers: {totals.externalPayingActive}
        </p>
        {noExternalPaying && (
          <p className="mt-1 text-xs opacity-60">
            your own accounts and cancelled subscriptions are excluded
          </p>
        )}
        <p className="mt-3 text-sm opacity-70">
          {totals.users} total users · {totals.externalUsers} external ·{" "}
          {totals.jobs} jobs · {totals.clips} clips
        </p>
      </section>

      {/* 3. Funnel - true step order, with drop-off from the previous step. */}
      <section>
        <h2 className="mb-2 font-semibold">Funnel</h2>
        {funnel.length === 0 ? (
          <p className="text-sm opacity-60">
            No funnel data yet - instrumentation started 2026-07-27.
          </p>
        ) : (
          <div className="space-y-2">
            {funnel.map((step) => (
              <div
                key={step.event}
                className={`rounded-md border-l-4 py-2 pl-3 ${
                  step.biggestDrop ? "border-red-400 bg-red-400/10" : "border-white/10"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm">{step.label}</span>
                  <span className="text-lg font-semibold tabular-nums">{step.people}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-xs opacity-60">
                  <span>
                    {step.pctOfPrev !== null ? `→ ${step.pctOfPrev}% of previous` : "first step"}
                    {step.biggestDrop && (
                      <span className="ml-2 rounded bg-red-400/20 px-1.5 py-0.5 text-red-300">
                        biggest drop
                      </span>
                    )}
                  </span>
                  {step.repeats > 0 && <span>+{step.repeats} repeats</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. Refusals - people who tried and were turned away, only shown when it happened. */}
      {refusals.length > 0 && (
        <section>
          <h2 className="mb-1 font-semibold">Refusals</h2>
          <p className="mb-2 text-xs opacity-60">
            People who tried to submit a video and were refused, by reason.
          </p>
          <div className="space-y-1">
            {refusals.map((r) => (
              <div key={r.reason} className="flex items-baseline justify-between text-sm">
                <span className="opacity-80">{r.reason}</span>
                <span className="font-semibold tabular-nums">{r.people}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5. Traffic - hidden on the bot surface, which has no guests. */}
      {traffic && (
        <section>
          <h2 className="mb-2 font-semibold">Guest traffic (30d)</h2>
          {traffic.visitorDays === 0 && traffic.pageviews === 0 ? (
            <p className="text-sm opacity-60">No guest visits recorded yet.</p>
          ) : (
            <>
              <p className="text-sm opacity-80">
                visitor-days {traffic.visitorDays} · pageviews {traffic.pageviews}
              </p>
              <p className="text-xs opacity-50">
                Visitor-days, not unique people: the salt behind each visitor
                hash rotates daily by design, so a daily returner is counted
                once per day they show up.
              </p>
              {traffic.byCountry.length > 0 && (
                <p className="mt-2 text-sm opacity-80">
                  {traffic.byCountry
                    .slice(0, 10)
                    .map((c) => `${c.country ?? "??"} ${c.guests}`)
                    .join(" · ")}
                </p>
              )}
              {traffic.topReferrers.length > 0 && (
                <p className="mt-2 text-sm opacity-80">
                  {traffic.topReferrers.map((r) => `${r.referrerHost} ${r.guests}`).join(" · ")}
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* 6. Footnotes */}
      <p className="text-xs opacity-50">
        Web funnel starts at signup - an anonymous visitor cannot be identified
        before login without cookies, which this product does not set. In
        Combined, a person with both a bot and a web account is counted twice.
      </p>
    </div>
  );
}
