# Submission queue instead of the concurrency refusal - design (2026-08-18, APPROVED)

## 0. The defect, in numbers

`concurrentJobsLimit: 1` (NONE / STARTER) refused 11 submissions from 6 people in three
weeks. One person sent five videos in 200 ms and got four refusals; people send albums.
The refusal copy says "send this one again once that is done" - nobody did. This is
ordinary behaviour, not abuse, and the answer should be a queue.

## 1. Goals / non-goals

- Goal: a second (third, ...) submission while one is running is ACCEPTED, told it is
  queued, and starts by itself when the running one ends. Free seconds are reserved at
  submission exactly as today.
- Goal: nothing about the per-user advisory lock, the zero-clip forgiveness cap or the
  ledger changes shape. Serialising per user makes the forgiveness race SAFER (two
  finalisations of one user can no longer overlap).
- Non-goal: cross-user fairness or priority (BullMQ order stays FIFO); a queue UI on the
  web; cancelling a queued job from the bot (the web "delete project" already exists).

## 2. Mechanism

1. `Job.enqueuedAt DateTime?` (new, nullable). NULL = created, charged, waiting for a
   slot; set = handed to BullMQ. Index `(userId, enqueuedAt, createdAt)`.
2. `createJob` keeps its transaction and lock. Inside it the in-flight count becomes
   `status IN ACTIVE AND enqueuedAt IS NOT NULL`. If `count >= limit` the job is still
   CREATED (row + freeUsage charge, as today) but NOT enqueued and `enqueuedAt` stays
   NULL; the result is `{ status: "queued", position }` instead of `concurrent_limit`.
   Otherwise `enqueuedAt = now()` and the download job is added as today.
3. Release: `finalizeJob` (worker-finalize, on DONE and on terminal FAILED) calls
   `releaseNextQueued(userId)`: under the same per-user advisory lock, if the user's
   enqueued-active count is below the limit, take the oldest `enqueuedAt IS NULL` PENDING
   job, stamp `enqueuedAt`, add to the download queue. Repeat while under the limit (a
   MAX account with limit 3 may release several).
4. Stall guard: an hourly maintenance rule (beside the retention sweep) releases queued
   jobs for any user whose enqueued-active jobs have not updated `updatedAt` in 3 h - a
   dead worker must not hold a person's queue forever. Logged, counted.
5. Bot copy: `concurrent_limit` branches become `queued(position)` - "Got it - it's
   next in line behind the one I'm doing; I'll start it the moment that finishes." The
   progress board (`showQueuedBoard`) already renders a queued state. Web: 202 with
   `{ queued: true, position }`; the dashboard shows the job as "Queued" (status PENDING,
   `enqueuedAt` null) - one badge.
6. Telemetry: `upload_rejected_concurrent` stops being written (nothing is refused);
   a new funnel event `video_queued` counts people who queued at least once; the ledger
   gets nothing (not a refusal).

## 3. Bounds and abuse

- Free seconds are reserved at creation, so a queue cannot overspend the trial; the
  60-second floor bounds the count (<= 60 jobs lifetime).
- Paid accounts: bounded by minutes per period exactly as today; `maxJobsPerDay` still
  counts created jobs.
- Optional cap on queue LENGTH per user (e.g. 10) - Decision A below.

## 4. Edge cases

- Running job FAILED and later healed to DONE (a stage retry): release runs on both;
  `releaseNextQueued` is idempotent under the lock and the count check.
- User deletes a queued job (web): row goes, nothing to release; ledger refund follows
  the existing delete path (verify: charge is refunded on delete of a job that never ran).
- Two submissions in 200 ms (the album case): both take the lock in turn; the second
  sees count 1 >= limit 1 -> queued. Reproduce against Postgres in the test, as the
  concurrency limit was.

## 5. Decisions (owner, 2026-08-18)

- A. Queue length cap per user: NONE. The existing walls bound it - free seconds are
  charged at creation, the daily cap is 60, paid accounts have minutes per period. No
  new refusal code.
- B. Release on terminal FAILED: YES. A failed run must not block the next video.
- C. Stall guard threshold: 3 hours.
- D. Web: 202 + { queued: true, position }, dashboard shows a "Queued" badge
  (status PENDING and enqueuedAt NULL).

## 6. Size

Schema + createJob + release + stall rule + bot copy (7 locales) + web route + tests:
about a day with the executor/reviewer loop used for cut recovery. Ships behind
`SUBMISSION_QUEUE=on` with `off` = today's refusal, byte-identical.
