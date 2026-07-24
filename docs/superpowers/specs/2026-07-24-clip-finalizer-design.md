# Clip Finalizer + Regression Harness

**Date:** 2026-07-24
**Status:** Approved (2026-07-24) - ready for implementation plan
**Scope:** ANALYZE stage only (`apps/worker/src/analyze-v2/`). A replay-based regression harness, a deterministic teaser-montage filter, and a new FINALIZE step (one LLM call) that dedups, salvages and vetoes clips as a set. No schema migration; no changes to RENDER or any consumer.

## 1. Problem

Real production output (job `cmrzcqhl6`, 5 clips from a 52-minute Russian podcast) exposed defects the engine cannot catch. Each maps to a structural blind spot, not to a tuning miss.

| Defect | Real example | Why the engine misses it |
|---|---|---|
| Question title with no answer inside the clip | Clip 2 "Человек - зло для планеты… или всё не так однозначно?" - 7.2s, hook spans the whole clip, payoff == end, the promised "не так однозначно" never arrives | The `endsOnQuestion` backstop only fires on a literal `?` ending the last SPOKEN sentence. Here the question lives in the TITLE. The clip paid only the short-clip surcharge (0.6 + 0.15 = 0.75) and its 0.86 cleared it |
| Duplicate clips | Clips 1 and 2 both open on the identical line "Человек - это зло для планеты Земля"; clips 3 and 4 argue the same thesis in different words | NMS in `select.ts` dedups by TIME OVERLAP only. The two windows are 1868s apart, so nothing collides. There is no lexical or semantic dedup anywhere |
| Meandering opening | Clip 5 "Бактерии едят пластик" - ~15s of tangent (evolution speed, urbanizing animal species) and crosstalk before the actual topic re-anchors | The critic checks the opening for the COLD VIEWER rule (does it point at invisible context) but never asks whether the opening states what the clip is about |

The common root cause for dedup: **the critic judges candidates in batches of 6, before snapping and before selection.** It never sees the final set, so any cross-clip judgment is architecturally impossible where it currently lives.

### 1.1 The intro montage - the deeper root cause behind clip 2

Interviews and podcasts routinely open with a **teaser montage**: bait phrases lifted from later in the conversation, spliced together, each deliberately truncated by the source editor. Clip 2 is exactly that - a 7.2s fragment from the video's first seconds whose opening line reappears verbatim at 1868s, where the thought is actually completed. This one fact explains both symptoms at once: the "duplicate" (the montage quotes the real moment) and the "half-thought" (the editor cut it mid-argument).

The engine cannot currently see this. Its boundary machinery reasons about sentence edges in the transcript, but a montage cut is a cut in the SOURCE AUDIO - Whisper transcribes a truncated thought as a perfectly well-formed sentence, so every clean-start and clean-end guard passes. Worse, stratified selection guarantees `perWindowMinCandidates` candidates from the first window, so a montage intro is *guaranteed* to spend candidate slots on bait fragments and crowd out real moments.

The signal that does work is deterministic and specific: **teaser text recurs later in the same transcript.** The montage is a copy, so its sentences appear twice - once truncated at the start, once complete later.

### 1.2 Repetition inside one clip

Preventive rather than diagnosed: the speaker states a thought, then restates it in different words, and the clip drags. No component reads a finished clip end to end today, so nothing looks for it. The finalizer will, so the check costs nothing extra.

### 1.3 No regression net

Three rounds of engine fixes have shipped on real-upload feedback. Every fix is a prompt rule plus a code backstop, and the code backstops have unit tests - but nothing tests the SYSTEM: whether the clips that used to ship still ship. This spec adds five new ways to reject a clip, which is precisely when a regression net stops being optional.

## 2. Fixed product decisions

Settled with the owner before design.

1. **Regression harness first.** The harness is built and green BEFORE any finalizer code lands, so every later change is measured against a known-good baseline.
2. **Dedup is lexical AND semantic.** A deterministic hook-line comparison kills exact opening duplicates with no LLM involved; a judge over the final set catches paraphrase duplicates. The higher-scored clip always survives.
3. **Salvage before dropping.** A promise-style title is rewritten into a truthful statement; a meandering opening is trimmed forward to the topical sentence. A clip is dropped only when it cannot be repaired.
4. **The finalizer is a real final critic, not a dedup pass.** It receives the FULL speech of every final clip and judges each as a finished product: does it stand alone, is the payoff delivered, is the title honest, does it repeat itself. It may veto a clip the batch critic passed.
5. **Teaser fragments are filtered before the critic**, not after: they waste critic budget and steal first-window candidate quota from real moments.
6. **Boundaries stay code-owned.** Every trim the model proposes is re-validated through `snapNodes`; a rejected trim leaves the original boundaries untouched. Models emit node indices only, never seconds - the engine's existing invariant.
7. **The finalizer never fails a job.** Any error, timeout, refusal or malformed output ships the selection as-is. Deterministic layers (teaser filter, hook dedup, surcharges) have already run in code and survive an LLM outage.
8. **Every LLM rule pairs with a code backstop** - the pattern established across this engine.
9. **Out of scope:** re-scoring (score authority stays with the batch critic; the finalizer only vetoes), end-boundary trimming (payoff protection outranks tidiness), backfilling dropped clips with fresh candidates (selection headroom absorbs drops instead), cross-job dedup, automated scoring of clip "quality" against a human rubric.

## 3. Architecture

```
transcript -> sentence graph -> scanner -> merge
  └─ TEASER FILTER            [NEW, CODE, pure]  drop montage-recurrence candidates
  └─ stratified select -> critic (batches of 6, gpt-5.1)
        └─ evidence gate -> snapNodes -> eligible[]
              └─ selectAndOrder(limit = softCap + HEADROOM)      [CODE]
                    ├─ tier thresholds + surcharges (short clip, ends-on-question,
                    │    NEW: question-title teaser shape)
                    └─ time-overlap NMS
              └─ FINALIZE                                         [NEW]
                    ├─ 1. hook dedup        [CODE, pure]  identical openings
                    ├─ 2. finalizer call    [LLM, ONE call over the whole set]
                    └─ 3. apply + validate  [CODE]  trims re-snapped, titles
                                                    re-grounded, drops capped
              └─ slice(softCap) -> highlights
```

One extra LLM call per job, over at most `softCap + HEADROOM` (16) clips. The finalizer is the only component in the engine that sees the shipped set as a set.

## 4. Step details

### 4.1 Teaser-montage filter (code, pure, before the critic)

For every merged candidate whose start lies within `TEASER_WINDOW_SEC` (default 120) of the source start, normalize its node texts (lowercase, strip punctuation, collapse whitespace) into token 5-grams and test how many recur **later than the candidate's own end** in the same transcript. When the recurring share reaches `TEASER_RECURRENCE_FRAC` (default 0.5), the candidate is a montage copy: drop it and let the later, complete occurrence compete on its own merits.

Two properties make this safe. It is *specific*: only the video's opening minutes are examined, and only against later text, so a normal intro that merely shares vocabulary with the body does not trip it - the montage matches because it is literally the same sentences. It is *conservative*: dropping a montage fragment never loses content, because by construction the same words exist later in full.

The LLM half of this pair lives in the finalizer prompt (rule 5 below) as a safety net for montages the recurrence test misses - for example a teaser whose later occurrence was re-recorded rather than copied.

### 4.2 Hook dedup (code, pure, first step of FINALIZE)

Normalize each clip's opening sentence and compare every pair by token Jaccard similarity. Similarity at or above `HOOK_DEDUP_SIMILARITY` (default 0.8) marks the lower-scored clip a duplicate and drops it before any LLM sees the set. Costs nothing, fully unit-testable, and still works when the finalizer call fails.

### 4.3 The finalizer call (LLM, one call)

**Model:** `OPENAI_FINALIZER_MODEL`, default = the critic model (`gpt-5.1`), with the existing `CRITIC_MODEL_FALLBACK` chain. The task is evaluative judgment over full clip texts, so it gets the strong model.

**Input** - for each surviving clip, compact but complete:

```
CLIP c3 | score 0.68 | 42s
title: Бактерии уже научились есть пластик - решит ли это проблему
description: Биолог объясняет, как эволюция поддерживает бактерии...
speech:
¶ #412 [557.0s] Например появляются бактерии которые питаются пластиком
  #413 [559.4s] В дикой природе действительно из-за быстрого изменения условий...
¶ #414 [566.1s] Вот вы упоминали про бактерии которые научились питаться пластиком
  ...
```

Every node of the clip is shown with its index; `¶` marks nodes `isCleanStart` accepts as legal clip starts - the same marker the batch critic reads. Clips are capped at 90s by construction, so a full clip is roughly 30-40 nodes.

**Output** (strict `json_schema`, one entry per clip id, mirroring the scanner/critic pattern):

- `verdict`: `"ship" | "drop"`
- `drop_reason`: closed enum - `duplicate | unanswered_title | broken_opening | no_payoff | redundant | teaser_montage | incoherent` (required when dropping, else null)
- `duplicate_of`: another clip id, or null
- `shared_claim`: one short phrase justifying a duplicate call, or null
- `title`: a rewritten title, or null to keep the original
- `title_evidence_nodes`: 1-3 node indices inside the clip supporting the rewritten title (required whenever `title` is non-null)
- `trim_start_node`: a `¶` node index inside the clip, or null

**Prompt rules** (the LLM half of each pair):

1. *Set-level dedup:* "These clips ship together as one batch from one video. Would a viewer feel they watched the same thing twice? Judge the CLAIM, not the wording." Requires `shared_claim` on every duplicate call.
2. *Honest titles:* "A question title is valid only when the answer is spoken inside the clip. Otherwise rewrite it as a truthful statement grounded in the clip's own words, or drop it. Never promise what the clip does not deliver. Every rewrite must cite the node indices whose words support it."
3. *Topical opening:* "The first sentence must state what the clip is about. When a tangent or crosstalk precedes the real topic, move the start forward to the topical sentence - it must be a `¶` line and must stay before the payoff. The COLD VIEWER rule still applies: the new opening must not point at anything the clip never shows."
4. *No repetition inside a clip:* "If the clip states one thought and then restates it in different words with no new information, it drags. Prefer trimming the start to the sharpest formulation; drop as `redundant` only when the whole clip circles one point. Natural emphasis, a rhetorical echo, or a restatement that ADDS a new angle is not repetition - do not punish it."
5. *Teaser montage:* "Interviews often open with a montage of bait phrases cut from later in the conversation. They are truncated by the source editor: half-thoughts with no setup and no payoff. Drop them as `teaser_montage` - the complete moment lives later in the video."
6. *Final verdict:* "Judge each clip as a finished product a stranger will watch standalone: does the hook land, is the payoff delivered inside the clip, is the title honest. Drop what does not work."

### 4.4 Apply and validate (code)

Every model output passes a deterministic gate before it can change anything:

| Model output | Validation | On failure |
|---|---|---|
| `trim_start_node` | Inside the clip, a `¶` clean start, strictly before `payoffNode`; the modified verdict is re-run through `snapNodes` (clean start, payoff containment, invariants, `hardMinSec`) | Keep the original boundaries |
| `title` rewrite | `<= 70` chars; `title_evidence_nodes` present, valid, and inside the clip's final `[startNode, endNode]` - re-checked with the same range rule `evidenceGate` applies, and re-checked AFTER any accepted trim; passes `scriptMismatch` against the clip's speech | Keep the original title |
| `duplicate_of` / `verdict: drop` | Resolved by score descending so the strongest clip of a duplicate group always survives; chains and cycles collapse to a single survivor; total finalizer drops capped at `floor(n / 2)` | Drops are applied in ascending clip score (weakest first) until the cap is reached; every further drop is ignored and counted as `dropCapHits` |
| Unknown clip id, missing entry | Ignored; a clip with no entry ships unchanged | - |

Trimming only ever moves the start forward, so a trimmed clip can never create a new NMS collision.

### 4.5 Question-title surcharge (code, in `select.ts`)

A deterministic backstop for the teaser shape, independent of the LLM. When a title is a question (terminal `?` / `？`) **and** the payoff does not follow the hook (`payoffSec <= hookEndSec + EPS` - the hook spans the whole clip), the clip pays `QUESTION_TITLE_SCORE_BONUS` (default 0.15) on top of the tier threshold, exactly like the existing short-clip and ends-on-question surcharges, which stack.

Verified against the real case: clip 2 (0.86, 7.2s, payoff == hookEnd) faces `0.6 + 0.15 (short) + 0.15 (question title) = 0.9` and drops. A question-titled 60s clip whose payoff lands after the hook is untouched.

## 5. Regression harness

The harness answers one question: **did this change alter which clips ship, and how?**

### 5.1 Replay fixtures - the core idea

The engine's non-determinism lives entirely in two LLM calls. Record them once, and everything downstream becomes a pure function that can be tested exactly.

A fixture is a directory under `apps/worker/src/__tests__/fixtures/eval/<case-name>/`:

- `transcript.json` - a real Whisper `TranscriptionResult` from one of the owner's jobs
- `scanner.json` - the recorded scanner response for that transcript
- `critic.json` - the recorded critic responses (all batches)
- `finalizer.json` - the recorded finalizer response (added with this feature)
- `expected.json` - the assertions for this case (below)

Replay runs `analyzeHighlightsV2` with a stub OpenAI client that returns the recorded responses in order, so a full engine run costs zero API calls and milliseconds of wall clock. Every deterministic layer - sentence graph, teaser filter, merge, gates, snap, surcharges, dedup, finalizer application, NMS, cap - is exercised for real.

### 5.2 What `expected.json` asserts

Two tiers, deliberately different in strictness:

**Tier 1, named regressions ("never again").** Each is one specific defect the owner found in a real clip, expressed as a hard assertion that fails loudly if the behavior returns:

| Case | Assertion |
|---|---|
| anaphora start ("вот эта ссанина") | no shipped clip starts at that node |
| mid-word start ("глаза на все её хотелки") | no shipped clip starts at that node |
| mid-clause end ("...искала ты его потому,") | no shipped clip ends at that node |
| answer completeness ("Главные разрушители планеты?") | a shipped clip covers the question AND its answer (end >= the answer node) |
| teaser montage (clip 2 of job `cmrzcqhl6`) | no shipped clip starts inside the montage window |
| duplicate hook (clips 1 and 2) | exactly one clip opens on that line, and it is the higher-scored one |
| meandering opening (clip 5) | the shipped clip's start is at or after the topical node |

**Tier 2, the shape snapshot.** For each fixture, a recorded summary: clip count, each clip's `[start, end]` rounded to 0.1s, score, tier, and the drop-reason histogram. A change that shifts any of these fails the test with a readable diff. The snapshot is not a correctness claim - it is a *change detector*. Updating it is a deliberate, reviewed act (`npm run eval:bless`), and the diff is what the reviewer reads: "this fix removed the teaser clip and left the other four untouched" is a good diff; "this fix silently moved three unrelated clip boundaries" is not.

### 5.3 Recording fixtures

A script `apps/worker/src/scripts/eval-record.ts <jobId> <case-name>` pulls a real job's transcript from the database, runs the engine once against the live API, and writes the fixture directory including the recorded LLM responses and a freshly blessed snapshot. Recording is a manual, occasional act; replay is what runs in the test suite.

### 5.4 What the harness does NOT do

It does not judge whether a clip is *good* - only whether the engine's behavior changed. Taste stays with the owner. When a prompt is edited, replay still uses the OLD recorded LLM responses, so it verifies that deterministic layers did not regress; the prompt's real effect is judged by re-recording the fixture and reading the diff, or by a live upload. This limitation is the price of a free, fast, deterministic suite, and it is stated here so nobody mistakes a green run for "quality is fine".

### 5.5 Production watch

The existing ANALYZE telemetry already records per-job counts and drop reasons. A small query script `eval-telemetry.ts` summarizes the last N jobs: mean clips per job, tier distribution, and a drop-reason histogram (including the new finalizer reasons). A sudden shift - say `teaser_montage` firing on a third of all clips - is the signal to look, and it is the only mechanism here that sees real traffic rather than frozen fixtures.

## 6. Configuration

| Env | Default | Meaning |
|---|---|---|
| `ANALYZE_FINALIZER` | `on` | `off` skips the LLM call; deterministic layers still run |
| `OPENAI_FINALIZER_MODEL` | value of `OPENAI_CRITIC_MODEL` | model for the finalizer call |
| `HOOK_DEDUP_SIMILARITY` | `0.8` | Jaccard floor for deterministic opening-line dedup |
| `QUESTION_TITLE_SCORE_BONUS` | `0.15` | surcharge for a question title whose hook spans the clip |
| `FINALIZER_HEADROOM` | `4` | extra clips selection passes to the finalizer above `softCap` |
| `TEASER_WINDOW_SEC` | `120` | only candidates starting inside this prefix are recurrence-tested |
| `TEASER_RECURRENCE_FRAC` | `0.5` | share of a candidate's 5-grams that must recur later to call it a montage |

## 7. Failure handling

The finalizer is wrapped so no path can fail the job: LLM error, timeout, refusal, truncation, schema violation, or unparseable output all ship the pre-finalizer set unchanged with `finalizerSkipped: <reason>` in telemetry. The teaser filter, hook dedup and surcharges run before and independently of the call, so an outage degrades quality gracefully rather than reverting every fix at once.

## 8. Telemetry

Added to the existing ANALYZE telemetry object: `teaserDrops` (candidate ids and recurrence fraction), `hookDedupDrops`, `semanticDedupDrops` (each with `id`, `duplicateOf`, `shared_claim`), `finalizerDrops` (each with `id` and `drop_reason`), `titleRewrites` (before/after), `openingTrims` (nodes moved, and whether the re-snap accepted), `trimRejected`, `rewriteRejected`, `dropCapHits`, `finalizerSkipped`.

This is the tuning surface: the owner reads it after each job to see what the finalizer decided and why.

## 9. Testing

**Harness (built first, per decision 2.1):** replay infrastructure, the stub client, at least two recorded fixtures from the owner's jobs (`cmrzcqhl6` and the earlier podcast carrying the answer-completeness case), Tier-1 assertions for the seven named regressions, Tier-2 snapshots, and the bless script. The harness must be green on the CURRENT engine before finalizer code lands - that is what makes it a baseline.

**Unit (pure, vitest in the worker container):**
- Teaser filter: montage copy detected, normal intro not flagged, candidate outside the window skipped, recurrence measured only against text after the candidate's end, threshold boundary behavior.
- Hook normalization and Jaccard: identical openings, punctuation/case variants, genuinely different openings, empty and single-word openings.
- Duplicate-graph resolution: pairs, chains (A dup B dup C), cycles, self-reference, unknown ids, drop-cap enforcement.
- Question-title surcharge: teaser shape drops, question title with a real payoff after the hook ships, non-question titles unaffected.
- Trim validation: non-`¶` target rejected, target past the payoff rejected, target that shortens the clip below `hardMinSec` rejected via re-snap, valid trim accepted.
- Title-rewrite validation: over-length rejected, missing or out-of-range evidence rejected, evidence that leaves the range only AFTER a trim rejected, wrong-script rejected, valid rewrite applied.
- Finalizer disabled and finalizer-failure paths: set ships unchanged, telemetry records the reason, deterministic layers still applied.

## 10. Rollout

1. Land the harness, green against the current engine. This is the baseline commit.
2. Land the teaser filter, finalizer and surcharge. Replay diffs must show exactly the intended changes on the fixtures - a clean diff is the merge gate.
3. Restart `worker-analyze` (source is bind-mounted, tsx reloads).
4. Owner re-uploads the same podcast; compare against the five known clips: clip 2 gone as a teaser, clip 5 opening tightened, clips 3 and 4 arbitrated by the judge with a logged justification.
5. Read `teaserDrops`, `semanticDedupDrops` and `finalizerDrops` for the first jobs; tune thresholds if the judge over-reaches.
6. Kill switch: `ANALYZE_FINALIZER=off` disables the LLM pass; `TEASER_RECURRENCE_FRAC=2` disables the teaser filter without a deploy.

## 11. Rejected alternatives

- **Fix inside the batch critic** (bigger batches, dedup rules in the critic prompt): the critic runs before snapping and selection and sees 6 candidates at a time, so the final set is unknowable there. Growing the batch to 40 raises cost and truncation risk without solving the ordering problem.
- **Pure deterministic dedup, no LLM:** catches the identical-hook duplicate but not paraphrase duplicates (clips 3 and 4), and cannot judge whether an opening states the clip's topic.
- **Position-only teaser rule** (drop everything in the first 60-90s): would kill genuine cold opens where a video starts straight into its strongest moment. Recurrence is the signal that actually identifies a montage.
- **Re-scoring in the finalizer:** would put score authority in a second model and destabilize the tier thresholds. The finalizer vetoes instead.
- **End-boundary trimming:** the engine already protects the payoff with clean-end and payoff-chasing logic; letting a second model move the end risks cutting delivered payoffs for cosmetic tidiness.
- **Backfilling dropped clips** with the next-best eligible candidates: needs a second LLM round to finalize the newcomers. Selection headroom achieves the same in one call.
- **Live-API eval suite in CI:** non-deterministic, slow, and costs money per run; it would be flaky enough to be ignored within a week. Recorded replay plus a manual re-record ritual gets the regression safety without the flakiness.
