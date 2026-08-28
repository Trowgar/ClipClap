# Analytics notes

Working notes on the analytics stack (funnel, guest traffic, the /admin page), written for whoever picks
this up next - including a future me. Same rules as `engine-notes.md`: every number here came from a
measurement, not from reasoning; when a claim is reproduced, say how; when something is believed but
unmeasured, mark it. Delete an entry when it stops being true - a stale note is worse than none.

Shipped and live in production since 2026-07-27. Last substantive update: 2026-07-27 (security review,
traps 7-10).

---

## 1. Why this exists

The product had ~100 users who arrived with **zero marketing**, and essentially none of them converted.
Measured on 2026-07-26:

- 101 users (66 Telegram, 35 web), arriving at ~2-3/day on their own.
- **1 external user had ever run a job** (Максим Корнилов, tg 332548055, exactly 1 job). He churned; his
  subscription went CANCELED on 2026-07-20.
- 0 external paying customers.

The signups are real people, not bots. Checked five independent ways: Telegram IDs are non-sequential and
span 2016-2026 (22 of 68 predate 2021, which a farm does not bother with); 27 of 35 web users hold real
Google OAuth rows with profile avatars; signup gaps are all different (25/34/38/51/52/80/107s - a script
produces identical gaps or bursts); locales are `en/ru/fa/id/fr/pt-br/ar`; and there is nothing to farm
here - no airdrop, no paid referral, no free credits.

So the question was never "is the traffic real" but "where do these real people die", and nothing in the
system could answer it. The bot instrumented only its first three steps. The web app had no instrumentation
at all. Guest traffic was unmeasurable: clipclap.io shares the default nginx `access.log` with
`clipsubs.com` and `linearis.ai` and the Host header is not logged, so clipclap traffic cannot be separated
from it retroactively.

Reading any number meant hand-writing SQL, which is why this file exists at all.

---

## 2. Architecture, in one pass

Three subsystems, one page.

**Funnel events** - `funnel_events` (was `bot_funnel_events`, generalized 2026-07-27).
Columns: `surface` ("bot"|"web"), `subjectId`, `event`, `locale`, `occurrences`, `firstSeenAt`, `lastSeenAt`,
unique on `(surface, subjectId, event)`. Service: `packages/shared/src/services/funnel.service.ts`.

`subjectId` is a **telegramId** on the bot and a **users.id** on the web. That asymmetry is deliberate: on
the bot we can see a person *before* they have an account (the first screen is shown to a telegramId with no
user row), which is exactly the population we care about. On the web an anonymous visitor cannot be
identified before login without cookies, which this product does not set - so the **web funnel starts at
signup** and the page says so.

One row per person per step, not one per press: `count(*)` is the answer to "how many people", and
`occurrences` carries the "came back four times and still did not commit" signal without a row per event.

**Guest traffic** - `site_visits`. One row per visitor per path per day; a reload increments `hits`.
`visitorHash` = `sha256(ip + ua + sha256(TRACK_SECRET + YYYY-MM-DD))`. **No raw IP is ever stored**, and the
daily salt means the same person is unlinkable across days. The path is not the raw pathname but
`normalizeTrackedPath` of it - the site's real routes, ids stripped, everything else bucketed as `/_other`
(see trap 8). Service: `packages/shared/src/services/site-visit.service.ts`.

Collected by the Edge middleware handing off to a Node route, because Next.js middleware cannot use Prisma -
the codebase already documented this before analytics existed ("the Edge runtime is not compatible with
Prisma's Node.js bindings"), and the GeoIP reader needs `fs`.

**The page** - `apps/web/app/admin/page.tsx`, read on a phone as a Telegram Mini App.

---

## 3. The event vocabulary, and what is deliberately NOT an event

Steps, in the order a person passes them:

| Event | Surface | Meaning |
|---|---|---|
| `start_first_screen` | bot | typed /start with no account yet (the two-button screen it was named for is gone since 2026-07-30) |
| `signed_up` | both | a User row now exists, wherever it came from |
| `app_opened` | both | bot: main menu sent · web: dashboard loaded |
| `email_verified` | web | the confirmation link was opened - scoped to the accounts the wall applies to |
| `video_submitted` | both | attempted to create a job, recorded **before** the limit checks |

**Not stages, shown separately.** `SIDE_ACTION_EVENTS` in `analytics.service.ts` - things people do that
nobody has to do on the way to anything: `first_screen_link_account` (a link code was handed over by /link
or Settings), `earn_advertisers_tapped`, `video_queued`, `plans_opened`, `checkout_started`,
`checkout_error`. They render under the funnel as counts with no percentage. `first_screen_new_account` is
retired - the button that wrote it no longer exists, and a retired event is drawn nowhere at all.

**Refusals are branches, not stages.** Current suffixes emitted on both surfaces are `free_exhausted`,
`free_too_long`, `free_budget_closed`, `quota`, `lifecycle`, `too_long`, `too_short`, `duplicate`,
`daily_limit`, `concurrent`, `probe_failed`, and `busy`. `media_group` is bot only. `submit_failed` is web
only. `free_not_anchored` is web in normal operation; the bot creates a phone-backed Telegram account before
the shared gate, so that code is structurally unreachable there. Historical `trial_used` and
`trial_attempts` rows remain readable but those codes are retired. The reason lives in the event NAME, not a
column, so adding one is a code change rather than a migration, and `WHERE event LIKE
'upload_rejected%'` reads well.

**Not events, on purpose:** job created, clips delivered, zero-clip outcomes, and "returned". They are
already rows in `jobs`, `telegram_deliveries`, `clips` and in `occurrences`. A second counter would drift
from the real rows, and then you would have two numbers and no idea which one lies.

`video_submitted` is recorded **before** the limit checks on both surfaces. This is the whole point: it is
what makes "tried and was refused" distinguishable from "never tried". Do not move it after the checks.

---

## 4. How to read the numbers - and what they do NOT mean

- **`externalPayingActive` is the only honest revenue number.** It excludes cancelled subscriptions and the
  owner's own accounts (`ANALYTICS_OWN_ACCOUNTS`). The raw `paying` count says 3 and means nothing: two are
  Oleg's own accounts and the third cancelled on 2026-07-20. As of 2026-07-27 the honest number is **0**.
- **The Reality check line shows the EXTERNAL jobs and clips**, with the totals demoted to a footnote.
  It briefly showed the raw ones: `externalJobs` was computed and never rendered, and `externalClips` did
  not exist, so the section built to refuse to flatter read "9 jobs · 46 clips" when the external truth was
  **1 job · 5 clips**. Fixed 2026-07-27. If you add a figure here, add its external twin in the same commit.
- **`visitorDays`, not unique visitors.** The salt rotates daily by design, so somebody who visits on ten
  days counts ten times. This is the price of not being able to follow a person across days, and it is the
  right trade. Do not rename it back to "guests".
- **`byCountry` / `topReferrers` count distinct visitors**, not rows. They were briefly counting rows (one
  visitor viewing 5 pages showed as 5) - fixed 2026-07-27.
- **Combined double-counts** anyone with both a bot and a web account. At this scale, with almost no
  account linking, that is acceptable and disclosed on the page rather than solved.
- **Bots are flagged, not dropped** (`isBot`). The page counts `isBot = false`. Keeping the row means the
  noise ratio stays visible and the filter itself can be audited - and this host gets a *lot* of scanner
  traffic (`/cgi-bin/ViewLog.asp`, UA `r00ts3c-owned-you`), so an unfiltered counter would have reported
  several times the real number.

Baseline captured 2026-07-27, immediately after deploy (use it to judge whether anything is moving):

```
users 101 · externalUsers 98 · externalPayingActive 0 · jobs 9 · externalJobs 1 · clips 46
pulse: today +1 user · 7d +14 users · 30d +42 users, 1 external job, 5 clips
funnel (bot): saw first screen 2 -> created account 2 (100%) -> opened app 2 (100%, +6 repeats)
```

The funnel is nearly empty because instrumentation only started on 2026-07-26 - it is not a bug. Give it
days, not hours.

---

## 5. Traps this work paid for - do not reintroduce

Every one of these was found by reviewing or testing against the live system, and every one would have been
invisible in unit tests.

**1. Email alone must never authorize.** `/api/register` is open self-registration, the `users.email` unique
index is case-SENSITIVE, and the admin check was case-INSENSITIVE. So registering `Olegs@linearis.io`
against an existing `olegs@linearis.io` passed the duplicate check and granted `/admin`. If the configured
admin address had no user row at all, the plain address worked directly. Fixed: the gate requires a
**federated identity**, and registration lowercases the address. Note `emailVerified` is NULL for every user
in this database, so it cannot be used as the gate. See trap 7 for why that identity is Google only.

**2. Never build a middleware fetch URL from `req.url`.** The host nginx uses `proxy_set_header Host $host`,
i.e. it forwards the client's Host. `curl -H 'Host: attacker.tld' https://clipclap.io/` made the Edge
runtime POST `TRACK_SECRET` (plus the visitor's IP/UA/path/referer) to the attacker, who could then forge
every number on the page. Fixed: the origin comes from `NEXT_PUBLIC_APP_URL`, and tracking is skipped
entirely if that is unset.

**3. A Next.js App Router folder starting with `_` gets no route.** `app/api/_track/route.ts` returned 404
for every request - the endpoint never existed and every visit was silently lost. Typecheck and unit tests
were green throughout; only hitting the real URL found it. It is `/api/track` now.

**4. `NOT (a IN (...) OR b IN (...))` silently drops NULL rows.** The own-accounts filter used that form.
Both columns are nullable, so for a telegram-only user `email IN (...)` is NULL, `NULL OR FALSE` is NULL,
`NOT NULL` is NULL, and the row fails the filter. Measured on the real table: **2 of 101** users survived
instead of 98. Fixed as an AND of null-tolerant negations, with a regression test that fails if anyone
writes `NOT` there again. This is the dangerous kind of bug - the numbers stay plausible and are simply
wrong.

**5. Instrument where the thing HAPPENS, not where you think it happens.** `app_opened` was first recorded
in the `case "menu"` handler, which is the *settings-back* button - it would have counted "exited settings"
while missing `/start` and `/menu` entirely, so returning users would have looked like they never opened the
app. The same mistake put the admin button on the `/menu` text command only, while the menu is reached from
seven places. Both now live in one `sendMainMenu` helper, which is also the only place `app_opened` is
recorded, so double-counting is structurally impossible.

**6. Telemetry never blocks the user and never throws.** `recordFunnelEvent` and `recordSiteVisit` swallow
their own errors (and log), because a telemetry write that can turn a stranger's first interaction into
silence is worse than no telemetry. Callers await them AFTER the reply is out. One deliberate exception is
documented in the code: the refusal record inside `getSubmissionBlocker` lands just before the refusal text,
because decoupling it would mean changing that function's return type and rippling into two other test
files.

Traps 7-10 came out of a deliberate security pass on 2026-07-27, after the rest of the stack was already
live. All four are fixed and covered by tests.

**7. "Has a federated account" is not "is who they say they are".** The trap-1 fix accepted a `google` OR
`telegram` row as proof of the address. But a telegram row says nothing about an email, and **any** logged-in
user can mint one for themselves through `/api/auth/telegram/link/redeem`. So the gate was one link away from
being email-alone again: register an unclaimed `ADMIN_EMAILS` address at `/api/register` (open, self-service,
and `/api/auth/check-email` will even tell you for free whether it is claimable), link any telegram account,
open `/admin`. Not exploitable as configured - `ikscerato@gmail.com` already holds a `google` row, checked
against the live table - but it would have gone live the moment a second address joined the list before its
account existed. Fixed: only `google` counts (it verified the mailbox, and @auth/core refuses to link it onto
an existing same-email user). Telegram admins never needed this path - they enter through the Mini App, which
checks the id against `REFERRAL_ADMIN_TELEGRAM_IDS`.

**8. The tracked path was attacker-chosen.** The unique key is `(day, visitorHash, path)` and the middleware
tracks every extensionless URL *including ones that 404* - so an anonymous visitor walking `/a1`, `/a2`,
`/a3`... minted one row per URL per day, no secret and no login required, and `getTraffic` then read every
one of those rows into memory with `findMany` to compute two numbers. Unbounded table, admin page slower with
every scanner. Fixed at both ends: `normalizeTrackedPath` collapses onto the routes that exist (`/_other` for
the rest, ids stripped), and the two totals are a `groupBy` and an `aggregate` instead of a full read.
Verified live: two distinct 404 URLs now land as one `/_other` row with `hits = 2`.

**9. A reply keyboard belongs to the chat, not to the sender.** The admin check for the "📊 Analytics" button
was `from.id`, which is right, but the keyboard goes to `chat.id` - and without `selective` Telegram shows it
to *every member* of a group. One `/menu` in any group would have put the analytics button on everyone's
keyboard. The data behind it stays shut (initData is checked per user, and the page renders a blank gate to
anyone else), but the entry point is not theirs to see either. `sendMainMenu` now builds the button only when
`chatId === from.id`, which is exactly the private-chat test.

**10. A captured `initData` was a 24-hour day pass.** `MAX_AUTH_AGE_SEC` was 86400, so one leaked initData -
a screenshot, a proxy log, a borrowed phone - could mint fresh one-hour admin cookies all day. The gate posts
initData the instant the Mini App loads, so nothing legitimate needs more than the hour it now gets; an admin
who left the app open overnight just reopens it and Telegram issues a new `auth_date`.

**11. A branch on the main path misreports itself AND its neighbour.** `first_screen_link_account` was
funnel step two because it once counted a button every stranger saw. That screen was deleted on 2026-07-30
and the event moved to /link, where only somebody who already owns a web account has a reason to press it -
7 people in a month against 66 who saw the welcome screen. So it wore the red "biggest drop" badge
permanently, as if a product defect were losing 89% of everybody, and because `getFunnel` advanced
`prevPeople` past it the step below read "Created an account 68 -> **971%** of previous". Fixed 2026-08-24:
side actions are their own list, with counts and no percentages. The same commit rescued `plans_opened`,
`checkout_started` and `checkout_error`, which had been instrumented the day before, put in neither list and
rendered nowhere - the guard test in `analytics.service.test.ts` was already red about it and was committed
red. **The test being red IS the notification. Read it.**

---

## 6. Operational facts

Env (all in `.env`, none in git):

| Var | Purpose |
|---|---|
| `TRACK_SECRET` | shared secret between middleware and `/api/track`; without it that endpoint would be a public row-writer |
| `NEXT_PUBLIC_APP_URL` | trusted origin for the tracking POST - never `req.url` (see trap 2) |
| `NEXT_PUBLIC_APP_HOST` | bare host used to recognise our own referrers as internal |
| `ADMIN_EMAILS` | who may open `/admin` by session - **and only with a `google` account row**, see trap 7 |
| `REFERRAL_ADMIN_TELEGRAM_IDS` | who gets the Mini App button and may enter via `initData` |
| `ANALYTICS_OWN_ACCOUNTS` | Oleg's own accounts, excluded from every "external" figure |
| `MAXMIND_LICENSE_KEY` | optional; absent = visits still recorded, `country` is null |

**Two ways into `/admin`:**
1. Desktop: a session whose email is in `ADMIN_EMAILS` **and** which has a `google` account row (trap 7).
2. Phone: the reply-keyboard "📊 Analytics" Mini App button, shown in **private chats only** (trap 9) ->
   Telegram injects `initData`, valid for one hour (trap 10) -> `/api/admin/enter` validates the HMAC and
   sets a signed one-hour `cc_admin` cookie -> the page renders. No login at all.

The `cc_admin` cookie is scoped `path=/admin`, so a future `/api/admin/*` route will NOT see it and would
have to re-verify initData itself. That is deliberate, and it is the kind of thing that reads as a bug when
you hit it.

The Mini App HMAC uses `HMAC_SHA256("WebAppData", botToken)` as the secret. The Login Widget uses
`sha256(botToken)`. Mixing those up is the classic "the signature never matches" bug.

The page lives at `/admin`, **not** under `/dashboard`, because the middleware redirects unauthenticated
`/dashboard/*` to `/login` - a Mini App has no session cookie and would have seen the login screen instead
of the page. `/admin` is also excluded from guest tracking so the owner's own visits do not pollute the
numbers he is reading.

Deploy ritual is the usual one for this host (see `project_deploy_regen` in memory): after
`docker compose up -d` recreates a container, re-run `prisma generate` **inside each container that needs
it** and rebuild `shared/dist`, or the bot runs old code and `/admin` 500s on a stale client. Also: an
in-container `npm install` does not reach the host lockfile - copy it back with `docker compose cp`.

---

## 7. Where this stands, and what is worth doing next

Working and verified live: migrations applied with all four historical rows preserved; secretless POST to
`/api/track` writes nothing; a real visit records once and a reload increments `hits` instead of adding a
row; curl is correctly flagged as a bot; `/admin` shows an anonymous visitor no data; the Mini App opens
inside Telegram and renders.

Open, roughly in order of value:

1. **Let the funnel fill.** Nothing here beats a week of real data. The first question it should answer is
   whether the ~2-3 daily arrivals reach `video_submitted` at all, or die between `app_opened` and it.
2. **Countries are null** until `MAXMIND_LICENSE_KEY` is set and the web image rebuilt. The incoming stream
   has shifted to `en/fa/id/ar`, so this is more interesting than it looks.
3. **Engine telemetry by genre/language** is the deliberate next subsystem and is not built: which genres
   and languages the highlight engine actually fails on, measured over real traffic rather than the four
   talking-head videos currently in the corpus.
4. **The payment funnel** (plans screen -> pay link -> paid) is out of scope so far. With
   `externalPayingActive` at 0 there is nothing to measure yet; revisit when somebody reaches the paywall.

Found in the 2026-07-27 security pass, judged real but **not** fixed, so nobody rediscovers them as news:

- **The web runs the Next.js dev target in production.** That is deliberate on this host (see `CLAUDE.md`),
  but it is why `/admin` ships the turbopack HMR client, the devtools bundle and server-side chunk paths like
  `/app/apps/web/.next/server/chunks/ssr/...` in its RSC payload, and why an unhandled error returns a full
  stack trace rather than a generic page.
- **`/api/auth/check-email` is an unauthenticated account oracle.** It answers `exists` and `hasPassword` for
  any address. Harmless on its own, it is the reconnaissance half of trap 7.
- **`/admin` answers 200 to anonymous visitors**, because the Mini App gate has to run in their browser to be
  able to post initData. It renders no data - only the gate - and now carries `robots: noindex`, but the
  route is not a 404 and cannot be made one without breaking the phone path.

What this instrumentation cannot tell you: whether the clips are any good. That question belongs to
`engine-notes.md`, and it is still the one that decides whether any of these 98 people stay.
