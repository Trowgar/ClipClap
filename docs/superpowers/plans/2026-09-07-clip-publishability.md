# Final speech and title review

The rated BORING passage passed every existing judge. Its finalizer title also
reversed the proposition. Longer instructions in those judges did not reliably
help; a short, independent review of the finished speech caught both defects in
three exploratory calls. These are development cases, not holdout evidence.

Implement one batched review after final boundaries and copy repair, shared by
primary and recovery lanes. No score, prior verdict, feedback, or neighbouring
context goes into its request. Reject only explicit generic restatements; retain
useful beginner/niche information and uncertain visual moments. Check title
meaning separately and reuse the existing title/evidence validator for repairs.
Malformed/incomplete calls preserve input and report an incomplete audit; recovery
cannot promote that failure as a verified result. No boundary changes or new
packages. Enable with ANALYZE_PUBLISHABILITY=on; default off pending release
validation, without editing the live worker mount or historical customer clips.

- [x] Validate actual title errors independently of content rejection.
- [x] Add failing contract and quality-lane regressions, then implement.
- [x] Run the implemented reviewer on the rated passage and declared controls.
- [x] Run focused tests/typecheck and review the final diff.

Validation on 2026-09-07 (development evidence, not a release holdout):

- Three calls of the implemented reviewer, each with the rated passage plus five
  declared controls: rated passage and two circular statements rejected 3/3;
  useful game tactic, beginner coffee tip, and existing podcast positive retained
  3/3. The original title was independently marked unsupported in all responses.
- Three calls with four separate title defects (actor reversal, negation, causal
  reversal, missing condition) plus a visual-reaction and joke control: all four
  titles repaired in the correct language each time; no content removed. The
  final wording varies. This establishes those defects, not universal entailment.
- Three calls with all ten shipped clips from the original job plus two useful
  controls, filling the default 12-slot batch: only the rated clip rejected in
  every call. All other originals and controls retained, without title changes.
  Each call used 2,717 input and 1,642–1,861 output tokens, against a 10,400 output
  cap, and took 12.5–15.7 seconds. One extra model request per nonempty lane.
- Reasoning `low` still missed a synthetic actor reversal after a short comparison
  explanation was added, and once returned a correction in another clip's
  language. The final implementation uses `medium`; its three actual-function
  probes above did not show those failures. No model or dependency was added.
- Integration regressions failed before wiring: the sole generic clip shipped,
  the finalizer's wrong title survived, and recovery could promote an incomplete
  review. All now pass. Reviewer-found telemetry disagreement and soft-cap
  misattribution were reproduced and fixed using one final survivor set.
- Final focused suite: 237 tests pass; worker typecheck passes. Broad suite before
  the last unchanged-repair guard: 3,009 passed, the same 23 failures and four
  import-failing suites as baseline (2,981 passed). Failure identities match
  exactly. No historical recordings or expected snapshots were rewritten.

Private requests, full provider responses, request hashes, scripts and usage are
under ignored `apps/worker/.corpus/publishability-check`, files 0600. The final
experiments are `implemented-probe`, `implemented-challenge`, and
`implemented-full-batch` (`.ts` / `.json`). They invoke the production function;
no feedback or expected verdict appears in the model's request. Do not copy
customer speech, titles or identifiers into tracked fixtures or public reports.

Limits: this is a fix verified on the reported case and declared development
controls; a single BORING label does not establish general audience preference.
The text-only reviewer preserves uncertainty about visual moments. A failed call
or invalid/unchanged title repair preserves the primary clip and reports the
unresolved review; recovery cannot promote that incomplete result. No automatic
backfill after a final veto, no extra title retry, no new dependency.

Rollout: code is isolated on `fix/clip-publishability`, based on the preceding
`fix/finalizer-no-payoff` fix. The live worker mount, environment, database and
existing rendered clips were not changed. `ANALYZE_PUBLISHABILITY=on` activates
the measured path; default remains off until release validation. Turning it off
removes the extra request, veto/repair decisions, and new telemetry key.
