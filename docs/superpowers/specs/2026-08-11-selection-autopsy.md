# Selection autopsy: where labeled moments die in the funnel (instrument spec)

2026-08-11. Owner's direction after the arc-audit programme (tasks 0-4, spec 2026-08-10): "если
хиты не вырастут, будем смотреть на селекцию (какие моменты вообще попадают в criticCandidates и
finalizer)". The labels for `podcast-nuclear` already contain the motivating facts: three
moments with 3/3 blind-scout consensus that NEITHER engine run shipped (the strongest, "Чернобыль
грязнее Хиросимы" at 1041-1071, was ranked #1 by two of three scouts), and roughly five shipped
moments that no scout chose. Nothing currently says WHERE in the funnel the missed moments died,
and without that the remedy is a guess. Engine-notes separately records that finalizer sampling
variance is the largest single instability in the engine - any selection remedy has to be
designed with that fact in view.

**This spec is for the INSTRUMENT only.** No engine change, no remedy design. The remedy gets its
own spec once the autopsy tables exist - the arc-audit programme's "instrument first, corpus
first, code second" rule, which has now paid for itself four times.

## The instrument

`apps/worker/src/scripts/eval-selection-autopsy.ts` - replay-only, zero cost, follows
`eval-arc-audit.ts`'s CLI shape (`[--variant NAME] <fixture>`, default labels path from the
fixture directory).

For each LABELED moment (labels.json `moments[]` by their `range`, plus `missedMoments[]`), trace
the funnel and print the moment's fate at every stage, matching by time overlap (a candidate/
verdict/clip counts as covering a moment when their ranges overlap by >= 30% of the shorter -
reuse the arc-audit label matcher's convention where it fits):

1. **SCANNED** - did any scanner candidate (pre-merge) cover it? With which `interest`.
2. **MERGED / TEASER** - did it survive `mergeCandidates` and the teaser filter?
3. **JUDGED** - did `selectCriticCandidates` hand it to the critic (if not: budget, region cap,
   or rank - name which), and what did the critic answer (keep/score, node range)?
4. **GATED / SNAPPED** - evidence gate and snap outcomes, with drop reasons.
5. **SELECTED** - tier, NMS (name the winning neighbour when NMS killed it), soft cap.
6. **FINALIZED** - shipped, or the finalizer verdict and drop reason.

Reverse direction, same table: for each SHIPPED clip that matches NO labeled moment and no scout
consensus (`the "no scout chose it" population`), print the same trace backwards - scanner
interest, critic score, what loved it. The two tables together answer "recall died where" and
"precision leaked where".

Implementation notes:
- The front half of the pipeline replays from recorded answers exactly as
  `eval-arc-stability.ts` already does (scanner -> critic -> gates -> snap -> select); reuse or
  extract that plumbing rather than writing a third copy. The finalizer verdicts come from
  `runFixtureVariant`'s full result plus the telemetry drop maps.
- Scanner candidates and critic verdicts carry node indices; convert through the same
  `buildSentenceGraph` the replay built - never re-derive seconds independently.
- A moment may be covered by SEVERAL candidates; print each candidate's own fate line, indented
  under the moment - aggregating them hides exactly the near-miss detail the autopsy exists for.
- Output ends with a per-stage kill histogram over the labeled moments (scanned:N judged:N ... ),
  which is the one-line summary the remedy spec will be built from.

## Acceptance

- On `podcast-nuclear` every one of the three `missedMoments` and every `moments[]` entry gets a
  DEFINITE verdict line - no "unknown"; if the script cannot decide a stage, that is a bug in the
  script, not a caveat in the output.
- The three missed moments' kill stages are printed with enough context (interest values, scores,
  budget counters, NMS neighbour) that a reader can name the remedy candidate without re-running
  anything.
- The reverse table lists the shipped-but-unwanted clips with their scanner interest and critic
  score, so "what loved them" is answered.
- The script runs on any fixture and degrades gracefully when labels are missing (prints the
  reverse table only... which without labels is every shipped clip, clearly headed as such).

## Out of scope, deliberately

Any change to `buildScanWindows` (its speechSec mis-budgeting is a KNOWN separate defect,
engine-notes §6a - the autopsy may CONFIRM it as a kill stage but the fix has its own re-record
budget), the critic prompt, `regionMaxCandidates`, the soft cap, and anything about the finalizer
sampling variance. Those are remedy candidates, and remedies wait for the tables.
