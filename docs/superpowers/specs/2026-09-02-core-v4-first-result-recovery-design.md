# Core V4: First-result recovery without quality-gate bypasses

**Date:** 2026-09-02
**Status:** draft for owner review
**Branch:** `feature/core-v4-first-result-recovery`

## Decision

Core V4 replaces the current score-only short/mid rescue with a bounded second
selection lane that may recover a clip only when the normal analyzer would
otherwise return an honest zero. A recovered clip must pass the same critic,
evidence, boundary, arc, hook, standalone, and finalizer authorities as a normal
clip. A critic rejection or an explicit quality-gate drop is terminal and may
never be overridden by recovery.

V4 is deliberately not a global prompt or threshold retune. It changes only
empty outcomes, is a true no-op when disabled, and is released only against a
reviewed private corpus containing both recoverable false negatives and valid
empty controls.

## Why this is the next change

The 2026-09-02 production audit, excluding synthetic and owner accounts, found:

- 142 customer jobs: 132 `DONE`, 10 `FAILED`;
- 47 `DONE` jobs produced no clips;
- 37 all-time ratings: 10 `AS_IS`, 12 `EDIT`, and 15 `NO`;
- in the last seven days, 8 of 16 rated jobs received only `NO`;
- only 11 of 79 customers who submitted a job returned on another day.

The 47 empty jobs split into 26 `NO_VIABLE_MOMENTS` and 21
`NO_USABLE_SPEECH`. The latter are 12 song-gate and 9 degenerate outcomes and
are intentionally outside V4. Of the 26 viable-speech empty jobs, eight retain
an unjudged candidate tail: 54 candidates in total. V4 therefore has a real,
bounded pool to test, but cannot honestly claim it can repair every empty job.

Raw zero-output count is not itself a defect: weak, musical, speechless, or
unreliably transcribed sources may correctly produce no clip. The defect V4
targets is a **reviewed false negative**: a strong source moment existed, the
normal pipeline missed it, and a candidate can recover it without weakening
the existing quality contract.

The existing rescue is not safe enough to do that. In production it ran on nine
jobs and shipped five clips. Three of those five had `keep:false` from the
critic. The only two rescued jobs with feedback received `EDIT` and `NO`; none
received `AS_IS`. The implementation in `analyze-v2/rescue.ts` also skips the
normal finalizer. This is direct evidence to remove the bypass, not a reason to
lower the quality bar further.

V3 visual recall remains enabled and is not judged by the pre-V3 feedback. At
the time of this design there is no post-enable V3 feedback. V4 must preserve
V3's visual nominations and measure its own contribution separately.

## Goals

1. Stop delivery of critic-rejected or explicitly gate-rejected rescue clips.
2. Recover reviewed false-negative empty outcomes from candidates the primary
   lane did not judge or did not reach because of bounded selection.
3. Preserve byte-equivalent normal non-empty output in `off` and `shadow`.
4. Attribute every delivered result and every feedback snapshot to a stable
   engine/recovery version.
5. Measure false-negative recovery separately from valid empty outcomes so the
   system is never rewarded for manufacturing weak clips.
6. Bound additional model cost, latency, output count, and retry behavior.

## Non-goals

- No automatic reinterpretation of every `NO` or `EDIT` as objective truth.
- No resurrection of `keep:false`, evidence-gate, snap, arc, post-boundary,
  standalone-filter, or finalizer drops.
- No second scanner call in V4.1; recovery uses already discovered candidates.
- No changes to pricing, checkout, billing, free-minute settlement, or user
  quota semantics.
- No automatic post-feedback re-render in V4.1.
- No global score-threshold, prompt, crop, subtitle, or long-clip retune.
- No claim that reducing raw `DONE + 0` is automatically an improvement.

## Immediate containment

Before V4 code is enabled, production must set both legacy bypasses off:

```text
SHORT_SOURCE_RESCUE=off
RESCUE_MID_SOURCE=off
```

This is a reversible configuration mitigation. It may increase honest empty
results, but it removes a path already observed to ship critic-rejected clips.
The change is deployed only with an empty analyze queue, one canary, and a
recorded rollback command. No database rollback is required.

## Runtime architecture

### 1. Stable candidate trace

The analyzer currently collapses several different losses into a final empty
array. V4 adds an in-memory, typed candidate trace with closed disposition
codes. It contains ranges, scores, candidate type, and stage decisions, but no
transcript text, user identity, URL, or storage key.

Minimum dispositions are:

- `not_selected_for_critic`;
- `critic_rejected`;
- `evidence_rejected`;
- `snap_rejected`;
- `selection_not_chosen`;
- `arc_rejected`;
- `post_boundary_rejected`;
- `standalone_rejected`;
- `finalizer_rejected`;
- `shipped`.

Each lane gives every candidate exactly one terminal disposition. A recovery
candidate keeps its immutable primary disposition (`not_selected_for_critic`)
and receives a separate recovery disposition; primary history is never
rewritten to make recovery look cleaner. Tests reconcile each lane's input,
shipped, and terminal buckets. An unknown or duplicate lane disposition is a
technical invariant failure, not an eligible recovery case.

### 2. Recovery eligibility

Recovery is considered only after the primary pipeline produces zero clips and
all of these conditions hold:

- the outcome would otherwise be `NO_VIABLE_MOMENTS`;
- scanner and critic technical-completeness guards passed;
- the transcript is not partial and no candidate crossed a missing range;
- the source was not rejected by the degenerate or song gate;
- no recovered candidate was previously rejected by any semantic, boundary,
  render-safety, or finalizer authority;
- an unused `not_selected_for_critic` candidate exists.

The first recovery pool is therefore only the bounded tail that normal critic
selection did not inspect. Candidates are ordered deterministically by source
region diversity, scanner interest, and stable id. At most six enter recovery.
The limit is configuration-bounded and part of the evaluation fingerprint.

V4.1 does not retry a candidate already judged `keep:false`, does not lower a
threshold, and does not invent a transcript-free visual clip. If the unused
pool is empty, the honest zero remains.

### 3. Shared quality lane

Primary and recovery candidates must use one shared quality-lane function. It
runs critic, evidence grounding, snap/compression, copy-language checks, arc
and boundary policy, selection/NMS, standalone filtering, and finalizer. V4
must not copy a partial approximation of those stages into a rescue module.

The refactor is accepted only when the feature is `off` and all existing
deterministic replays remain byte-equivalent. The legacy `rescueShortSource`
delivery path is then removed or made unreachable; it must not coexist with V4
as a fallback.

Recovery gets one critic batch and no recursive recovery. Model error follows
the existing technical-failure policy: if no recovery candidate was judged,
the original complete primary result remains an honest zero; a partial or
ambiguous recovery result is discarded and recorded, never shipped.

### 4. Modes and configuration

`ANALYZE_OUTCOME_RECOVERY_V1` has exactly three values:

- `off`: no recovery computation and no recovery telemetry key;
- `shadow`: run recovery on eligible empty jobs, record the hypothetical
  result, but return the primary empty result;
- `on`: return a recovered result only after the shared quality lane passes.

Unknown values resolve to `off`.

Additional bounded configuration:

- `OUTCOME_RECOVERY_MAX_CANDIDATES`, default `6`, maximum `12`;
- `OUTCOME_RECOVERY_VERSION`, a code-owned constant rather than an arbitrary
  production string.

The mode and numeric configuration enter the existing engine fingerprint and
quality-gate decision. `off` must be byte-identical to the current analyzer
with both legacy rescue flags disabled. `shadow` must return the same customer
result as `off`.

### 5. Version attribution

Add a nullable `Job.analysisVersion` string rather than overloading
`highlightsVersion`, whose existing values distinguish legacy and
recall-critic output shapes. The analyze stage stamps a code-owned version for
every new job.

The immutable feedback snapshot adds:

- `analysisVersion`;
- recovery mode;
- recovery outcome: `not_eligible`, `no_candidate`, `rejected`, `shadow_hit`,
  or `shipped`.

Historical rows remain valid with null fields. The snapshot contains no raw
candidate trace. Detailed stage counts stay in ANALYZE `JobStep.outputJson`.

### 6. Telemetry

When mode is `shadow` or `on`, `telemetry.outcomeRecovery` contains:

- version and mode;
- eligibility result and closed reason code;
- primary terminal-disposition counts;
- recovery pool size and judged count;
- rejection counts by existing authority;
- finalizer input/survivor counts;
- hypothetical or shipped range metadata;
- added model usage and elapsed time;
- final outcome.

No transcript text, title, note, source identifier, URL, object key, user id, or
raw frame is emitted.

## Private evaluation corpus

Clip feedback cannot represent a zero-output job because no `Clip` exists.
V4 therefore extends the private, ignored quality corpus with an append-only
job-outcome label type. Promotion is an explicit owner action during source
retention; V4 does not automatically preserve every customer source forever.

A zero-output label freezes:

- job and ANALYZE-step identity hashes;
- engine/config fingerprint and source duration;
- reviewer disposition: `recoverable_false_negative`, `valid_empty`, or
  `exclude`;
- acceptable and forbidden source windows;
- the materialized transcript/source digests and recorded model responses;
- confidence and causal subsystem.

Only source-reviewed, high/medium-confidence cases enter eval or holdout.
Unavailable, subjective, or source-limited cases are excluded rather than
guessed. Existing confirmed `AS_IS` and confirmed-negative clip cases remain
mandatory non-regression controls.

Before `on`, the corpus must contain at least five positives and eight
confirmed negatives under the existing quality-gate policy. At least three of
the negatives must exercise selection/rescue policy. The zero-outcome lane
additionally requires at least four `recoverable_false_negative` and four
`valid_empty` jobs, with at least one of each locked in holdout. Owned/licensed
real-media cases may seed eval, but customer evidence and holdout may not be
replaced with synthetic JSON fixtures.

## Offline release gate

The gate is content-addressed to commit, engine configuration, corpus, runner,
and policy. It fails closed on missing/stale evidence or replay drift.

Hard requirements:

1. No recovered clip has a prior `critic_rejected` or explicit-gate terminal
   disposition.
2. All retained confirmed `AS_IS` windows remain reachable and shipped.
3. No confirmed negative reappears or worsens in its labelled subsystem.
4. Every `valid_empty` control remains empty.
5. At least 30% of reviewed `recoverable_false_negative` cases recover an
   approved window, with at least two recovered cases; percentages alone
   cannot pass a tiny corpus.
6. `off`/`shadow` customer outputs are byte-equivalent for deterministic
   replays.
7. Recovery never exceeds one critic batch, six candidates, the normal output
   cap, or existing geometry/render invariants.
8. Worker unit/integration suite, typecheck/build, production image build,
   migration rehearsal, and a real-media canary pass.

If the current private corpus lacks enough recoverable and valid-empty cases,
V4 may ship dark or shadow but cannot be enabled through the release wrapper.
An override records a reason but does not turn a failed gate into a pass.

## Live rollout and decision window

1. Apply the immediate containment separately and observe one canary.
2. Deploy V4 `off`; verify migration, health, queue, and output invariance.
3. Run `shadow` on all eligible empty jobs because traffic is low. Shadow does
   not alter customer output.
4. Review every shadow hit against retained source before promotion.
5. Enable `on` for all users only after the offline gate passes. Low traffic
   makes a small percentage split slower and less informative than a guarded
   all-user rollout.
6. Evaluate after at least 20 eligible first jobs and at least 10 ratings, or
   after 14 days, whichever occurs later.

Hard rollback triggers:

- any shipped candidate previously rejected by critic or an explicit gate;
- any positive-corpus loss or valid-empty false positive;
- malformed/unplayable output or geometry regression;
- analyze technical-failure rate increases by more than 5 percentage points
  against the preceding 30-job baseline;
- configuration/fingerprint mismatch or missing version attribution.

Product success signals, reported separately from hard safety gates:

- at least 40% `AS_IS` among V4-attributed ratings;
- at most 30% jobs with only `NO` among rated V4 jobs;
- at least 35% of new users submit again within seven days;
- plan-open and payment conversion are tracked, but are not used to weaken or
  promote the engine gate.

The small sample is always shown as counts and percentages. No conclusion is
reported without its denominator.

## Testing strategy

Implementation follows TDD. Tests must cover:

- config parsing, bounds, unknown-value fallback, and fingerprint binding;
- closed candidate-disposition accounting and invariant failures;
- eligibility for every allowed and forbidden empty-outcome branch;
- deterministic pool ordering, diversity, and cap;
- explicit proof that `keep:false` and every quality-gate drop are terminal;
- full shared-lane reuse, including finalizer, with mutation tests that fail if
  a stage is skipped;
- no recursion and one-batch cost bound;
- `off` not-a-key and byte invariance; `shadow` output invariance;
- Job version stamping and immutable feedback snapshot attribution;
- zero-output corpus validation, append-only labels, privacy, permissions,
  symlink refusal, hashes, and stale evidence;
- baseline/candidate/holdout policy including synthetic positive loss,
  negative resurrection, valid-empty false positive, and true recovery;
- migration up/down rehearsal and compatibility with historical null rows;
- worker suite, deterministic evals, real-media replay, production image, queue
  preflight, canary, and rollback command verification.

## Rejected alternatives

### Lower the critic or selection threshold globally

This would affect every successful job and optimize clip count instead of
quality. The current rescue evidence already shows the danger of shipping the
best rejected candidate.

### Re-run the scanner with a more permissive prompt

It adds model variance, cost, and a second prompt policy before the unused
existing pool has been measured. It may be considered only as a later version
with a separate corpus result.

### Automatically repair every `EDIT` or replace every `NO`

Feedback is subjective and arrives after delivery. Reason-specific re-render
can be a later product feature, but it needs idempotency, source-retention,
billing, delivery, and user-consent design and must not be smuggled into the
analyzer safety change.

### Optimize raw zero-output rate

This rewards junk output on genuinely weak sources. V4 optimizes reviewed
false-negative recovery while requiring valid-empty precision of 100% in the
gate corpus.

## Acceptance criteria

- Legacy short/mid rescue cannot deliver a clip in V4 production.
- No V4 clip can bypass critic or any existing quality authority.
- Disabled and shadow modes do not change customer-visible outputs.
- Every V4 job and subsequent feedback carries stable version attribution.
- The release gate proves a real recovery and zero regressions on reviewed
  positives, negatives, and valid-empty controls.
- Production has an explicit one-command flag rollback and no data rollback is
  needed to stop recovery.
