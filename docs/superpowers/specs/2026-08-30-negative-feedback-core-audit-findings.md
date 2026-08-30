# Negative-feedback core audit findings

**Date:** 2026-08-30  
**Status:** private audit summary; observation rollout remains paused

## Scope and reconciliation

The frozen cohort contains 19 ratings: 11 `EDIT` and 8 `NO`. The independent
partitions reconcile exactly: boundaries 4, selection 8, and visual 7. Each
rating has one matrix row and one primary layer/classification.

The recorded reason distribution is: `CUTOFF` 4, `QUALITY` 4, `FRAMING` 3,
`BORING` 3, and no recorded reason 5.

The evidence matrix is private and remains under the ignored audit corpus. This
document intentionally contains aggregate counts and paraphrased patterns only;
it contains no case references, identifiers, links, transcript text, media, or
user-specific details.

## Disposition

| Disposition | Count | Interpretation |
| --- | ---: | --- |
| Confirmed engine-caused | 8 | Artifact and telemetry support a defect in the processing path. |
| Partial / qualified engine involvement | 6 | A mechanism is plausible or measurable, but attribution or the counterfactual is incomplete. |
| Not engine-caused on available evidence | 5 | Source limitation, subjective disagreement, or an evidence gap prevents an engine claim. |

The six `insufficient_evidence` primary classifications are kept separate from
confirmed defects. They include three visual cases where focal-region coverage
cannot be measured without bounding-box telemetry, two boundary cases lacking
source-backed semantic handoff evidence, and one boundary case where timing is
only a qualified hypothesis. Three cases are classified as subjective
disagreement, and one as source-pre-existing quality limitation. Confidence is
not upgraded merely because a rating was `NO`.

## Ranked root-cause clusters

Ranking weighs affected count, `NO` impact, engine-causation confidence,
reproducibility, and blast radius/risk. Counts are ratings, not users.

### 1. Static or unstable portrait reframe loses salient layout

- **Count:** 4 (3 `EDIT`, 1 `NO`); confirmed engine-caused in the reviewed
  artifacts.
- **Evidence:** high for two cases and medium-high for two; all four are
  reproducible as a crop/layout behavior. Landscape or graphic-heavy content
  is converted to portrait without sufficient layout/tracking information,
  leaving subjects or important regions incomplete.
- **Regression fixture:** production reframe fixtures with sampled subject,
  focal, and UI bounding boxes; assert at least 90% focal coverage, bounded
  crop movement, and safe-area/legibility preservation across representative
  shots and merged layouts.
- **Risk:** high blast radius and medium regression risk; assertions must cover
  both talking-head and multi-region/graphic layouts so a fix does not trade
  framing failures for unstable motion.

**Recommendation:** this is the first justified core-change candidate because
multiple cases support the same reproducible engine behavior. Do not implement
it as part of this audit; obtain owner approval, add a failing fixture first,
then replay the broader evaluation corpus.

### 2. Rescue path can bypass a negative quality decision

- **Count:** 1 (`NO`); confirmed, critical severity, very high confidence and
  directly reproducible from stage decisions.
- **Evidence:** a rejected low-quality rescue candidate was delivered outside
  the normal finalizer review.
- **Regression fixture:** a rescue candidate rejected by the critic must remain
  undelivered unless an explicit, auditable override policy is satisfied.
- **Risk:** high blast radius if rescue is common; high regression risk because
  tightening the gate can reduce recall. Preserve explicit override telemetry.

This is a high-severity follow-up, but the cohort does not establish it as the
first change because it is a single observed case.

### 3. Post-boundary repair can leave a long, empty lead-in

- **Count:** 1 (`NO`); confirmed engine-caused, high severity and high
  confidence; reproducible in the reviewed selection path.
- **Evidence:** a repaired boundary retained a long pre-hook gap while a nearby
  completed alternative was not substituted.
- **Regression fixture:** assert maximum hook delay and pre-hook gap after
  boundary repair, with deterministic replacement by an eligible alternative
  when thresholds are exceeded.
- **Risk:** medium blast radius and medium regression risk; thresholds need
  corpus calibration to avoid removing intentional narrative setup.

### 4. Music-gate acceptance can skip quality judging

- **Count:** 1 (`EDIT`); confirmed engine-caused, high severity and high
  confidence; reproducible from the gate path.
- **Evidence:** a detector-generated window reached output with no critic or arc
  quality review.
- **Regression fixture:** detector/gate candidates must meet an interest floor or
  enter the same quality review path before delivery; assert nonzero judging or
  an explicit, bounded exception.
- **Risk:** medium-to-high blast radius and medium regression risk; preserve
  recall for genuinely music-led moments while preventing unjudged output.

### 5. Render can append a black tail after a valid selected end

- **Count:** 1 (`EDIT`); confirmed engine-caused, high severity and very high
  confidence; reproducible in the render artifact.
- **Evidence:** black frames appear in rendered output while the corresponding
  source region is not black; boundary no-window telemetry is not treated as
  causal evidence for this render defect.
- **Regression fixture:** compare output frames through the selected end and
  assert no appended black interval after a valid end, including encode and
  muxing variants.
- **Risk:** medium blast radius and medium regression risk; avoid masking valid
  intentional black content at the source.

## Owner judgment and deferred items

The following remain owner-policy or evidence-gated rather than automatic core
changes:

- Three visual quality/framing reports lack focal bounding-box telemetry; add
  that telemetry and repeat review before assigning causation.
- Three boundary reports lack enough source-backed semantic handoff evidence to
  confirm a cutoff; retain timing observations as hypotheses only.
- Three ratings are best explained by subjective disagreement on available
  evidence; one additional candidate has partial attribution because the
  counterfactual alternative set is incomplete.
- One quality report is source-limited rather than an encoding failure.

No claim above exceeds the matrix confidence or reproducibility fields. No
production code, prompt, configuration, data row, or running service was
changed by this audit. Any implementation cycle must first create a failing
regression fixture, secure owner approval, and replay the broader corpus before
considering rollout.
