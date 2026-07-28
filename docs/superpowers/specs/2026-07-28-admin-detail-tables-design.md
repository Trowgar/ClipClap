# Admin analytics: per-user and per-guest tables

Date: 2026-07-28
Status: designed, not implemented

## Problem

`/admin` answers "how many" and nothing else. Pulse, funnel, refusals and
traffic are all counts, so the page can say six people opened the app today and
cannot say who they were or what any one of them did. Reading a single person's
story means opening Prisma Studio and joining four tables by hand.

Two views are missing:

- **Telegram**: the people. Who registered, when, and what each of them
  actually did - start, settings, an upload, the clips that came out.
- **Web**: the guests. Where they came from, what they looked at, how long they
  stayed.

## What the data can and cannot support

Measured on prod, 2026-07-27:

| Table | Rows |
| --- | --- |
| `users` | 101 (68 with `telegramId`, 35 with `email`) |
| `jobs` / `clips` | 9 / 46 |
| `site_visits` | 20 rows across 17 visitor-days |
| `funnel_events` | **6 rows, 3 event types, 2 subjects** |

The last row governs the design. `funnel_events` is where "pressed start,
chose a language" lives, and it is empty because instrumentation only started
on 2026-07-27. It cannot be backfilled - an event is written when the action
happens or never. So the per-user story is assembled mostly from `jobs`,
`job_steps`, `clips`, `telegram_deliveries` and `users`, all of which carry
full history, with funnel events layered on as they accumulate.

Consequence to accept up front: the accordion is rich for anyone who has ever
run a video and thin for the other 66, who have a registration date, a locale
and a plan and nothing else. That is a fact about the past, not about the view.

Guest duration has a second limit. `site_visits` is written from middleware on
each navigation, so the table holds the first and last *request* of a
visitor-day and nothing about the last page's dwell. Real time on site is
always at least the recorded span, sometimes much more. A single-pageview
guest - the majority, 14 of 20 rows are `/` - has one timestamp and no span at
all.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Missing funnel events | Build on what exists | Adding events does not recover history, and the job/clip data already tells the useful part of the story |
| Guest duration | Recorded span, labelled as a minimum; "one page" instead of `0` | A zero reads as "bounced instantly" when the truth is "unknown". No new client-side tracking on the public site |
| Day boundary | `Europe/Riga` | The reader is in Latvia. A fixed +3 breaks at the EEST/EET change, so an IANA zone, not an offset |
| Placement | Sections of `/admin`, per surface | A Mini App navigates between routes badly, and a second route would duplicate the auth gate |
| Expand mechanism | Native `<details>` | No client JS. The blank-page incident of 2026-07-27 came from depending on an external script; this page should depend on nothing |
| Page size | 25 | Comfortable scroll on a phone |

## Design

### Placement and navigation

The existing surface filter selects the table:

- `surface=bot` - the users table
- `surface=web` - the guests table
- Combined - neither; it stays the overview

Pagination is plain links in the same URL, `?surface=bot&page=2`. It works
without JS, survives a reload, and is shareable. The surface links reset `page`
to 1; the pager preserves `surface`. Out-of-range pages clamp to the last page
rather than rendering an empty table.

### Users table (Telegram surface)

One row per user, newest registration first:

| Column | Source |
| --- | --- |
| Registered | `users.createdAt`, date only |
| Who | `users.name`, falling back to `telegramId` |
| Locale | `users.telegramLocale` |
| Plan | `users.plan` + `subscriptionStatus` |
| Activity | job count · clip count |

Users registered today - Riga day - are **bold**. Accounts listed in
`ANALYTICS_OWN_ACCOUNTS` are shown with a marker rather than hidden: the list
has to be complete to be useful, while the aggregate numbers above it have to
exclude them to be honest. Those are different jobs.

Expanding a row shows everything held about that person:

- registration timestamp, locale, plan, subscription status, period end
- referrer, if they arrived through a referral, and their own referral code
- funnel events: which ones exist, first seen, occurrence count
- each job: created, source (URL or filename), source duration, status, clips
  generated, analyze engine, per-step timings, error when it failed, Telegram
  delivery status
- totals: minutes processed, estimated cost

### Guests table (Web surface)

One row per visitor-day. Not per person: the salt behind `visitorHash` rotates
daily by design, so "the same visitor tomorrow" is unknowable and the row must
not pretend otherwise.

| Column | Source |
| --- | --- |
| Day | `site_visits.day` |
| Country | `country`, `??` when GeoIP was absent |
| Source | `referrerHost`, "direct" when null |
| Views | sum of `hits` |
| Time | `max(lastSeenAt) - min(firstSeenAt)` across that visitor-day |

Crawlers stay filtered (`isBot = false`), matching the existing traffic block.
Expanding shows the individual paths with their first and last timestamps and
hit counts.

### Code

New file `packages/shared/src/services/analytics-detail.service.ts`. The
boundary against the existing `analytics.service.ts` is aggregates versus
per-subject rows; the existing file is already 391 lines and should not absorb
this.

Exports:

- `getBotUsers({ page, pageSize, ownAccounts })` - rows plus total count
- `getWebGuests({ page, pageSize })` - rows plus total count

`ANALYTICS_TIMEZONE = "Europe/Riga"` and a start-of-local-day helper go in
shared config, used by both the new bold rule and `getPulse`, whose "Today"
tile currently uses `setUTCHours` and would otherwise disagree with the table
on the same page between midnight and 03:00 local.

### Tests

- day boundary in summer and in winter, across the EEST/EET change - the case
  a fixed offset gets wrong
- "today" flag for a user registered just before and just after local midnight
- pagination arithmetic, including an out-of-range page
- guest duration with one pageview (renders "one page", not `0`) and with
  several
- own-account marking does not remove the row

## Out of scope

- **New tracking on the public site.** A dwell-time heartbeat would make guest
  duration exact and was considered and declined: it is client-side
  surveillance of guests for a number that is directionally right without it.
- **Backfilling or extending funnel instrumentation.** Worth doing on its own
  merits; it does not recover a single past event and would triple this change.
- **A registered web-user list.** 35 accounts exist and a table for them is
  reasonable, but the request was guests. Separate work.
- **In-page actions** - clicks, scroll depth, form starts. Nothing records them
  and recording them is the declined item above.
