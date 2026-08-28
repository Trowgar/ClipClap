# Standalone Clip Filter - Design

Date: 2026-08-28. Status: approved in conversation, pending written-spec review.

## Problem

A recent user-rated `NO` clip exposed a contradiction inside analyze-v2. Arc audit marked the
candidate `standalone.ok=false` because essential rules and stakes lived outside the selected
window, but the clip still shipped. Its entry and exit were clean, its score was `0.67`, and the
single standing flag received the configured one-flag penalty of `0.0`. The finalizer saw the audit
note and still kept the clip.

The media itself was healthy. Video, audio, framing, subtitles, and delivery did not explain the
rejection. This is an ANALYZE selection-policy defect: the pipeline detected missing context but did
not act on that detection.

The second `NO` in the same three-day window carried reason `QUALITY`, but forensic comparison of
source and render found no reproducible core defect. It is not part of this change.

## Production evidence

The following is a retrospective simulation over final shipped highlights, not a full pipeline
replay. The fixed UTC cohort is `2026-08-14T21:00:00Z <= Job.createdAt <
2026-08-28T21:00:00Z`, with `Job.status=DONE`, `AnalyzeEngine=RECALL_CRITIC`, and a non-empty
`Job.highlights` array:

- 40 completed RECALL_CRITIC jobs shipped 173 clips.
- 34 clips, 19.7%, carried explicit `standalone.ok=false`.
- A hard standalone gate would have left 3 jobs with no clips.
- Requiring a fully clean alternative and applying the existing `0.15` severe-arc penalty would
  have removed 16 clips from 12 jobs, 9.2% of shipped clips, and would have emptied no job.
- The known rejected clip would have been removed because `0.67 - 0.15 < 0.60`.
- Among live rated clips, the only explicit standalone failure was rated `NO`; none was rated
  `AS_IS` or `EDIT`. This is directional evidence, not enough authority for a global hard gate.

Because the new stage runs before the finalizer, removing a prompt block can change downstream
finalizer decisions. The 16/173 figure describes the deterministic filter applied to already shipped
highlights. It is an impact estimate, not an exact prediction of the final output of a replayed job.

## Approaches considered

### 1. Hard-drop every standalone failure

Rejected. It removes 34 of 173 recent clips and produces zero output for 3 jobs.

### 2. Raise the global one-flag arc penalty

Rejected. Entry-only and exit-only flags have different repair and quality semantics. The existing
corpus includes acceptable clips with one soft flag, so changing the shared penalty would broaden
the intervention beyond the measured defect.

### 3. Alternative-aware standalone filter

Chosen. Penalize an explicit standalone failure only when the same job already has at least one
fully clean candidate. Drop it only when the penalized score falls below the existing score
threshold. This removes the measured failure without withholding the only available result.

## Behavior

Add a deterministic stage after start/end extension and the existing arc-downrank stage, and before
the finalizer.

The stage is active only when both `arcAuditEnabled` and a new
`standaloneFilterEnabled` configuration flag are true. A candidate is penalty-eligible only when all
of the following hold:

1. It has a real arc-audit record.
2. `flags.standalone.ok` is exactly `false`.
3. `candidate.score - arcDownrankPenalty2 < scoreThreshold`.

A penalty-eligible candidate is removed only when at least one other candidate in the same input set
is fully clean according to `isFullyOk`.

The stage preserves input order. Missing audit flags never count as either a failure or a clean
alternative. Entry-only and exit-only failures are not affected.

`isFullyOk` keeps its existing strict semantics: an axis with `ok=false, repaired=true` is not clean.
The score comparison is strictly `<`. A score of exactly `0.75` with penalty `0.15` and threshold
`0.60` survives.

If the input set has no fully clean candidate, the stage returns it unchanged. This is the fail-open
rule that prevents the feature from turning a content answer into an empty job.

The existing severe penalty, currently `0.15`, is reused instead of adding another numeric tuning
knob. The recorded critic score is never mutated.

## Configuration and rollout

Add `ANALYZE_STANDALONE_FILTER_V1`, parsed fail-closed as enabled only for the literal value `on`.
Include it in the analyze-v2 configuration and eval fingerprint. `ARC_AUDIT` remains an explicit
dependency; enabling the filter alone is a no-op.

The code ships behind the flag. Acceptance requires replaying the existing worker fixtures and the
synthetic regression fixture. Production arming is a separate operational action after the code is
merged and verified.

## Telemetry

When the stage is active, attach `standaloneFilter` telemetry with:

- `considered`: input candidate count;
- `eligible`: explicit standalone failures below the penalized threshold;
- `dropped`: candidates actually removed;
- `bypassedNoCleanAlternative`: eligible candidates retained because no fully clean alternative
  existed.

Every removed candidate is also appended to `droppedVerdicts` with:

- `stage: "standalone_filter"`;
- `reason: "not_self_contained"`;
- the original critic score.

When either required flag is off, the stage is byte-for-byte behavior-dark and the telemetry key is
absent.

Name the stage output `afterStandaloneFilter`, pass that exact array to `finalizeClips`, and set the
existing `selectedForFinalizer` telemetry to `afterStandaloneFilter.length`. The counter continues to
mean the number of candidates actually presented to the finalizer.

## Testing

The pure filter tests must cover:

1. The anonymized measured shape: score `0.67`, threshold `0.60`, penalty `0.15`,
   `standalone=false`, and a fully clean alternative. The bad candidate is dropped.
2. A standalone failure with no fully clean alternative. Nothing is dropped.
3. A high-score standalone failure whose penalized score still meets the threshold. It survives.
4. Entry-only and exit-only failures. They survive.
5. Missing audit flags. They survive and do not count as clean alternatives.
6. A repaired-only alternative with `ok=false, repaired=true`. It is not clean; the eligible
   candidate survives and increments `bypassedNoCleanAlternative`.
7. Equality at the threshold: `0.75 - 0.15 = 0.60`. The candidate survives.
8. Stable order and original scores.
9. Exact `considered`, `eligible`, `dropped`, and `bypassedNoCleanAlternative` counters for every
   pure-filter case.
10. Feature-dark and audit-dark wiring. Output and telemetry remain unchanged/absent.
11. Production-path wiring before the finalizer: `afterStandaloneFilter` is passed to the finalizer,
    `selectedForFinalizer` equals its length, and `droppedVerdicts` contains the removed candidate.
12. Eval fingerprint changes when the flag changes.

Run the focused analyze-v2 tests, worker typecheck, and the complete worker test suite before merge.

## Acceptance criteria

- The known failure shape cannot reach the finalizer when a fully clean alternative exists.
- No job is emptied by this stage.
- No score is mutated.
- The fixed-cohort retrospective simulation identifies 16 of 173 shipped highlights across 12 jobs
  as removable and zero jobs lose all clips at the filter stage.
- Feature-dark output is unchanged.
- All targeted and complete worker tests pass.

## Non-goals

- Hard-dropping every standalone failure.
- Repairing missing context by expanding clip boundaries.
- Changing critic prompts, score thresholds, or the global one-flag penalty.
- Fixing the generic `QUALITY` verdict without a reproducible defect.
- Fixing the feedback crop snapshot, which incorrectly expects `keyframes` while current crop plans
  use `shots`. That diagnostic defect is a separate change with its own tests.
