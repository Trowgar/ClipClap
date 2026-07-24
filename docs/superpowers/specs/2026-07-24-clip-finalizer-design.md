# Clip Finalizer: Cross-Clip Dedup, Salvage and Final Verdict

**Date:** 2026-07-24
**Status:** Approved (2026-07-24) - ready for implementation plan
**Scope:** ANALYZE stage only (`apps/worker/src/analyze-v2/`). New FINALIZE step after selection, one new LLM call, deterministic dedup and surcharge backstops, config knobs, telemetry. No schema migration, no changes to RENDER or any consumer.

## 1. Problem

Real production output (job `cmrzcqhl6`, 5 clips from a 52-minute Russian podcast) exposed three defects the current engine cannot catch. Each maps to a structural blind spot, not to a tuning miss.

| Defect | Real example | Why the engine misses it |
|---|---|---|
| Question title with no answer inside the clip | Clip 2 "Человек - зло для планеты… или всё не так однозначно?" - 7.2s, hook spans the whole clip, payoff == end, the promised "не так однозначно" never arrives | The `endsOnQuestion` backstop only fires on a literal `?` ending the last SPOKEN sentence. Here the question lives in the TITLE. The clip paid only the short-clip surcharge (0.6 + 0.15 = 0.75) and its 0.86 cleared it |
| Duplicate clips | Clips 1 and 2 both open on the identical line "Человек - это зло для планеты Земля"; clips 3 and 4 argue the same thesis in different words | NMS in `select.ts` dedups by TIME OVERLAP only. The two windows are 1868s apart, so nothing collides. There is no lexical or semantic dedup anywhere |
| Meandering opening | Clip 5 "Бактерии едят пластик" - ~15s of tangent (evolution speed, urbanizing animal species) and crosstalk before the actual topic re-anchors | The critic judges the opening for the COLD VIEWER rule (does it point at invisible context) but not for "does the opening state what this clip is about" |

The common root cause: **the critic judges candidates in batches of 6, before snapping and before selection.** It never sees the final set. Any cross-clip judgment - dedup, set-level coherence - is architecturally impossible where it currently lives.

## 2. Fixed product decisions

Settled with the owner before design.

1. **Dedup is lexical AND semantic.** A deterministic hook-line comparison kills exact opening duplicates with no LLM involved; a judge over the final set catches paraphrase duplicates. The higher-scored clip always survives.
2. **Salvage before dropping.** A promise-style title is rewritten into a truthful statement; a meandering opening is trimmed forward to the topical sentence. A clip is dropped only when it cannot be repaired.
3. **The finalizer is a real final critic, not a dedup pass.** It receives the FULL speech of every final clip and judges each as a finished product: does it stand alone, is the payoff delivered, is the title honest. It may veto a clip the batch critic passed.
4. **Boundaries stay code-owned.** Every trim the model proposes is re-validated through `snapNodes`; a rejected trim leaves the original boundaries untouched. The model emits node indices only, never seconds - the engine's existing invariant.
5. **The finalizer never fails a job.** Any error, timeout, refusal or malformed output ships the selection as-is. Deterministic layers (hook dedup, surcharges) have already been applied in code and survive an LLM outage.
6. **Every LLM rule pairs with a code backstop** - the pattern established across this engine (short-clip surcharge, capitalization veto, clean-end guard, question-end surcharge).
7. **Out of scope:** re-scoring (score authority stays with the batch critic; the finalizer only vetoes), end-boundary trimming (payoff protection outranks tidiness), backfilling dropped clips with fresh candidates (headroom absorbs drops instead), cross-JOB dedup.

## 3. Architecture

```
critic (batches of 6, gpt-5.1)
  └─ evidence gate -> snapNodes -> eligible[]
        └─ selectAndOrder(limit = softCap + HEADROOM)     [CODE]
              ├─ tier thresholds + surcharges (short clip, ends-on-question,
              │    NEW: question-title teaser)
              └─ time-overlap NMS
        └─ FINALIZE                                        [NEW]
              ├─ 1. hook dedup            [CODE, pure]  exact/near-identical openings
              ├─ 2. finalizer call        [LLM, one call over the whole set]
              └─ 3. apply + validate      [CODE]  trims re-snapped, titles re-gated,
                                                  drops capped
        └─ slice(softCap) -> highlights
```

One LLM call per job, over at most `softCap + HEADROOM` (16) clips. The finalizer is the only component in the engine that sees the shipped set as a set.

## 4. Step details

### 4.1 Hook dedup (code, pure, runs first)

Normalize each clip's opening sentence: lowercase, strip punctuation and diacritics, collapse whitespace. Compare every pair by token Jaccard similarity. Similarity `>= HOOK_DEDUP_SIMILARITY` (default 0.8) marks the lower-scored clip as a duplicate and drops it before any LLM sees the set.

This alone resolves clips 1 and 2: identical opening line, clip 1 (0.9) survives, clip 2 (0.86) drops. It costs nothing, is fully unit-testable, and works when the LLM call fails.

### 4.2 The finalizer call (LLM, one call)

**Model:** `OPENAI_FINALIZER_MODEL`, default = the critic model (`gpt-5.1`). The task is evaluative judgment over full clip texts, so it gets the strong model; the same `CRITIC_MODEL_FALLBACK` chain applies on failure.

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

Every node of the clip is shown with its index; `¶` marks nodes that `isCleanStart` accepts as legal clip starts (the same marker the batch critic reads). Clips are capped at 90s by construction, so a full clip is roughly 30-40 nodes. Very long sets are bounded by the 16-clip input cap.

**Output** (strict `json_schema`, one entry per clip id, mirroring the scanner/critic pattern):

- `verdict`: `"ship" | "drop"`
- `drop_reason`: closed enum - `duplicate | unanswered_title | broken_opening | no_payoff | incoherent` (required when dropping, otherwise null)
- `duplicate_of`: another clip id or null
- `shared_claim`: one short phrase justifying a duplicate call, or null
- `title`: a rewritten title, or null to keep the original
- `title_evidence_nodes`: 1-3 node indices inside the clip carrying the words that support the rewritten title (required whenever `title` is non-null, else null)
- `trim_start_node`: a `¶` node index inside the clip, or null

**Prompt rules** (the LLM half of each pair):

1. *Set-level dedup:* "These clips ship together as one batch from one video. Would a viewer feel they watched the same thing twice? Judge the CLAIM, not the wording." Requires `shared_claim` on every duplicate call.
2. *Honest titles:* "A question title is valid only when the answer is spoken inside the clip. Otherwise rewrite it as a truthful statement grounded in the clip's own words, or drop it. Never promise what the clip does not deliver. Every rewrite must cite the node indices whose words support it."
3. *Topical opening:* "The first sentence must state what the clip is about. When a tangent or crosstalk precedes the real topic, move the start forward to the topical sentence - it must be a `¶` line and must stay before the payoff. The COLD VIEWER rule still applies: the new opening must not point at anything the clip never shows."
4. *Final verdict:* "Judge each clip as a finished product a stranger will watch standalone: does the hook land, is the payoff delivered inside the clip, is the title honest. Drop what does not work."

### 4.3 Apply and validate (code)

Every model output passes a deterministic gate before it can change anything:

| Model output | Validation | On failure |
|---|---|---|
| `trim_start_node` | Must be inside the clip, a `¶` clean start, strictly before `payoffNode`; the modified verdict is re-run through `snapNodes` (clean start, payoff containment, invariants, `hardMinSec`) | Keep the original boundaries |
| `title` rewrite | `<= 70` chars; `title_evidence_nodes` present, valid, and inside the clip's final `[startNode, endNode]` (re-checked with the same range rule `evidenceGate` applies, and re-checked AFTER any accepted trim); passes `scriptMismatch` against the clip's speech | Keep the original title |
| `duplicate_of` / `verdict: drop` | Resolved by score descending so the strongest clip of a duplicate group always survives; chains and cycles collapse to a single survivor; the total number of finalizer drops is capped at `floor(n / 2)` | Excess drops are ignored, lowest-confidence first, and counted in telemetry |
| Unknown clip id, missing entry | Ignored; a clip with no entry ships unchanged | - |

Trimming only ever moves the start forward, so a trimmed clip can never create a new NMS collision.

### 4.4 Question-title surcharge (code, in `select.ts`)

A deterministic backstop for the teaser shape, independent of the LLM. When a title is a question (terminal `?` / `？`) **and** the clip's payoff does not follow its hook (`payoffSec <= hookEndSec + EPS`, i.e. the hook spans the whole clip), the clip pays `QUESTION_TITLE_SCORE_BONUS` (default 0.15) on top of the tier threshold, exactly like the existing short-clip and ends-on-question surcharges, which stack.

Verified against the real case: clip 2 (0.86, 7.2s, payoff == hookEnd) faces `0.6 + 0.15 (short) + 0.15 (question title) = 0.9` and drops. A question-titled 60s clip whose payoff lands after the hook is untouched.

## 5. Configuration

| Env | Default | Meaning |
|---|---|---|
| `ANALYZE_FINALIZER` | `on` | `off` skips the LLM call; deterministic layers still run |
| `OPENAI_FINALIZER_MODEL` | value of `OPENAI_CRITIC_MODEL` | model for the finalizer call |
| `HOOK_DEDUP_SIMILARITY` | `0.8` | Jaccard floor for the deterministic opening-line dedup |
| `QUESTION_TITLE_SCORE_BONUS` | `0.15` | surcharge for a question title whose hook spans the clip |
| `FINALIZER_HEADROOM` | `4` | extra clips selection passes to the finalizer above `softCap` |

## 6. Failure handling

The finalizer is wrapped so no path can fail the job: LLM error, timeout, refusal, truncation, schema violation, or unparseable output all result in the pre-finalizer set shipping unchanged, with `finalizerSkipped: <reason>` in telemetry. The deterministic hook dedup and the surcharges run before and independently of the call, so an outage degrades quality gracefully rather than reverting all three fixes.

## 7. Telemetry

Added to the existing ANALYZE telemetry object: `hookDedupDrops`, `semanticDedupDrops` (each with `id`, `duplicateOf`, `shared_claim`), `finalizerDrops` (each with `id` and `drop_reason`), `titleRewrites` (before/after), `openingTrims` (nodes moved, and whether the re-snap accepted it), `trimRejected`, `rewriteRejected`, `dropCapHits`, `finalizerSkipped`.

This is the tuning surface: the owner reads it after each job to see what the finalizer decided and why.

## 8. Testing

**Unit (pure, vitest in the worker container):**
- Hook normalization and Jaccard similarity: identical openings, near-identical with punctuation and case differences, genuinely different openings, empty and single-word openings.
- Duplicate-graph resolution: pairs, chains (A dup B dup C), cycles, self-reference, unknown ids, drop cap enforcement.
- Question-title surcharge: teaser shape drops, question title with a real payoff after the hook ships, non-question titles unaffected.
- Trim validation: non-`¶` target rejected, target past the payoff rejected, target that makes the clip shorter than `hardMinSec` rejected via re-snap, valid trim accepted and boundaries updated.
- Title-rewrite validation: over-length rejected, missing or out-of-range evidence nodes rejected, evidence that falls outside the range only AFTER a trim rejected, wrong-script rejected, valid rewrite applied.
- Finalizer disabled and finalizer-failure paths: set ships unchanged, telemetry records the reason, hook dedup still applied.

**Regression fixtures** from job `cmrzcqhl6`, so these exact defects can never return silently:
- Clips 1 and 2 openings -> hook dedup keeps clip 1.
- Clip 2 shape (0.86, 7.2s, payoff == hookEnd, question title) -> surcharge drops it.
- Clip 5 opening nodes -> the trim target is a `¶` node before the payoff and survives re-snap.

**Integration:** a mocked-LLM run of `analyzeHighlightsV2` asserting the finalizer is wired, drops apply, and the cap is respected.

## 9. Rollout

1. Merge, restart `worker-analyze` (source is bind-mounted, tsx reloads).
2. Owner re-uploads the same podcast; compare against the five known clips: clip 2 gone, clip 5 opening tightened, clips 3 and 4 arbitrated by the judge with a logged justification.
3. Read `semanticDedupDrops` and `finalizerDrops` in telemetry for the first jobs; tune `HOOK_DEDUP_SIMILARITY` and the drop cap if the judge over-reaches.
4. Kill switch: `ANALYZE_FINALIZER=off` restores the current behavior minus nothing but the LLM pass.

## 10. Rejected alternatives

- **Fix inside the batch critic** (bigger batches, dedup rules in the critic prompt): the critic runs before snapping and selection and sees 6 candidates at a time, so the final set is unknowable there. Growing the batch to 40 raises cost and truncation risk without solving the ordering problem.
- **Pure deterministic, no LLM:** catches the identical-hook duplicate but not paraphrase duplicates (clips 3 and 4), and cannot judge whether an opening states the clip's topic. The owner explicitly chose semantic dedup.
- **Re-scoring in the finalizer:** would put score authority in a second model and destabilize the tier thresholds. The finalizer vetoes instead.
- **End-boundary trimming:** the engine already protects the payoff with clean-end and payoff-chasing logic; letting a second model move the end risks cutting delivered payoffs for cosmetic tidiness.
- **Backfilling dropped clips** with the next-best eligible candidates: needs a second LLM round to finalize the newcomers. Selection headroom achieves the same result in one call.
