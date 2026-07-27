# Storage retention: sweep job and source-artifact lifecycle

Date: 2026-07-27
Status: implemented on `feature/retention-sweep`, running in report-only mode

This document was revised after implementation and an adversarial review. Where
the built thing differs from the original design, the design was wrong - the
differences are called out inline rather than hidden.

## Problem

Nothing in R2 is ever deleted automatically.

`Clip.expiresAt` is written at insert time by `computeClipExpiresAt`
(`packages/shared/src/lib/retention.ts`), the schema carries
`@@index([expiresAt, deletedAt])`, and `usage.service` already counts stored
clips as `deletedAt: null` - the whole contract for retention exists except the
thing that enforces it. The comment in `retention.ts` calls the missing sweep
"Plan 2". As of today prod holds 5 clips that are past `expiresAt` and still
occupy their objects, and the plans page sells 7/30/90-day retention that is in
fact unlimited on every tier.

Source video is worse than the clips by two orders of magnitude, and it is
stored in three places per job:

| Key | Written by | Read by | Dead after |
| --- | --- | --- | --- |
| `uploads/...` (`Job.sourceKey`) | web presign, or bot `handlers.ts` | `download.ts` only, once | the download stage |
| `work/<user>/<job>/source-*.mp4` (`Job.sourceArtifactKey`) | `download.ts` | nobody once `normalizedArtifactKey` differs | normalization |
| `work/<user>/<job>/normalized-*.mp4` (`Job.normalizedArtifactKey`) | `download.ts` | transcribe, render, editor | the edit window |

For an uploaded file, copy 2 is a byte-identical re-upload of copy 1. A clip is
5-20 MB; a source is up to 2 GB, twice or three times over.

Two further leaks:

- `deleteProject` collects `sourceKey`, `sourceArtifactKey` and `thumbnailKey`
  but not `normalizedArtifactKey`, so manual project deletion orphans the
  largest object.
- `download.ts` builds `source-${randomUUID()}.mp4` and uploads it on *every*
  BullMQ attempt, overwriting the DB column each time. Every retry orphans a
  full-size copy that no row references.

## Scope

In: the sweep job, the source-artifact lifecycle, deterministic artifact keys,
the `deleteProject` leak, and teaching the clip read paths about `deletedAt`.

Out, deliberately:

- Storing the Telegram `file_id` returned by `sendVideo` so Telegram becomes the
  archive for bot-delivered clips. Attractive - re-sending by `file_id` is free
  and unlimited in size - but it changes the offer copy ("Storage: X/Y clips,
  kept N days" is printed in every locale) and is a separate piece of work.
- Changing the 7/30/90 numbers. 90 days belongs to MAX only, where long
  retention is part of the price. The number cannot be argued about honestly
  until it is first enforced.
- A `clip_downloaded` funnel event. Needed to answer "do users come back to old
  clips", not needed to stop the leak.

## Design

### 1. Deterministic artifact keys

`work/<user>/<job>/source.mp4` and `work/<user>/<job>/normalized.mp4`, replacing
the `randomUUID()` forms. A retried download stage overwrites its own object
instead of orphaning the previous one, and the whole artifact set for a job
becomes addressable by prefix.

Only new jobs get the new shape. Existing rows keep their uuid keys and are
handled by the sweep through the DB columns, which is how the sweep works
anyway.

### 2. The sweep

A repeatable BullMQ job, hourly, registered next to the referral schedules in
`apps/worker/src/referral-scheduler.ts` (same pattern: fixed `jobId`, cron
pattern, registration on worker boot).

Three rules, each with its own clock:

**Rule A - expired clips.** `expiresAt <= now() AND deletedAt IS NULL`. Delete
the R2 object at `storageKey`, then set `deletedAt`. The row stays: `clipsStored`
counts `deletedAt: null`, so the quota frees up, and the history stays intact
for analytics. `storageKey` is kept for forensics.

A clip with an empty `storageKey` is a real case, not a defensive one: `editClip`
inserts the row with `storageKey: ""` and an `expiresAt` before the render queue
has produced anything. If that render never completes, the row expires with no
object behind it. Rule A must mark such a row `deletedAt` without calling
`deleteFile("")`, which would otherwise be an S3 call with an empty key.

**Rule B - redundant source copies.** Job status is terminal (`DONE` or
`FAILED`), `createdAt < now() - 24h`, `sourceSweptAt IS NULL`, and the job has
not been touched since the cutoff. Delete `sourceKey`; delete
`sourceArtifactKey` *only if* `normalizedArtifactKey` is non-null *and* differs
from it. Null the columns that were actually deleted.

The `normalizedArtifactKey IS NOT NULL` half of that guard was missing from the
first implementation and is the sharpest edge in the whole design. When the
column is null, `sourceArtifactKey !== normalizedArtifactKey` is trivially true -
and every consumer reads `normalizedArtifactKey ?? sourceArtifactKey`, so the
"redundant copy" being deleted is in fact the job's only source. Four rows in
production were in that state.

"Not touched since the cutoff" means `processingStartedAt` is null or older than
the cutoff. This exists because **`FAILED` is not a terminal status**: the worker
stages write `Job.status = FAILED` inside their catch on every BullMQ attempt,
not only the last one - `telegram-delivery.service.ts` documents this at length
for its own poller. Without the guard, a job whose first download attempt just
threw looks terminal for the few seconds before attempt two, and Rule B deletes
the `sourceKey` that attempt two is about to re-read. The user's upload would be
gone with no way back. `download.ts` refreshes `processingStartedAt` at the start
of every attempt, which makes it the reliable "a worker is on this" signal.

This is the large, free win: two copies of three, with no product consequence at
all. The 24-hour grace exists so a manual re-run or an incident investigation
on the day of the failure still has the input.

**Rule C - end of the edit window.** Job is terminal and
`createdAt < now() - 7 days`. Delete whatever artifact keys remain
(`normalizedArtifactKey`, plus `sourceArtifactKey` when it is the same key) and
null them.

Both B and C require a terminal status for the same reason: a non-terminal job
still owns its input. A job that has been `PROCESSING` for seven days is stuck,
and deleting its source guarantees it can never resume - so the sweep leaves it
alone and logs it instead. Stale non-terminal jobs are a real problem and a
separate one.

Seven days is a fixed number for every plan, not a plan field: it is not sold,
not shown, and not tied to clip retention. Past it, editing degrades rather than
breaking - `renderTrim` already branches on the presence of
`payload.sourceArtifactKey` and falls back to re-trimming the clip file
(`apps/worker/src/stages/render.ts`). The degradation is real - re-burning
subtitles onto a clip that already has them stacks text - so the fallback is the
worse path, not a free one, which is why the window exists at all.

The number lives in `packages/shared/src/lib/retention.ts` next to
`computeClipExpiresAt`, as `SOURCE_ARTIFACT_RETENTION_DAYS = 7` and
`REDUNDANT_SOURCE_GRACE_HOURS = 24`.

**Rule D - orphaned thumbnails.** Jobs with a `thumbnailKey` that have at least
one clip and where no clip is still alive. Delete the thumbnail, null the column.

The clock here is the clips, not the artifacts, and that distinction is the whole
point. Rule C fires at 7 days, but a MAX user's clips live 90 - reclaiming the
thumbnail with the artifacts would leave a project card with no picture above
clips that still play. A thumbnail is orphaned when the project has nothing left
to show, which is exactly "every clip swept". The `at least one clip` half is
load-bearing: a job that produced no clips satisfies "no clip is alive"
vacuously, and its card is still perfectly current.

**The invariant that makes this safe:** a column is nulled *only after its own*
R2 delete is confirmed (a 404 counts as confirmed - the object is gone either
way), and the patch is built key by key rather than all at once. The first
implementation was all-or-nothing: it attempted every delete and, if any failed,
nulled nothing - so a confirmed delete sitting next to a failed one left a
deleted object behind a live column, which is precisely the state this invariant
exists to forbid. Only Rule B's `sourceSweptAt` stamp is withheld on failure, so
the row is retried; Rule C needs no stamp because it selects on the very columns
it nulls.

The reverse order is the trap: `sourceArtifactKey` pointing at a deleted object
makes `renderTrim` take the `cleanSource` branch and fail on download, instead
of taking the fallback branch and degrading. The DB column, not the bucket, is
the source of truth for "this artifact exists".

**Where that invariant is not enough.** `editClip` snapshots the artifact key
into the BullMQ payload at enqueue time, and `renderTrim` branches on the
*payload*, not the column. So an edit queued at 13:59 and rendered at 14:03 can
meet a sweep that ran at 14:00, however atomic that sweep was. Worse, a trim
failure is reported nowhere - `runRenderStage` only calls `markJobFailed` for
`mode: "clips"` - so the user would get a permanently empty clip and no error.
`renderTrim` therefore treats a failure to *obtain* the clean source as a signal
to degrade to the clip-file fallback rather than to throw. Only that one failure
degrades; encode failures still propagate, because they have their own fallback
ladder and swallowing them would hide real bugs.

Batching: each rule takes a bounded page (200 rows) per run, ordered by the
column it selects on, so one pass cannot hold the worker or the R2 client for an
unbounded time and the page is deterministic rather than whatever Postgres felt
like returning. A backlog drains over successive hours. Within a page each row's deletes are isolated - a key that
fails costs its own row and nothing else, and the other 199 still get swept.
Deletes run sequentially rather than fanned out: nothing here is urgent, and 200
concurrent DeleteObject calls from the finalize worker are a burst nobody asked
for.

Idempotence: every rule's selector excludes what it already did (`deletedAt IS
NULL`, `key IS NOT NULL`), so a re-run after a crash mid-page is a no-op on the
rows it finished.

### 3. Clip read paths learn about `deletedAt`

`getDownloadUrl` currently signs a URL for whatever `storageKey` says and hands
the user an R2 404. `getClip`, `getClipsByJob` and `getUserClips` likewise return
rows whose bytes are gone.

- `getDownloadUrl` refuses a clip with `deletedAt` set, with a distinct error the
  route turns into "this clip's retention period has ended" rather than a 500.
- The list paths keep returning the rows but the dashboard renders them as
  expired: the clip existed, and saying so is more honest than a row that
  silently vanishes.
- `getPendingTelegramDeliveries` gets a defensive `deletedAt: null` filter on its
  clip include. Delivery happens minutes after render and the shortest retention
  is 3 days, so this can only matter in a pathological backlog - but the failure
  mode there is the bot sending a dead presigned URL.

### 4. `deleteProject` leak

Add `normalizedArtifactKey` to the select and to the key list, and dedupe the
list through a `Set` before deleting - `normalizedArtifactKey` and
`sourceArtifactKey` are frequently the same string, and deleting the same key
twice logs a spurious error.

### 5. Deleting is opt-in, not opt-out

`RETENTION_SWEEP_LIVE` must hold a non-empty value for any delete to happen.
Unset, empty, absent: every rule runs its selector and logs what it would delete,
and neither R2 nor the DB is touched.

The flag is named for the destructive branch on purpose. The original design had
`RETENTION_SWEEP_DRY_RUN`, which fails open - a line reading
`RETENTION_SWEEP_DRY_RUN=` is exactly what copying `.env.example` produces, and
an empty value is falsy, so the safest-looking `.env` in the world would have run
live against a bucket nobody had ever cleaned. For a switch guarding irreversible
deletion of user data, a typo has to land on "report".

A non-zero `failed` count sends the summary to `console.error` rather than
`console.log`. Without that, a revoked `R2_ACCESS_KEY_ID` produces a sweep that
runs cheerfully for ever, deletes nothing, and never frees a byte or a quota.

## Testing

Unit tests in the worker package, run inside the `worker` container:

- Rule B does not delete `sourceArtifactKey` when it equals
  `normalizedArtifactKey`. This is the one case where a wrong selector destroys
  a live job's only source.
- Rule B does not touch a job that is still processing, nor one that is terminal
  but younger than the grace.
- Rule C deletes the remaining artifact and nulls the columns.
- Rule A sets `deletedAt` and leaves the row and `storageKey` in place.
- Rule A marks an expired clip with an empty `storageKey` as deleted without
  issuing an R2 call.
- Neither B nor C touches a job that is still non-terminal, however old it is.
- A failing R2 delete leaves the column set and the clip's `deletedAt` null, and
  the next run retries the same row.
- A second run over already-swept rows is a no-op.
- Dry run performs no writes to either R2 or the DB.

The quota-release behaviour needs no new test: `usage.service.test.ts` already
asserts that `clipsStored` is counted with a `deletedAt: null` filter, which is
the whole contract between the sweep and the quota. That test is run as part of
the sweep work to confirm the contract still holds.

## Consequences

- Storage stops growing without bound. Steady state becomes roughly one
  normalized source per job for 7 days plus clips for the plan's retention,
  instead of every byte ever processed.
- The 7/30/90 retention the plans page sells becomes true. Users on paid plans
  will start losing clips they currently keep forever. This is the advertised
  behaviour, but it is a visible change and the first sweep is the moment it
  starts.
- Editing a clip from a job older than 7 days silently takes the lower-quality
  re-trim path. If that turns out to matter, the lever is the constant, not the
  design. Note that this path re-burns subtitles onto a clip that already has
  them, which stacks text - pre-existing behaviour, but the sweep makes it
  reachable far more often, so it is now worth fixing on its own.

## What this deliberately does not do

**It never deletes a `Job` row.** Considered and rejected: the rows are the
billing ledger and the free-tier ledger. `usage.service` sums
`sourceDurationSec` over jobs inside the current billing period, so deleting
7-day-old jobs would hand a monthly subscriber their spent minutes back every
week; and the lifetime trial counter is `job.count` with no date filter, which
`plans.ts` already warns can be reset by deleting jobs. The R2 objects are the
expensive part; the rows are grams.

**It does not reclaim orphans.** An object in R2 that no row references is
invisible to every rule. Derived artifact keys stop new orphans being created by
retries, but anything orphaned before that change is still in the bucket and
needs a prefix scan to find. That is a separate piece of work.
