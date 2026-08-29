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
