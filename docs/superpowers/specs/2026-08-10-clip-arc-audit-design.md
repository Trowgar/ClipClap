# Clip arc audit: entries, exits and self-containment (design)

2026-08-10. Motivated by the owner's verdict on job `cmsnmcbec005ouhfj30l0w4qm` ("Вся правда о
ядерном оружии", 48 min ru podcast, 12 clips, critic gpt-5.6-luna): clips open mid-story without
context and end mid-thought. This document is a DESIGN and a set of implementation task specs for
executor agents. It follows the rules of `docs/engine-notes.md`: every number below is a
measurement or is marked believed; every LLM rule gets a deterministic backstop; boundary changes
are judged on the SHIPPED SET, never on the boundary alone.

---

## 0. The motivating corpus, measured

Job `cmsnmcbec005ouhfj30l0w4qm`, 2026-08-10, `RECALL_CRITIC`, critic `gpt-5.6-luna`, 12 clips.
The owner named the defects by eye; the stored `subtitleTrack` cues confirm each one in text.
First and last cues, read from the DB (not from memory):

| clip | score | opens on | ends on | defect class |
|---|---|---|---|---|
| Что увидела мать после возвращения дочери? | **0.90** | "Он ехал на велосипеде Увидел яркую вспышку" | "...комок кожи с кровью Ну вот так это все было" | orphaned premise: title is about the GIRL's story, opening is the BOY's; the girl's setup sits before the clip |
| Миллиарды погибнут не там, где упадёт бомба | 0.84 | "**Это** миллиарды вот тут я то так скажу" | (closes) | dangling anaphora: "Это" has no antecedent inside |
| Правда ли, что водка спасает от радиации? | 0.81 | (clean question) | "Поэтому давайте водку мы сразу отложим" | exit on a TRANSITION: grammatically complete, discursively a setup - the speaker is about to deliver the actual point |
| Что на самом деле происходит с человеком после облучения | 0.78 | "**И** можно ли **ее** избежать" | (weak) | dangling anaphora + coordinating conjunction in onset |
| Что такое ядерная зима и как она возникает | 0.72 | "**И** проверять **это** на практике" | "...чтобы корректно быть" | same, both ends |
| Как понять, можно ли есть продукты после радиации | 0.69 | "Республика Беларусь пострадала..." | "или нет Вот сейчас такие..." | exit mid-enumeration |

Five of twelve clips open on a coordinating connective or an unresolved anaphor. The two facts
that make this corpus worth recording as a fixture:

- **The top-scored clip (0.90) is the most broken one.** Same as §5b of engine-notes (the 2-of-8
  job): the critic's score does not rank postability. Two jobs, two judges (gpt-5.1 then Luna),
  same shape.
- **The engine's own artifacts already contain the missing context.** The 0.90 clip ships
  `_startNode: 740` while its `_descriptionEvidenceNodes` include **738** - the critic cited the
  girl's setup two nodes BEFORE its own start, and its description honestly narrates both stories
  ("мальчика спасла бетонная труба, а маленькая девочка вернулась к матери..."). The model knew
  the arc; the boundary cut it. Likewise the vodka clip's `payoffAt` (1995.56) sits ON its last
  line - the critic called a transition sentence a payoff. Detection quality, not visibility, is
  the defect.

---

## 1. What is already true (verified in code, 2026-08-10)

The hypothesis "the critic never sees the final clip transcript" is **false**, and the design
below depends on the exact way it is false.

**Who sees what:**

- The **critic** (`prompts.ts:184-206`) sees each candidate inside a padded window -
  `CONTEXT_BEFORE = 16`, `CONTEXT_AFTER = 20` nodes - and is told the padding exists "so you can
  FIX boundaries, not so you can understand the clip". It returns node indices, `self_contained`,
  hook/payoff nodes, title/description with evidence node citations.
- The **finalizer** (`prompts.ts:369-402`) sees EXACTLY the clip's post-snap range, no padding,
  "the judge must see what the viewer sees" - i.e. the layer the hypothesis asks for exists.
  Its rules 4 (`no_payoff` - ends on a setup) and 5 (`broken_opening` - opens on a reply to an
  unseen question) name precisely the owner's two complaints.

**Why it fails anyway - three gaps:**

1. **Detection reliability at batch scale.** The finalizer is ONE call over up to 16 clips
   (`softCap 12 + finalizerHeadroom 4`) at `reasoning_effort: low`. Measured (engine-notes §5a,
   on gpt-5.1): rule 5 fired **zero** times across both fixtures including on a clip with exactly
   that defect; rule 4 is "roughly a coin flip" - the same malaria moment dropped in one fixture,
   shipped in the other. Nothing about the Luna swap re-measured this; Luna vetoes MORE (3 vs 0 on
   ecology) but nobody has checked what it vetoes for.
2. **The repair verbs point the wrong way.** For a bad opening the only verbs are trim FORWARD
   (`trim_start_node`) or drop - but the missing premise lives BEHIND the start. The only things
   that ever move a start backward are `widenRangeToEvidence` (2 nodes, pre-snap) and snap's
   clean-start walk-back (6s, fires only when the start is grammatically dirty - "Он ехал на
   велосипеде" is pristine). For a bad ending the finalizer may not move the end at all, so `drop`
   is the only verb; `extendClipEnds` exists but ships OFF, runs BEFORE the judge (so it never
   hears the judge's opinion), and self-motivates its proposals (its honest-miss case in
   engine-notes §3: the model "looked at a legal answer and preferred its own").
3. **No telemetry names the defect.** Nothing counts "shipped with a dangling opening" or
   "shipped ending on a setup". The owner is the detector of record, at one job per discovery.

**Load-bearing order that any change must respect** (engine-notes §2): extension may only WIDEN,
the finalizer may only SHORTEN, and the shortener gets the last word on a boundary. Models emit
node indices only; every moved boundary re-runs `snapNodes`.

---

## 2. Design position

Do NOT add another whole-set judge, and do NOT try to fix this with deterministic text gates.
Both are measured dead ends: the finalizer is already the whole-set judge and its per-clip
attention is the thing that fails; deterministic discourse signals have died twice (the anaphora
rule, reverted same day, engine-notes §3; "hook geometry is critic variance, not signal").
The exception that works is `looksLikeQuestion` (onset-position test after particle skipping) -
narrow, mechanical, measured.

Instead: a **per-clip ARC AUDIT stage** plus **two widen-only repair verbs**, all code-gated.

```
selectAndOrder
  -> arcAudit          NEW  per-clip LLM verdicts: entry / exit / self-containment,
                            with fix pointers that may lie OUTSIDE the clip
  -> extendClipStarts  NEW  widen start BACKWARD only, gated, fed by arcAudit entry flags
  -> extendClipEnds    EXISTING, now fed exit flags as hints (stays a separate stage)
  -> finalizeClips     UNCHANGED - still the last word on boundaries (may trim what
                            the extensions widened; may drop what audit could not repair)
```

Why this shape:

- **Per-clip, tiny batches (2-4), three questions only.** The measured failure mode of the
  finalizer is thin attention across 9 rules x 16 clips. The audit asks 3 questions about 1-4
  clips per call. Cost is bounded and measured before shipping (task 2).
- **The audit sees BOTH texts, clearly separated:** the clip exactly as the viewer hears it
  (finalizer-style, no padding), then labeled `CONTEXT BEFORE` / `CONTEXT AFTER` windows
  (critic-style padding) marked "the viewer never sees this; use it only to say whether the clip
  stands alone and where the missing piece lives". This is the one place both views exist at once,
  which is exactly what neither the critic (padded, judges self-containment while knowing the
  context) nor the finalizer (unpadded, cannot point outside) can do today.
- **Repairs are widen-only and run before the finalizer**, preserving the widen-then-shorten
  order. A start widened to include the girl's setup can still be trimmed back by the finalizer
  if it judges the wider opening worse - the dueling structure the engine already uses.
- **Every pointer is code-gated**: clean-start/clean-end (including the opaque-node sentence-close
  rule from engine-notes §3), window bounds, `maxSec`, teaser region, scene gap, re-snap. A model
  answer that fails a gate becomes telemetry, never a boundary.

### 2a. The audit schema (contract for the model)

Strict json_schema, one row per clip id, following `CRITIC_SCHEMA` conventions (indices, never
timestamps):

```
{
  id: string,
  entry:   { ok: boolean,
             defect: "dangling_reference" | "mid_story" | "borrowed_answer" | "meta_opening" | null,
             fix_start_node: int | null },   // may be BEFORE the current start
  exit:    { ok: boolean,
             defect: "mid_thought" | "setup_no_payoff" | "transition_out" | "refuted_after" | null,
             fix_end_node: int | null },     // may be AFTER the current end
  standalone: { ok: boolean, missing: string | null }  // one phrase naming what a cold viewer lacks
}
```

Mapping to the owner's language: `entry.ok` = "начало даёт понятный хук/контекст";
`exit.ok` = "мысль закрыта"; `standalone.ok` = "понятно, о чём это вообще".
Mapping to the defect vocabulary of engine-notes §5b: orphaned cause / orphaned premise ->
`entry`, refuted conclusion / cut inside an anaphoric run -> `exit`, drag and arc stacking are
deliberately OUT OF SCOPE here (no mechanism measures them; separate programme item).

### 2b. Code-owned policy (mechanism in modules, policy in index.ts)

- `entry.ok=false` with a gated, in-window `fix_start_node` -> handed to `extendClipStarts`.
- `exit.ok=false` with a gated `fix_end_node` -> handed to `extendClipEnds` as a hint row
  (the stage keeps all its existing gates; a hint only adds the clip to the offered set with the
  audit's reason attached).
- Unrepairable flags (`standalone.ok=false` and no gated fix): the clip SHIPS, flagged - it
  reaches the finalizer, whose existing drop verbs remain the only drop path. The audit never
  drops. Rationale: the billing invariant (a weak set is an honest answer), the evidence-gate
  lesson (a redundant pre-drop contradicting a later, better-informed stage), and the false-
  positive asymmetry of engine-notes §4 (a wrongly dropped good clip is invisible forever).
  The flag is published per clip (`_arcFlags` on `V2Highlight`) and counted in telemetry, so for
  the first time the job record says HOW MANY clips shipped with a known-bad entry/exit.
- If widening both ends would cross `maxSec`, entry wins (the owner's complaint ordering: a
  viewer who does not understand the opening never reaches the ending). Measured decision,
  revisit with data.

### 2c. Start extension: the mirror stage, not a snap patch

`extendClipStarts` mirrors `extendClipEnds` structurally (offer window -> model/audit pointer ->
gates -> apply -> telemetry) but is fed by arcAudit rather than self-motivated. Gates, in order:
`not_an_index`, `not_backward` (must be strictly earlier), `outside_graph`, `outside_window`
(window = min of `startExtensionWindowSec` [new, default 20, measured in task 3], scene cut
behind, teaser-region end - a start may never be pulled INTO the teaser region), `not_clean_start`
(`isCleanStart`, same function snap uses), `no_gain`, `too_long` (`maxSec` via the same
`fitsMaxSec` arithmetic). Conversion to seconds through the same functions snap uses, so the two
can never place one node differently. Widening cannot invalidate copy (evidence inside a range
stays inside a larger one - same argument end extension already relies on), so no `regroundCopy`
re-run is needed on this path.

New env knobs: `ARC_AUDIT=on` (default off), `START_EXTENSION_WINDOW_SEC` (default 20).
New variant key: `arcAuditEnabled` - follow the `endExtensionEnabled` precedent exactly
(the 6-step checklist in `eval-fixture.ts` / `eval-variants.test.ts` / `eval-fingerprint.ts`).
`startExtensionWindowSec` is deliberately NOT a variant key (tuning door - same refusal as
`endExtensionWindowSec`).

### 2e. The long-clip exception (owner decision 2026-08-10, Task 5 - AFTER tasks 2-4)

The hibakusya arc measured the constraint: the 3/3 scout-consensus moment is 105s against
`maxSec` 90, so the engine MUST cut it, and two runs cut it in opposite directions (labels.json).
The owner's decision: **a clip over 90s is an allowed format for strong moments, not a bug** -
under two conditions, both his words: it must be an EXPLICIT finalizer decision (never an
accidental maxSec overflow), and only on material where arcAudit judges entry, exit and
self-containment all ok.

Mechanism sketch (design to be finalized in its own plan, measurement first):
- `LONG_CLIPS=on` (default off) + `LONG_CLIP_MAX_SEC` (candidate default 150, MEASURE first:
  count critic verdicts whose raw range exceeds maxSec across all five fixtures' recordings -
  that count is the population this feature affects; one known case is thin evidence).
- snap: when the flag is on and a verdict fits `longClipMaxSec`, DEFER the over-length
  compression - validate boundaries at the long cap, mark the clip `overLength`. Compression
  becomes conditional policy in `index.ts` (run the exact same compression code) instead of
  unconditional mechanism: it fires when arcAudit flags any axis on the wide clip.
- extensions: their `too_long` gates read the long cap ONLY when the audit's other axes are
  clean, so a widening can cross 90 only on audit-blessed material.
- finalizer: an over-length clip is announced in its prompt block ("LENGTH EXCEPTION: this clip
  runs Ns, over the 90s standard - ship it long only if every second earns its place"), and the
  code gate refuses to ship any over-length clip whose `_arcFlags` are not fully ok - so the
  finalizer can only ratify a long clip that arcAudit blessed, which is exactly the owner's two
  conditions in code.

### 2d. What this does to the fixtures (budget it, do not discover it)

An audit that widens a boundary changes the finalizer's prompt, so recorded finalizer answers go
stale exactly as engine-notes §3 documents ("adding a clip invalidates the fixture recordings...
same for end extension when it is on"). Every measured arm below therefore needs an
`eval-topup.ts --variant arc-audit` pass; the 2026-08-05 precedent cost $0.079 for 8 calls.
The audit's own calls are new request keys and record like any other stage.

---

## 3. Measurement plan (instrument first, corpus first, code second)

**M0. Fixture 5: `podcast-nuclear`.** Record job `cmsnmcbec005ouhfj30l0w4qm` via
`eval-record.ts <jobId> podcast-nuclear`. This is the first fixture whose defects the owner has
already enumerated clip by clip - a labeled corpus for free. Costs real API money (one full
re-record; scanner + critic + finalizer); get the owner's go-ahead. Note the known caveat: it is
a third Russian conversational podcast - it buys DEFECT labels, not corpus SHAPE diversity.

**M1. Ground truth, two sources:**
- The owner's complaint list (already in hand for 6 of 12 clips - §0 table).
- Three blind `clip-scout` runs over the source transcript, consensus = >=2 of 3 agreement,
  exactly the protocol that produced the only deterministic acceptance criterion this programme
  has (end extension, engine-notes §3). Scouts name where the strong moments START and END;
  their starts are the entry ground truth the way their ends were the exit ground truth.

**M2. The audit script BEFORE the stage: `eval-arc-audit.ts`** (task 1). Replay-only, zero cost,
shaped after `eval-end-audit.ts`. Per shipped clip it prints: first/last speech-node text, onset
analysis (first non-PARTICLE token; is it a connective / pronoun / interrogative - reusing the
`PARTICLE` machinery of `looksLikeQuestion`), distance from clip start to the nearest preceding
scout-consensus start, `payoffAt` vs end, evidence nodes lying outside the shipped range (the
node-738 signal, which is free and already persisted). Its distributions on all five fixtures are
the baseline every later change is judged against. The onset counters are TELEMETRY, not gates -
"А помогают ли..." opens on a particle and is a fine hook; the counter measures, the audit judges.

**M3. Acceptance for the audit stage (task 2), deterministic:**
- On `podcast-nuclear`: of the labeled defective MOMENTS the fixture run actually ships (matched
  by time overlap against `labels.json` - clip ids do not survive a re-run, see the M0 note
  below), the audit flags them on the correct axis (entry vs exit), and does NOT flag the
  positive-control moment (1113.8-1131.2, scout-consensus-correct boundaries) - measured over
  THREE runs of the stage (the panel-variance lesson: one run of an LLM judge is not a
  measurement; the audit must be stable where the panel was not, and if it is ~40% unstable per
  clip like the panel, that is a kill result for the design).
- The `водка` exit label is contested ground truth (owner says cut-off, scouts 2:1 say verdict
  line - recorded in labels.json) and must not be a pass/fail case on either side.
- Instrument: stability CANNOT be measured through the replay harness - `responses.json` keys by
  sha256(model, system, user), so an identical prompt replays one recorded answer forever. It
  needs a dedicated script (`eval-arc-stability.ts`) that replays the pipeline up to selection,
  then calls the LIVE API N times (default 3) on the audit prompts WITHOUT writing recordings,
  and prints per-clip flag agreement across runs and against labels. It must refuse to run
  without an explicit `--live` flag, because it spends money on every invocation.
- Flag agreement vs scout-consensus starts/ends on the two old podcast fixtures.
- `clip-viewer`/`clip-editor` are explicitly NOT acceptance instruments (engine-notes §8b:
  byte-identical clips moved one verdict step; any future use requires that control run).

**M4. Acceptance for the repair verbs (tasks 3-4), on the SHIPPED SET, all five fixtures,
stage on vs off** (the anaphora lesson - a boundary rule feeds NMS, the finalizer's input and
the soft cap, and can delete the very clip it repairs):
- The 0.90 clip's shipped start moves to include node 738's sentence (its own description's
  evidence) - the concrete, falsifiable target.
- Shipped clip COUNT per fixture moves by at most the finalizer's own resampling noise
  (measure against the topped-up baseline, read the bless diff by hand).
- No new snap drops, no new NMS deletions attributable to the widening (dark-stage control where
  possible: with finalizer and both extensions replayed from recordings, an audit-off run must be
  byte-identical to base).
- Owner reads the before/after clip list for `podcast-nuclear`. His eye is the only instrument
  that has ever moved a decision here (engine-notes §8b).

**M0/M1 execution note (2026-08-10, Task 0 done).** The fixture recorded from the same stored
transcript shipped **8 clips where production shipped 12, mostly different moments, the same
day** - scanner temperature 0.4 plus judge sampling. Consequences, now baked into
`fixtures/eval/podcast-nuclear/labels.json`: labels are keyed by source time ranges and matched
by overlap; the file also records three 3/3 scout-consensus moments NEITHER run shipped (the
"Чернобыль грязнее Хиросимы" moment at 1041-1071 was ranked #1 by two of three scouts - a recall
miss, out of scope here but recorded), a positive control the engine gets right, and all three
scouts' independent ceiling statement: this episode holds 8-9 postable moments, not 12.

**M5. Token budget for the audit model: measured, not guessed** - the Luna ladder discipline of
engine-notes §3. Before setting `maxTokens`, run the real prompt at batch 1/2/4 and record the
reasoning-vs-JSON split; size the constant by "smallest round number above an observed completing
cap"; an unused cap is not billed, a starved one cascades.

---

## 4. Task specs for executor agents

Rules that bind EVERY task below. Cite the task spec in the commit message. Any deviation needs a
new measurement, not an argument.

- Models emit node indices only. Every boundary an LLM proposes goes through the stage's gates
  and re-runs `snapNodes` unless the stage provably only widens through snap's own arithmetic
  (`endSecFor` / the same clean-start walk) - copy end extension's pattern, including WHY its
  snap skip is legal (engine-notes §6).
- Policy in `index.ts`, mechanism in the module that owns the data (`snapNodes` owns boundaries).
- Tests: for every new rule, build the fixture so the mechanism must OVERCOME the tie-break
  default (memory `feedback_test_matches_default`); mutation-test by disabling the guard by hand
  (copy to /tmp, edit, restore, md5-verify) and watch the test go red; a green mutation run is
  indistinguishable from a mutation that did not apply - verify it applied.
- Run everything inside the `worker-analyze` container:
  `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src"`,
  scripts via `npx tsx src/scripts/<name>.ts`. Host Node is v18 and cannot run vitest.
- Never touch: `apps/web/lib/auth.ts`, `apps/web/lib/telegram-provider.ts`, billing semantics
  (a content outcome must never become FAILED), `lexicalOverlap` as a gate, the variant
  whitelist beyond the one declared key.
- Costs money -> stop and ask: `eval-record.ts`, `eval-topup.ts`, any live API measurement.
  Replay and unit tests are free and need no permission.

**Task 0 (owner + one agent, no engine code): record the corpus.**
Record `podcast-nuclear` (M0), run 3 clip-scouts (M1), commit
`fixtures/eval/podcast-nuclear/labels.json`: per clip `{ ownerVerdict, entryDefect, exitDefect,
scoutConsensusStart?, scoutConsensusEnd? }`. Deliverable: the fixture replays green in
`eval-snapshot.test.ts` and labels.json exists. No engine change.

**Task 1 (one agent): `scripts/eval-arc-audit.ts`** per M2. Read-only replay; follow
`eval-end-audit.ts`'s structure (parseVariantArgs -> loadFixture -> runFixtureVariant -> per-clip
table -> distribution summary -> telemetry block). Unit-test the onset classifier against the six
§0 openings verbatim (they are in the fixture transcript). Deliverable: baseline tables for all
five fixtures pasted into the PR description. No engine change.

**Task 2 (one agent, after 0+1): the arcAudit stage, detection only.**
New module `analyze-v2/arc-audit.ts` + prompt in `prompts.ts` + schema in `schemas.ts` + config
key `arcAuditEnabled` (`ARC_AUDIT=on`) + variant `arc-audit` + fingerprint key + telemetry
(`arcAudit: { audited, flaggedEntry, flaggedExit, flaggedStandalone, gatedOut, byDefect }`) +
`_arcFlags` on `V2Highlight`. NO boundary moves in this task - flags and telemetry only, so the
dark-stage control stays byte-identical and the stage's detection quality is measured in
isolation (M3) before any repair exists. Token budget per M5. Tests: schema strictness, gate
rejection of out-of-graph / non-clean pointers, replay determinism, the M3 stability run.

**Task 3 (one agent, after 2): `extendClipStarts`** per §2c, fed only by gated
`entry.fix_start_node` pointers. Telemetry mirrors end extension (`offered, proposed, applied,
refused, refusedBy, secondsGained`). Acceptance per M4 including the node-738 target. Tests
mirror `end-extension.test.ts`, including the teaser-region bound (a start pulled into the
teaser region must be refused - write the fixture so the pointer is otherwise legal).

**Task 4 (one agent, after 2): wire exit flags into `extendClipEnds`.**
The audit's `exit.fix_end_node` becomes a hint: the clip enters the offered set with the hint
rendered in `buildExtensionUser` as a labeled line ("an audit of the finished clip judged the
thought incomplete; the completing line may be #N"). All existing gates unchanged. This is the
measured answer to the honest-miss case (the model "preferred its own" ending when asked cold).
Acceptance per M4; additionally re-measure the compilation-reel harm that keeps END_EXTENSION
off (engine-notes §3) - if `sitcom-friends` still degrades, the audit-hinted path must be
separable from the self-motivated path so one can ship without the other.

**Task 5 (after 2-4, own plan): the long-clip exception** per §2e. Blocked on Task 2 shipping
(its gate is `_arcFlags`) and on the population count (§2e). Not started until the owner sees
tasks 2-4 measured.

**Explicitly out of scope** (do not let an implementing agent drift into these): arc stacking and
drag (no mechanism, separate programme item), any change to critic prompts or scan windows (own
re-record budgets), retention of the finalizer's 9 rules (unchanged), genre profiles, RENDER.
The long-clip exception (§2e) is Task 5 scope only - tasks 2-4 treat `maxSec` exactly as today.

---

## 5. Open questions, deferred with reasons

- **Should the finalizer's rules 4-6 eventually be DELETED in favor of the audit?** Prefer
  removing mechanism over adding it - but only after the audit's detection quality is measured
  (M3). If the audit is stable and the finalizer's per-clip rules stay coin-flips, delete them
  and let the finalizer own only set-level judgements (dedup, cap) plus the last-word trim.
  Measure, then cut.
- **Drop authority for `standalone.ok=false`.** The audit ships flags only (§2b). If the flag
  proves precise on the labeled corpus (>=90% agreement with the owner over two more jobs), a
  downrank below `scoreThreshold` - not a drop - is the next candidate verb.
- **Does entry repair move the postability rate?** 2-of-8 and now this job say openings are the
  binding defect; §10 of engine-notes ranks the in-point as "largest by expected value". The only
  honest test is the owner reading a repaired job end to end.
