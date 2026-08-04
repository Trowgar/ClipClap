# Clip Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the engine describing a clip in its own caption, and stop it printing the payoff there.

**Architecture:** Two prompt edits that stop contradicting each other, then a re-record whose snapshot diff is a side-by-side of every old caption against its replacement. A deterministic backstop is wanted and is NOT yet designable - see the withdrawn task below - so it is deferred until the population of surviving defects is known.

**Tech Stack:** TypeScript, vitest, the eval fixture harness.

---

## Why this shape - read before starting

Source: [`docs/superpowers/specs/2026-08-04-clip-quality-programme-design.md`](../specs/2026-08-04-clip-quality-programme-design.md) §3.4, project 3.

**`title is a recap` appears in 11 of 11 editor verdicts** on the 2026-08-04 audit, and again in 11 of 11 on the re-judged set after end-extension. In six it also spoils: the caption states the payoff before playback. It is the only defect in the audit that is universal AND fixable in text.

**Two clips are one caption rewrite from publishable.** The editor's words on the extended set: for the eyelash-curler clip, "the in-point and the out-point are both right, replace the caption and this goes up"; for the pregnancy-test clip, "no cut to the video is required for this to reach publish".

**The prompt is not silent about this - it is contradictory, and that is the finding.** `prompts.ts:133` asks the critic for a title that is "curiosity-driven but TRUTHFUL". The finalizer's rule 3 (`prompts.ts:251-259`) then treats a question title as suspect and instructs: "Rewrite it as a truthful **statement** built from the clip's own words." A statement built from the clip's own words is a description of the clip. The finalizer converts hooks into recaps and does it correctly, because that is what it was told.

The honesty requirement inside that rule is correct and survives: a title promising what the speech never delivers is the defect it was written for, and `engine-notes` §4 records the `Плюсы` incident that came of letting copy degrade unchecked. What goes is the equation of "honest" with "descriptive".

**Fixtures will move, and that is the review artefact.** This changes what an existing stage is asked, so every recorded critic and finalizer answer is invalidated and all four fixtures must be re-recorded rather than topped up. The variant mechanism cannot absorb it and should not: `VARIANT_OVERRIDE_KEYS` admits WHO answers and WHICH stages run, never what a stage is asked. The blessed snapshot carries `{range, score, title}` per clip, so **the snapshot diff is a side-by-side of every old caption against its replacement** - the artefact a human should read here, needing no agent and no score.

---

## WITHDRAWN 2026-08-04: the spoiler gate on evidence position

This plan originally opened with a deterministic gate refusing any title whose `titleEvidenceNodes` sat in the clip's final third. **It cannot be built. Do not attempt it.**

Measured over all 106 shipped clips across the ten available (fixture, variant) pairs, evidence position does not separate a spoiling title from a clean one, and the failure is a proof rather than a bad threshold:

- **Identical position vectors, opposite labels.** "Spelling tips become a jab about Scrabble with Monica" (spoiler) and "They Beg Someone Not to Reveal Their Big News" (clean) each cite exactly two nodes: the first and the last of their own shipped range. Both are `[0, 1]`. No function of position can give them different verdicts, under any denominator, in seconds or in nodes.
- **A clean clip's evidence is strictly later than a spoiler's.** "The Eyelash Curler Was His" (spoiler) cites 0.333 and 0.5; "Joey Exposes the Secret Kissing" (clean) cites 0.8 and 1.0. Any rule monotone in lateness that catches the first must catch the second. Both inversions survive under the `end-extension` variant.

The most permissive threshold catching all six audit-named spoilers flags **11 of the 12** clips. Evidence position relative to `payoffNode` was measured too and overlaps fully.

**What the difference actually is**, read off the transcripts: whether the title RESTATES the payoff's content or merely REFERS to it. Node #663 is "playing Scrabble with Monica" and the title says "Scrabble with Monica" verbatim; node #626 is "Please just promise you won't tell" and the title says "Their Big News", a pointer to something the caption never states. Same shape, opposite copy.

**A correction to this plan that came out of the same measurement:** `evidenceGate` runs pre-snap against the critic's PROPOSED range, and `regroundCopy` tolerates `EVIDENCE_BOUNDARY_SLACK_NODES = 2` either side, so **3 of 106 shipped clips carry a title evidence node outside the shipped range**. Any future gate must treat that as a live case at ~3% of production, and must never divide by a span it assumes contains its inputs.

**Candidates for the eventual backstop, measured but not adopted.** Title against the LAST NODE's text only - not the whole clip - catches 3 of 6 spoilers at `lexicalOverlap >= 0.167` with **zero** false positives here: perfect precision, half recall, and still a word-overlap test, so the objection that killed the whole-clip version applies in full and it must be measured on the two Russian fixtures before anyone trusts it. The stronger option is to stop inferring altogether: have the critic emit the payoff's claim as a discrete field the title can be checked against. That is a schema change, not a threshold.

The backstop is deferred to its own project, to be designed against the defects that SURVIVE the prompt change rather than the ones the prompt change removes.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/worker/src/analyze-v2/prompts.ts` (modify) | The critic's title rule and the finalizer's rule 3. |
| `apps/worker/src/__tests__/prompts.test.ts` (modify) | Both prompts carry the rule; neither can lose it silently. |
| `apps/worker/src/__tests__/fixtures/eval/*` | Re-recorded; the snapshot diff is the deliverable. |

---

### Task 1: The prompts

**Files:** modify `apps/worker/src/analyze-v2/prompts.ts`, modify `apps/worker/src/__tests__/prompts.test.ts`

- [ ] **Step 1: The critic's title rule.**

Replace the current rule 6 (`prompts.ts:133-134`) with one that asks for a hook and names the recap as the failure. In the file's own voice it must say: the title's job is to make a stranger want to watch; it must be true to what the clip delivers; and **it must not state the payoff** - if the clip's best line can be read off the caption, the clip has nothing left to pay. Keep the 70-character bound and the no-clickbait rule.

Give it the worked contrast, because the distinction is the whole task and an abstract rule has already been measured firing zero times in this prompt (`engine-notes` §5a): a title may REFER to the payoff ("Their Big News") and must not RESTATE it ("Scrabble with Monica" when the punchline is "playing Scrabble with Monica").

- [ ] **Step 2: The finalizer's rule 3** (`prompts.ts:251-259`).

Keep every word of the honesty requirement, and keep `unanswered_title`. Remove the instruction to rewrite as a "statement built from the clip's own words", and remove the blanket suspicion of question titles - a question whose answer IS inside the clip is a hook, not a broken promise. Add the same do-not-restate-the-payoff rule so the two stages cannot disagree.

- [ ] **Step 3: Pin both in `prompts.test.ts`.**

That file already keeps the finalizer's drop reasons in sync with its schema enum - follow the pattern. A test must fail if either prompt loses the payoff rule. Mutation-test what you write: a test asserting a substring that appears anywhere in a 500-line prompt proves nothing, and the previous branch measured suites where 19 of 29 mutants survived.

- [ ] **Step 4: Commit.** Explanatory prose, house style.

---

### Task 2: Re-record and read the diff

- [ ] **Step 1: Re-record all four fixtures** with `eval-record.ts` - every critic and finalizer key is invalidated, so this is a record, not a topup. It costs real API calls; the last full topup was about $0.03, a full re-record will be more.

`eval-record` re-runs the scanner at temperature 0.4, so the candidate set moves too and the diff mixes the prompt change with fresh sampling. **Say so when reporting, and never present a moved range as an effect of this work.**

- [ ] **Step 2: Produce the title diff** - one table: fixture, range, old title, new title, for every clip on all four fixtures. This is the deliverable a human reads. No agent, no score.

- [ ] **Step 3: Bless the snapshots once the diff has been read**, and commit.

---

## Acceptance

**The six titles the audit named as spoilers must no longer state their payoff**, judged by reading them:

- "The bachelor party was in a Pizza Hut basement"
- "Joey Heard 'No Strippers' and Ignored It"
- "The Eyelash Curler Was His"
- "The test result changes from negative to positive"
- "He Announces His Student Girlfriend-and Gets Fired"
- "Spelling tips become a jab about Scrabble with Monica"

The working clipper's replacements are recorded in the audit and can be read alongside as a reference for what a hook looks like on the same material.

No clip may be dropped for its copy. That invariant predates this work (`engine-notes` §4) and nothing here may weaken it.
