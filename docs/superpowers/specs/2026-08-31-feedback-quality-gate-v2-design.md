# Feedback Quality Gate V2 — Production Design

**Date:** 2026-08-31  
**Status:** owner-approved for implementation

## Goal

Turn curated `AS_IS`, `EDIT`, and `NO` feedback into a strict pre-deploy quality
gate. A candidate engine may be rolled out only when it does not regress the
reviewed positive and negative corpus. The gate never changes prompts, flags,
or production state by itself and never runs in the user request path.

## Scope

V2 delivers one trusted-host workflow:

1. promote reviewed feedback into immutable private labels;
2. materialize replay inputs and render evidence under `.corpus/`;
3. compare a baseline observation with a candidate observation;
4. emit a content-addressed gate decision for one Git commit, engine config,
   and corpus version;
5. allow the deployment wrapper to proceed only for a matching passing result.

The first active gate requires at least five fresh positive labels and eight
fresh confirmed negative labels. Until then it exits nonzero with
`insufficient_corpus`; it is never silently report-only.

## Non-goals

- No online learning, weight tuning, prompt mutation, or automatic flag change.
- No runtime blocking of customer jobs.
- No assumption that an unreviewed feedback tap is objective ground truth.
- No private transcript, note, user identifier, media, or storage key in Git,
  process logs, CI artifacts, or the public admin surface.
- No replacement of the existing deterministic fixture suite. The feedback
  gate complements it with private real-world cases.

## Alternatives

Runtime gating was rejected for V2 because a new job has no ground-truth label
and an additional judge would add latency, cost, refunds, queue/idempotency
semantics, and a new outage dependency. Automatic tuning was rejected because
the cohort is small, mutable, subjective, and biased. A strict pre-deploy gate
is reproducible, auditable, and fails before customers are affected.

## Private data model

V1 remains the authority for `AS_IS` export, review identity, destination lock,
freshness, capacity, and append-only decisions. V2 adds a separate append-only
quality-label ledger under:

```text
.corpus/feedback-quality-gate/
  ledger/labels.jsonl
  ledger/labels.lock
  cases/<case-version>/case.json
  cases/<case-version>/transcript.json
  cases/<case-version>/source-or-evidence.mp4
  observations/<observation-id>/{manifest.json,results.jsonl}
  decisions/<decision-id>/{decision.json,report.md}
```

Every owned directory is `0700`, every regular file is `0600`, symlinks and
special files are rejected, and publication uses write/fsync/rename/fsync.
`flock` serializes ledger mutation. The existing V1 private persistence and
canonical JSON primitives are reused rather than reimplemented.

A label freezes:

- schema version, event ID, action, timestamp;
- exact feedback ID, feedback update time, snapshot hash, and candidate version;
- destination (`eval` or `holdout`);
- user verdict and reviewer disposition (`positive`, `confirmed_negative`, or
  `exclude`);
- subsystem (`selection`, `boundary`, `framing`, `subtitles`, `render`);
- confidence (`high` or `medium`);
- expected invariants and optional acceptable source windows;
- materialized case digest.

Only owner-reviewed `AS_IS` may become `positive`. `EDIT`/`NO` become
`confirmed_negative` only after artifact review identifies a reproducible
engine-caused defect. Subjective disagreement, missing evidence, and
source-caused defects are excluded. A correction retires an earlier event;
history is never rewritten.

## Case materialization

Promotion re-reads feedback in a PostgreSQL read-only repeatable-read
transaction and requires exact feedback identity. It captures the Job
transcript and clip metadata, then performs read-only R2 GETs for the permanent
evidence and, when needed, the source artifact. It writes no database row and
no R2 object.

A case is replayable only when all inputs required by its subsystem exist:

- selection/boundary: complete transcript plus exact source duration and
  reviewed acceptable/forbidden windows;
- framing/subtitles/render: permanent delivered evidence and either a source
  artifact or an explicitly reference-only invariant;
- all cases: current feedback identity and an active non-retired label.

Missing or changed inputs make the case stale and the gate fails closed. The
holdout destination is permanently locked and is not available to development
reports.

## Observation runners

An observation is immutable and bound to:

- Git commit SHA;
- canonical engine configuration fingerprint;
- corpus digest;
- runner version;
- mode: `baseline` or `candidate`;
- deterministic replay or explicitly named live replay.

The gate has three lanes:

1. **Deterministic engine lane.** Reuses recorded model responses and the
   existing eval fingerprint discipline. Missing requests or fingerprint drift
   are hard failures, never skipped fixtures.
2. **Selection live lane.** Required only when a model, prompt, or request shape
   changes. It runs the same bounded live analyze path multiple times and stores
   all outcomes. Model variance is reported separately from code effect.
3. **Render lane.** Uses the stage-equivalent path
   `segmentsToCues -> createAssFilter -> computeCropPlan -> buildFiltergraph ->
   cutClips`, with no DB/R2 writes. It probes duration, geometry, SAR, frames,
   black/freeze intervals, subtitle bounds, and reviewed focal coverage.

Runner subprocesses receive an explicit environment allowlist. A stray shell
flag cannot change the observation fingerprint.

## Comparison policy

Hard invariants fail on any reviewed case:

- a positive case becomes empty, loses its approved moment, breaks a complete
  boundary, introduces black/frozen tail, clips required text/subject, or
  creates new subtitle overlap;
- a confirmed negative case becomes worse in its labelled subsystem;
- a previously fixed critical negative reappears;
- output geometry is not `1080x1920` with SAR `1:1`;
- input, replay request, fingerprint, label, or observation is missing/stale.

Aggregate non-inferiority also requires:

- positive retention is not lower than baseline;
- confirmed-negative defect count is not higher than baseline;
- zero-clip false negatives, boundary error, and focal/subtitle failures do not
  increase;
- candidate has at least one measurable improvement when the rollout claims an
  engine-quality improvement. Infrastructure-only changes may declare
  `non_regression_only` and need no improvement.

The holdout runs once after eval passes. A holdout failure blocks deployment and
its case-level details remain private.

## Decision contract

`decision.json` is canonical JSON and contains only non-private identifiers:

- schema version and decision ID;
- candidate commit SHA and config fingerprint;
- baseline observation ID, candidate observation ID, corpus digest;
- eval/holdout counts and aggregate metrics;
- policy version;
- verdict: `pass` or `fail`;
- closed machine reason codes;
- creation timestamp and expiry timestamp.

The decision ID hashes every field except itself. A pass expires after 24 hours.
Changing the commit, config, corpus, runner, policy, or observation invalidates
it. Logs contain only decision/observation IDs, counts, verdict, and machine
reasons.

## Deployment enforcement

The trusted-host command has two separate operations:

```text
feedback-quality-gate run ...
feedback-quality-deploy --decision <decision-id> -- <explicit deploy command>
```

The deploy wrapper verifies a fresh passing decision, current `HEAD`, effective
environment fingerprint, corpus digest, clean tracked worktree, and exact
command allowlist. It refuses shell strings and executes an argument vector.
V2 initially permits only force-recreation of explicitly named ClipClap worker
services; database migration and unrelated service restart are outside scope.

An override requires `--override-reason-file`, a nonempty private `0600` file.
The wrapper records an append-only override event before deployment. An
override never changes the gate result and is visible in the final operator
report.

Before worker recreation the wrapper verifies the target BullMQ queues have no
active or waiting jobs. After recreation it verifies effective config, startup
health, and one canary job before declaring rollout complete. Failure stops
further services and prints the rollback command; it does not guess that a
partial rollout was reverted.

## Failure handling

All ambiguity is fail-closed for deployment: insufficient corpus, stale label,
missing evidence, replay refusal, model outage, timeout, malformed output,
digest mismatch, expired decision, dirty tracked files, nonempty queue, or
canary failure. Failures never mutate feedback, labels, observations, or
production flags except through an explicitly authorized deployment or
override operation.

## Testing

Development follows TDD. Tests cover:

- closed label/observation/decision schemas and canonical hashes;
- exact feedback freshness and append-only correction rules;
- private modes, symlink refusal, lock contention, atomic publication, and
  crash recovery;
- subsystem eligibility and stale case detection;
- deterministic comparison policy for positive and negative cases;
- hard failure on missing fixtures, fingerprints, labels, and observations;
- holdout isolation;
- commit/config/corpus binding and 24-hour expiry;
- command allowlisting, argument-vector execution, queue preflight, override
  audit, canary failure, and partial-rollout reporting;
- log redaction and dependency tests proving no DB/R2 mutation or runtime-job
  dependency;
- worker unit suite, worker typecheck/build, deterministic fixture suite, and a
  same-commit baseline/candidate smoke gate that must pass.

## Rollout

1. Ship V2 commands dark; production pipeline remains unchanged.
2. Curate at least five fresh positive and eight fresh confirmed-negative
   cases, with at least one holdout positive and two holdout negatives.
3. Run a same-commit/config baseline and candidate. It must pass with zero
   differences; this validates the gate itself.
4. Run the current risky flags/fixes as the first real candidate. Do not enable
   any flag that fails eval or holdout.
5. Deploy through the wrapper, verify one canary, and retain the decision and
   rollout report privately.
6. Keep the gate out of customer runtime. A future runtime shadow requires a
   separate design.

## Acceptance criteria

- No worker rollout can use the wrapper without a fresh matching pass or an
  append-only reasoned override.
- The gate cannot pass with insufficient, stale, missing, malformed, or
  fingerprint-incompatible evidence.
- Same-commit/config baseline versus candidate passes with identical metrics.
- A synthetic positive regression and negative reappearance both fail.
- Private content never enters Git or allowed process logs.
- Production clip processing remains byte-equivalent until a separately tested
  candidate configuration is deployed.
