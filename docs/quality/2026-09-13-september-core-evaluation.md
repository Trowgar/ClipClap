# September 2026 clipping-engine investigation

Status: implementation and development experiments completed; **release blocked, no production deployment**. The frozen candidate fixes a demonstrated boundary bug, but broad quality superiority and the requested release gates have not been established. This is an interim evidence report, not a successful production-improvement claim.

## 1. Real data and exclusions

Read-only production snapshot at 2026-09-12T23:27:42Z covers September 1 through capture, not the entire future month. It contains 72 jobs from 52 external accounts, grouped into 58 source identities, and 213 stored clip rows. Rows include historical/retry/deleted outputs and are not 213 distinct delivered clips. There are 68 DONE and 4 FAILED jobs, 70 transcripts, 13 NO_VIABLE_MOMENTS and 2 NO_USABLE_SPEECH outcomes. Languages: Russian 19, English 19, Arabic 17, Indonesian 7, Hindi 5, Portuguese 3, unavailable 2.

Excluded synthetic users, configured owner/admin accounts through existing exclusion helpers, and identifiable test/example accounts. These flags and heuristics cannot guarantee detection of an undisclosed test account.

The snapshot contains all 18 formal feedback records: 2 AS_IS, 6 EDIT, 10 NO. Development also includes 9 incoming support messages, including requests for more interesting clips and specific physical action. Feedback was joined to original delivered clip intervals; historical delivery is kept separate from a fresh baseline replay.

Before experiments, account/source-connected components were assigned to development (52 jobs, 36 accounts, 39 source groups) and holdout (20 jobs, 16 accounts, 19 source groups). Connections include fingerprints, URLs, upload keys and identical transcripts. Previously reviewed cases were assigned to development. No account or identified source crosses the split.

Development replay covers 33 jobs, 28 accounts, 31 source groups, including unrated, empty and poor-result cases. Locally retrieved source media is available for 31 development jobs overall; 23 of the 33 replay jobs have source media and 10 are transcript-only. Twelve delivered feedback clips were downloaded. Review used source transcripts, selected source frames/contact sheets, delivered-clip frames, feedback and pipeline records. This was **not exhaustive audiovisual review or human audio listening**. Retained-media metadata initially listed 14 holdout jobs, but the later download stopped with NoSuchKey; availability metadata is not proof of successful retrieval.

Customer data, media, prompts/responses, split identifiers and credentials remain in ignored `apps/worker/tmp/september-core/`; none are included in this document or committed fixtures.

## 2–3. Failure modes and where quality is lost

| Observed failure | Evidence and pipeline path | Implementation implication |
| --- | --- | --- |
| Accepted explanation is missed while its teaser is judged interesting | s007 historical AS_IS covers 0–64.58s. Scanner fragments the explanation. Three critic verdicts converge on nodes 0–1, which promise three principles without delivering them; final output has only two later account-security examples. The accepted explanation is absent in both fresh versions. | A promise of information can pass critic scoring without the promised explanation. Padded-window reselection can collapse distinct candidates onto the same attractive introduction. Raising rejection thresholds does not recover the missing episode. |
| Actual outcome is rejected, introduction is selected | s012 scanner finds the code/vault episode. Critic rejects the actual attempt/outcome as insufficiently grounded or self-contained while approving the introduction promising to explain it. | Loss occurs after discovery, in critic context/episode judgment and scoring. Merely increasing scanner recall cannot fix it. |
| Good nominees remain unjudged despite unused capacity | In the 33-job baseline: 1,377 raw nominations, 785 merged candidates, 388 critic candidates and 394 unjudged candidates after teaser handling. Twenty-one jobs have unjudged candidates while below the reported critic budget. | `partitionCriticCandidates` applies a per-region cap during global fill. Filling remaining capacity was tested, but changed critic batches and added weak clips. Unjudged counts alone do not prove all omitted candidates are good. |
| Physical action is underrepresented by text | s037 customer asks for somersault moments, accepts the jump, rejects a floor/camera clip. Frame review confirms the difference. Fresh baseline and frozen candidate preserve the accepted 147.29–155.58s cut. | Transcript-only judgment and motion peaks cannot reliably distinguish an event from camera movement. No validated semantic visual fix was implemented. |
| Apparent sentence completion crosses into another scene | s058 CUTOFF feedback; frame review places an unrelated scene transition near 434.7s. Transcript continues the previous dialogue to about 438.3s. Fresh baseline/candidate end at 438.84s. | Transcript completion is not a reliable scene boundary. The hypothesis that a longer end repairs this feedback was falsified by source frames. Generic shot-cut truncation would also harm ordinary camera switches. |
| Finalizer judges the wrong interval; opening trim loses a validated ending | End/start repair updates `finalStartNode`/`finalEndNode`, leaving critic bounds unchanged. Finalizer prompt used critic bounds. Opening trim re-snapped the old payoff and could undo validated end extension. | Two competing boundary representations cause a concrete mechanical loss. See the real-source ablation below. |
| Formally acceptable but uninteresting output | Added candidates include a gameplay intro promising later headshots and a short setup without its reaction. Stronger payoff wording recovered some moments but also produced a long setup and lost other useful episodes. | More outputs and higher model scores are not evidence of publishability. Context, delivered payoff and customer intent must be measured separately. |
| Feedback can refer to framing, not selection | s064 delivered desktop demonstration was badly cropped. Existing baseline already contains a framing repair. | Do not credit this change for a prior fix or interpret every QUALITY/EDIT vote as a ranking error. |
| Eval reported approved retention for unrelated clips | Existing selection-lane metric returned retained=1 for any nonempty approved case. | False-positive evaluation could hide recall regressions; fixed below. |

These observations span education, gaming, demonstrations, comedy/action and long-form discussion in multiple languages. They establish several distinct failure mechanisms, not a single universal cause.

## 4–5. Code changes retained and causal evidence

Frozen runtime candidate `final-boundary-authority`, baseline `c34dc27`, frozen before holdout review at 2026-09-13T00:16:19Z:

- `analyze-v2/prompts.ts`: finalizer receives the actual selected node interval after boundary repairs.
- `analyze-v2/finalize.ts`: opening-trim validation starts from actual bounds; preserves the already validated end, end node and question status; recalculates short-moment status and records actual trim nodes.
- `feedback-quality/selection-lane.ts`: approved retention requires coverage of the approved reference interval, rather than any nonempty output.
- New `evaluation/moment-metrics.ts` and `scripts/eval-moment-quality.ts`: full required setup/payoff coverage, missed positives, unique publishable moments, top-3/top-5 precision and fixed-K yield, boring outputs and start/end/context review axes. Unreviewed clips remain unknown. Empty-output sources stay in denominators. Recorded provider failures, refusals, truncation, empty or malformed structured responses cause comparison to fail rather than count fallback output as a quality result.

Deterministic real-source ablation, s057: the same recorded finalizer decision requests start node 149 on a clip with validated range 442.59–531.90s. Old code outputs 475.02–529.40s; new code outputs 475.02–531.90s. It preserves 2.50005s of the already validated ending. Both cuts were rendered from the retained source preview and probed as H.264/AAC (54.387s versus 56.889s). This is an analysis/boundary ablation with identical model judgment, not a new ASR or full production reframing run.

Regression tests cover expanded and shortened prompt ranges, trimmed extended ends, orphan-question context and unrelated approved-reference matches. Independent review found and prompted fixes for duplicate publishable counting and unknown reviews being treated as zero yield, then incomplete model-response validation.

The runtime change is deliberately narrow because broader experiments failed on real examples, not because broader changes were ruled out in advance.

## 6. Development evaluation

Analysis replay uses recorded real transcripts, available motion telemetry, source duration and effective production configuration. Exact unchanged model request bodies replay recorded responses, preserving occurrence order; changed requests use the provider. Repeated finalizer/publishability evaluations measure some model variability while holding upstream judgments fixed. This does not estimate full-pipeline stochastic variance.

The sparse positive reference set contains 32 required intervals across 13 jobs: 2 customer-approved moments plus 30 provisional assistant editorial labels from source transcript/frame review. It is not exhaustive ground truth. Timestamp precision and subjective setup requirements can create conservative misses. Unlabeled moments are never negatives. Primary results include all 33 replay jobs in source denominators; repeated subsets contain the 13 labeled jobs.

| Comparison | Old found / 32 | New found / 32 | Old missed | New missed | Old outputs | New outputs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Primary, 33 jobs | 20 (62.5%) | 20 (62.5%) | 12 | 12 | 107 | 104 |
| Repeat 2, 13 jobs | 18 (56.25%) | 19 (59.38%) | 14 | 13 | 46 | 42 |
| Repeat 3, 13 jobs | 19 (59.38%) | 21 (65.63%) | 13 | 11 | 44 | 44 |

Summing repeated opportunities gives 57/96 versus 60/96, **not 96 independent labeled moments**. This small difference is insufficient to establish broad superiority. Customer-approved retention is 1/2 in each primary version: s037 retained, s007 missed. Output count is not publishable yield.

Only direct approved-cut identity and the frame-confirmed cross-scene defect are transferred into structured clip reviews. Overall P@3/P@5, publishable clips/source and boring-clip prevalence remain **unknown**, because independent review coverage is insufficient. The tools expose these unknowns instead of reporting invented precision gains. The verified cross-scene end defect remains in both versions. Full start/end/context and boring assessments across all outputs are outstanding release requirements.

## 7. Holdout

Code was frozen before opening holdout source content; no runtime tuning followed. Eighteen jobs have analyzable transcripts; two failed jobs have none. Nine provisional source-transcript positives were recorded on five jobs before inspecting their outputs. No claim of holdout visual publishability is made.

Twelve candidate jobs contain incomplete calls with `429 credit_balance_exhausted` and fallback behavior. They are invalid quality comparisons and the new comparator rejects the complete holdout manifest. The remaining six jobs contain 11 clips in both versions, with identical output ranges and zero changed live model calls. On the six labeled opportunities within this valid subset, both cover 3/6. The subset provides no evidence of improvement and cannot substitute for the planned holdout.

A fresh single-source retry after resuming on September 13 also returned credit_balance_exhausted on both the primary and fallback models; its degraded output is retained separately as holdout-final-resume and excluded from metrics.

The baseline holdout calls completed. Preserve the frozen candidate and existing labels; rerun affected jobs after provider capacity is restored, without tuning on the exposed holdout. A subsequent design iteration requires a new untouched evaluation split, not repeated optimization against this one.

## 8. Regressions and rejected experiments

- Removing/filling regional caps increased candidate coverage but introduced weak setups and displaced useful moments through changed critic batches. Reverted.
- More permissive opening wording improved sparse coverage in one run but admitted an unanswered question and lost useful chase moments. Reverted.
- Candidate anchoring lost the customer-approved jump, a car-prank episode and a practical exercise. Reverted.
- Higher reasoning effort recovered a vault outcome but lost other useful moments and still missed the accepted explanation. Reverted.
- Stronger delivered-payoff prompting recovered the accepted explanation and vault outcome, but retained a long introduction and lost other good clips. Reverted.
- Frozen candidate still loses the s039 repentance question/answer in the primary run, despite equal aggregate recall. This remains a release concern, not an eliminated regression.
- Trim-only variant changed s039 start from about 1512.5 to 1515.3s. Possible context loss remains unvalidated. A reviewer also identified a pre-existing too-short rejection before restored end length is considered.

## 9. Technical verification and production outcome

- Focused changed-area tests: **143 passed**, five files.
- Worker typecheck: passed. Worker and shared TypeScript builds: passed.
- Clean-environment baseline worker/shared suite: 3,597 passed, 55 failed. Final candidate run: **3,612 passed, 55 failed**, with exactly the same 55 failing test names and no new failures.
- Existing failures: 52 recorded-eval cases with missing critic recordings, one Docker-dependent render-artifact test without Docker inside the test container, one analytics event expectation and one Telegram notification expectation. These are baseline failures, but the requested all-green release gate is still unmet. Snapshots were not blindly updated.
- Source-derived ablation media encoding/probe passed. Full production ASR/reframe/end-to-end stability is not established by that check.
- **Nothing deployed.** Live source and queues were not modified. Changes are isolated on `feature/september-core-improvement`; detached baseline worktree and effective configuration are retained. Live workers bind-mount source and watch it, so merging/copying into the live tree would itself be a runtime change.

Release remains blocked by incomplete holdout, insufficient publishability assessment, unresolved quality regressions and non-green existing tests. If later gates pass, follow the repository queue-drain/source-update/restart procedure with the baseline commit and prior effective configuration retained for rollback. Do not deploy this branch on the strength of the mechanical ablation alone.

## 10. Next priorities and reproducibility

1. Restore provider capacity and complete the frozen holdout comparison; no tuning against exposed holdout.
2. Establish independent audiovisual publishability reviews, including ranking, boring clips, semantic start/end and setup/payoff, on a broader positive set.
3. Make critic episode construction deliver the nominated outcome without drifting to nearby teasers; preserve accepted examples and test new designs on a fresh untouched split.
4. Add semantic visual event/scene evidence for physical action and compilation boundaries, distinguishing camera switches from episode changes.
5. Repair incomplete stage-eval recordings and the render-test environment, then require clean existing tests and real full-pipeline renders before release.

Private evidence directory contains `inventory.json`, `split-lock.json`, `availability.json`, `candidate-freeze.json`, per-source original/fresh/experimental runs, `label-protocol.json`, `holdout-label-protocol.json`, `trim-ablation.json`, paired preview cuts, manifests, comparison outputs and test logs. Preserve this directory locally; it contains customer data and must not be published.

Run comparisons inside the isolated evaluation container, from `/app/apps/worker`:

```sh
npx tsx src/scripts/eval-moment-quality.ts tmp/september-core/manifest-development.json
npx tsx src/scripts/eval-moment-quality.ts tmp/september-core/manifest-repeat-2.json
npx tsx src/scripts/eval-moment-quality.ts tmp/september-core/manifest-repeat-3.json
npx tsx src/scripts/eval-moment-quality.ts tmp/september-core/manifest-holdout-valid.json
# Expected to fail until affected recorded runs are replaced with valid reruns:
npx tsx src/scripts/eval-moment-quality.ts tmp/september-core/manifest-holdout-all.json
```

The generic comparator accepts a manifest of source IDs and paths to baseline/candidate runs, independent moment labels and optional clip reviews. It makes no network calls. The private replay harness is `tmp/september-core/run.ts`; use a new mode/output filename for retries to preserve failed-run evidence.
