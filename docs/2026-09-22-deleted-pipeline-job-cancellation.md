# Deleted pipeline job cancellation

Date: 2026-09-22
Status: approved design

## Problem

Deleting a project hard-deletes its `Job` row, but does not remove that project's pending BullMQ stage jobs. A stale stage then retries database writes against a missing record. The cleanup path also writes `job_steps` and marks the job failed, so the final error is a Prisma `P2025`/foreign-key error rather than a useful pipeline result. After the retry budget is exhausted, the worker raises a false production incident.

The observed failure was a stale `video-transcribe` job. The same race exists in download, analyze, render, and finalize.

## Goals

- Remove queued work when its project is deleted.
- Treat a stage whose project was concurrently deleted as cancelled, not failed.
- Do not retry, refund, or raise an incident for user-initiated deletion.
- Release the user's concurrency slot so their next waiting project can start.
- Preserve normal retries and incident reporting for real failures.

## Design

### Pending queue cleanup

Add one shared helper that inspects all five stage queues and removes jobs in removable, unprocessed states (`waiting`, `delayed`, `prioritized`, and `paused`) whose payload contains the deleted pipeline `jobId`.

`deleteProject` calls this helper after the database row is deleted. Cleanup is best effort: a Redis failure is logged but does not turn an already completed database deletion into an API failure. Active BullMQ jobs are deliberately excluded because BullMQ refuses to remove a job locked by a worker.

Scanning payloads is intentional. Existing stage jobs use generated numeric BullMQ IDs, and render-edit work may have more than one queue item for the same pipeline job. A new deterministic-ID convention would not clean existing work and would not cover every render item.

### Active-job race guard

Wrap stage dispatch at the worker boundary. If a stage throws, query the pipeline `Job` by the payload's `jobId`:

- if the row still exists, rethrow the original error and keep the current retry/alert behavior;
- if the row no longer exists, classify the work as cancelled, release the user's next queued project, and complete the BullMQ item without retry or incident;
- if the existence check itself fails, preserve and rethrow the original stage error rather than hiding a database outage.

This centralized boundary covers every stage, including failures raised before a stage's own `try/catch`, and avoids duplicating Prisma error-code handling across five files. It also covers the race where an active stage enqueues its successor after queue cleanup has already run: that successor will be discarded on its first failed database access.

The completed-event hook must not perform its normal finalize release a second time for the cancelled outcome.

## Error handling

- Queue cleanup failures are logged with queue and pipeline job identifiers.
- An active deleted job produces a concise cancellation log, not an error incident.
- No Prisma error code is used as the source of truth; absence of the owned pipeline row is the cancellation condition.
- Malformed queue payloads and genuine processing failures retain existing behavior.

## Tests

- Shared queue helper removes matching jobs from every removable state and leaves unrelated jobs untouched.
- Project deletion calls queue cleanup only after the database delete and remains successful when Redis cleanup fails.
- Worker dispatch rethrows a genuine stage failure while the job exists.
- Worker dispatch consumes a stage failure when the job was deleted, releases the next queued project, and causes no retry/incident path.
- Finalize cancellation does not release the queue slot twice.

## Release

Run focused shared and worker tests, package type checks, and the relevant build checks. Then commit, push, merge to `main`, deploy the shared web/API and all five worker roles, and verify the deployed revision plus worker health.
