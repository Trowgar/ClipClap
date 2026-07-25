# Known issues

Findings that are real, reproduced, and deliberately not fixed yet. Each says what triggers it, what it
costs, and why it waits. Delete an entry when it is fixed; do not delete one because it looks old.

Context for the priority calls below: as of 2026-07-25 the product has 95 registered users, 3 of whom have
ever run a job, 8 jobs total and 38 clips ever made. Every issue here needs either many users or an
infrastructure outage to fire. That is why they wait, not because they are wrong.

## Telegram delivery

**The attempt counter cannot drain a failing write path.**
`apps/bot/src/handlers.ts` (the `owedWrites` memo branch). The branch `continue`s before reaching
`markTelegramDeliveryAttemptFailed`, so a memoized row spends no attempt and never retires. When the failing
subsystem is Postgres writes rather than Telegram sends - a read-only replica, disk-full, transaction-id
wraparound, a promoted standby - reads keep succeeding, the drain never fires, and 20 such rows starve the
whole queue again. Measured: 20 write-failing rows plus one healthy row, 360 polls, zero deliveries, all rows
still PENDING with attempts 0. Fixing it means the retirement decision cannot depend solely on a DB write.

**A restart during the write window re-sends the whole clip batch.**
`apps/bot/src/handlers.ts` - `owedWrites` is an in-process Map, so a fresh process has an empty memo. If the
status write is broken when the container restarts, every clip of the job is sent again. Measured: 2-clip
job, 2 videos before restart, 4 after. Strictly better than the pre-2026-07-25 behaviour (which repeated
forever) but still a duplicate send, and the window it opens is a DB outage - exactly when a container is
most likely to be restarted.

**`isPermanentTelegramError` is applied to errors that never came from Telegram.**
`packages/shared/src/services/telegram-delivery.service.ts`, called from `handlers.ts`. The surrounding `try`
spans `getUserLocale` (Prisma), `getPresignedDownloadUrl` (R2) and the Telegram calls, so any of their
messages get substring-matched against the permanent list. Probe: an R2 error containing "chat not found"
retires the row instantly and terminally. The check should be gated on the error actually originating from
the Telegram client.

**`owedWrites` leaks entries.**
Entries are removed only when a flush succeeds. If a row leaves the pickup set with a memo outstanding (job
or user deleted, so the flush keeps failing with P2025 and `findMany` stops returning the row), the entry is
never evicted. A slow leak in a long-lived process; a TTL or an eviction on P2025 closes it.

**Polling has no backoff.**
`apps/bot/src/index.ts` re-polls every 10s regardless of outcome. A Telegram 429 asking for 300s of flood
wait is answered with further requests inside its own window, which extends it. The attempt budget is
denominated in polls rather than time, so "two minutes of tolerance" is only true when a pass is instant.

## Analyze

**Partial critic omission with zero survivors is not covered by the all-or-nothing guard.**
`apps/worker/src/analyze-v2/index.ts`. The guard fires when nothing at all was judged. A run where some
candidates were judged and every one of them was then dropped downstream still ships DONE with 0 clips and
bills. Same shape as the scanner and critic guards already closed; left open because distinguishing a
technical drop from a legitimate one requires per-reason judgment that has already been gotten wrong twice on
this branch.

## Billing

**Every job that is not FAILED bills, including honest empty answers.**
`packages/shared/src/services/usage.service.ts` sums `sourceDurationSec` over jobs with
`status: { not: "FAILED" }`. A video with no speech, or one the engine honestly found nothing in, consumes
the user's minutes. Competitor research (2026-07-25) found the market leader treats both as refundable
failures and auto-returns credits; three other competitors publish no policy at all. The proposed fix is a
`Job.billedSeconds` column summed instead of `sourceDurationSec`, set to 0 for empty outcomes - deliberately
cheap to do now while the table is tiny. Waiting on an owner decision.

## Product

**There is no free tier, and it is the measured bottleneck.**
`packages/shared/src/config/plans.ts` - `NONE_LIMITS` is zero on every field, so a registered user cannot
process a single second of video before paying. 92 of 95 registered users have never made a clip. Every
competitor examined offers a free trial (Vizard 60 credits, Submagic 3 videos, Sonix explicitly recommends
using trial minutes to check whether the service handles your audio). Nobody has ever used this product
without paying first, so there is no signal about clip quality from anyone but the owner.

**The top of the funnel is invisible.**
`apps/bot/src/handlers.ts` - `/start` shows the two-button screen and returns without creating a user, so
people who press `/start` and leave are not recorded anywhere. We can see that 95 users deliberately created
an account and 3 uploaded; we cannot see how many bounced one step earlier.

**The submission blocker is hardcoded English.**
`apps/bot/src/handlers.ts` `getSubmissionBlocker` returns `"Active subscription required to process videos."`
as a literal, bypassing the EN/RU dictionary. Of the 95 registered users, 21 are Russian, and there are also
Arabic, Indonesian, Farsi, Uzbek, Portuguese, Ukrainian and French locales. Most of them hit this wall in a
language they may not read.
