# AS_IS Learning Corpus V1 - Design

Date: 2026-08-29. Status: approved in conversation, pending written review.

## Problem

`AS_IS` is a useful positive signal: one user approved one delivered clip without requesting an
edit. Today the row is stored but is not organized into a safe learning corpus. It is also mutable,
has no history, and may outlive the Job and Clip that supplied its full context.

V1 creates a deterministic private review queue and an authoritative local assignment ledger. It
does not train, tune, replay, or change the production engine.

## Goals

- Export current exact `AS_IS` rows deterministically with no database writes and no LLM calls.
- Freeze each candidate as `feedbackId + updatedAt + canonical snapshot hash`.
- Produce private JSONL and Markdown reports under the existing gitignored `.corpus/` root.
- Record approve, reject, and correction events in an append-only private ledger.
- Lock the first approved destination intent to `eval` or `holdout` for future projects.
- Enforce at most 2 approved assignments per job and 3 per user in each destination.
- Detect and report feedback that changed or disappeared after review.
- Preserve exact, testable ordering, cap, count, lock, and failure behavior.

## Non-goals

V1 does not create eval fixtures, refactor or call `eval-record`, call an LLM, create positive labels,
match clip ranges, replay a holdout, download video, write production configuration, or change any
production behavior. It does not claim that current eval CI is protected by these private reviews.

## Current evidence

`ClipFeedback` stores one mutable row per `(clipId, userId)`, including verdict, note, identifiers,
timestamps, snapshot, and optional permanent `evidenceKey`. The snapshot can include clip metadata,
engine/version fields, crop digest, and a transcript slice capped at 4000 characters.

The row has no relations and no history. An upsert can replace verdict and snapshot and advance
`updatedAt`. Full Job transcript and analyze data are available only while the Job survives. These
facts require version-bound review and explicit stale reporting.

## Approaches considered

Direct online updates were rejected because feedback is subjective, sparse, mutable, and biased.
Automatic recommendations were deferred. A curated offline queue was chosen because it adds evidence
without affecting production.

## V1 architecture

```text
current ClipFeedback AS_IS rows
  -> deterministic read-only exporter -> private candidates, exclusions, and run manifest
  -> review command under one corpus lock -> append-only private review ledger
  -> stale and capacity reports
No production or eval consumer exists in V1.
```

Private files use this layout:

```text
.corpus/feedback-learning/exports/<run-id>/{run.json,candidates.jsonl,candidates.md,exclusions.jsonl}
.corpus/feedback-learning/ledger/{reviews.jsonl,reviews.lock}
```

The existing `.corpus/` ignore rule covers all content. V1 commits no candidate, transcript, note,
identifier, evidence key, decision ledger, or video.

## Export inputs and database behavior

`feedback-learning-export` requires `--set eval|holdout`, inclusive
`--updated-from <UTC ISO timestamp>`, exclusive `--updated-to <UTC ISO timestamp>`, and optional
`--limit <positive integer>` with default 50.

The database predicate is exactly:

```text
verdict = "AS_IS"
and updatedAt >= updated-from
and updatedAt < updated-to
```

After capturing the ledger snapshot, the exporter performs every database read inside one PostgreSQL
read-only `REPEATABLE READ` transaction. The first statement marks the transaction read-only. That
transaction reads the cohort, the Job projection for its rows, and current feedback rows for every
active approval, including approvals outside the cohort. After it closes, selection and rendering use
only the captured memory snapshot and perform no database reads.

The repository exposes no create, update, upsert, delete, raw mutation, object-store copy, or LLM
dependency. A transaction or projection failure publishes no run.

## Candidate identity and normalization

Snapshot canonicalization recursively sorts object keys, preserves array order, serializes JSON
primitives normally, and represents a missing snapshot as JSON `null`. It adds no absent values.

```text
snapshotSha256 = "sha256:" + SHA256(UTF8(canonicalSnapshotJson))
candidateVersion = "sha256:" + SHA256(
  UTF8(feedbackId + "\n" + updatedAt.toISOString() + "\n" + snapshotSha256)
)
```

The exact reviewed identity is `(feedbackId, updatedAt, snapshotSha256)`. There is no fuzzy time or
transcript deduplication. Current database uniqueness already prevents duplicate feedback for one
`(clipId, userId)` pair.

The pre-selection input record is the only source for output bytes. Its feedback projection is
`id, clipId, jobId, userId, verdict, note, snapshot, evidenceKey, updatedAt`; its Job projection is
`id, transcriptJson, transcriptPartial`. The normalized record contains every projected value or a
canonical derived value used by candidates, Markdown, exclusions, warnings, tier, identity, strata,
caps, stale reports, or hashes. Raw `snapshot` is represented by its canonical JSON and hash. Raw
`transcriptJson` is represented by deterministic `present` and `segmentsIsArray` booleans because no
other transcript value affects V1 output. Adding an output field requires adding its source projection
and normalized representation in the same change.

Its fixed field order is `feedbackId, clipId, jobId, userId, verdict, note, evidenceKey, updatedAt,
snapshotCanonical, snapshotSha256, jobProjectionId, jobPresent, transcriptPresent, segmentsIsArray,
transcriptPartial, language, clipKind, tier, warnings, review`. `review` uses the candidate contract's
field order. Missing projected values are explicit JSON null, never omission.

Language is trimmed lowercase `snapshot.language`, or `unknown`. UI locale is not a fallback because
it is not content language. Clip kind is trimmed lowercase `snapshot.clipKind`, or `unknown`. The
balance stratum is the tuple `(language, clipKind)`.

A row is `replay-ready` planning evidence only when its Job exists, `transcriptJson.segments` is an
array, and `transcriptPartial` is false. Otherwise it is `reference-only` with a specific warning.
Both tiers remain private rows and create nothing in V1. Null or sparse snapshots, missing transcript
slices, and missing `evidenceKey` produce warnings instead of crashes.

Warnings are emitted at most once in this exact order:
`job_missing`, `transcript_missing`, `transcript_segments_invalid`, `transcript_partial`,
`snapshot_missing`, `snapshot_sparse`, `transcript_slice_missing`, `evidence_missing`. A missing Job
suppresses all transcript warnings. A null snapshot emits only `snapshot_missing`; a non-null value
emits `snapshot_sparse` when it is not an object or lacks a non-empty title, finite start/end, or
numeric score, and emits `transcript_slice_missing` when its transcript is absent or blank.
`evidence_missing` is independent of snapshot warnings and remains last.

## Effective review state

`reviews.jsonl` is append-only. Every event has a unique `eventId` and events are folded in file
order. An invalid JSON line, duplicate event ID, forward correction reference, or invalid transition
makes the ledger unusable and stops export or review before output.

The actions are:

- `approve`: creates an active approval for one candidate version and records destination intent;
- `reject`: creates an active rejection for one candidate version;
- `correct`: retires one earlier active approve or reject event after an operator mistake.

Only one active decision may exist for a candidate version and only one active approval may exist
across all versions of one feedback ID. A correction targets an earlier active approve or reject with
operation `retire`, never another correction. After retirement, a new decision may be appended.

The first approve event for a `feedbackId` permanently locks its destination to `eval` or `holdout`.
Retiring that approval frees its capacity but does not remove or change the destination lock. Every
later approval for that feedback ID must use the locked destination. Rejections do not create a set
lock.

The canonical effective ledger state contains sorted active decisions, retired target IDs, and
per-feedback destination locks. Historical events that fold to the same effective state do not
change the effective-state digest.

## Stale state and capacity

An active approval is fresh only when a current database read finds the same feedback ID with:

- verdict exactly `AS_IS`;
- identical `updatedAt.toISOString()`;
- identical canonical snapshot hash.

A deleted row or any mismatch makes the approval stale. Exactly one reason is chosen in this order:
`missing`, `verdict_changed`, `updated_at_changed`, `snapshot_changed`. The first matching reason
wins. V1 reports stale approvals in `run.json` and `candidates.md`; it does not repair them.

Capacity has these authoritative rules:

- a fresh active approval consumes one job and one user slot in its destination;
- a stale active approval reserves the same slots until an explicit `correct: retire` event;
- an active rejection consumes no capacity;
- a retired approval or rejection consumes no capacity;
- one feedback ID is counted at most once in a destination, even if ledger history has multiple
  retired versions.

Thus the cap calculation uses fresh approvals plus stale reservations. The report shows them as
separate counts. A new version of a feedback row with a stale active approval is excluded as
`stale_review_requires_retirement`; the operator must retire the old approval before reviewing the
new version. Its original destination lock remains.

These caps apply only to assignments made by feedback-learning. Existing hand-written eval fixtures
or any other project do not consume these V1 slots.

## Deterministic selection

Selection has ordered phases. A row leaves the pipeline at its first exclusion, so later phases never
replace an earlier reason:

1. Normalize every transaction row. A row without the fields needed for canonical identity becomes
   `invalid_row` before any decision, stratum, or cap work.
2. Fold decisions against normalized rows. A new version whose feedback ID has a stale active approval
   becomes `stale_review_requires_retirement`. Otherwise an exact active approval becomes
   `already_approved`, then an exact active rejection becomes `already_rejected`.
3. Put remaining rows into strata sorted lexicographically by `(language, clipKind)`. Within a stratum
   sort by `updatedAt` descending, then `feedbackId` ascending.
4. Initialize provisional counts from fresh approvals plus stale reservations in the requested set.
   Prefilter each stratum against those starting counts: job at 2 gives `job_cap`; otherwise user at 3
   gives `user_cap`.
5. Visit strata in lexicographic round-robin order, one head per stratum per round. Recheck provisional
   counts before each take with the same job-first precedence. A take increments both counts.
6. Stop at `limit`. Emit remaining eligible rows as `limit_reached` in the order produced by continuing
   the same round-robin without taking them.

An active fresh approval for the same candidate version is `already_approved`. An active rejection
for the same version is `already_rejected`. A retired decision does not block re-selection. A prior
export without a review does not consume authoritative capacity; concurrent exports may therefore
overlap, but the locked review command prevents concurrent approvals from exceeding caps.

Every queried row produces exactly one candidate or exclusion line. The resulting precedence is:

```text
invalid_row
stale_review_requires_retirement
already_approved
already_rejected
job_cap
user_cap
limit_reached
```

## Deterministic run identity

Three hashes are stored in `run.json`:

- `optionsSha256`: canonical JSON of schema version, set, UTC bounds, and limit;
- `inputSha256`: canonical JSON of every queried row reduced to a deterministic input record and
  sorted by `feedbackId`; a row that cannot normalize carries a deterministic invalid marker;
- `ledgerSha256`: canonical JSON of the captured effective ledger state plus, for each active approval,
  `feedbackId, present, verdict, updatedAt, snapshotCanonical, snapshotSha256, staleReason` from the
  same transaction, sorted by feedback ID.

```text
runDigest = "sha256:" + SHA256(canonicalJson({ optionsSha256, inputSha256, ledgerSha256 }))
runId = set + "-" + first 16 hex characters after the runDigest prefix
```

The same options, normalized input, and effective ledger state produce the same run ID and identical
files. Any relevant change produces a new run ID. If the target run directory already contains the
expected bytes, export is a no-op. Different bytes under the same run ID are a hard integrity error;
the exporter never overwrites them.

## Data contracts

All contracts are closed: unlisted fields are invalid and require a schema version change. Machine
files use UTF-8 without BOM and LF only. Objects use the field order shown below. `run.json` and
Markdown have exactly one terminal LF. A JSONL file with records has one compact object per line and
exactly one terminal LF; an empty JSONL file is zero bytes. Every hash string is lowercase
`sha256:<64 hex>`.

`run.json` field order and shape are:

```json
{"schemaVersion":1,"runId":"eval-0123456789abcdef","targetSet":"eval","updatedFrom":"2026-08-22T00:00:00.000Z","updatedTo":"2026-08-29T00:00:00.000Z","limit":50,"optionsSha256":"sha256:...","inputSha256":"sha256:...","ledgerSha256":"sha256:...","runDigest":"sha256:...","counts":{"queried":12,"selected":6,"excluded":6,"selectedReplayReady":4,"selectedReferenceOnly":2,"freshApprovals":3,"staleReservations":1},"staleAssignments":[{"feedbackId":"feedback-id","candidateVersion":"sha256:...","set":"eval","reason":"snapshot_changed"}]}
```

`queried` is the database predicate result count. `selected` is the number of candidate lines.
`excluded` is the number of exclusion lines, so `queried = selected + excluded`.
`selectedReplayReady + selectedReferenceOnly = selected`. Approval counts describe the captured
effective ledger for the requested destination, not just the cohort.
`staleAssignments` sorts by feedback ID and its reason is `missing`, `verdict_changed`,
`updated_at_changed`, or `snapshot_changed`; it contains only the requested destination and its
length equals `staleReservations`.

A candidate requires fields in this order: `schemaVersion, candidateVersion, targetSet, feedbackId,
clipId, jobId, userId, updatedAt, snapshotSha256, language, clipKind, tier, warnings, review`.
`review` requires `title, startTime, endTime, score, transcript, note, evidenceKey`; nullable source
values are JSON null. Its shape is:

```json
{"schemaVersion":1,"candidateVersion":"sha256:...","targetSet":"eval","feedbackId":"feedback-id","clipId":"clip-id","jobId":"job-id","userId":"user-id","updatedAt":"2026-08-28T12:00:00.000Z","snapshotSha256":"sha256:...","language":"ru","clipKind":"insight","tier":"replay-ready","warnings":["evidence_missing"],"review":{"title":"Example","startTime":12.3,"endTime":45.6,"score":0.82,"transcript":"Private transcript slice","note":null,"evidenceKey":null}}
```

The queue may contain `userId`, note, and `evidenceKey` because it is private and gitignored. Process
logs never print those values or transcript content.

Markdown section order is title with `runId`, summary counts, stale assignments, candidates, then
exclusions. Each section follows its JSON array or JSONL order, empty sections remain with count zero,
and no wall-clock generation time is rendered.

An exclusion requires `schemaVersion, feedbackId, candidateVersion, reason`, then its reason-specific
field. `candidateVersion` is a hash except that `invalid_row` uses null when identity cannot be
computed. The exact variants are:

- `invalid_row` requires `detailCode` from `identity_unavailable`, `snapshot_not_json`, or
  `projection_invalid`, and forbids `cap`;
- `job_cap` or `user_cap` requires `cap: { limit, occupied }`, with keys in that order, and forbids
  `detailCode`;
- `stale_review_requires_retirement`, `already_approved`, `already_rejected`, and `limit_reached`
  forbid both `detailCode` and `cap`.

Example:

```json
{"schemaVersion":1,"feedbackId":"feedback-id","candidateVersion":"sha256:...","reason":"job_cap","cap":{"limit":2,"occupied":2}}
```

Every review event starts with `schemaVersion, eventId, action, occurredAt`. Hashes are lowercase
`sha256:<64 hex>`, and times are UTC ISO strings with millisecond precision. Required and forbidden
fields are:

- `approve` then requires `candidateVersion, feedbackId, feedbackUpdatedAt, snapshotSha256, clipId,
  jobId, userId, set`; it forbids `reason, operation, targetEventId`;
- `reject` requires the same frozen fields through `userId`, then non-empty private `reason`; it
  forbids `set, operation, targetEventId`;
- `correct` requires `operation: "retire", targetEventId, reason`; it forbids every candidate,
  feedback, clip, job, user, hash, timestamp-copy, and set field.

Approval example:

```json
{"schemaVersion":1,"eventId":"review-event-id","action":"approve","occurredAt":"2026-08-29T10:00:00.000Z","candidateVersion":"sha256:...","feedbackId":"feedback-id","feedbackUpdatedAt":"2026-08-28T12:00:00.000Z","snapshotSha256":"sha256:...","clipId":"clip-id","jobId":"job-id","userId":"user-id","set":"eval"}
```

## Review command and lock

`feedback-learning-review` accepts either a candidate from an export plus `approve|reject`, or a
prior event ID plus `correct --operation retire`. It never accepts raw IDs in place of a candidate
record for a new decision.

Every corpus directory is mode `0700`; every regular file and temporary file is `0600`. Commands
reject symlinks at owned paths. On Linux, each command opens `reviews.lock` with mode `0600`, keeps
the file descriptor open, and retries advisory `flock(fd, LOCK_EX | LOCK_NB)` every 50 ms for at most
5 seconds using monotonic time. Timeout fails without work. Closing the descriptor or process exit
lets the kernel release the lock; no stale-lock deletion or PID guessing exists.

Review holds that lock across ledger read, validation, current feedback read, cap check, persistence,
and result verification. Export holds it only while reading and folding the complete ledger into an
immutable memory snapshot, then releases it before the database transaction.

Approval re-reads the current feedback row and requires exact candidate identity and current
`AS_IS`. The database row is authoritative for `clipId`, `jobId`, and `userId`: candidate copies must
match it, and capacity checks plus event fields use values from the row rather than trusting the
export file. Under the lock it recomputes effective capacity and refuses the event if job 2 or user
3 would be exceeded. It also enforces the permanent destination lock. Rejection does not consume
cap. Correction validates and retires its target under the same lock.

Review persistence rewrites the complete ledger in the same directory: open an exclusive temporary
file whose bytes are the prior ledger unchanged plus exactly one new event line, write all UTF-8
bytes, `fsync` its descriptor, close it, atomically rename it over
`reviews.jsonl`, then `fsync` the ledger directory. The rename is the commit point. Before rename, a
failure has made no ledger mutation. If any error can occur at or after rename, the command re-reads
the destination and searches for the expected `eventId`: present means
`committed_durability_uncertain`; absent means `indeterminate`, never `unchanged`.

Export uses the same protocol at directory scale. It creates a sibling temporary run directory,
writes each `0600` file, `fsync`s and closes every descriptor, `fsync`s the temporary directory,
atomically renames it to `<run-id>`, then `fsync`s the exports parent. Rename is the publish commit
point. Before rename there is no published run. At or after rename failure, it re-reads `run.json` and
the expected run digest: a match is `committed_durability_uncertain`; absence or mismatch is
`indeterminate`. Existing exact bytes are a no-op; existing different bytes are an integrity error.
Best-effort temporary cleanup never changes these results.

The lock coordinates one corpus filesystem. Cross-host review of separate copies is unsupported in
V1 and must not be run concurrently.

Process logs use a closed field allowlist: operation, `runId`, `eventId`, and machine reason code.
They never contain `feedbackId`, `candidateVersion`, `clipId`, `jobId`, `userId`, note, evidence key
or status, transcript, title, or any excerpt of private content.

## Failure handling

- Database or transaction failure exits nonzero and publishes no run.
- Invalid options or ledger state exit nonzero before database selection.
- One malformed database row becomes one `invalid_row` exclusion with a safe detail; other rows
  continue.
- Missing Job, transcript, snapshot fields, or evidence becomes a warning when normalization is
  still possible.
- Review freshness, cap, set-lock, or transition failure appends nothing.
- Lock or permission failure names only an allowed operation and machine reason code.
- Pre-rename persistence failure leaves published state unchanged. At/post-rename failure returns
  only verified `committed_durability_uncertain` or `indeterminate`, never a false rollback claim.
- Markdown includes exclusion counts, tier warnings, and stale reservation summaries in the same
  deterministic order as JSONL.

## Testing

Focused tests must prove:

1. Export captures its ledger first, then cohort, Job, and active-approval rows in one read-only
   `REPEATABLE READ` transaction, with no later database read.
2. Every output-affecting projection field is represented in the canonical input; changing one
   changes `inputSha256` or expected bytes.
3. Hashes are key-order stable; exact `AS_IS` and half-open UTC bounds are the only cohort semantics.
4. Warning and stale-reason order is exact when multiple defects coexist.
5. Decision filtering precedes strata; normalization, decision, cap, and limit reasons obey the
   documented precedence.
6. Strata, row tie-breaks, and round-robin are exact. Starting and provisional counts enforce job 2
   then user 3 independently by set and ignore unrelated fixtures.
7. Fresh approvals consume, stale approvals reserve, and rejects plus retired approvals do not;
   retirement never unlocks the first destination.
8. Fold rejects wrong event unions, extra fields, duplicate IDs, forward or correction-of-correction
   targets, conflicting active decisions, and destination changes.
9. A stale approval blocks its new version until retirement; multiply changed rows use one reason.
10. Fixed options, transaction rows, and ledger produce byte-identical no-op runs; changing any digest
    input changes the run ID. All documented count equations hold.
11. UTF-8, LF, final newline, canonical field order, closed event/exclusion unions, and warning order
    match golden bytes.
12. Linux flock retry, timeout, kernel release, modes `0700`/`0600`, and symlink refusal are exercised;
    concurrent reviews cannot overfill caps or interleave events.
13. Faults before write, fsync, close, rename, and parent fsync prove commit results; post-rename paths
    re-read the expected `eventId` or run digest and never falsely claim unchanged.
14. Sparse snapshot, deleted Job, partial transcript, and missing evidence remain readable.
15. Dependency tests prove no mutation, LLM, eval recorder, production analyze, video download, or
    post-snapshot database read is reachable.
16. Candidate identifier tampering is refused; capacity and stored clip, job, and user identifiers
    come from the current row.
17. Log capture permits only operation, run ID, event ID, and machine reason code and rejects each
    prohibited identifier and private-content value.

## Acceptance criteria

- A fixed state produces one deterministic private export with complete candidate and exclusion
  accounting.
- The append-only fold and correction rules produce one unambiguous effective state.
- Review command locking makes max 2 per job and max 3 per user authoritative per destination.
- Review validates exported identifiers against the current row and never trusts them for capacity.
- Stale approvals are visible and reserve capacity until explicit retirement.
- The first approved destination for a feedback ID cannot change.
- Export bytes derive from one identified ledger snapshot and one read-only repeatable database
  snapshot, with no later reads.
- Private modes, Linux flock, exact serialization, and verified rename commit points match this spec.
- No V1 path writes the database, calls an LLM, downloads video, creates a fixture, or changes
  production.
- No corpus content is committed, and logs contain only the explicit safe field allowlist.
- Focused tests, worker typecheck, and the complete worker suite pass before merge.

## Future projects

V2 may add privacy-reviewed eval promotion and positive matching. V3 may add private holdout top-up,
release gating, retirement, and backup. Each requires a separate design and approval.

## Limitations

- `AS_IS` is subjective delivered-clip approval, not recall or missed-moment ground truth.
- Feedback participation creates user, source, language, and content selection bias.
- Caps limit concentration but do not make a small corpus representative.
- Snapshot transcript is capped and is insufficient for exact replay.
- Mutable feedback history cannot be recovered after an upsert; V1 can only detect current mismatch.
- The private ledger is local operational state and V1 provides no cross-host coordination or backup.
