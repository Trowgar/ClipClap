# Feedback learning V1 runbook

This is a private, offline review corpus for approved `AS_IS` feedback. V1 does not train or tune the
video engine, create eval fixtures, change eval behavior, or change production behavior.

## Private storage

Before running a command, a trusted operator must pre-create or mount
`apps/worker/.corpus` as a private directory with mode `0700`:

```bash
install -d -m 0700 apps/worker/.corpus
```

Do this on the trusted host or persistent private volume. The production image must not create,
populate, or bake in this corpus. Never add `.corpus` content to git.

V1 creates `.corpus/feedback-learning`, `exports`, each run directory, and `ledger` with mode `0700`.
It creates run files, `reviews.jsonl`, `reviews.lock`, and temporary files with mode `0600`. A command
stops when an owned path is a symlink, special file, or has an unsafe mode. It does not repair
unrelated `.corpus` content.

The lock coordinates only one corpus filesystem. Run export and review commands for a corpus on one
host. Do not run commands concurrently against copies on different hosts.

## Export

Run from the repository root. Bounds must be UTC timestamps with milliseconds. The lower bound is
inclusive, the upper bound is exclusive, and the default limit is 50.

```bash
npm run feedback-learning-export -w @clipclap/worker -- --set eval --updated-from 2026-08-26T00:00:00.000Z --updated-to 2026-08-29T00:00:00.000Z
npm run feedback-learning-export -w @clipclap/worker -- --set holdout --updated-from 2026-08-26T00:00:00.000Z --updated-to 2026-08-29T00:00:00.000Z --limit 25
```

Read the private `candidates.md` and use identifiers from its matching `candidates.jsonl`. Do not copy
candidate content into tickets, chat, shell history, or logs.

## Review

Approval needs no reason file:

```bash
npm run feedback-learning-review -w @clipclap/worker -- approve --run eval-0123456789abcdef --candidate-version sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

For rejection or retirement, prepare a nonempty UTF-8 regular file with exact mode `0600`. Put the
private explanation in the file, not on the command line.

```bash
install -m 0600 /dev/null /trusted/private/rejection-reason.txt
npm run feedback-learning-review -w @clipclap/worker -- reject --run eval-0123456789abcdef --candidate-version sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --reason-file /trusted/private/rejection-reason.txt

install -m 0600 /dev/null /trusted/private/retirement-reason.txt
npm run feedback-learning-review -w @clipclap/worker -- correct --target-event 01234567-89ab-cdef-0123-456789abcdef --operation retire --reason-file /trusted/private/retirement-reason.txt
```

Edit each reason file in a way that preserves mode `0600`. The command rejects symlinks, directories,
special files, wrong modes, empty files, and invalid UTF-8.

## Stale assignments

An approval becomes stale when its feedback row is missing, no longer `AS_IS`, has another
`updatedAt`, or has another canonical snapshot. A stale approval remains visible and reserves its job
and user capacity. It also preserves the first destination lock. Retire the prior approval explicitly
with `correct --operation retire` before reviewing a new version. Retirement releases capacity but
does not allow the feedback ID to move between eval and holdout.

## Uncertain commit recovery

The command exits `1` with machine reason `durability_uncertain` when the expected run or event was
found after the rename commit point but the final durability step failed. It exits `1` with machine
reason `commit_indeterminate` when it could not prove whether the expected state is present. Invalid
arguments exit `2`; ordinary committed or exact no-op results exit `0`. Do not retry blindly after
either commit-related machine reason.

For an export, inspect the expected private run directory and `run.json`, then rerun the identical
export. Exact bytes are a safe no-op; an integrity mismatch is a hard stop. For a review, inspect
`ledger/reviews.jsonl` for the expected event ID. If it is present, do not append the decision again.
If it is absent or the ledger cannot be validated, stop and preserve the corpus for investigation.

## Backup limitation

V1 has no built-in backup, replication, restore, or cross-host reconciliation. Back up the entire
private `.corpus/feedback-learning` tree as one protected unit while no command is running. Keep the
backup private, preserve modes, and do not commit it. A partial copy of exports without the ledger, or
the ledger without exports, is not a supported restore.

## Feedback quality gate V2

V2 is a private, fail-closed replay gate. It consumes reviewed V1 approvals and never writes customer
rows, changes analyzer settings, or promotes a candidate by itself. Run all commands from the
repository root on the trusted host. Use a separate private root and keep it mode `0700`:

```bash
install -d -m 0700 apps/worker/.corpus/feedback-quality-gate
```

Before the first production run, rebuild the worker image so `fs-ext` and the current Prisma Client
are installed. The host and image must use Node 20. The private root is host-side release state; it
is not mounted into production workers, must not be baked into an image, and must not be copied into
git. Back up the complete
`apps/worker/.corpus/feedback-quality-gate` tree as one protected unit while no command is running,
including `ledger`, `cases`, `observations`, and `decisions`. Preserve `0700` directories and `0600`
files. There is no supported partial restore or cross-host reconciliation.

The current development `docker-compose.yml` is not a production rollout adapter: it bind-mounts
source and has no immutable image/config mount for this gate. Use the release CLI and the checked-in
`docker-compose.production.yml`; a local dev compose run is not deployment evidence. The current
release adapter still has known integration gaps (for example, deployment depends on a host Docker
environment and the production image/config contract); treat any nonzero release/rollback result as
a hard stop until those gaps are corrected.

The release host must provide these private inputs before invoking the CLI:

- `FEEDBACK_QUALITY_ROOT`: private corpus/decision/rollback store root.
- `FEEDBACK_QUALITY_CONFIG_HOST`: host path to the `0600` quality config JSON. The release reads it
  once, snapshots it into the private rollback bundle, and bind-mounts that bundle snapshot read-only
  at `/run/clipclap/feedback-quality-config.json`; workers receive that container path through
  `FEEDBACK_QUALITY_CONFIG_FILE`.
- `CLIPCLAP_PRODUCTION_ENV_FILE`: host path to the `0600` production env file. The release reads it
  once and snapshots it into the private rollback bundle; the production compose `env_file` consumes
  the bundle snapshot from the rollback working directory (it is not a host-path mount).
- `CLIPCLAP_PRODUCTION_NETWORK`: existing external Docker network (defaults to `clipclap_default`).
- `CLIPCLAP_PRODUCTION_PROJECT`: project name required by the rollback CLI and rollback artifact.

Build and push an immutable worker image first, record its `repo@sha256:<digest>` reference, and
ensure its OCI revision label is the 40-character candidate commit. The release adapter verifies the
candidate digest/revision and captures the pre-rollout image digests, production env, config, and
compose material into an immutable private rollback artifact before recreating any worker. The
artifact is durable only after its ledger event commits.

### Promote reviewed cases

Export and review feedback through the V1 workflow above. Only deterministic `AS_IS` positives and
confirmed engine-caused `EDIT`/`NO` negatives with complete evidence belong in V2. Put the private
promotion decision JSON in a regular `0600` file; the command rejects symlinks, special files, wrong
modes, stale identities, missing transcript/source artifacts, and subjective or source-caused rows:

```bash
npm run feedback-quality-promote -w @clipclap/worker -- promote --decision-file /trusted/private/quality-decision.json
```

Retire an active case only with a private nonempty `0600` reason file. Retirement is an append-only
audit event and does not move a feedback ID between eval and holdout:

```bash
npm run feedback-quality-promote -w @clipclap/worker -- retire --target-event <event-id> --reason-file /trusted/private/retirement-reason.txt
```

The case ledger is content-addressed and private. A case is selected into exactly one immutable lane:
the minimum eval corpus is four positives and six negatives; holdout is one positive and two
negatives. Keep the holdout assignments private and do not use them to tune a candidate.

### Observe baseline and candidate

Prepare a private `0600` observation config containing the reviewed prompt/model/request fingerprints
and the explicit environment allowlist. Run the current worker commit as a baseline, then run the
candidate at the same commit/config/corpus/runner version. Run both eval and holdout; replayed
observations use recorded responses, while a prompt/model/request fingerprint change requires
`--live` (three independently stored live attempts):

```bash
npm run feedback-quality-observe -w @clipclap/worker -- --set eval --mode baseline --commit "$(git rev-parse HEAD)" --config-file /trusted/private/quality-config.json
npm run feedback-quality-observe -w @clipclap/worker -- --set eval --mode candidate --commit "$(git rev-parse HEAD)" --config-file /trusted/private/quality-config.json
npm run feedback-quality-observe -w @clipclap/worker -- --set holdout --mode baseline --commit "$(git rev-parse HEAD)" --config-file /trusted/private/quality-config.json
npm run feedback-quality-observe -w @clipclap/worker -- --set holdout --mode candidate --commit "$(git rev-parse HEAD)" --config-file /trusted/private/quality-config.json
```

Record the four safe observation IDs printed by the command. Do not copy case text, transcripts,
source keys, or model responses into shell history, tickets, or logs. An observation is immutable;
rerunning an identical command is a safe content-addressed no-op.

Path variables are currently CLI-specific: `feedback-quality-observe` reads `QUALITY_ROOT`; the gate
and deploy CLIs read `FEEDBACK_QUALITY_ROOT` and fall back to their private default (the gate also
accepts `QUALITY_ROOT` through its fallback). Promotion uses its compiled worker private default and
does not consume either root variable. Set the actual path expected by each command explicitly; do
not assume `.env.example` alone configures every CLI.

### Evaluate and authorize

Run eval first. Holdout is read only after eval passes. The gate binds all observations to commit,
effective config, complete corpus, and runner version; it expires a decision after 24 hours (or the
earliest observation expiry). Any missing, stale, uncertain, mismatched, or invalid state exits
nonzero and leaves deployment unauthorized:

```bash
npm run feedback-quality-gate -w @clipclap/worker -- --baseline-eval <id> --candidate-eval <id> --baseline-holdout <id> --candidate-holdout <id> --claim non-regression
```

Keep the resulting decision ID and its redacted report. Reports contain only machine reasons,
digests, counts, and observation/decision IDs; private feedback identity and media remain in the
private corpus.

### Queue preflight, canary, and rollout

Only deploy a non-expired passing decision whose candidate commit/config/corpus match the current
checkout. Verify the effective environment, then name each worker explicitly. The release CLI wraps
the deploy command, checks the corresponding BullMQ queue immediately before each service, creates
the rollback artifact, recreates workers in order, waits for startup/canary evidence, and stops on
the first failure:

```bash
npm run feedback-quality-release -w @clipclap/worker -- --image registry.example/clipclap-worker@sha256:<immutable-digest> --project clipclap --decision <decision-id> --service worker-analyze --service worker-render
```

Inspect startup logs and one canary job end-to-end (delivery included) before proceeding. A partial
rollout produces a private report and must be investigated; do not continue manually around a failed
service. Roll back using the recorded rollback artifact and verify the canary again:

```bash
npm run feedback-quality-rollback -w @clipclap/worker -- --rollback <rollback-artifact-id>
```

Rollback uses the artifact's captured immutable `production.env`, quality config, compose files, and
external network name; the original `FEEDBACK_QUALITY_CONFIG_HOST` and
`CLIPCLAP_PRODUCTION_ENV_FILE` paths are not needed for rollback. The compose `env_file` is consumed
from the artifact (it is not a host-path mount). The rollback CLI still needs Docker access,
`FEEDBACK_QUALITY_ROOT`, and `CLIPCLAP_PRODUCTION_PROJECT` to select the production adapter; the
network and config/env contents come from the captured artifact. Verify every restored service's
image digest and OCI revision before reopening queues.

An override requires a nonempty private `0600` reason file. It is an append-only audit event and may
bypass `decision_not_pass`, expiry, and binding mismatches, but it does not bypass malformed
decisions, invalid reason files, queue checks, rollback preparation, health/canary failures, or
event durability. Use it only under incident authority:

```bash
npm run feedback-quality-release -w @clipclap/worker -- --image registry.example/clipclap-worker@sha256:<immutable-digest> --project clipclap --decision <decision-id> --service worker-analyze --override-reason-file /trusted/private/override-reason.txt
```

Never retry a command after `durability_uncertain` or `commit_indeterminate` without inspecting the
private store and ledger. Exact content-addressed replays are safe; an integrity mismatch is a hard
stop. A failing or expired quality decision leaves production unchanged.
