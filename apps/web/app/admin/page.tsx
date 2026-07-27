import { auth } from "@/lib/auth";
import { cookies } from "next/headers";
import {
  getFunnel,
  getTotals,
  getTraffic,
  isAdminEmail,
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

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string }>;
}) {
  // Two independent ways in: a normal admin session (desktop), or the signed
  // cookie that /api/admin/enter sets after validating Telegram initData.
  const session = await auth();
  const cookieOk = verifyAdminCookie(
    (await cookies()).get("cc_admin")?.value,
    process.env.NEXTAUTH_SECRET
  );
  if (!isAdminEmail(session?.user?.email, process.env.ADMIN_EMAILS) && !cookieOk) {
    // Render only the Mini App gate: inside Telegram it posts initData and
    // reloads; in a plain browser it renders nothing, which is the
    // 404-equivalent we want (no hint that this route matters).
    return <MiniAppGate />;
  }

  const { surface: raw } = await searchParams;
  const surface: FunnelSurface | undefined =
    raw === "bot" || raw === "web" ? raw : undefined;

  const [funnel, totals, traffic] = await Promise.all([
    getFunnel(surface),
    getTotals(surface),
    surface === "bot" ? Promise.resolve(null) : getTraffic(30),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-10 p-6">
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

      <section>
        <h2 className="mb-2 font-semibold">Totals</h2>
        <p className="text-sm opacity-80">
          users {totals.users} · paying {totals.paying} · jobs {totals.jobs} ·
          clips {totals.clips}
        </p>
      </section>

      {traffic && (
        <section>
          <h2 className="mb-2 font-semibold">Guest traffic (30d)</h2>
          <p className="text-sm opacity-80">
            guests {traffic.guests} · pageviews {traffic.pageviews}
          </p>
          <p className="mt-2 text-sm opacity-80">
            {traffic.byCountry
              .slice(0, 10)
              .map((c) => `${c.country ?? "??"} ${c.guests}`)
              .join(" · ")}
          </p>
          <p className="mt-2 text-sm opacity-80">
            {traffic.topReferrers.map((r) => `${r.referrerHost} ${r.guests}`).join(" · ")}
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-semibold">Funnel</h2>
        <table className="w-full text-sm">
          <tbody>
            {funnel.map((row) => (
              <tr key={row.event} className="border-b border-white/10">
                <td className="py-1">{row.event}</td>
                <td className="py-1 text-right">{row.people}</td>
                <td className="py-1 text-right opacity-60">+{row.repeats} repeats</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-xs opacity-50">
        Web funnel starts at signup - an anonymous visitor cannot be identified
        before login without cookies, which this product does not set. In
        Combined, a person with both a bot and a web account is counted twice.
      </p>
    </div>
  );
}
