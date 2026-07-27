# Analytics notes

Working notes on the analytics stack (funnel, guest traffic, the /admin page), written for whoever picks
this up next - including a future me. Same rules as `engine-notes.md`: every number here came from a
measurement, not from reasoning; when a claim is reproduced, say how; when something is believed but
unmeasured, mark it. Delete an entry when it stops being true - a stale note is worse than none.

Shipped and live in production since 2026-07-27. Last substantive update: 2026-07-27.

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
daily salt means the same person is unlinkable across days. Service:
`packages/shared/src/services/site-visit.service.ts`.

Collected by the Edge middleware handing off to a Node route, because Next.js middleware cannot use Prisma -
the codebase already documented this before analytics existed ("the Edge runtime is not compatible with
Prisma's Node.js bindings"), and the GeoIP reader needs `fs`.

**The page** - `apps/web/app/admin/page.tsx`, read on a phone as a Telegram Mini App.

---

## 3. The event vocabulary, and what is deliberately NOT an event

Steps, in the order a person passes them:

| Event | Surface | Meaning |
|---|---|---|
| `start_first_screen` | bot | saw the two-button screen, no account yet |
| `first_screen_new_account` | bot | pressed "New account" |
| `first_screen_link_account` | bot | pressed "Link account" |
| `app_opened` | both | bot: main menu sent · web: dashboard loaded |
| `video_submitted` | both | attempted to create a job, recorded **before** the limit checks |
| `upload_rejected_*` | both | refused, with the reason in the name |

Refusal reasons: `trial_used`, `trial_attempts`, `too_long`, `free_too_long`, `quota`, `lifecycle`,
`daily_limit` (web only), `concurrent` (web only). The reason lives in the event NAME, not a column, so
adding one is a code change rather than a migration, and `WHERE event LIKE 'upload_rejected%'` reads well.

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
**federated identity** (a `google`/`telegram` row in `accounts`), and registration lowercases the address.
Note `emailVerified` is NULL for every user in this database, so it cannot be used as the gate.

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

---

## 6. Operational facts

Env (all in `.env`, none in git):

| Var | Purpose |
|---|---|
| `TRACK_SECRET` | shared secret between middleware and `/api/track`; without it that endpoint would be a public row-writer |
| `NEXT_PUBLIC_APP_URL` | trusted origin for the tracking POST - never `req.url` (see trap 2) |
| `NEXT_PUBLIC_APP_HOST` | bare host used to recognise our own referrers as internal |
| `ADMIN_EMAILS` | who may open `/admin` by session (plus a federated account row) |
| `REFERRAL_ADMIN_TELEGRAM_IDS` | who gets the Mini App button and may enter via `initData` |
| `ANALYTICS_OWN_ACCOUNTS` | Oleg's own accounts, excluded from every "external" figure |
| `MAXMIND_LICENSE_KEY` | optional; absent = visits still recorded, `country` is null |

**Two ways into `/admin`:**
1. Desktop: a session whose email is in `ADMIN_EMAILS` **and** which has a `google`/`telegram` account row.
2. Phone: the reply-keyboard "📊 Analytics" Mini App button -> Telegram injects `initData` ->
   `/api/admin/enter` validates the HMAC and sets a signed one-hour `cc_admin` cookie -> the page renders.
   No login at all.

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

What this instrumentation cannot tell you: whether the clips are any good. That question belongs to
`engine-notes.md`, and it is still the one that decides whether any of these 98 people stay.
