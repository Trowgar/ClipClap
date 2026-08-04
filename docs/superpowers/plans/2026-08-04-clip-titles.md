# Clip Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the engine describing a clip in its own caption, and stop it printing the payoff there.

**Architecture:** Two prompt edits and one deterministic gate. The critic is asked for a hook rather than a summary; the finalizer stops converting hooks into statements; and a code check refuses a title whose cited evidence lies in the clip's final third, because a title grounded in the payoff IS the payoff. No new stage, no new model call except the existing repair path.

**Tech Stack:** TypeScript, vitest, the eval fixture harness.

---

## Why this shape - read before starting

Source: [`docs/superpowers/specs/2026-08-04-clip-quality-programme-design.md`](../specs/2026-08-04-clip-quality-programme-design.md) §3.4, project 3.

**`title is a recap` appears in 11 of 11 editor verdicts** on the 2026-08-04 audit, and again in 11 of 11 on the re-judged set after end-extension. In six it also spoils: the caption states the payoff before playback. It is the only defect in the audit that is universal AND cheap.

**Two clips are one caption rewrite from publishable.** The editor's words on the extended set: for the eyelash-curler clip, "the in-point and the out-point are both right, replace the caption and this goes up"; for the pregnancy-test clip, "no cut to the video is required for this to reach publish". Nothing else in the programme buys two publishable clips with a text change.

**The prompt is not silent about this - it is contradictory.** `prompts.ts:133` asks the critic for a title that is "curiosity-driven but TRUTHFUL". Then the finalizer's rule 3 (`prompts.ts:251-259`) says a question title is valid ONLY when the answer is spoken inside the clip, and instructs: "Rewrite it as a truthful **statement** built from the clip's own words." A statement built from the clip's own words is a description of the clip. The finalizer is actively converting hooks into recaps, and it is doing exactly what it was told.

The honesty requirement inside that rule is correct and must survive: a title that promises what the clip does not deliver is the defect it was written for, and `engine-notes` §4 records the `Плюсы` incident that came from letting copy degrade unchecked. What has to go is the equation of "honest" with "descriptive".

**Why an evidence-node gate and not a word-overlap test.** `lexicalOverlap` is documented at its definition as telemetry and never a gate, because it penalises paraphrase and inflected languages - a Russian title would fail it for being well written. `titleEvidenceNodes` are indices, so the same check works in every language. A title whose evidence sits in the final third of the shipped range is quoting the payoff; a hook is grounded in the setup.

**Fixtures will move, and that is the review artefact.** Unlike end-extension, this changes what an existing stage is asked, so every recorded critic and finalizer answer is invalidated and all four fixtures must be re-recorded. The variant mechanism cannot help: `VARIANT_OVERRIDE_KEYS` admits WHO answers and WHICH stages run, never what a stage is asked, and that guard is right. The blessed snapshot carries `{range, score, title}` per clip, so **the snapshot diff is a side-by-side of every old title against its replacement** - which is precisely what a human should read here, and it needs no agent.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/worker/src/analyze-v2/prompts.ts` (modify) | The critic's title rule and the finalizer's rule 3. |
| `apps/worker/src/analyze-v2/gates.ts` (modify) | `titleSpoilsPayoff` - the deterministic check. |
| `apps/worker/src/analyze-v2/index.ts` (modify) | Call the gate after snap, count it, attempt one repair. |
| `apps/worker/src/__tests__/title-spoiler.test.ts` (create) | The gate. |
| `apps/worker/src/__tests__/prompts.test.ts` (modify) | The prompts say what the gate enforces. |

---

### Task 1: The spoiler gate

**Files:** modify `apps/worker/src/analyze-v2/gates.ts`, create `apps/worker/src/__tests__/title-spoiler.test.ts`

- [ ] **Step 1: Measure before choosing the threshold**

Do not take "final third" from this plan. Replay all four fixtures, and for every shipped clip compute where its `titleEvidenceNodes` sit as a fraction of `[finalStartNode, finalEndNode]`. Report the distribution. Then pick the boundary so that the titles the 2026-08-04 audit called spoilers are caught and the ones it did not are not - the audit named these as spoiling: the Pizza Hut basement caption, "Joey Heard 'No Strippers' and Ignored It", "The Eyelash Curler Was His", "The test result changes from negative to positive", "He Announces His Student Girlfriend-and Gets Fired", and "Spelling tips become a jab about Scrabble with Monica". Record the number and its derivation in the commit message.

If no threshold separates them, say so and stop - that is a finding, and it means the gate has to be built on something else.

- [ ] **Step 2: Write the failing test, then implement `titleSpoilsPayoff(clip, nodes, cfg)`**

Design the cases yourself. The plan's test sketches have been inadequate three times on the previous branch - four cases let 6 of 8 mutations through, ten let 19 of 29 through. Mutation-test the gate and report a full matrix. Cover at minimum: evidence entirely in the final third; evidence spanning the whole clip; evidence entirely in the opening; a single evidence node exactly on the boundary; an empty evidence list; evidence outside the range entirely (already impossible upstream, so decide and document whether this throws or refuses).

- [ ] **Step 3: Commit.**

---

### Task 2: The prompts

**Files:** modify `apps/worker/src/analyze-v2/prompts.ts`, modify `apps/worker/src/__tests__/prompts.test.ts`

- [ ] **Step 1: The critic's title rule.** Replace the current line 133-134 with a rule that asks for a hook and names the recap as the failure. It must say, in the file's own voice: the title's job is to make a stranger want to watch; it must be true to what the clip delivers; and **it must not state the payoff** - if the clip's best line can be read off the caption, the clip has nothing left to pay. Keep the 70-character bound and the no-clickbait rule.

- [ ] **Step 2: The finalizer's rule 3.** Keep every word of the honesty requirement - a title that promises what the speech never delivers is still the defect that rule exists for, and `unanswered_title` stays. Remove the instruction to rewrite as a "statement built from the clip's own words", and remove the blanket suspicion of question titles: a question whose answer IS inside the clip is a hook, not a promise broken. Add the same do-not-state-the-payoff rule so the two stages cannot disagree.

- [ ] **Step 3: Pin both in `prompts.test.ts`.** That file already keeps the finalizer's drop reasons in sync with its schema enum; follow the pattern. A test must fail if either prompt loses the payoff rule.

- [ ] **Step 4: Commit.**

---

### Task 3: Wire the gate, re-record, and read the diff

**Files:** modify `apps/worker/src/analyze-v2/index.ts`; re-record all four fixtures

- [ ] **Step 1: Call the gate after snap, next to the existing copy checks.**

A clip is **never dropped for its copy** (`engine-notes` §4, and the snippet-title incident that established it). So a spoiling title gets one repair attempt through the existing `repairCopy` path, and if the repair also spoils, the clip ships with the original title and a telemetry counter. Publish `titleSpoilers` and `titleSpoilersRepaired` alongside the existing copy counters.

- [ ] **Step 2: Re-record all four fixtures.**

```bash
docker compose exec -T worker-analyze sh -c \
  "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts <jobId> <case-name>"
```

Every critic and finalizer key is invalidated by the prompt change, so this is `eval-record`, not `eval-topup`. Note that re-recording re-runs the scanner at temperature 0.4, so the candidate set moves too and the diff mixes the prompt change with fresh sampling - say so when you report, and do not present a moved range as an effect of this work.

- [ ] **Step 3: Produce the title diff, old against new, for every clip on all four fixtures.**

This is the deliverable a human reads. One table: fixture, range, old title, new title. It needs no agent and no score.

- [ ] **Step 4: Report the gate's telemetry** - how many titles the gate caught, how many the repair fixed, how many shipped spoiling anyway.

- [ ] **Step 5: Bless the snapshots once the diff has been read, and commit.**

---

## Acceptance

**The six titles the audit named as spoilers must no longer state their payoff**, judged by reading them. Not a score - the editor already wrote replacements for all eleven clips, and the new titles can be read against those directly.

Zero clips may be dropped for a title. If `titleSpoilers` is non-zero and `titleSpoilersRepaired` is zero, the repair path is not working and that is a failure regardless of how the titles read.
