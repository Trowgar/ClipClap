# Analytics: Funnel + Guest Traffic + Admin Page - Design

**Date:** 2026-07-26
**Status:** Approved - ready for implementation plan
**Author:** Trowgar

## Problem

~100 people have found the product organically with zero marketing, and almost
none of them convert:

- 100 users (66 Telegram, 34 web), growing ~2-3/day.
- **1 external user has ever run a job** (Максим, 1 job). He churned.
- 0 external paying customers today.

We do not know *where* they die. The bot instruments only the top three steps
([bot-funnel.service.ts](../../../packages/shared/src/services/bot-funnel.service.ts)):
`start_first_screen`, `first_screen_new_account`, `first_screen_link_account`.
The first rows recorded (26 Jul) show people *do* reach the screen and *do*
press "New account" - so the top works. Between "account created" and "first
video uploaded" there is **no instrumentation at all**, and that is exactly
where everyone is lost.

The web app has no funnel instrumentation whatsoever, and anonymous site
traffic (guests, countries, referrers) is not measured either. The shared nginx
`access.log` cannot answer it: clipclap.io writes to the default log together
with `clipsubs.com` and `linearis.ai`, and the Host header is not logged, so
clipclap traffic cannot be isolated from it.

Reading the numbers currently means hand-writing SQL each time.

## Goal

One admin page that answers, per surface (**Telegram · Web · Combined**):
where do people drop off, why are uploads refused, and how much guest traffic
(and from which countries) the site actually gets.

## Scope

Three subsystems, one page:
1. **Funnel events** - extend the existing table to both surfaces.
2. **Guest traffic** - anonymous visit tracking with GeoIP.
3. **Admin page** - read-only view over both.

Out of scope (YAGNI): payment funnel (plans screen -> pay link -> paid),
engine-quality telemetry by genre/language (separate upcoming task),
third-party analytics, cross-surface identity de-duplication.

## Design

### 1. Funnel events - generalize the existing table

`bot_funnel_events` is keyed by `telegramId`. Web users have no `telegramId`,
so the model is generalized (the table holds 4 rows; the migration is trivial):

```prisma
model FunnelEvent {
  id          String   @id @default(cuid())
  surface     String   // "bot" | "web"
  subjectId   String   // bot: telegramId (may predate the account), web: userId
  event       String
  locale      String?
  occurrences Int      @default(1)
  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())

  @@unique([surface, subjectId, event])
  @@index([event, firstSeenAt])
  @@map("funnel_events")
}
```

Migration: rename table `bot_funnel_events` -> `funnel_events`, rename column
`telegramId` -> `subjectId`, add `surface`, backfill the existing rows to
`surface = 'bot'`, replace the unique index.

`recordBotFunnelEvent` becomes `recordFunnelEvent(surface, subjectId, event,
locale?)`. Its existing contract is preserved and is non-negotiable: **it never
throws and never rejects** (a telemetry write must never turn a stranger's first
interaction into silence), and callers await it **after** the user has been
answered.

**Inherent asymmetry, stated openly:** on the bot we can see a person *before*
they have an account (the first screen is shown to a `telegramId` with no user
row). On the web an anonymous visitor cannot be identified before login without
cookies/browser analytics, which we deliberately do not use. The web funnel
therefore starts at signup. The page must label this rather than imply the two
funnels are like-for-like.

#### Step vocabulary

Bot only (pre-account, already implemented - keep as is):
`start_first_screen`, `first_screen_new_account`, `first_screen_link_account`

Both surfaces (same event names, distinguished by `surface`):
- `app_opened` - bot: main menu rendered; web: dashboard loaded
- `video_submitted` - an attempt to create a job (recorded *before* the checks)
- `upload_rejected_<reason>`, where reason is one of:
  `trial_used`, `trial_attempts`, `too_long`, `quota`, `lifecycle`,
  `daily_limit` (web), `concurrent` (web)

The reason is encoded **in the event name**, not in a new column: it keeps the
schema unchanged and reads well in SQL (`WHERE event LIKE 'upload_rejected%'`).

Rejection reasons line up across surfaces for free because
[canSubmitJob](../../../apps/web/app/api/jobs/route.ts) is shared by bot and web;
`daily_limit` and `concurrent` exist only on the web route.

#### Deliberately NOT new events

These are already recorded elsewhere and must not be duplicated - a second
counter would drift from the real rows:

| Funnel step | Source of truth |
|---|---|
| job created | `jobs.createdAt` (first job per user) |
| clips delivered | `telegram_deliveries.status = 'DELIVERED'` / `clips` |
| zero-clip outcome | `jobs.noClipsReason` |
| returned / repeat attempt | `video_submitted.occurrences > 1`, and `lastSeenAt - firstSeenAt` for the engagement span |

The page stitches events to jobs via `users.telegramId` (bot) and `users.id`
(web).

#### Call sites

| Event | Bot | Web |
|---|---|---|
| `app_opened` | main menu render | dashboard server component |
| `video_submitted` | when a video/URL is recognized, before checks | `api/jobs/route.ts`, before checks |
| `upload_rejected_*` | `switch (submission.code)` (~handlers.ts:1616) | every refusal branch (400 / 402 / 429) |

No message contents, no URLs, no raw identifiers beyond the subject id: only the
step and the locale. This matches the privacy bar the existing service set.

### 2. Guest traffic - middleware -> internal API route

```prisma
model SiteVisit {
  id           String   @id @default(cuid())
  day          DateTime @db.Date
  visitorHash  String   // sha256(ip + ua + daily salt) - no raw IP is stored
  country      String?  // ISO-2, from MaxMind GeoLite2
  path         String
  referrerHost String?
  isBot        Boolean  @default(false)
  hits         Int      @default(1)
  firstSeenAt  DateTime @default(now())
  lastSeenAt   DateTime @default(now())

  @@unique([day, visitorHash, path])
  @@index([day, country])
  @@index([day, isBot])
  @@map("site_visits")
}
```

One row per visitor per path per day, `hits` incremented on repeat. Unique
guests = `count(distinct visitorHash)`; pageviews = `sum(hits)`.

**Why an API route and not the middleware itself:** Next.js middleware runs on
the Edge runtime, which cannot use Prisma - the codebase already documents this
in [middleware.ts](../../../apps/web/middleware.ts) ("the Edge runtime is not
compatible with Prisma's Node.js bindings") - and the GeoIP reader needs `fs`.
The middleware therefore only extracts request data and hands it to a Node
route that does the lookup and the write.

Flow:
1. Middleware reads IP (`X-Real-IP` / `X-Forwarded-For`, both already forwarded
   by the host nginx), user-agent, path, referrer.
2. It calls `/api/_track` through **`event.waitUntil(fetch(...))`** - not a bare
   un-awaited `fetch`, which the Edge runtime may kill along with the response,
   silently losing visits.
3. `/api/_track` (`export const runtime = "nodejs"`) verifies the shared secret,
   resolves the country, hashes the visitor, and upserts the row.

**Required guards:**
- **`TRACK_SECRET`** (new env) sent as a header by the middleware and checked by
  the route. Without it `/api/_track` is a public endpoint that writes to the
  database and anyone could inflate the numbers. On mismatch: return 204 and
  write nothing.
- **Matcher** widens from `["/", "/dashboard/:path*"]` to all pages but must
  exclude `/api`, `/_next` and static assets - otherwise the tracker records
  itself in a loop. The existing auth guard (`startsWith("/dashboard")`) and the
  `?ref` cookie logic are unchanged.

**GeoIP:** `GeoLite2-Country.mmdb` fetched at Docker build time using a new
`MAXMIND_LICENSE_KEY`. If the file is absent the lookup degrades to
`country = null` and everything else keeps working - a missing database must
never fail a page load.

**Bot filtering:** classify by user-agent
(`bot|crawler|spider|curl|wget|python-requests|headless`) and by junk paths. Bot
hits are **flagged, not dropped** (`isBot`), so the noise ratio stays visible and
the filter itself can be audited. This matters here: the shared nginx log is
full of scanners (`/cgi-bin/ViewLog.asp`, UA `r00ts3c-owned-you`), and an
unfiltered counter would report several times the real traffic. The page counts
`isBot = false` by default.

**Privacy:** the daily salt is derived in-process as
`sha256(TRACK_SECRET + YYYY-MM-DD)` - nothing extra to store or rotate by hand,
and because it changes every day, visitor hashes cannot be linked across days.
Raw IPs are never persisted; no cookies are set for tracking.

### 3. Admin page

`apps/web/app/(dashboard)/dashboard/admin/page.tsx`, a server component that
aggregates on the server - no client-side fetching.

**Access:** a new `ADMIN_EMAILS` env (comma-separated) checked against the
`auth()` session. Anything else returns 404 (not 403 - the page should not
advertise its own existence). This mirrors the existing env-based admin pattern
(`REFERRAL_ADMIN_TELEGRAM_IDS`) and needs no schema change. Note the existing
bot-admin mechanism cannot be reused directly: the owner's web account
(`ikscerato@gmail.com`) and Telegram account (`575308044`) are separate,
unlinked user rows.

**Filter:** Telegram · Web · Combined.

**Sections:**
1. **Traffic** (web/combined only) - guests, pageviews, countries, top paths,
   referrers.
2. **Funnel** - steps with counts, % of the previous step, and median time to
   reach the step (from `firstSeenAt` deltas).
3. **Refusals** - breakdown by reason.
4. **Totals** - users, paying users, jobs, clips.

Locale breakdown is shown alongside the funnel: the incoming stream has shifted
to `en/fa/id/ar`, and we need to see whether non-Russian users drop off harder.

**Combined-view caveat:** a person present on both surfaces (linked accounts)
is counted twice. At ~100 users with almost no linking this is acceptable; it is
disclosed as a footnote on the page rather than solved with de-duplication.

## Execution notes

- The bot runs the **built** `shared/dist`, so after changing the shared service:
  `npm run build -w @clipclap/shared`, then recreate/restart the bot - otherwise
  events silently are not written.
- Bot tests must run **inside the `bot` container**; the `web` container holds a
  stale copy of `apps/bot` and passes silently.
- `prisma migrate deploy` and `prisma generate` run per container.

## Verification

1. Migration applies; the 4 existing rows land in `surface='bot'` with their
   history intact.
2. Bot: a `/start` -> menu -> send video -> refusal path produces
   `app_opened`, `video_submitted`, `upload_rejected_*` with the right surface.
3. Web: dashboard load and a refused upload produce the same event names with
   `surface='web'`.
4. `/api/_track` without the secret writes nothing and returns 204.
5. A page visit produces exactly one `site_visits` row; a reload increments
   `hits` instead of adding a row.
6. A request with a crawler user-agent is stored with `isBot = true` and is
   excluded from the guest count.
7. `/dashboard/admin` returns 404 for a non-admin session and renders for an
   `ADMIN_EMAILS` session.

## Open questions

None.
