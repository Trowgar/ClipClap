# Free plan: a lifetime minute allowance, anchored and capped

Date: 2026-07-28
Status: design approved, not implemented

## Problem

In four months of web traffic nobody has ever received a clip.

| | |
| --- | --- |
| Users total | 102 |
| Users on plan `NONE` | 99 |
| Web accounts with an email | 36 |
| Of those, accounts that ever produced a clip | **1** (the owner's own `ikscerato@gmail.com`) |
| `ACTIVE` subscriptions | 2, both owner test accounts |
| Tribute orders | 5, **all `PENDING`** - none ever paid |
| Stripe webhook events, lifetime | 1 |

Thirty-four strangers registered since April, from `gmail`, `icloud`, `qq`,
across Indonesia, India, Morocco and Russia, and every one of them has 0 jobs
and 0 clips. The revenue is not small, it is zero.

The cause is not pricing. It is that a new account cannot run anything:

- The free tier was zeroed on 2026-07-25 (`NONE_LIMITS`, all fields 0, in
  `packages/shared/src/config/plans.ts`) because it was an unbounded compute
  faucet.
- `apps/web/app/(dashboard)/dashboard/page.tsx` still renders `UploadZone`
  **enabled** for a `NONE` account. Its comment - "NONE now carries the free
  allowance rather than zeros" - describes the tier that was switched off.
- The user submits, and only then `apps/web/app/api/jobs/route.ts:79` rejects on
  `jobsToday >= limits.maxJobsPerDay` (`0 >= 0`) with
  `Daily job limit reached (0). Try again tomorrow or upgrade.` - untrue on both
  counts. Observed end to end on 2026-07-28: `app_opened` ->
  `video_submitted` -> `upload_rejected_daily_limit` in 72 seconds, 0 jobs
  created. That user arrived from ChatGPT.

The three holes that justified zeroing the tier are real and are still open:

1. `POST /api/register` is unauthenticated, unrate-limited and unverified - any
   string with an `@` mints an account, so "one trial per account" means
   "unlimited trials per person".
2. `apps/web/app/api/jobs/route.ts:31` takes `sourceDurationSec` **from the
   request body**. It is client-supplied, and absent (therefore 0) on every URL
   submission - so a duration-based allowance cannot be enforced at all.
3. `projectService.deleteProject` runs `prisma.job.delete`
   (`packages/shared/src/services/project.service.ts:299`), a hard delete with
   cascade. Any allowance counted from `jobs` rows is reset by the user pressing
   Delete.

## Goal

A free plan that lets a stranger reach a real result on their own content, on
both Telegram and web, without the owner being able to lose money on it.

## Non-goals

- **Re-pricing the paid tiers.** The markup slope is inverted (Starter 4.2x over
  cost, Starter-monthly 3.5x, Plus 3.05x, Max 2.67x) and weekly billing burns
  $1.30/month more in Stripe fixed fees than monthly. Both are real and both are
  optimisations of a multiplication by zero until someone pays. Separate work.
- **Switching the critic model.** `gpt-5-mini` instead of `gpt-5.1` would cut
  analysis cost ~5x and return ~10 points of gross margin, but it trades against
  highlight quality, which is already the weak axis. It needs a fixture-level
  comparison, not a config edit. Separate work.
- **Live Stripe keys.** Prod runs `sk_test_`; web checkout cannot take real
  money. Tracked separately, and it does *not* fix this problem - the wall sits
  in front of a `NONE` user before any payment step.
- **The apology email to the 34 stranded users.** It is the reason this work
  started, but it is a downstream send that must not go out until the free plan
  is live. The email infrastructure built here is what makes it possible.
- **Telegram broadcast.** 66 of 102 users have no email at all. Reaching them is
  a bot feature, not a Resend feature.

## Unit economics this design is built on

Measured from the 9 real jobs in prod that carry cost telemetry, not estimated.

| Item | $/source-minute | Real cash? |
| --- | --- | --- |
| Transcription (`whisper-1`) | 0.0060 | yes |
| Analysis (`gpt-5.1` critic, V2 `recall-critic`) | 0.0035 (range 0.0018-0.0052) | yes |
| Compute | 0.0060 *as booked* | **no** - own server, sunk |
| R2 storage | ~0.0001 | negligible |
| **Cash cost** | **0.0095** | **$0.57 per source hour** |

Two notes that matter for anyone reading the numbers later:

- `COMPUTE_COST_PER_MINUTE = 0.006` in `apps/worker/src/cost-telemetry.ts:8` is
  a constant tuned to match the Whisper price. Nobody measured it. It inflates
  reported cost by ~63% and is not money leaving the account.
- `gpt-4o-mini-transcribe` sits in the price table at half the cost, but
  `apps/worker/src/processors/transcribe.ts:154` requests `verbose_json` with
  word-level timestamps, which the karaoke subtitles depend on. Verify against
  current API docs before counting on that saving.

Consequences: 60 free minutes cost **$0.57** per account. One Plus subscriber
nets $18-25/month, so a single Plus lasting three months funds ~95 free
accounts. Break-even conversion is ~1% into Plus at three-month retention, or
~7% into weekly Starter at one-month retention. Typical freemium conversion is
2-5%, so the model closes - with a thin margin and no retention data, which is
why the global ceiling below is not optional.

## The offer

| Parameter | Value | Why |
| --- | --- | --- |
| Free allowance | **60 minutes of source, lifetime** | $0.57 cash; lifetime, because a renewing free tier is farmable forever and the point is "see one real result once" |
| Per-video ceiling | 60 minutes | one whole podcast episode or stream chunk - the length at which scanning by hand is genuinely painful, which is the thing being sold |
| Divisible | yes: one 60-min, or six 10-min | lets a user try different content |
| Clips delivered | all that were found | compute is already spent; withholding output only annoys |
| Storage | 3 days, up to 10 clips | swept by the existing retention sweep |
| Queue | lowest priority | a paying user never waits behind a free one |
| Surfaces | Telegram and web | anchored differently, see below |

60 rather than 30 minutes: the audience clips 3-8 hour VODs, and a 30-minute
ceiling forces them to hand-trim a segment first - the exact work they came to
avoid - and proves nothing on a segment they could scan themselves. The extra
30 minutes cost $0.27 per account.

60 rather than 120: Starter gives 75 minutes **per week** for $3. A lifetime
free allowance must stay clearly below one week of the entry tier or it competes
with the product's own cheapest plan. This constraint, not cost, is what caps
generosity.

### Charging rule

Minutes are **reserved at submission** and released afterwards if the run did
not deserve to cost anything. Reservation, not post-hoc charging, is what makes
concurrent submissions safe: ten videos submitted at once would each see a full
balance and all ten would run.

- `CHARGE` is written **before the job is enqueued**, for the probed duration.
- A job that ends `FAILED` is refunded in full, **always and without limit**.
  Our own breakage must not consume a stranger's only look at the product.
- A job that transcribes but produces **zero clips** is refunded **once per
  account**. This protects against "first attempt was a dud, left forever"
  without letting anyone feed us silence indefinitely.

So the money and the ledger agree in the end: a free account only ends up having
spent minutes on runs that actually produced clips, or on its second and later
zero-clip attempts.

## Architecture

| Component | Responsibility | Depends on |
| --- | --- | --- |
| `free_usage` table | Append-only ledger: one row per charge and per refund | nothing - survives job deletion by design |
| `freeTier.service` | The only place a balance is computed or a submission is judged: `balanceSeconds()`, `charge()`, `refundOnce()` | `free_usage` |
| `source-probe` (promoted to shared) | The real duration: `yt-dlp --print duration` for links, `ffprobe` for uploads. Never trusts the client | lifted from `apps/bot/src/url-probe.ts` |
| `freeBudget.service` | Monthly ceiling from `.env`, month-to-date sum, killswitch | `free_usage` |
| `email.service` | One send function plus templates: verification, password reset, later the apology | `RESEND_API_KEY`, DNS |
| Trial gate | `emailVerified != null` OR `telegramId != null` | `email.service` |

### `free_usage`

```prisma
model FreeUsage {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId            String?  // NO relation, NO cascade - the job may be deleted
  kind             FreeUsageKind // CHARGE | REFUND
  seconds          Int
  estimatedCostUsd Float?   // written from the probe, trued up at finalize
  createdAt        DateTime @default(now())

  @@index([userId])
  @@index([createdAt])
  @@map("free_usage")
}
```

`jobId` is a bare string, deliberately: a foreign key with any cascade
reintroduces hole 3 through the back door.

Balance is `FREE_TIER.lifetimeSeconds - sum(CHARGE) + sum(REFUND)`.

A counter column on `User` was rejected: it cannot be audited, corrected, or
distinguished from farming after the fact. The ledger costs one table and
answers all three.

### Flow of a free submission

1. User submits a URL or upload.
2. `source-probe` returns the true duration. A URL probe is metadata-only, no
   bytes downloaded; an upload is `ffprobe`d.
3. `freeTier.service` checks, in order: trial gate (verified email or Telegram),
   per-video ceiling, remaining balance, monthly budget.
4. Any failure rejects **before a single cent of OpenAI spend**, with copy that
   names the real reason.
5. On pass, a `CHARGE` row is written with the estimated cost - reserving the
   minutes - and the job is enqueued at lowest priority.
6. At finalize, `estimatedCostUsd` is trued up from the actual telemetry.
7. If the job ended `FAILED`, a full `REFUND` is written, always. If it finished
   with `clipsGenerated == 0`, `refundOnce` writes a `REFUND` - at most one per
   account, ever.

### Closing the three holes

| Hole | Closed by |
| --- | --- |
| Open registration | Trial gate: allowance requires a verified email or a linked `telegramId`. Password signup stays (owner's decision), so it needs the verification mail |
| Client-supplied duration | `source-probe`; `sourceDurationSec` from the request body is no longer trusted for gating |
| Reset by deletion | `free_usage` has no cascade from `Job` |

### Anti-farm details

- **`emailCanonical`**, new unique column: everything after `+` is dropped on
  **every** domain, and for `gmail.com`/`googlemail.com` dots are stripped too,
  so `o.l.e.g+1@gmail` and `oleg@gmail` collide as one account. The raw `email`
  stays as typed, because that is the address mail is delivered to.

  The two rules have different scopes on purpose. Plus-addressing is not a Gmail
  feature - Outlook, Yahoo, Proton and Fastmail all honour it - so gating it to
  Gmail would leave the alias hole open on every other major provider.
  Providers that reject `+` outright, iCloud among them, cost nothing here: the
  mail never arrives, so the account never verifies and never reaches the
  allowance. Dots are the opposite: they are significant in the local part almost
  everywhere except Gmail, so folding them globally would merge two different
  people onto one account. The failure directions are not symmetric either.
  Collapsing two distinct addresses refuses a registration with a message the
  user can read and act on; separating one mailbox into two silently hands out a
  second allowance that costs real money.

  A trailing dot on the domain (`oleg@gmail.com.`, legal FQDN notation that
  receiving servers treat as the same mailbox) is stripped before any of this,
  or it mints a second canonical key for one person.
- **Disposable-domain blocklist**, static list in shared config, checked at
  registration.
- Telegram needs neither: a `telegramId` is phone-backed and costs a SIM.

A Google account counts as verified regardless of what the adapter wrote into
`emailVerified`: the gate accepts a user who has a linked `google` row in
`accounts`. Google has already proven the address, aliases collapse to one
canonical mailbox on their side, and minting Google accounts costs real effort -
which is exactly the property the anchor is for.

**But OAuth signups do not pass through the registration route**, and that was a
hole in the first draft of this design. `PrismaAdapter` creates the user itself,
with `emailCanonical` left NULL - so every new Google account leaves its mailbox
identity unclaimed, and the same person can then register a plus-alias by
password and collect a second allowance. Both lookups miss: the exact address is
different, and the canonical lookup finds nothing because the Google row never
claimed it. This is the main path, not a corner: 28 of the 36 existing email
accounts arrived through Google.

Closed in two places. The `events.createUser` hook in `apps/web/lib/auth.ts`
writes the canonical for OAuth signups. When that write hits a unique violation,
the mailbox is genuinely already owned by another account, and the column is
left NULL rather than failing a sign-in the user cannot fix - so for an account
that HAS an email, a NULL `emailCanonical` means exactly "another account owns
this mailbox". The trial gate therefore requires `emailCanonical != null` on its
email branch. A Telegram-only account has both columns NULL and is anchored by
`telegramId`, so the Telegram branch is checked first and is unaffected.

### Global ceiling

`FREE_TIER_MONTHLY_BUDGET_USD` in `.env` (initial value 50). `freeBudget`
sums `estimatedCostUsd` over the current calendar month's ledger rows; when the
ceiling is reached the trial closes until the first of the next month, paying
users untouched. At $50 and $0.57 per account this funds ~90 new people a month,
against the current inflow of ~10.

The ceiling is the reason bankruptcy is structurally impossible here regardless
of how the per-account numbers are tuned, and the reason a farmer who defeats
the anchor costs money but cannot cost unbounded money.

## Config changes

- `FREE_TIER` becomes `{ lifetimeSeconds: 3600, zeroClipRefunds: 1 }`. The old
  `runs`/`attempts` pair is replaced: the allowance is denominated in minutes
  now, and the attempts backstop is subsumed by the refund rule.
- `NONE_LIMITS` gets real values: `maxSourceDurationMinutes: 60`,
  `maxJobsPerDay: 5`, `storageClips: 10`, `retentionDays: 3`,
  `concurrentJobsLimit: 1`, `priorityQueue: false`. `minutesPerPeriod` stays 0 -
  the free allowance is lifetime and is answered by the ledger, not by
  `usage.service`'s period window.
- The "DISABLED 2026-07-25" comment block is replaced with a description of what
  now enforces each of the three holes.

## Surfaces

- **Web dashboard**: for `NONE`, `UploadZone` shows the remaining free minutes
  and stays enabled while a balance exists. At zero it is replaced by the plans
  and Telegram-bot call to action - not by a form that fails on submit.
- **API copy**: the `Daily job limit reached (0)` path can no longer be reached
  by a `NONE` user; each rejection reason gets its own honest message
  (unverified email, no balance, video too long, trial closed for the month).
- **Bot**: the existing trial strings already exist for `runs`/`attempts` and
  are re-expressed in minutes, across all six locales (`en`, `ru`, `uk`, `es`,
  `pt`, `id`).
- **Funnel**: new `upload_rejected_*` variants so `/admin` shows which wall a
  user hit - unverified, exhausted, too long, or budget closed.
- **`/login` renders `?verified=`.** The verify route redirects with
  `?verified=ok|invalid|not-found|expired` and nothing reads it, so a user who
  clicks Confirm in their mail lands on the generic sign-in card with no
  acknowledgement - the address really is verified, but the only evidence is a
  query parameter nobody displays. The rational next move is to click the link
  again, which returns `not-found` because the token was burned, and the feature
  now reads as broken. Two constraints on the copy: `not-found` must say **"this
  link has already been used"** and never "your email is not verified", because
  a corporate mail scanner prefetching the link burns it before the human ever
  clicks; and `ok` has to be visible to someone already signed in, because
  registration auto-signs-in before the mail arrives. `login/page.tsx` is a
  client component, so `useSearchParams()` needs a `<Suspense>` boundary or the
  build fails.

## Error handling

- Probe failure (dead link, unsupported host, unreadable upload) rejects with
  the existing bot copy and charges nothing.
- Resend being down must not block registration: the account is created
  unverified and the mail is retried; the user can request a new link.
- A finalize that cannot true up the cost leaves the probe estimate in place -
  the ceiling then runs on estimates, which is the conservative direction.
- Ledger writes are transactional with job creation, so a crash cannot enqueue
  work that was never charged.

## Testing

- `freeTier.service`: balance arithmetic, charge/refund ordering,
  refund-once-only, the exact boundary at 3600 seconds.
- Deletion: charge, delete the project, assert the balance did not move. This is
  the regression test for hole 3 and must exist.
- `source-probe`: client-supplied duration is ignored; a URL over the ceiling is
  rejected without a download.
- `emailCanonical`: gmail dots and `+` aliases collapse; other domains do not.
- `freeBudget`: the ceiling closes the trial and does not touch paid users.
- Per `project_running_tests`: bot tests run **inside the bot container** - the
  web container holds a stale `apps/bot` copy that passes silently.

## Rollout

1. Migration (`prisma migrate`, not `db push`) for `free_usage` and
   `emailCanonical`, plus a backfill of `emailCanonical` for the 36 existing
   email accounts. Checked on prod 2026-07-28: canonicalising all 36 produces
   **zero collisions**, so the unique index can be added in the same migration.
   The backfill must still be written collision-safe - keep the oldest account's
   canonical form and leave later duplicates null rather than failing the
   migration - because it will run again on whatever the database looks like at
   deploy time, not today's snapshot.
2. Resend domain verification on one.com DNS: SPF, DKIM, DMARC. The domain
   currently has **no TXT records at all** and a null MX (`0 .`), so it neither
   sends nor receives today. Decide where replies go before the first send.
3. Re-run the backfill once the code is live. Existing rows were filled by step
   1 and new OAuth signups are claimed by the `createUser` hook, but a Google
   account created *between* those two moments has a NULL `emailCanonical` with
   no collision behind it. The gate refuses such an account its allowance - it
   fails safe, but to a real user that looks like a bug. The script is
   idempotent, so it costs nothing when the window is empty.
4. Ship with `FREE_TIER_MONTHLY_BUDGET_USD` set low (e.g. 10) for the first
   week, watch `/admin`, then raise.
5. Only after the plan is live and observed: the apology mail to the 34 stranded
   accounts.

Rollback is `FREE_TIER_MONTHLY_BUDGET_USD=0`, which closes the trial without a
deploy and without touching paying users.

## Open questions

- What the infrastructure actually costs per month is still unknown, so
  break-even is quoted against a ~$0 fixed cost. If the server turns out to cost
  $50-200, the required subscriber count changes but nothing in this design
  does.
- Retention of free-to-paid converts is unmeasurable until someone pays; the 1%
  and 7% break-even conversions are arithmetic, not observation.
