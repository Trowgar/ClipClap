# Storage retention: sweep job and source-artifact lifecycle

Date: 2026-07-27
Status: approved, not implemented

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
`FAILED`) and `createdAt < now() - 24h`. Delete `sourceKey`; delete
`sourceArtifactKey` *only if it differs from* `normalizedArtifactKey` (they are
the same key when `normalizeSource` returned `action: "none"`). Null the columns
that were actually deleted.

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

**The invariant that makes this safe:** a column is nulled *only after* its R2
delete is confirmed (a 404 counts as confirmed - the object is gone either way).
Any other error leaves the column set and the next hourly pass retries. The
reverse order is the trap: `sourceArtifactKey` pointing at a deleted object
makes `renderTrim` take the `cleanSource` branch and fail on download, instead
of taking the fallback branch and degrading. The DB column, not the bucket, is
the source of truth for "this artifact exists".

Batching: each rule takes a bounded page (200 rows) per run, so one pass cannot
hold the worker or the R2 client for an unbounded time. A backlog drains over
successive hours. Deletes within a page run through `Promise.allSettled` - one
failing key must not abandon the other 199.

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

### 5. Dry run for the first production pass

`RETENTION_SWEEP_DRY_RUN=1` in `.env`: every rule runs its selector and logs what
it would delete and the row counts, and neither R2 nor the DB is touched. The
first pass in prod will hit 5 expired clips and the artifacts of all 9 existing
jobs, so it is worth reading before it happens. The flag comes off once the log
looks right.

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

`clipsStored` after a sweep is checked against `usage.service` directly, so the
quota-release behaviour is asserted where it is actually read.

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
  design.
