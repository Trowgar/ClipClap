# Core quality programme: customer AS_IS above 50%

Date: 2026-09-05
Status: proposed programme; implementation experiments are not yet validated

## Owner objective

Improve the complete delivered clip: interesting moment, understandable opening,
complete payoff, natural ending, appropriate framing, readable subtitles and clean
render. The target is customer AS_IS above 50%. A framing fix alone does not satisfy
this objective. Moment selection is a required workstream, not optional follow-up.

## Evidence and limits

The September 5 handoff reports 40 ratings from 24 users across 29 jobs:
11 AS_IS, 14 EDIT, 15 NO (27.5% AS_IS). This is a selective historical sample,
not a representative measurement of every delivered clip or the current engine.
Reaction clips have 0/9 AS_IS; this motivates media review, not a kind blacklist.
The critic score does not currently separate postable outputs reliably.

The repository remains at 553f4a0. Running configuration was checked during this
session: V3 visual recall on; V4 recovery shadow; hook and safe-end gates off;
camera motion off; safety planner and safe-fit on; saliency shadow on.
The handoff's V4 production observations are three shadow misses and zero hits;
they have not been refreshed in this programme. Its release corpus is insufficient.

Code inspection confirms that mergeAdjacentLayouts retains the first layout's
geometry. Whether this still harms a particular delivered clip must be reproduced
through the active safety planner. Historical defect counts are not current failures.

## Measurement contract

Primary product metric: AS_IS / all AS_IS, EDIT and NO customer ratings in a
declared observation window, attributed to the engine/configuration version.
Unrated clips remain unknown, never inferred positives. Owner and synthetic accounts
are excluded from the customer metric.

Report the raw numerator/denominator, unique customers and source jobs, response
rate, language/content mix, and a user-balanced result alongside the clip-weighted
rate. Report uncertainty accounting for repeated ratings by the same customer.
Exceeding 50% in a small cohort is provisional, not proof of a stable population rate.
For a strong claim, the lower bound of a predeclared 95% customer-cluster interval
must exceed 50%; if evidence is insufficient, explicitly leave the target unproven.
Freeze the observation window and analysis rule before inspecting candidate outcomes.

Guardrails: useful clips per eligible source, fraction of sources with at least one
publishable clip, confirmed-positive recall, valid-empty preservation, duplicate
rate, technical failures, latency and model cost. Report unreviewed sources as unknown.
Reducing output count must not hide a collapse in useful moment recall.

Offline evaluation: blinded baseline/candidate comparisons on the same retained
sources and final rendered clips. Judge the clip without source context first, then
use the source to diagnose omissions and missed alternatives. Human editorial
judgment is an offline proxy; model judgments cannot establish customer AS_IS.
Score moment value, opening, payoff/end, internal drag, framing, subtitles and render
separately, plus one whole-clip AS_IS/EDIT/NO verdict. Do not average away a fatal defect.

## Three intervention workstreams

### 1. Moment selection and narrative completeness

Audit whether strong moments were never nominated, rejected, poorly bounded, or
outranked. Compare complete candidate arcs rather than guessing a new global score
threshold. Evaluate context-independent openings, one coherent question/claim and
payoff, unnecessary interior material, and unrelated scene stacking.

Compare reuse of the existing finalizer with an isolated alternative ranking
experiment before adding another model stage. Test bounded visual evidence for
reaction/action material only against source-backed examples; motion alone does
not establish interest. Any new model or prompt requires fresh request-fingerprinted
recordings in a declared live evaluation lane.

Falsification: humans do not prefer the selected complete moments, known positives
disappear, a payoff is lost, or improvement comes only from dropping useful outputs.
Boundary correctness and moment preference must be reported separately even when
they belong to the same analysis workstream.

### 2. Framing and visual continuity

Replay the active render path on retained sources. Distinguish crop placement,
merged-shot geometry, missed scene cuts, missing/false face tracks and layout errors.
The first mechanical candidate is merged geometry, conditional on reproducing an
actual remaining failure. Compare preserving shot-local layouts with recomputing
geometry across a merged span; choose the smallest change supported by the media.

Measure focal coverage through time, face bisection, UI/action legibility and motion.
Protect talking heads, multiple subjects, streams and faceless content independently.
Do not count moving the important subject entirely out of frame as a successful fix.

Falsification: the full current path already fixes the alleged failure, focal
visibility does not improve, or protected clips acquire worse composition or jitter.

### 3. Subtitle and render completeness

Verify source-to-output word coverage and timing, subtitle safe-area placement,
legibility, final-frame coverage, aspect ratio and render completion on the shared
evaluation set. Start from retained defects; avoid global typography changes based
on the single formal SUBS rating. Existing seam and black-tail fixes are controls.

Falsification: a proposed fix changes no remaining source-backed defect, removes
legitimate source material, loses words, or makes protected outputs less readable.

Explicit requested duration, alternate-moment regeneration, subtitle position,
subtitles-only mode and output language are a separate product-control backlog.
They must not be silently treated as autonomous-engine failures or counted as core
quality gains without implementing and testing the corresponding user contract.

## Execution and acceptance

1. Build a private eval-only matrix of current remaining failures and protected
   positives, using retained sources and stage evidence. Keep customer media,
   transcripts, identifiers and signed links out of git and chat. Do not inspect
   holdout during diagnosis or tuning.
2. Establish reproducible baseline observations in the Node 20 worker environment.
   Separate known harness failures from engine failures. Audit existing evaluator
   coverage before adding new infrastructure.
3. Rank experiments by affected cases, severity, causal confidence, expected AS_IS
   impact, reproducibility and regression risk. Selection remains mandatory; the
   first code change is selected only after a media-backed failing case exists.
4. For each isolated experiment, record the invariant and falsification rule, add
   its failing check, implement the smallest causal change and replay positives
   and negatives. Report exact output changes and cost/latency, including uncertainty.
5. Combine individually successful changes and repeat end-to-end comparison to
   detect interactions. Use holdout only after the eval gate passes. An exhausted
   holdout must not become a repeatedly tuned test set.
6. Require the existing release contract and explicit owner deployment approval.
   Observe version-attributed customer feedback to determine whether AS_IS exceeds
   50%; offline preference improvement alone does not establish the product target.

Quality authorities remain terminal: no resurrection of rejected candidates,
no threshold reduction to manufacture outputs. Models propose node indices;
snapNodes owns boundaries. Off/shadow preserve customer output. Technical failure
must not be disguised as a valid empty result. Production flags, queues, customer
rows, billing and deployment are outside this programme's current authorization.

## Approach decision

Recommended: coordinated programme, isolated causal experiments, then combined
whole-clip validation. This covers the entire core while preserving attribution.
A global prompt/model rewrite would invalidate attribution and recordings before
establishing why outputs fail. Fixing render alone is narrower and easier to measure,
but cannot satisfy the owner's explicit moment-quality objective.
