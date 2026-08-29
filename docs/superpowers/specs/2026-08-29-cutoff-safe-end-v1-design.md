# Cutoff safe-end V1

**Status:** proposed, approved for written specification review

## Goal

Reduce user-reported `EDIT / CUTOFF` clips without regressing the quality or
count of clips users currently receive.

## Evidence

The seven-day feedback sample contains nine `EDIT` verdicts: two `CUTOFF`, one
`FRAMING`, one `BORING`, one `QUALITY`, and four without a reason. The two
labelled cutoff cases are technically correct renders, but have different
causes:

- a normal French reveal ends 0.30 seconds after the payoff. The next sentence
  begins 3.10 seconds later and adds identity and context; critic, arc audit,
  and finalizer accepted the grammatically complete reveal;
- an English reveal ends exactly where the next turn begins. Arc downrank
  rejected it as mid-story, but mid-source rescue re-snapped and shipped it as
  low quality without audit, extension, or finalizer review.

The problem is editorial completion, not FFmpeg precision: stored duration and
A/V checks are within normal tolerance in both cases.

## Non-goal and invariant

V1 does not change critic selection, snap semantics, rendering, captions,
camera planning, finalizer rules, score thresholds, or feedback UI.

V1 exposes only `off` and `shadow`. It contains no enforce mode, no drop
authority, no boundary move, and no rescue-ranking change. `off` performs no
work. `shadow` may add one bounded audit call and telemetry, but must preserve
the exact selected clip objects, clip order, rescue outcome, render request,
and persisted highlight projection from the same run. A good current clip
cannot disappear because of this feature's rollout.

Any future action authority requires a separate approved specification. It is
blocked by any `AS_IS` feedback in the proposed-action cohort, any reviewed
good standalone clip in that cohort, or a measurable output regression during
the later staged rollout.

## Definitions

For a snapped candidate, `tailSec = endSec - payoffSec`; it is telemetry only
in V1 and never a drop threshold.

`zero_tail_handoff` is a speech-boundary signal, not a claim about visual
afterbeat. Let `last` be the final node in the candidate's inclusive node range
with `hasWords === true` and finite `start < end`; let `next` be the first
following node by index with the same validity and `hasWords === true`. It is
true only when `last.end` is within 50 ms of `endSec` and `next.start` is within
50 ms of `endSec`. It is false if either node does not exist, an end is opaque,
or the timings are invalid. This intentionally measures an immediate spoken
handoff only; it does not infer visual motion or a later pause.

`standing_arc` means an existing arc axis whose `ok === false` and
`repaired !== true`. V1 does not use a non-existent `unrepairable` audit value.
An audit record matches a rescue geometry only if candidate id, final start
node, final end node, and rounded start/end milliseconds all match. Otherwise
the rescue geometry reports `arcEvidence: "stale_or_absent"`; no flag is copied
to it.

`needs_afterbeat` means a context-aware audit sees a complete payoff but judges
that a nearby following beat is necessary for the viewer to experience the
ending as complete. `hard_handoff` means the ending runs into a new question,
topic, or unfinished conversational turn and must not be extended across it.

## Two independent controls

### 1. Rescue safe-end shadow audit

The rescue path currently makes a below-bar clip publishable after normal
selection has produced zero survivors. It must be evaluated independently of
normal selection because its purpose is availability, not proof of quality.

V1 observes the existing rescue pool only after its current unjudged guard,
short or mid eligibility, post-boundary-hook exclusions, and all-hook-dropped
suppression. It preserves the current critic-score descending then id ordering,
the distinction between a ranked verdict and a realizable snapped clip, and all
existing snap, compression, copy, and low-quality behavior.

For every realizable rescue candidate, calculate and record:

- whether its snapped geometry has `zero_tail_handoff`;
- whether the same geometry carries `standing_arc` evidence, with its matching
  status;
- the critic score, score rank, and selected rescue outcome.

`shadow` records the current rescue choice and a closed proposed-action enum:
`none`, `zero_tail_handoff`, `standing_arc`, or `both`. It does not exclude,
re-rank, replace, or suppress any candidate. This makes the observed English
case measurable without changing its current low-quality rescue behavior.

A future specification may decide whether an exclusion can choose the next safe
candidate or return zero. That decision is deliberately outside V1.

### 2. Normal end-completion audit

Normal candidates need a semantic check that syntax cannot provide. V1 adds a
separate context-aware shadow audit over the post-extension, post-long-clip,
post-boundary-hook survivor list, immediately before arc downrank. It receives
the exact `SnappedClip` geometry that would otherwise enter arc downrank plus a
bounded forward transcript window. Its result is stored separately from
`arcFlags` and cannot be read by long-clip policy, start/end extension, arc
downrank, standalone filter, finalizer, rendering, or rescue.

It produces one of these non-binding closed outcomes:

- `safe` - candidate can keep its current end;
- `needs_afterbeat` - a specific following sentence node is a candidate future
  end extension, with a closed explanation code;
- `hard_handoff` - the current end is a candidate future action cohort; V1
  does not change whether it ships or whether any existing extension path sees
  it;
- `not_evaluable` - incomplete timing/context, with no output change.

Normal explanation codes are closed: `post_payoff_context` for
`needs_afterbeat`, and `next_question`, `topic_switch`, or `unfinished_turn`
for `hard_handoff`. Audit failure codes are closed: `model_refusal`,
`malformed_response`, `timeout`, and `construction_error`. The implementation
maps any unrecognised model value to `malformed_response`, never stores model
prose.

The audit does not move boundaries, modify prompts or schemas of existing
stages, turn on end extension, or make an action decision in V1. A model
refusal, malformed answer, timeout, or feature-local telemetry construction or
serialization error is fail-open: it records an aggregate failure code when
possible and leaves output unchanged. A shared `completeJobStep` or database
write failure keeps its current stage-failure semantics; V1 must not swallow
it. Future extension or drop precedence, including both existing extension offer
paths and every later filter, requires a separate approved design.

This distinguishes the French case from the rescue case: the French reveal is
not mechanically broken, so it needs semantic evidence before any change.

## Telemetry and review contract

Both controls write bounded, privacy-safe ANALYZE telemetry. A record uses the
job-local geometry reference `{ candidateId, startMs, endMs, startNode, endNode
}`, score, language, clip kind, and a closed outcome/reason enum. It must not
hold transcript text, model prose, source URL, user id, video key, or rendered
media.

Normal record outcome is one of `safe`, `needs_afterbeat`, `hard_handoff`,
`not_evaluable`, or `audit_failed`; its explanation is either null or one of
the closed codes above. Rescue `arcEvidence` is exactly
`matching_standing`, `matching_clear`, or `stale_or_absent`; rescue proposed
action is exactly `none`, `zero_tail_handoff`, `standing_arc`, or `both`; its
per-candidate selected state is `selected` or `not_selected`. A rescue summary
is exactly `not_run`, `no_realizable_candidate`, or `selected`.

Aggregates count every evaluated candidate. Persist at most 20 detailed normal
and 20 detailed rescue records per job, each with `truncatedCount`. Normal
severity order is `hard_handoff`, `needs_afterbeat`, `audit_failed`,
`not_evaluable`, `safe`; rescue severity order is `both`,
`zero_tail_handoff`, `standing_arc`, `none`; ties use candidate id. The current
selected rescue record is always retained, even if it would otherwise fall
below the cap. A truncated proposed-action cohort cannot qualify for a future
action decision until its omitted records are reconstructed and reviewed.

After finalizer, V1 appends reconciliation state to each retained normal audit
record: `shipped` with final rounded geometry, `removed_before_finalizer`, or
`removed_by_finalizer`, or `removed_by_soft_cap`. This is metadata only and
cannot alter output. Operators join `shipped` records to the Clip and feedback
rows by job id and final rounded geometry.

V1 adds an operator-only exact-geometry replay command. It accepts `jobId`,
`startMs`, `endMs`, and an explicit local `outputPath`; resolves the retained
source artifact and writes exactly that interval to `outputPath`. It exits
without database, queue, object-storage, or telemetry writes. The temporary
downloaded source is always deleted; a successful review file is deliberately
left at the caller's explicit local path so it can be inspected, and the
operator deletes it before leaving the secured review session. It rejects a
missing/expired source, invalid range, or invalid output path. The command is
available only in the existing secured worker operator environment. For a
nonshipped record, daily review invokes this command within 72 hours of job
completion. After source retention expires, only aggregate reporting remains.
V1 adds no remote or database media retention.

The report has separate schemas. Normal reports evaluated, `safe`,
`needs_afterbeat`, `hard_handoff`, `not_evaluable`, and `audit_failed` counts.
Rescue reports evaluated, realizable, `zero_tail_handoff`, matching standing
arc, proposed-action, selected-state, and summary counts. Fields outside the
respective schema are absent, not zeroed.

Both reports show:

- flagged candidate counts, not a simulated output-count loss; V1 has no
  counterfactual action authority;
- score, source-duration, language, clip-kind, and feedback-verdict cohorts;
- proposed-action candidates and all `AS_IS` candidates in those cohorts for
  human review, including candidates later removed by existing stages.

The observed French and English timing geometries become synthetic regression
fixtures. Timing/node-shape fixtures prove deterministic wiring only. A second,
invented de-identified semantic fixture with a mocked audit reply proves
`needs_afterbeat` and `hard_handoff` plumbing; it does not claim to evaluate
model judgement.

## Rollout and acceptance

1. Ship only `off` and `shadow`, with a kill switch defaulting to `off`.
   Same-run tests compare the complete highlight projection, ordered geometry,
   rescue outcome, render input, and artifact hash between control and shadow.
   Recorded scanner, critic, and finalizer replies make this comparison
   deterministic; generated Clip ids are excluded from the projection.
2. Test fail-open audit refusal, malformed output, timeout, and telemetry
   failure; test zero-tail equality tolerance, opaque/end-of-graph cases,
   matching and stale arc geometry, current rescue exclusions, and normal
   audit isolation from every live stage. Test reconciliation for every state,
   including a finalizer survivor removed by the soft cap, and the replay
   command's exact range, invalid input, missing-source, and no-write behavior.
3. Collect a shadow cohort of at least 50 evaluated candidates from at least
   30 source jobs over seven consecutive days. The product owner reviews each
   day every retained proposed-action record and every matching `AS_IS` feedback
   record while source replay remains available. Store the review decision and
   aggregate report with the rollout record.
4. Keep V1 shadow-only after that review. Any future enforce, next-safe rescue,
   end hint, or drop action needs a separate design, explicit product approval,
   a 10 percent traffic ramp, a named kill switch, and rollback on the first
   reviewed `AS_IS` false positive or any output-count decline above 2 percent
   against the same source cohort.

Acceptance for this specification is stable control output during shadow,
complete review artifacts, and no operational failure. It is not a lower
`EDIT / CUTOFF` count, and it grants no enforcement authority.

## Alternatives rejected

### Always add a fixed silent tail

Rejected. A fixed hold cannot repair a semantic handoff and can make clips feel
slow or display an unrelated next shot.

### Let rescue keep the highest-scoring critic verdict

Rejected. The observed English case proves critic score alone can promote a
mid-story, zero-tail fragment after stronger quality stages rejected it.

### Turn on end extension globally

Rejected. Existing evidence records that broad end extension was net-negative
on compilation material. V1 needs targeted shadow evidence before offering any
extension.
