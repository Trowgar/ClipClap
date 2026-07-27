# Retention sweep - operating it

The sweep deletes R2 objects irreversibly. It runs hourly on the maintenance
queue (`retention-sweep`, registered by the `finalize` worker role only) and is
**opt-in**: without `RETENTION_SWEEP_LIVE` set to a non-empty value it reports
what it would delete and touches neither R2 nor the database.

That default is the safety mechanism. Do not remove it casually, and do not set
the variable until the numbers below have been read.

## What the four rules do

| Rule | Selects | Deletes |
| --- | --- | --- |
| A - expired clips | `Clip.expiresAt <= now`, `deletedAt IS NULL` | the clip object, then stamps `deletedAt` (row kept - it is what `usage.service` counts) |
| B - redundant source copies | terminal jobs older than 24h, `sourceSweptAt IS NULL`, not touched since the cutoff | `Job.sourceKey` and `Job.sourceArtifactKey`, never the latter when it IS the normalized artifact |
| C - end of edit window | terminal jobs older than 7 days still holding a key | every remaining artifact object, nulls all three key columns |
| D - orphaned thumbnails | jobs with a `thumbnailKey` whose clips all have `deletedAt` set | the thumbnail - the project card has nothing left to show |

Two invariants hold the design up. **A column is nulled only after its own
delete is confirmed** - `renderTrim` branches on whether the key is present, not
on whether the object exists. And **a job that is not terminal owns its input** -
`FAILED` is written on every BullMQ attempt, not only the last, so both artifact
rules also require that no worker has touched the job since the cutoff.

## First live run

### 1. Read the dry run

The sweep is already reporting every hour. Read what it says:

    docker compose logs --tail 200 worker-finalize | grep retention

Expect a line of the shape:

    [retention][dry-run] clips 5/0 failed, redundant sources 8/0 failed, expired artifacts 5/0 failed, thumbnails 0/0 failed

The `[dry-run]` marker means nothing was deleted. Each pair is `swept/failed`.

To force a pass instead of waiting for the top of the hour:

    docker compose exec -w /app worker-finalize node -e \
      "require('/app/packages/shared/dist/index.js').runRetentionSweep().then(r=>console.log(r))"

### 2. Cross-check the counts against the database

    docker compose exec -T postgres psql -U clipclap -d clipclap \
      -c 'select count(*) from clips where "expiresAt" <= now() and "deletedAt" is null;' \
      -c $'select count(*) from jobs where status in (\'DONE\',\'FAILED\') and "sourceSweptAt" is null;'

The first number must equal the dry run's clip count. If it does not, stop: the
selector and the report disagree, and one of them is lying about what would be
deleted.

### 3. Go live

Only after step 2 agrees:

    echo 'RETENTION_SWEEP_LIVE=1' >> .env
    docker compose up -d worker-finalize

`up -d`, not `restart` - a restart does not re-read `.env`.

Watch the next hourly line. It must now appear WITHOUT the `[dry-run]` marker,
and `failed` should be 0 everywhere.

## Reading a failure

`failed` counts rows the sweep gave up on this pass. It is not an emergency: on
any failure the rule leaves every column set and the row is retried next hour.
When any rule reports a non-zero `failed` the summary goes to `console.error`,
so it is visible as an error line rather than routine chatter.

A `failed` count that stays constant hour after hour means the same rows keep
failing - check R2 credentials and the bucket policy before anything else. Note
the failure mode this guards against: a revoked `R2_ACCESS_KEY_ID` makes every
delete fail while the sweep otherwise looks healthy.

## What to check a day after going live

    docker compose exec -T postgres psql -U clipclap -d clipclap \
      -c 'select count(*) from jobs where "sourceArtifactKey" is not null and "createdAt" < now() - interval \'7 days\';' \
      -c 'select count(*) from clips where "deletedAt" is not null;'

The first count should be zero. The second should be non-zero and stable - it is
the running total of clips whose retention has ended.

## Turning it off

Remove `RETENTION_SWEEP_LIVE` from `.env` and `docker compose up -d
worker-finalize`. The sweep keeps running and keeps reporting; it stops
deleting. There is no need to unregister the schedule.

## What the sweep does NOT do

- **It never deletes a `Job` row.** The rows are the billing ledger
  (`usage.service` sums `sourceDurationSec` per period from them) and the
  lifetime free-tier counter (`job.count` with no date filter). Deleting them
  would hand users back minutes they had already spent and reset a trial that is
  meant to be once per account.
- **It never touches a job that is still processing**, however old.
- **It does not reclaim orphans.** Objects in R2 that no database row references
  are invisible to every rule. Since `20260727` artifact keys are derived from
  the job id rather than random, so retries stop creating new orphans - but
  anything orphaned before that date is still there and needs a prefix scan to
  find.
