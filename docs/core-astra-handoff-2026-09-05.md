# ClipClap core quality handoff for Astra

Date: 2026-09-05
Repository: `/srv/dev/clipclap.io`
Branch at capture: `feature/core-v4-first-result-recovery`
Commit at capture: `553f4a0f35cbf3e0438d63597b01d5665d38aff9`

This is a fact pack for a new model/session working on ClipClap's clip quality.
It deliberately separates measured evidence, production configuration, historical
findings, current experiments, and hypotheses. Do not turn every negative rating
into a code change: the feedback vocabulary describes symptoms, not proven causes.

Private customer media, transcripts, user identifiers, signed R2 links, holdout
assignments, and model recordings are intentionally not copied into this document.
They remain in the ignored private corpus and must stay out of git and chat.

## 1. Product and target outcome

ClipClap converts long videos into vertical clips for TikTok, Reels, and Shorts:

```text
source upload or URL
  -> DOWNLOAD / NORMALIZE
  -> TRANSCRIBE
  -> ANALYZE: discover, judge, and bound moments
  -> RENDER: cut, reframe to 9:16, burn subtitles
  -> upload and deliver
```

The quality goal is not merely “produce more clips.” A good output must jointly:

1. select a moment a viewer would willingly publish;
2. open on a comprehensible hook rather than a borrowed answer or setup fragment;
3. contain one coherent arc with its payoff and a natural ending;
4. avoid dead interior material and unrelated scene/argument stacking;
5. keep the visually important subject, UI, action, or composition legible in 9:16;
6. preserve readable, complete, correctly timed subtitles;
7. render without black tails, bad geometry, duplicate artifacts, or delivery failure.

These are different subsystems. A prompt change in ANALYZE cannot fix a crop, and a
reframe change cannot satisfy a request such as “make it exactly 45 seconds.”

## 2. Current production evidence

Owner and synthetic accounts are excluded from the customer metrics below.

### All-time customer use at capture

- 225 customer accounts.
- 92 customers have submitted at least one job.
- 160 jobs: 148 `DONE`, 12 `FAILED`.
- 97 successful jobs produced clips.
- 30 `DONE` jobs ended with `NO_VIABLE_MOMENTS`.
- 21 `DONE` jobs ended with `NO_USABLE_SPEECH`.
- 377 customer clips exist in the database.
- 32 customers submitted at least two jobs.
- Only 11 customers used the product on more than one UTC day.

The product has real use, but retention is still weak and quality evidence is sparse.
Do not optimize only for first-job output count; returning use is the business signal.

### August 2026

- 102 registrations.
- 73 active users with at least one job: 71 new, 2 returning.
- 133 jobs: 123 `DONE`, 10 `FAILED`.
- 289 clips.
- 30 users submitted at least two jobs during the month.

### September 1-5, 2026 at capture

- 22 registrations.
- 20 active users: 18 new, 2 returning.
- 26 jobs.
- Registration-to-first-job activation was approximately 82% in this short window.

## 3. Current production configuration

This is the effective configuration printed from the running analyze and render
containers, not inferred only from `.env`.

### ANALYZE

```text
engine                         recall-critic
scanner model                  gpt-4o-mini
critic model                   gpt-5.6-luna
critic fallback                gpt-5-mini
finalizer model                gpt-5.6-luna
reasoning effort               low
scanner passes                 2
scanner window                 600s with 90s overlap
critic batch / max candidates  6 / 40
score threshold                0.60
soft clip cap                  12
target min / hard min / max    8s / 6s / 90s
long clips                     off
end extension                  off
start extension                on
arc audit                      on
arc downrank                   on, 0.15 penalty for two standing axes
standalone filter              off
post-boundary hook gate        off
safe-end audit                 off
song gate                      on
music shorts                   on, max source 480s, two outputs
stream mode                    on
stream resolver v2             on
visual recall v3               on
outcome recovery v4            shadow, maximum six candidates
```

### RENDER / reframe

```text
engine                         faces
output                          1080x1920, SAR 1:1, DAR 9:16
face sampling                   2 fps
scene threshold                 0.30
face minimum score              0.70
stream layout                   on
stream virtual camera           on
camera motion                   off
cut recovery                    on
tail keep                       on
saliency                        shadow only
safety shadow                   off
safety planner                  on
safe-fit                        on
stream coverage gate            on
```

The active shadow features are therefore:

- `ANALYZE_OUTCOME_RECOVERY_V1=shadow` — Core V4 empty-result recovery;
- `REFRAME_SALIENCY_SHADOW=on` — telemetry for faceless-shot visual anchoring.

The following experiments exist in code but are not active production behavior:

- post-boundary hook gate;
- safe-end audit;
- standalone clip filter;
- camera motion;
- reframe safety shadow;
- end extension and long-clip exception.

Do not describe an implemented-but-off feature as a shipped quality improvement.

## 4. ANALYZE architecture and invariants

The current transcript-first path is:

```text
Whisper verbose_json with word and segment timings
  -> buildSentenceGraph
  -> runScanner (two stochastic passes per window, returns node indices)
  -> teaser filtering
  -> mergeCandidates
  -> deterministic visual nominations from motion envelope (V3, on)
  -> selectCriticCandidates with regional diversity and a spend ceiling
  -> runCritic
  -> evidenceGate
  -> snapNodes, which owns boundaries
  -> arc audit / start repair / policy gates
  -> score selection and temporal NMS
  -> finalizer over the candidate set
  -> title/evidence repair after the final boundary
```

Important invariants:

- Models return sentence-node indices, never authoritative timestamps.
- `snapNodes` owns boundary conversion and clean-start/clean-end checks.
- Any model-proposed shortening must be re-snapped and evidence-regrounded.
- A clip must never be dropped only because its title/copy is poor; repair the copy.
- `lexicalOverlap` is telemetry, not a multilingual quality gate.
- Technical incompleteness must fail the job rather than masquerade as an honest
  zero result. Honest weak content must remain a content outcome, not a retry storm.
- Critic rejection and explicit evidence, boundary, arc, standalone, and finalizer
  rejection are terminal. Recovery must not resurrect them.
- Prompt/model/config changes invalidate recorded-response replay fingerprints.

Primary code map:

- orchestrator: `apps/worker/src/analyze-v2/index.ts`
- shared primary/recovery quality path: `apps/worker/src/analyze-v2/quality-lane.ts`
- production defaults and flags: `apps/worker/src/analyze-v2/config.ts`
- prompts: `apps/worker/src/analyze-v2/prompts.ts`
- sentence graph: `apps/worker/src/analyze-v2/sentence-graph.ts`
- scanner: `apps/worker/src/analyze-v2/scanner.ts`
- candidate merge: `apps/worker/src/analyze-v2/candidates.ts`
- critic: `apps/worker/src/analyze-v2/critic.ts`
- boundary ownership: `apps/worker/src/analyze-v2/snap.ts`
- selection/NMS: `apps/worker/src/analyze-v2/select.ts`
- arc diagnosis: `apps/worker/src/analyze-v2/arc-audit.ts`
- final whole-set judge: `apps/worker/src/analyze-v2/finalize.ts`
- V3 visual nominations: `apps/worker/src/analyze-v2/visual-candidates.ts`
- V4 recovery: `apps/worker/src/analyze-v2/outcome-recovery.ts`
- V4 candidate audit: `apps/worker/src/analyze-v2/candidate-trace.ts`

## 5. RENDER architecture and invariants

The reframe engine is face-first. It detects scene changes and face tracks, builds a
shot-level crop/layout plan, merges compatible layouts, optionally attaches a camera
trajectory, compiles an ffmpeg filter graph, and burns subtitles.

Primary code map:

- orchestrator: `apps/worker/src/reframe/index.ts`
- plan construction and merging: `apps/worker/src/reframe/plan.ts`
- face tracking: `apps/worker/src/reframe/faces.ts`
- scene detection: `apps/worker/src/reframe/shots.ts`
- recovered cuts: `apps/worker/src/reframe/cut-recovery.ts`
- stream geometry/layout: `apps/worker/src/reframe/stream-geometry.ts`
- crop geometry: `apps/worker/src/reframe/geometry.ts`
- virtual camera: `apps/worker/src/reframe/camera.ts`
- safety evaluation/planner: `apps/worker/src/reframe/safety.ts` and
  `apps/worker/src/reframe/safety-planner.ts`
- ffmpeg compilation: `apps/worker/src/reframe/filtergraph.ts`
- top-level cutting/rendering: `apps/worker/src/processors/cut.ts`
- subtitle layout and ASS: `apps/worker/src/processors/subtitles.ts`

Output geometry is a hard contract: 1080x1920 with square pixels. Crop windows must
stay valid for the source geometry, cover the intended focal region, avoid bisecting
faces, and avoid introducing unstable movement merely to make the frame look active.

## 6. Formal customer clip feedback

The current digest was generated with:

```bash
docker exec clipclapio-worker-render-1 sh -lc \
  'cd /app/apps/worker && npx tsx src/scripts/feedback-digest.ts'
```

Private outputs:

- `apps/worker/.corpus/feedback/2026-09-05.md`
- `apps/worker/.corpus/feedback/feedback.jsonl`

The Markdown contains fresh seven-day signed evidence links. Never paste those links
into git or a public task. Regenerate them when they expire.

### Aggregate

- 40 ratings from 24 users across 29 jobs.
- 572 clips delivered across all accounts; feedback response rate 7%.
- `AS_IS`: 11.
- `EDIT`: 14.
- `NO`: 15.
- Postable rate among rated clips: 28%.
- 16 of the 24 raters rated only one clip; one user supplied five ratings.

Reason counts:

| Reason | Count | Verdict shape | Routed subsystem |
|---|---:|---|---|
| no reason | 21 | 11 AS_IS, 4 EDIT, 6 NO | requires evidence review |
| QUALITY | 5 | 2 EDIT, 3 NO | render/general artifact quality |
| FRAMING | 5 | 3 EDIT, 2 NO | reframe/crop |
| BORING | 4 | 1 EDIT, 3 NO | moment selection |
| CUTOFF | 4 | 4 EDIT | ANALYZE boundaries |
| SUBS | 1 | 1 NO | subtitle rendering/timing |

Ratings by language:

| Language | Ratings | AS_IS | EDIT | NO |
|---|---:|---:|---:|---:|
| English | 11 | 2 | 2 | 7 |
| Russian | 10 | 1 | 5 | 4 |
| Arabic | 5 | 1 | 3 | 1 |
| Indonesian | 5 | 3 | 2 | 0 |
| Hindi | 3 | 3 | 0 | 0 |
| Javanese | 2 | 1 | 1 | 0 |
| Japanese | 2 | 0 | 0 | 2 |
| Persian | 1 | 0 | 0 | 1 |
| French | 1 | 0 | 1 | 0 |

Ratings by engine-declared clip kind:

| Kind | Ratings | AS_IS | EDIT | NO |
|---|---:|---:|---:|---:|
| insight | 12 | 3 | 4 | 5 |
| reaction | 9 | 0 | 4 | 5 |
| story | 6 | 2 | 1 | 3 |
| reveal | 6 | 3 | 3 | 0 |
| unknown | 3 | 1 | 2 | 0 |
| question | 2 | 1 | 0 | 1 |
| conflict | 1 | 0 | 0 | 1 |
| funny | 1 | 1 | 0 | 0 |

The strongest warning is that `reaction` has 0/9 `AS_IS`. This agrees with the known
transcript-first weakness: reaction/action value often lives in the picture, while the
semantic judge sees mostly words. It is a hypothesis worth testing against media, not
permission to blanket-reject every reaction.

### Score does not predict postability

The present 0-1 critic score should not be treated as a calibrated postability score:

- score below 0.70: 5 AS_IS, 2 EDIT, 8 NO;
- score 0.70-0.79: 3 AS_IS, 4 EDIT, 4 NO;
- score at least 0.80: 2 AS_IS, 6 EDIT, 3 NO.

High-score rated clips were not more likely to receive `AS_IS`. This reproduces the
older owner finding that clips ranked above the preferred clip could still be rejected.
Do not solve this by guessing another global score threshold. First determine what the
score actually tracks and whether a separate postability/ranking signal is warranted.

### Duration is not a clean global rule

- under 30s: 3 AS_IS / 7 EDIT / 6 NO;
- 30-60s: 3 AS_IS / 5 EDIT / 6 NO;
- over 60s: 5 AS_IS / 2 EDIT / 3 NO.

This small, selectively rated sample does not support “shorter is always better.” Older
text-only audits did find drag in 60-111s lecture clips, but current user ratings contain
good long clips too. The relevant defect is likely interior drag or arc stacking, not
duration alone.

### Attribution limitation

All 40 current feedback snapshots identify `RECALL_CRITIC` but have no
`analysisVersion` or V4 recovery attribution. They were produced from jobs that predate
the versioned V4 contour. There is therefore no customer rating currently attributable
to Core V4, and no clean post-enable rating set for V3. Do not claim V3 or V4 improved
customer quality from this cohort.

## 7. Support-message feedback and unmet editing intent

Support logs contain a small set of meaningful requests among repeated test-like
“help me / x / look” messages. The actionable user language includes:

- “видео обрезано” — the video/content was cut off;
- “сделай субтитры повыше под тик ток” — move subtitles higher for TikTok;
- “cukup tambahin subitle aja” — only add subtitles;
- “Переделай клип на более интересный” — remake it with a more interesting moment;
- “Вырежи 45 секунд” / “45 секунд” — exact requested duration;
- “Bahasa indonesia” — explicit language request.

These reveal a product-control gap. Some complaints need core quality work, but several
need an edit command or preference contract:

- subtitle vertical position/style;
- subtitles-only mode;
- requested duration;
- alternative-moment regeneration;
- explicit output/transcript language.

Do not force the autonomous director to infer a deterministic user instruction that the
product can ask for or expose as a control.

## 8. Independently audited negative feedback

The 2026-08-30 frozen audit covered 19 negative ratings: 11 `EDIT`, 8 `NO`.

- 8 confirmed engine-caused.
- 6 partial/qualified engine involvement.
- 5 not proven engine-caused: source limitation, subjective disagreement, or missing
  evidence.

Reason distribution at that time: `CUTOFF` 4, `QUALITY` 4, `FRAMING` 3, `BORING` 3,
and no reason 5.

Ranked confirmed clusters:

1. Four cases: static or unstable portrait reframe lost salient layout/subjects.
2. One critical case: the old rescue path delivered a critic-rejected candidate.
3. One case: post-boundary repair retained a long empty lead-in.
4. One case: music-gate output bypassed the ordinary quality judge.
5. One case: rendering appended black frames after a valid selected end.

The full non-private aggregate is in
`docs/superpowers/specs/2026-08-30-negative-feedback-core-audit-findings.md`.

## 9. What has already been fixed or measured

Do not rediscover or re-propose these without reading the linked implementation/history.

### Selection and judging

- Critic budget used to judge roughly half the candidate pool because it was based on
  timed-word speech rather than source span. The budget/rate was corrected.
- The old gpt-5.1 critic frequently exhausted reasoning-token caps. Production moved to
  Luna after a controlled replay and preserved conservative token caps.
- Luna can omit one verdict without truncation. A bounded exact-ID re-ask now recovers
  omissions.
- Scanner candidate order used to depend on concurrent API completion order. Results are
  now flattened in deterministic window order.
- Scanner recall variance is addressed with two passes per window.
- Repeated overlapping moments were suppressed on 2026-09-03 (`fb0b61f`).
- The critic/evidence path no longer drops an otherwise good clip merely for poor title
  copy.
- Final title repair runs after final boundary movement and re-grounds evidence.
- Arc audit is active and two standing defects receive a measured 0.15 effective-score
  penalty.
- Song detection rejects speechless/lyric sources before LLM spend; a separate music
  mode creates bounded hook windows when enabled.
- Recap/meta-opening examples were added across relevant languages.

### Boundaries and arc

- Over-length compression now uses the shared clean-start policy rather than deleting a
  premise with a weaker private test.
- Opaque sentence nodes can own the natural end when they finish the thought.
- Finalizer trims that would orphan a question are rejected by code.
- End extension was built and measured but remains off: it helped podcast payoffs and
  worsened compilation clips by crossing scene boundaries.
- Start extension and end hints exist, but the remaining hard problem is not another
  edge heuristic: interior drag and multiple complete arcs can still occupy one clip.

### Visual recall and reframe

- Core V3 adds deterministic motion-peak nominations grounded back to nearby transcript
  nodes. It does not bypass semantic/boundary/finalizer gates and is active.
- V3 retained replay: 7/7 labelled visual windows nominated, zero weak-negative hits,
  12-27ms pure nomination latency. Six older positives lacked source media and were not
  protected by that replay.
- Output geometry was corrected to 1080x1920 with SAR 1:1 on every render path.
- Crop placement now penalizes bisecting a face.
- The small-face guard was narrowed to the stream/webcam shape it was designed for.
- Face-track turnover recovers some scene cuts missed by ffmpeg scene detection.
- Stream virtual-camera, two-region layouts, coverage gating, active safety planner, and
  safe-fit layouts are implemented and active.
- Black-tail trimming is implemented.
- Render retry now soft-deletes the previous attempt's partial clip rows before creating
  replacements.
- A 2026-09-05 ffmpeg failure on a 384x848 source was fixed by scale-to-cover then crop;
  narrow sources no longer request an impossible 476px crop from a 384px frame
  (`553f4a0`).

### Subtitles

- Untimed Whisper words at segment seams are restored and rendered.
- Cue splitting chooses a readable break instead of greedily filling the limit.
- Unicode/code-point and punctuation/seam bugs were corrected.
- CJK and Devanagari fonts and script-specific chunking are implemented.

### Measured dead ends

- Groq Whisper variants were 18-20x beyond the accepted transcript/timing jitter and had
  hundreds of timestamp monotonicity violations. `whisper-1` remains the ASR.
- Luma difference and cheap mouth-activity heuristics did not reliably identify the live
  speaker or distinguish a portrait card from a real speaker.
- Relaxing `find_cam_rect` thresholds did not find the missing webcam rectangle on the
  second stream source.
- Global end extension was not a safe universal quality improvement.
- Clip duration or critic score alone does not separate publishable from rejected clips.

The detailed measured record is `docs/engine-notes.md`. Some old product counts in that
file are historical; use this handoff's database snapshot for current counts.

## 10. Core V4: actual state, not aspiration

Core V4 (`core-v4-recovery-v1`) replaces unsafe short/mid rescue with a second bounded
quality lane. It runs only after the primary analyzer returns an honest
`NO_VIABLE_MOMENTS` and only over candidates that were not selected for the primary
critic. It does not call the scanner again, lower thresholds, or resurrect candidates
already rejected by any quality authority. At most six candidates enter one critic
batch, and they pass the same critic, evidence, snap, arc, hook, standalone, selection,
and finalizer stages.

Modes:

- `off`: no computation and no recovery telemetry;
- `shadow`: compute hypothetical recovery, record telemetry, return the original empty
  result;
- `on`: deliver only a fully judged survivor after a valid quality-gate decision.

Production is `shadow`. Customer output must remain identical to `off`.

### Production V4 telemetry at capture

There are 18 external jobs stamped `core-v4-recovery-v1`:

- 12 ordinary non-empty jobs: `not_eligible / non_empty`;
- 3 eligible empty jobs: `shadow_miss / unjudged_tail`;
- 2 music-short paths: `not_eligible / music_short`;
- 1 empty job: `no_candidate / no_unjudged_tail`.

There are currently zero `shadow_hit` outcomes. V4 has therefore demonstrated safe
observation but not recovered a production result. It should stay shadow until its
corpus and gates are complete. Do not expect V4 to improve the quality of normal
non-empty clips; by design it cannot touch them.

### V4 release gate is not ready

The private composite quality corpus currently contains 10 cases:

- 5 positives and 5 confirmed negatives;
- 7 eval and 3 holdout;
- all 10 are currently classified in the render subsystem;
- only 5 retain source media;
- no recorded model-response payloads in these case files.

The specified composite minimum is 5 positives and 8 confirmed negatives, including at
least 3 selection/rescue negatives. Current corpus composition does not satisfy it.

There is no real quality-gate decision in `decisions/`. The single observation directory
contains synthetic placeholder identifiers and is test debris, not production evidence.
The V4 outcome corpus is empty and no outcome decision exists. Therefore promotion to
`on` is unauthorized by the documented release contract.

The V4 design and runbook are:

- `docs/superpowers/specs/2026-09-02-core-v4-first-result-recovery-design.md`
- `docs/superpowers/plans/2026-09-02-core-v4-runtime-recovery.md`
- `docs/runbooks/feedback-learning.md`, section “V4 zero-outcome recovery gate”

## 11. Open quality problems with the best current evidence

### A. Publishability / moment selection

- Current user-rated postable rate is 28%, though selection bias is large.
- `reaction` is 0/9 AS_IS and visual-action sources historically underperform.
- Critic score is not calibrated to postability.
- Interior drag and arc stacking are still largely unmeasured by the pipeline.
- A clip can be semantically coherent yet not be the moment a human editor would choose.
- V3 adds recall but still relies on the same transcript-first critic to value the moment.

Promising research question: can a postability/reranking stage compare complete,
fully bounded candidate arcs using transcript structure plus bounded visual evidence,
without weakening the existing critic and gates?

### B. Hook and self-containment

- Historical 56-clip audit found weak openings 17 times, standalone gaps 14, weak
  endings only 5.
- Clips can still open one node after the question because the critic itself chose that
  boundary rather than a later trim causing it.
- Post-boundary hook gate exists but is off and lacks completed rollout evidence.
- Compression and trim policies have historically disagreed on orphaned questions.

Promising research question: represent “one clip, one question/claim/payoff” explicitly
in deterministic candidate structure and evaluate it after every boundary mutation.

### C. Reframe / visual direction

- Four audited negatives confirmed lost or unstable salient portrait composition.
- Known residual merge blindness keeps the first shot's x-position after layouts merge,
  even when the important face moves in a later shot.
- Faces below the tracker floor can be cut because placement never receives them.
- False-positive face boxes can become dominant anchors.
- Largest face is not always the speaker.
- Faceless content still lacks a proven active saliency anchor outside the specialized
  music path; saliency remains shadow.
- `find_cam_rect` fails on at least one real stream layout.

Promising first mechanical target: recompute merged crop geometry from the union of
shot-local focal tracks instead of inheriting the first shot's crop. It has a known
measured shape and is less speculative than a universal active-speaker model.

### D. Subtitles and edit controls

- Only one formal `SUBS` rating exists, so there is not enough evidence for global
  typography retuning.
- Support messages explicitly request subtitle vertical position and subtitles-only
  output.
- Exact duration, language, and “try another moment” are product-control requirements,
  not autonomous quality inference.

### E. Outcome and billing semantics

- 51 of 148 `DONE` customer jobs produced no clips.
- V4 addresses only a narrow subset of `NO_VIABLE_MOMENTS` with an unjudged tail.
- Honest empty jobs are currently billed because usage sums every non-FAILED job.
- `docs/known-issues.md` records a partial critic-omission edge case where an incomplete
  judgement can still become a billed zero.

Do not optimize raw zero-output count by manufacturing weak clips. Separate false
negatives from valid empty inputs and treat billing policy as an explicit owner decision.

## 12. Evaluation assets and current limitations

Useful checked-in harnesses and private assets include:

- deterministic replay fixtures under `apps/worker/fixtures/eval/`;
- visual-recall evaluator: `apps/worker/src/scripts/eval-visual-recall.ts`;
- selection autopsy and rating sheets under `apps/worker/src/scripts/`;
- reframe geometry/safety evaluators under the same directory;
- private feedback digest and evidence under `apps/worker/.corpus/feedback/`;
- private negative audit under `apps/worker/.corpus/negative-feedback-2026-08-30/`;
- director/reframe corpora under `apps/worker/.corpus/director-audit/`;
- feedback learning and quality gate stores under
  `apps/worker/.corpus/feedback-learning/` and
  `apps/worker/.corpus/feedback-quality-gate/`.

Current validation caveats:

- Focused cross-package verification on the latest work passed 7 test files / 98 tests,
  and worker TypeScript checking passed in the Node 20 worker container.
- A prior full worker run was not a clean baseline: 2998 tests passed and 43 failed,
  mostly from stale eval fixtures, missing test mocks, and nested-Docker unavailability.
- Host `node_modules` currently has a Vite/Vitest ESM mismatch; run worker tests inside
  the project Node 20 container.
- Bot-wide `tsc` also has existing `rootDir` errors from tests importing shared source.

Before comparing any core candidate, establish a reproducible baseline in the same
container and distinguish infrastructure/harness failures from candidate regressions.

## 13. Recommended work order for Astra

Do not begin with a broad rewrite or a global prompt retune. Use this sequence:

1. Read `CLAUDE.md`, `docs/engine-notes.md`, this handoff, the V3/V4 specs, the negative
   audit findings, and the feedback runbook.
2. Inspect the 40-row private digest and media evidence without exposing identifiers,
   links, transcripts, or holdout labels outside the private corpus.
3. Reconcile every proposed defect with the current commit. Mark it fixed, open,
   experiment-off, shadow-only, product-control, source-caused, or insufficient evidence.
4. Build a compact evidence matrix by subsystem: selection, boundary, framing,
   subtitles, render, product-control.
5. Choose one causal, high-frequency problem with available source evidence and a
   failing reproducible case. Do not bundle selection and reframe changes.
6. Add a failing regression/eval case before implementation.
7. Preserve all hard invariants and `off`/`shadow` output equivalence.
8. Replay protected positives and confirmed negatives using the same model recordings.
   If prompt/model/request fingerprints change, run the separately declared live lane.
9. Use eval first. Do not read or tune on the holdout until the eval gate passes.
10. Report exact changed outputs, retained positives, fixed negatives, new regressions,
    cost, latency, and confidence. A higher clip count is not a quality result.
11. Do not change production flags, customer rows, billing, queues, or deploy state
    without explicit owner authorization and the documented release gate.

## 14. Candidate priorities

Recommended evidence-weighted order:

1. **Moment postability and single-arc structure.** Highest possible product impact,
   but requires media-backed labels and a comparator/reranker design rather than another
   guessed threshold.
2. **Merged-shot focal geometry.** A narrower, reproducible reframe defect with existing
   corpus evidence; likely the safest first code improvement.
3. **Complete the quality corpus/gate.** Add selection/boundary negatives and real
   baseline/candidate observations before any major core rollout.
4. **Explicit editing controls.** Exact duration, alternate moment, subtitle position,
   subtitles-only, and language preference should become product inputs.
5. **V4 evidence collection.** Review eligible `shadow_miss` jobs and populate both
   recoverable-false-negative and valid-empty outcome controls. Do not enable V4 merely
   because it exists.

## 15. Copy-paste task for the Astra session

```text
You are taking over ClipClap's clip-quality core in
/srv/dev/clipclap.io. Your objective is to materially improve publishability,
not merely increase clip count.

Start by reading:
- CLAUDE.md
- docs/core-astra-handoff-2026-09-05.md
- docs/engine-notes.md
- docs/superpowers/specs/2026-08-30-negative-feedback-core-audit-findings.md
- docs/superpowers/specs/2026-09-02-core-v3-visual-recall-design.md
- docs/superpowers/specs/2026-09-02-core-v4-first-result-recovery-design.md
- docs/runbooks/feedback-learning.md

Then inspect the private feedback digest and evidence in
apps/worker/.corpus/feedback/ without copying customer identifiers, transcripts,
signed links, media, or holdout assignments into git, chat, logs, or tickets.

First produce an evidence-backed audit, not code. For every complaint or hypothesis,
classify the subsystem and current state: fixed, open, experiment-off, shadow-only,
product-control, source-caused, subjective, or insufficient evidence. Reconcile the
documents with the current implementation and effective production flags.

Rank opportunities by frequency, severity, evidence confidence, reproducibility,
expected publishability impact, and regression risk. Explicitly account for these
facts: 40 ratings / 24 users / 29 jobs; AS_IS 11, EDIT 14, NO 15; reaction clips are
0/9 AS_IS; critic score is not calibrated to postability; V4 is shadow-only and has
three shadow_miss plus zero shadow_hit production outcomes; the private quality gate
does not yet authorize rollout.

Propose at most three interventions. Keep selection/boundary, reframe, subtitles,
and product controls separate. Choose one first intervention only if a failing,
media-backed case can be made. Before changing code, state the invariant it must
preserve and the exact eval that would falsify the idea. Add the failing test/eval,
implement the smallest causal change, replay positives and negatives, and report
exact output differences, regressions, latency, model cost, and confidence.

Never lower quality gates to reduce zero-output count. Never resurrect critic-false
or gate-rejected candidates. Models propose node indices; snapNodes owns boundaries.
Off/shadow must preserve customer output. Do not inspect holdout until eval passes.
Do not change production flags, billing, customer data, queues, or deployment without
explicit owner approval and a valid quality decision.
```

## 16. Immediate sanity checks for the next session

```bash
git status --short
git rev-parse HEAD

docker exec clipclapio-worker-analyze-1 sh -lc \
  'cd /app/apps/worker && npx tsx -e "import { loadAnalyzeConfig } from \
  \"./src/analyze-v2/config\"; console.log(JSON.stringify(loadAnalyzeConfig(process.env), null, 2))"'

docker exec clipclapio-worker-render-1 sh -lc \
  'cd /app/apps/worker && npx tsx -e "import { loadReframeConfig } from \
  \"./src/reframe/config\"; console.log(JSON.stringify(loadReframeConfig(process.env), null, 2))"'
```

At capture, `apps/worker/src/tmp-audit.ts` is an unrelated untracked diagnostic file.
Do not stage, overwrite, or delete it while working on core quality.
