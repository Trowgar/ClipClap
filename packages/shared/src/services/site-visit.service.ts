import { createHash } from "crypto";
import { prisma } from "../lib/prisma";

/**
 * Anonymous guest traffic.
 *
 * The site sits behind the host nginx, which forwards X-Real-IP and
 * X-Forwarded-For, so the visitor's address is available - but it is never
 * stored. The row is keyed by a hash of (ip + user-agent + a salt derived from
 * the day), which makes repeat visits on one day collapse into one row and
 * makes the same person unlinkable across days.
 */

const BOT_UA =
  /(bot|crawler|spider|slurp|curl|wget|python-requests|httpclient|headless|phantomjs|scrapy|facebookexternalhit|preview|monitor|scanner|owned-you)/i;

/** A missing user-agent is treated as a bot: real browsers always send one. */
export function isBotUserAgent(ua?: string | null): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_UA.test(ua);
}

/** Host of an external referrer, or null for our own pages and junk values. */
export function referrerHost(
  referrer?: string | null,
  selfHost?: string
): string | null {
  if (!referrer?.trim()) return null;
  try {
    const host = new URL(referrer).host;
    if (!host) return null;
    if (selfHost && (host === selfHost || host.endsWith("." + selfHost))) return null;
    return host;
  } catch {
    return null;
  }
}

/** Top-level paths the site actually serves. Everything else is a 404. */
const KNOWN_ROOTS = new Set(["/", "/login", "/admin"]);
/** Second segment under /dashboard; a third segment is an id and is dropped. */
const KNOWN_DASHBOARD = new Set([
  "billing",
  "clips",
  "editor",
  "jobs",
  "payouts",
  "plans",
  "projects",
  "referrals",
  "settings",
]);
/** Bucket for anything unrecognised - one row per visitor-day, not per URL. */
export const OTHER_PATH = "/_other";

/**
 * Collapses a request path onto the small set of routes the site really has.
 *
 * The unique key is (day, visitorHash, path), and the middleware tracks EVERY
 * extensionless URL including ones that 404 - so without this, one visitor
 * walking /a1, /a2, /a3... mints one row per URL per day, with no secret and no
 * login. Bounded here instead: at most (known routes + 1) rows per visitor-day.
 * Ids are stripped too, so /dashboard/clips/<uuid> does not become a path of
 * its own for every clip.
 */
export function normalizeTrackedPath(raw: string): string {
  const path = raw.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  if (KNOWN_ROOTS.has(path)) return path;

  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "dashboard") return OTHER_PATH;
  if (segments.length === 1) return "/dashboard";
  if (!KNOWN_DASHBOARD.has(segments[1])) return OTHER_PATH;
  return `/dashboard/${segments[1]}`;
}

/**
 * sha256(ip + ua + sha256(secret + day)). The day-derived salt is what keeps
 * a visitor unlinkable across days, and it needs nothing stored or rotated by
 * hand.
 */
export function visitorHash(
  ip: string,
  ua: string,
  secret: string,
  day: string
): string {
  const salt = createHash("sha256").update(`${secret}|${day}`).digest("hex");
  return createHash("sha256").update(`${ip}|${ua}|${salt}`).digest("hex");
}

/** YYYY-MM-DD in UTC - the bucket key for both the salt and the `day` column. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface RecordSiteVisitInput {
  ip: string;
  userAgent?: string | null;
  path: string;
  referrer?: string | null;
  secret: string;
  selfHost?: string;
  now?: Date;
}

/**
 * NEVER THROWS. This runs on the request path of every page view; a telemetry
 * failure must not surface to a visitor.
 */
export async function recordSiteVisit(
  input: RecordSiteVisitInput
): Promise<void> {
  try {
    const now = input.now ?? new Date();
    const day = utcDay(now);
    const ua = input.userAgent ?? "";
    const hash = visitorHash(input.ip, ua, input.secret, day);
    const country = await lookupCountry(input.ip);

    await prisma.siteVisit.upsert({
      where: {
        day_visitorHash_path: {
          day: new Date(`${day}T00:00:00.000Z`),
          visitorHash: hash,
          path: input.path,
        },
      },
      create: {
        day: new Date(`${day}T00:00:00.000Z`),
        visitorHash: hash,
        path: input.path,
        country,
        referrerHost: referrerHost(input.referrer, input.selfHost),
        isBot: isBotUserAgent(ua),
      },
      update: { hits: { increment: 1 }, lastSeenAt: now },
    });
  } catch (error) {
    console.error(
      "Site visit telemetry: could not record visit:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * ISO-2 country from the local GeoLite2 database, or null.
 *
 * The reader is created once and cached. A missing or unreadable database is
 * not an error: the country column degrades to null and every other metric
 * keeps working.
 */
let readerPromise: Promise<{
  country: (ip: string) => { country?: { isoCode?: string } };
} | null> | null = null;

async function lookupCountry(ip: string): Promise<string | null> {
  try {
    if (!readerPromise) {
      readerPromise = (async () => {
        const path = process.env.GEOLITE2_COUNTRY_DB;
        if (!path) return null;
        const { Reader } = await import("@maxmind/geoip2-node");
        return (await Reader.open(path)) as never;
      })().catch(() => null);
    }
    const reader = await readerPromise;
    if (!reader) return null;
    return reader.country(ip).country?.isoCode ?? null;
  } catch {
    return null;
  }
}
