# Post-boundary hook gate V1 - Design

Date: 2026-08-29. Status: proposed, pending written review.

## Problem

Candidate quality is judged before the engine applies deterministic boundary
changes. A start repair can make a clip grammatically self-contained while
making its opening slower. The finalizer and renderer then treat that repaired
candidate as publishable even when its hook arrives too late.

The observed `NO / BORING` case demonstrates the failure mode:

- the critic accepted a score `0.63` candidate starting at `564.45s`, with its
  hook at `572.30s`;
- entry repair moved its start to `562.99s` to resolve a dangling reference;
- the shipped clip therefore had `9.31s` before the hook, including a `6.28s`
  transcript gap;
- a nearby completed failure arc existed, but V1 will not rescan or attempt to
  replace a candidate that fails the new gate.

The defect is neither rendering nor delivery. It is a missing post-boundary
semantic quality check.

## Goal

Before finalization and rendering, prevent a selected candidate from shipping
when its final boundaries leave an excessively delayed hook or an excessively
long untranscribed lead-in before that hook.

The gate protects quality. It does not promise a minimum clip count and does
not manufacture, scan, rank, or request a replacement candidate.

## Non-goals

- Do not change scanner prompts, critic thresholds, arc-repair semantics,
  transcript generation, rendering, delivery, or feedback UI in V1.
- Do not revert a repair merely because the repaired candidate fails. The
  original boundary may still be context-dependent.
- Do not add an LLM call, rescan a source, or search for another moment.
- Do not alter existing jobs, delivered clips, feedback rows, or learning
  corpus records.
- Do not claim that one `NO / BORING` feedback event establishes a universal
  hard threshold.

## Decision

Add one deterministic `post-boundary hook gate` after start repair and end
extension, before arc downranking and finalization. It applies to
every selected candidate, not only repaired candidates, because either a
repair or an extension can produce a poor final opening.

For each candidate, the gate derives from its post-extension, pre-finalizer
boundaries:

```text
hookDelaySec = hookStartSec - startSec
preHookGapSec = largest time without a transcript segment
                intersecting [startSec, hookStartSec)
```

Only a finite, non-negative hook delay is eligible for comparison. A malformed
candidate never becomes publishable because of this gate: existing validation
continues to own malformed boundaries and transcript state.

The gate rejects a candidate when either configured post-boundary limit is
exceeded. A rejection removes that candidate from the final selected list. It
does not restore an earlier boundary and does not trigger replacement.

## Rollout and configuration

The gate has four explicit modes:

- `off` is the default and performs no evaluation;
- `observe` calculates raw distributions only, with no limits and no output
  change;
- `shadow` requires provisional limits, calculates decisions, and reports
  `wouldDrop` without changing output;
- `enforce` requires the same limits and removes a failing candidate without
  replacement.

V1 rollout is `observe`, then thresholded `shadow`, then `enforce` after
explicit product approval. This avoids circular threshold selection: observe
collects the raw distributions first, and only approved provisional limits make
`wouldDrop` meaningful in shadow mode.

In `observe`, the report must include only raw, threshold-free measurements:

- evaluated and not-evaluable counts;
- distributions and maxima for delay and gap, split by clip kind, language,
  score band, repaired or extended state, and final clip-duration band;
- up to 20 privacy-safe candidate diagnostics with the greatest hook delay and
  up to 20 with the greatest pre-hook gap, de-duplicated and tie-broken by
  candidate ID.

V1 uses existing runtime boundaries for stable, non-arbitrary report bands:
score is `below_threshold` for values below `scoreThreshold`,
`threshold_to_0_8` for values from `scoreThreshold` through `0.8`, and
`above_0_8` thereafter; duration is `short` below `targetMinSec`, `target` from
`targetMinSec` through `maxSec`, and `long` thereafter. The raw maxima and
diagnostics remain the source of truth when a boundary changes.

In thresholded `shadow`, the report additionally includes count and rate of
candidates that exceed each metric, bounded diagnostics for every would-drop
candidate, and estimated output-count loss per job if enforcement were
enabled. `enforce` emits the same thresholded measurements with `dropped` in
place of `wouldDrop`.

No hard numeric limit is selected from prompt prose or this single feedback
case. Limits are selected from the observe report, checked in thresholded
shadow mode, and recorded in configuration before enforcement is approved.

The configuration values are:

- `postBoundaryHookGateMode` with exactly `off`, `observe`, `shadow`, or
  `enforce`;
- `postBoundaryHookMaxDelaySec`;
- `postBoundaryHookMaxPreHookGapSec`.

The two limits are required in `shadow` and `enforce`, and absent in `off` and
`observe`. Both must be finite, non-negative values. The parser must reject an
unknown mode, an invalid numeric value, or a mode-limit combination that is
not listed above. It must not fall back to a default numeric value. Invalid
configuration fails closed at startup or configuration validation, never
silently disables the gate.

## Data flow

```text
critic selected candidates
  -> snap boundaries
  -> arc audit
  -> long-clip boundary policy
  -> start repair
  -> end extension
  -> post-boundary hook gate
       -> shadow telemetry only, or
       -> drop failing candidate without replacement
  -> existing arc downrank and standalone filter
  -> finalizer
  -> render and delivery
```

The gate reads only already-available `SnappedClip` timing fields and sentence
nodes. It makes no database, object storage, queue, network, or LLM call.

The gate is post-extension and pre-finalizer, not literally after every future
boundary operation. Today the finalizer can only move a start later, move an
end earlier, or re-snap to an interior node. It can therefore only shorten the
interval measured by this gate. Any future finalizer change that widens a
candidate must either move before the gate or run the gate again.

`hookStartSec` is the critic's existing timestamp and must not be moved by the
gate. Given the half-open interval `[startSec, hookStartSec)`, the gate builds
coverage from every sentence node with finite `start < end` that intersects the
interval. It clips each range to the interval, sorts ranges by start, and
merges overlapping or adjacent ranges. Its gap list contains the leading gap,
each gap between merged ranges, and the trailing gap. `preHookGapSec` is the
largest item in that list. An empty interval has gap `0`; no coverage gives a
gap equal to `hookDelaySec`. Word-level availability does not change coverage:
a timed sentence node covers its full range.

A candidate is `not_evaluable` only when final `startSec` or `hookStartSec` is
non-finite, negative, or has `hookStartSec < startSec`, or sentence nodes are
unavailable as an array. Invalid individual node ranges are ignored. Existing
boundary validation remains authoritative for malformed candidates.

Each numeric rejection is strict: a candidate fails a reason only when its
value is `>` the configured limit. One candidate may have both reasons; it
counts once in `wouldDrop` or `dropped` and once for each applicable reason.

## Telemetry and operator contract

`off` emits no gate telemetry. `observe` emits, for every job, `evaluated`,
`notEvaluable`, per-job maxima, distributions, and the two provenance splits.
It does not emit `passed`, rejection reasons, `wouldDrop`, or `dropped` because
it has no limits.

`shadow` and `enforce` emit, for every job:

- `evaluated`;
- `passed`;
- `wouldDrop` in shadow mode or `dropped` in enforce mode;
- counts by rejection reason: `hook_delay` and `pre_hook_gap`;
- `notEvaluable`;
- maximum observed delay and gap for the job;
- counts split by `startRepairApplied` and `endExtensionApplied`.

`startRepairApplied` is the arc entry `repaired` flag, which is set only when
start repair successfully applies. `endExtensionApplied` is explicit stage
provenance: snapshot the end node immediately before and immediately after
`extendClipEnds`, and set it only when those nodes differ. It must not be
inferred from the critic end node, because snapping can change that node. These
are the only provenance splits in V1; no generic boundary provenance is
inferred.

Persist the aggregate plus bounded per-candidate diagnostics in the existing
ANALYZE `JobStep.outputJson` under `postBoundaryHookGate`, and mirror the same
schema under the existing engine `shadowV2` payload. In `observe`, persist the
bounded raw-outlier diagnostics defined above. In `shadow` or `enforce`, for
each rejected or would-drop candidate retain only its internal candidate ID,
`reasons: Array<'hook_delay' | 'pre_hook_gap'>`, final start, hook start,
delay, largest gap, score, clip kind, and boundary-change flags. Never log
transcript text, source URL, user ID, or video key.

The output count can fall below the soft cap and can be zero. In enforce mode,
an all-drop is terminal for short and mid-source rescue: rescue must not
re-snap, restore, or replace a candidate after the gate. Existing zero-clip
result and refund behavior remain authoritative and are not changed by this
feature.

## Failure behavior

- Missing or unusable transcript timing must not cause the job to fail. The
  gate records `not_evaluable` and leaves the candidate to existing safeguards.
- A malformed final candidate must preserve existing rejection behavior; the
  gate must not reinterpret malformed values as a pass.
- Gate evaluation is total for valid inputs and must not throw over one bad
  candidate.
- Shadow telemetry failure must not alter selected clips. Enforce mode must
  fail only the affected candidate, not the job.

## Testing and acceptance criteria

Unit tests cover:

- an ordinary candidate that passes both metrics;
- hook delay exactly at and just above the configured limit;
- transcript gap exactly at and just above the configured limit;
- overlapping, adjacent, leading, trailing, and absent node coverage;
- zero hook delay, dual-reason rejection, and `not_evaluable` telemetry;
- a repaired candidate whose boundary move changes a pass into a drop;
- an extended candidate subject to the same gate;
- no replacement, no boundary rollback, and stable ordering of survivors;
- observe mode emits its threshold-free schema and returns the original list;
- shadow mode emits `wouldDrop` but returns the original list;
- enforce mode drops only the failing candidate and records both reasons when
  both limits are exceeded;
- mode parsing, required limits, and invalid configuration failure;
- malformed and not-evaluable inputs follow the defined failure behavior.

Integration tests establish stage ordering: start repair and end extension run
before the gate, while downrank, finalization, rendering, delivery, and both
short and mid-source rescue never receive or restore a dropped candidate.
They also cover the existing long-clip boundary policy and finalizer's current
monotonic trimming invariant.

The observed caramel case becomes a regression fixture. Its final `9.31s`
hook delay and `6.28s` pre-hook gap must be observable in shadow mode. It
must drop once approved enforcement limits are configured below those values.

Acceptance requires an observe measurement report, a thresholded shadow
measurement report, and explicit product approval of both limits before
enabling enforce mode in production.

## Alternatives rejected

### Revert the repair

Rejected. The prior opening was itself a dangling reference. Restoring it
trades pacing failure for context failure.

### Rescan to find a replacement

Rejected for V1. It adds LLM cost, latency, and a second stochastic selection
path. A smaller set of strong clips is preferable to a forced replacement.

### Let finalizer decide from an audit note

Rejected. It leaves the invariant to an LLM and makes the safety condition
non-deterministic. The finalizer may later remain useful for qualitative
improvements, but it is not the V1 guard.
