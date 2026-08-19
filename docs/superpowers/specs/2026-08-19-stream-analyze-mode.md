# Stream analyze mode: fix the three measured killers in text (2026-08-19)

## ACCEPTANCE RESULTS (4 stream-mode autopsy runs, same evening)

Phase-1 baseline: 0/11 labels selected, nothing even reached eligible.
Stream mode (2 runs per source):
- **осуждаю (15,847 views): SELECTED, score 0.72** (run 2; run 1 judged it
  0.42 keep_false - in phase 1 it was never judged at all).
- **НУ НЕЕЕЕЕАД: SELECTED, score 0.82** (run 1; the scouts' unanimous rank-1
  pick that scored 0.18 under the podcast rubric; run 2 gave 0.48).
- m3wsu: eligible at 0.64 (run 1, lost the final selection cut of 16 from 32
  keepTrue; 0.20 in run 2) - the strict SELECTED bar was NOT met for this
  third target. потный туз also reached eligible (0.59).
- NEVER_CANDIDATED stayed within the phase-1 bound (per-run 1-4; ПСИХ and
  "на добром" remain scanner-blind in every run - consistent with the scout
  panel calling them text-invisible: that half belongs to the chat/audio
  tracks, not this one).
- Budget: sentToCritic 40 -> 77/60; осуждаю judged in BOTH runs (was
  rationed out). Two low-interest strogo labels still lost the ration in one
  run - scanner interest remains a weak virality proxy (watch item).
- Cost: 1.29-1.45x tokens (bar was 2x) ~= $0.065 vs $0.043 per 3h source.

**Verdict: union recall 0 -> 2 SELECTED + 2 eligible of 11 (of ~5
text-visible), both marquee labels among them. Shipped-set size in stream
mode: 11-16 pre-finalizer (softCap trims to 12 downstream). Known open
items: (1) critic score variance across runs is large (0.42 vs 0.72, 0.82 vs
0.48 on identical candidates) - single-run production recall is
correspondingly noisy; ensembling/sampling is a possible later lever; (2)
precision of the new, more generous keepTrue (5 -> 32) is UNMEASURED in this
track - the first real stream jobs' delivered clips are the precision test,
with telemetry analysisMode marking them and the flag as rollback.**

Phase 2 / track 1 of the moment-selection campaign
(2026-08-19-stream-moment-selection.md - phase 1 measured engine recall 0/11
on human-labeled stream moments). This track fixes only what phase 1 proved
is engine-internal; chat/audio signals are later tracks.

## 0. The three killers, located in code

1. **Budget ration eats merit** (candidates.ts selectCriticCandidates): the
   per-window quota (perWindowMinCandidates=2, interest-ranked) consumes
   nearly the whole criticMaxCandidates=40 on a 3h source (~18 windows -> 36
   quota picks, ~4 global extras). A viral moment in a stacked window dies
   unjudged - the 15,847-view label did. Cost fact: a full 3h scan+critic
   run measured 126k in / 15k out tokens ≈ $0.04 - DOUBLING the critic
   budget is noise against the $1.21 total cost of a 3h job.
2. **The critic rubric is stream-hostile by explicit instruction**
   (prompts.ts CRITIC_PROMPT_TEMPLATE): "Be doubly strict with short clips
   (under ~15s) that are a single reaction" - that clause is a kill order
   for precisely the class humans clip on streams. The scout panel's
   unanimous RANK-1 pick (a pure rage scream, human-labeled) got 0.18.
3. **Merge leaves burst stubs** (candidates.ts mergeCandidates): merging
   only unions OVERLAPPING candidates, so a lone 1-node scanner hit ships as
   a 3.2s candidate (the ГОЛЫЙ КОРОЛЬ label) that no critic can save.
   Secondary: 4 of 11 labels were never candidated at all - the scanner
   prompt has the same story-arc bias.

## 1. Design: an explicit STREAM MODE, resolved once per job

**S1 - mode resolution (deterministic, no LLM).** New
`resolveAnalysisMode(sourceUrl, transcription): "standard" | "stream"`:
- sourceUrl host is twitch.tv (or clips.twitch.tv) -> stream;
- youtube.com/live/ path -> stream;
- else transcript-shape fallback: speech density (sum of segment spans /
  total duration) under STREAM_DENSITY_MAX (default 0.55) AND source longer
  than 20 min -> stream. Corpus facts: strogo 0.40, recrent 0.27; measure 2
  podcast fixtures from the existing eval corpus BEFORE fixing the default
  and record both numbers in the code comment.
Master flag ANALYZE_STREAM_MODE (exact literal "on", default off, dark
everywhere until .env enables). Mode lands in telemetry as
`analysisMode` (present only when the flag is on - not-a-key discipline).
stages/analyze.ts threads job.sourceUrl into AnalyzeV2Options (mirror of
sourceDurationSec). Eval scripts pass nothing -> standard mode -> corpus
byte-identical with the flag off AND on for non-stream inputs.

**S2 - stream critic rubric** (prompts.ts): CRITIC_PROMPT_TEMPLATE_STREAM,
same JSON contract, same node/boundary mechanics, same COLD VIEWER RULE for
narrative clips, but: reaction bursts are PRIME material - a scream, rage
break, absurd exchange or instant-karma beat is clipworthy when its TRIGGER
is inside or immediately before the burst (move start_node to include the
trigger); the "doubly strict under 15s" clause is REPLACED by "a 8-20s
reaction with its trigger inside is the ideal stream clip"; scoring anchors
on emotional amplitude and quotability, not story completeness.
criticSystemPrompt gains a mode parameter; critic.ts threads it.

**S3 - stream budget** (config + candidates.ts): in stream mode the
effective criticMaxCandidates = STREAM_CRITIC_MAX_CANDIDATES (default 80)
and perWindowMinCandidates drops to 1 - coverage guarantee stays, merit gets
the freed slots (global interest extras). Standard mode numbers untouched.

**S4 - burst expansion in merge** (candidates.ts): in stream mode, after the
existing merge, any candidate spanning under STREAM_MIN_CANDIDATE_SEC
(default 12) of node time expands symmetrically node-by-node (prefer
backward - the trigger lives before the burst) until it reaches the minimum
or hits a silence gap > 3s / another candidate. Standard mode untouched.

**S5 - scanner stream nudge** (prompts.ts): scanner system prompt gains a
mode-conditional paragraph naming reaction bursts, rage, screams, banter
exchanges and instant-karma beats as first-class candidates even without a
narrative arc. Same output contract.

## 2. Hard rules

- Flag off = byte-identical everywhere (prompts, budget, merge, telemetry).
- Standard mode with the flag ON = byte-identical too (mode gates
  everything; a podcast must resolve "standard" - detection test with real
  podcast fixture stats).
- No prisma/schema changes, no .env edits by implementers, no compose
  up/down. Tests inside worker-render. Mutation checks on: the exact-literal
  flag, the density threshold direction, the twitch-host rule, the under-min
  expansion trigger, the budget override.
- The existing analyze test suite and eval fixtures stay green unmodified.

## 3. Acceptance (the corpus is the judge)

Autopsy runs (.corpus/moment-selection/autopsy.ts, extended to accept a mode
override) on both transcripts, 2 runs per config to absorb scanner variance:
- Text-visible labels (strogo: m3wsu@1370s, осуждаю@6721s; recrent:
  НУ НЕЕЕЕЕАД@1389s) must reach SELECTED in at least 1 of 2 stream-mode
  runs each. Zero of them did in phase 1.
- NEVER_CANDIDATED count across the 11 labels must not exceed phase 1's 4.
- lost_to_budget must be 0 for scanner-found labels.
- Standard-mode runs on the same transcripts (flag on, mode forced standard)
  must match phase-1 behaviour class (0-2 of those labels selected).
- Report usage tokens per run - the stream-mode delta must stay under 2x.

## 4. Rollout

Corpus proof -> .env ANALYZE_STREAM_MODE=on -> worker-analyze recreate ->
watch the `analysisMode: "stream"` jobs' clip sets vs their sources' Twitch
clips. Real users submitting twitch links exist in the jobs table today.
