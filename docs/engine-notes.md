# Engine notes

Working notes on the ANALYZE and RENDER engines, written for whoever picks this up next - including a future
me. This is not a spec. Specs say what should be true; this says what IS true, what was measured, and what
was tried and failed. Its purpose is to stop the next session re-deriving what this one paid for.

Rules for this file: every number here came from a measurement, not from reasoning. When a claim is
reproduced, say how. When something is believed but unmeasured, mark it. Delete an entry when it stops being
true - a stale note is worse than none, and this file has already caught two of its own.

Last substantive update: 2026-08-05.

---

## 1. What the product is, in one paragraph

ClipClap turns a long video into short vertical clips with burned-in subtitles. The audience is "clippers"
who cut viral shorts from streams, podcasts and VODs. Two engines matter: **ANALYZE** picks the moments from
the transcript, **RENDER** frames them into 9:16. Both assume humans talking on camera - ANALYZE picks by
WORDS, RENDER frames by FACES. Everything else degrades: gameplay and anime get a blind centre crop and only
verbal moments; speechless content yields zero clips.

---

## 2. ANALYZE: the pipeline and where each decision lives

```
transcript (Whisper verbose_json, word + segment timings)
  -> buildSentenceGraph      nodes with leading/trailingStrength, hasWords (opaque = music/crosstalk)
  -> runScanner              gpt-4o-mini, windowed, recall-oriented, returns NODE INDICES
  -> teaser filter           [code] drops intro-montage neighbourhoods
  -> mergeCandidates         overlap merge + span guard + split
  -> selectCriticCandidates  stratified: per-window quota, then global by interest, region-capped
  -> runCritic               gpt-5.6-luna, batches of 6, strict json_schema, returns NODE INDICES
  -> evidenceGate            [code] protocol check on the critic's answer; drift is reported, not fatal (§3)
  -> snapNodes               [code] OWNS ALL BOUNDARIES - clean start, payoff containment, clean end
  -> selectAndOrder          [code] tier thresholds + surcharges + time-overlap NMS + soft cap
```

Three more stages run after that sketch and are documented where they were measured: end extension (§3, off by
default), then the FINALIZE judge (§5a), then, last of all, the snippet-title repair pass (§4). Nothing runs
after the repair pass, which is precisely why the defect it fixes could ship. The order of the first two is
load-bearing: extension may only WIDEN, the finalizer may only shorten, and the shortener has to get the last
word on a boundary.

**The invariant that makes this safe:** models emit node indices only, never timestamps. Every cut lands on a
real word or segment edge because the code, not the model, converts indices to seconds. Mid-word cuts and
hallucinated timestamps are impossible by construction. Mid-*thought* cuts are only minimised, not
impossible.

**Where to put a new rule.** Every LLM rule needs a deterministic backstop; that pattern is the reason the
engine survived a hundred prompt-level failures. But put the *policy* in `index.ts` (the orchestrator owns
"technical failure versus content outcome") and the *mechanism* in the module that owns the data. `snapNodes`
owns boundaries - never let a model move a boundary without re-running snap on the result.

---

## 3. Measured facts about the engine

Numbers a future session should not have to re-derive.

**Critic token budget, part 1: gpt-5.1.** This is the half of the story that produced the constants, and it is
kept for two reasons: those constants still ship, and this is the cautionary case. The model that runs today
is Luna - part 2 below. gpt-5.1 spends `max_completion_tokens` on reasoning BEFORE writing any JSON. On the
real critic prompt at `reasoning_effort: low`, reasoning costs **330-450 tokens per candidate** (measured:
354-603 for one candidate, 918-1478 for three, 1979-2677 for six). The visible JSON is small and stable, about
**150 tokens per verdict**. The original budget of 400 tokens per candidate was BELOW the reasoning floor at
every batch size, so roughly half of all critic calls truncated, the batch-splitting recovery inherited the
same starvation, and candidates were silently dropped. After sizing the budget from these numbers, truncations
per fixture went **7 -> 0**, batch splits **6 -> 0**, API calls **18 -> 6**, and shipped clips went **5 -> 6**
and **7 -> 10** with the survivors spread across the whole source instead of clustering on weak early
material. Per-call variance is the same order as the headroom (a later run measured 2184 completion at a 6000
budget, below the 2857 seen at 5000), which is why a truncation can genuinely heal on a retry.

**Critic token budget, part 2: gpt-5.6-luna (the current default, `88a4435`).** Before measuring Luna, the
instrument itself was validated with a control run on gpt-5.1: all three truncation cells above reproduced
(1/400, 3/1200, 6/2400, each burning the whole cap on reasoning and returning zero verdicts) and every
completing cell landed within a few percent of what is recorded here (3/3000 measured 1351 completion / 915
reasoning against the recorded 1338/918; 6/5000 measured 2992/2131 against 2857/1979). So the numbers below
are comparable to the numbers above, and the re-measurement widens gpt-5.1's per-candidate reasoning band from
the 330-450 first recorded to roughly 207-620.

Luna's ladder at `reasoning_effort: low`, prompts pooled from both fixtures because neither carries all three
batch sizes on its own (`podcast-ecology` records batches of 6,6,6,6,1; `podcast-answer-arc` 6,6,6,6,3):

| batch | cap | input | completion | reasoning | verdicts |
|---|---|---|---|---|---|
| 1 | 400 | 3122 | 400 | 400 | 0 (truncated) |
| 1 | 1200 | 3122 | 310 | 160 | 1 |
| 1 | 2000 | 3122 | 389 | 225 | 1 |
| 1 | 3000 | 3122 | 390 | 239 | 1 |
| 3 | 1200 | 5092 | 1200 | 1200 | 0 (truncated) |
| 3 | 3000 | 5092 | 831 | 384 | 3 |
| 3 | 3600 | 5092 | 865 | 421 | 3 |
| 3 | 6000 | 5092 | 959 | 512 | 3 |
| 6 | 2400 | 9100 | 1424 | 558 | 6 |
| 6 | 5000 | 9100 | 1212 | 410 | 6 |
| 6 | 6000 | 9100 | 1513 | 701 | 6 |
| 6 | 9000 | 9100 | 1815 | 988 | 6 |
| 6 | 14000 | 9100 | 1531 | 717 | 6 |

Luna spends **68-171 reasoning tokens per candidate**. That inverts the assumption the budget comment is built
around: on gpt-5.1 the reasoning term dominates and the visible JSON is a rounding error, on Luna the visible
JSON is the dominant term. The clearest single symptom is that `6 / 2400` completes on Luna where it truncated
every time on gpt-5.1.

By this file's existing rule - the smallest round number above a cap observed to complete - Luna requires
2000 / 3600 / 3000 at batch 1 / 3 / 6. The shipped constants yield 2000 / 3600 / 6000 and clear all three, so
`CRITIC_BASE_TOKENS = 1200` and `CRITIC_TOKENS_PER_CANDIDATE = 800` are **unchanged, and that is a
measurement, not an omission**. A tighter 1800/600 was proposed and rejected: it would shrink the batch-6
budget on the strength of one sample per cell, and per-call variance is demonstrably the same order as the
headroom being traded away - the same batch measured 410 reasoning tokens at cap 5000 and 988 at cap 9000. An
unused cap is not billed; a starved one cascades (part 1).

**What the model change did to the shipped set - Luna is not a drop-in.** Both fixtures were replayed with
IDENTICAL scanner answers. The scanner's request keys do not contain the critic model, so its answers are
shared byte for byte between variants and the candidate set entering the critic is exactly the one gpt-5.1
judged. That is the whole point of the variant mechanism (§5) and it is what makes these numbers a statement
about the judge rather than about run-to-run noise. (The migration's motive was cost - `88a4435` puts analysis
at a measured $0.210 per 52-minute job on gpt-5.1 against $0.027 on Luna. The second figure is PROJECTED from
list prices, not billed and observed, and is marked as such here.)

- `podcast-ecology`: gpt-5.1 shipped 12 clips, Luna 10. Nine pair by time overlap; three are gpt-5.1-only, one
  Luna-only. Luna's finalizer vetoed 3 clips where gpt-5.1's vetoed 0.
- `podcast-answer-arc`: gpt-5.1 12 clips, Luna 11. **Only six pair**, and two of those at IoU 0.06 and 0.36 -
  barely the same moment. Six are gpt-5.1-only, five Luna-only. NMS drops went 1 to 4.

Where the two judges agree they agree tightly: on the six paired answer-arc clips Luna picks near-identical
boundaries (three at IoU >= 0.88, one exact) and its titles are consistently tighter. But overall agreement is
LOW. Luna is a materially different editor, not a cheaper spelling of the same one. That is a product fact
before it is a technical one, and nothing in §5a or §5b that was measured on gpt-5.1's output can be assumed
to transfer to what ships today.

**Luna silently omits a verdict; gpt-5.1 never did.** On `podcast-ecology` Luna returned **24 verdicts for 25
candidates**. Candidate `c8` got no row at all - no truncation, no refusal, no batch split, no `__outcome`
marker on disk. The token budget is not implicated: it was measured (above), and this batch completed well
inside its cap. gpt-5.1 did not omit once across 52 candidates in the same two fixtures. An omitted candidate
is invisible recall loss, because `index.ts` raises only when ZERO clips survive - with survivors it ships a
thinner set quietly and nothing in the job record says why.

Fixed in `e85bf6b` by re-asking once about exactly the omitted ids, routed through the same recursive entry
point that batch-splitting already uses, so the re-ask is a real critic prompt and inherits the existing
truncation, refusal and fallback handling. The one-pass bound is **structural rather than a counter**: a
`mayRetryOmissions` parameter that the retry passes as false, which everything reachable from it inherits.
Removing the bound in a mutation produced 68,377 warnings and a heap out-of-memory, which is how it was proved
load-bearing rather than decorative. A trap worth recording because it would have been silent:
`mapWithConcurrency` calls `fn(item, index)`, so passing `processBatch` by reference would have bound the
batch INDEX to that boolean - and index 0 is falsy, making batch 0 the one batch that never retries.

Luna answered on the re-ask (`keep`, score 0.72) and **the shipped set did not change**, because c8 ranked
16th of 20 keep-verdicts and only 13 clips reach the finalizer. The recall loss is real and is now recovered;
on this one fixture it happened not to matter. Note what that implies about how it was found: it took someone
counting verdicts against candidates. Nothing in the pipeline was going to report it.

**Scanner order used to be non-deterministic.** `runScanner` pushed candidates into a shared array from
inside `mapWithConcurrency`, so their order was API completion order. `mergeCandidates` sorts stably, so ties
preserved input order, which changed merges, ids, batch composition and ultimately which clips shipped. The
same transcript produced different clips run to run purely from network timing. Fixed by returning per-window
arrays and flattening in index order. This was the third distinct source of the "clip lottery" the owner
reported; the earlier two (evidence gate rejecting opaque nodes, snap gate) were fixed before it.

**Transcription jitter between two runs of the same audio** (LCS-aligned, 7047 vs 7050 tokens):
**14 substitutions, 28 insertions, 25 deletions.** Indels outnumber substitutions 3.8:1 and are almost all
discourse particles - значит, вот, да, ну, там, если, допустим. Any text-matching heuristic must survive
indels, not just respellings. ё/е is a coin flip: one fixture has zero ё tokens, the other has ten, and the
same lemma appears both ways within one run (всё/все, ещё/еще).

**`speechSec` is not how much speech a source has.** It sums the spans of
word-bearing nodes only, i.e. speech Whisper gave word timings we trust enough to CUT on. Measured on both
fixtures (the same 52-minute episode, 2026-07-26):

| | ecology | answer-arc |
|---|---|---|
| wall clock | 3136s | 3136s |
| word-bearing node spans (`speechSec`) | 1603s | 1649s |
| opaque node spans | 1167s | 1119s |
| gaps between nodes | 366s | 368s |

**The longest single pause in 52 minutes is 4.3s.** There is no 47% of silence in that episode - the missing
half is Whisper's word-timing quality, and 36% of the episode sits in opaque nodes that the scanner and critic
both read and that clips are routinely cut around. Any budget derived from `speechSec` is a budget derived
from a transcription artefact. `sourceSeconds()` (all node spans, ~2770s here) is the honest measure: it
excludes real silence, because silence produces no nodes, but keeps speech we merely could not time. Both
numbers are now published per job as `speechSec` and `sourceSec` precisely because confusing them is what
caused the critic-budget defect below.

**The critic budget used to judge half the pool.** `K = min(40, max(8, round(speechMin / 2)))` resolved to 13
and 14 on the two fixtures against pools of 28 and 32 - so 15 and 18 candidates were never judged by the
strict model, and the cut among them fell to `interest`, a gpt-4o-mini hunch. Two independent errors, both
halving: the wrong numerator (above) and a rate below the pool's own production rate. Measured production is
**0.58 and 0.72 candidates per source minute**, against a structural ceiling of ~1.4/min (the scanner schema
returns at most 12 moments per window, one window per ~510s of speech). The rate is now **1 per source
minute** - above what real material produces, so K stops binding on ordinary sources, and below the scanner
ceiling, so a pathological scan is still rationed. After the fix, judged 25/28 and 27/32; the residual is the
per-region diversity cap, not the budget. Cost at batch size 6 and gpt-5.1 list price: **$0.103 -> $0.195**
and **$0.110 -> $0.239** per 52-minute job. Shipped clips went **7 -> 12** and **10 -> 12** (all of this on
gpt-5.1, which was the critic at the time; the same fixtures ship 10 and 11 under Luna today), and 5 of
ecology's 12 come from candidates the old budget would have withheld.

**What limits clip count today.** Before this change it was K. After it, measured **on gpt-5.1**: on
`podcast-answer-arc` it is the soft cap - 21 keep-verdicts -> 16 handed to the finalizer
(= `softCap + finalizerHeadroom`, binding) -> 15 survivors -> 12 shipped; on `podcast-ecology` the
gate/snap/NMS funnel binds first, 20 keep-verdicts -> 12. Under Luna the funnel's shape moved with the judge:
ecology still produces 20 keep-verdicts, 13 reach the finalizer, the finalizer vetoes 3, and **10** ship;
answer-arc ships **11** with NMS drops up from 1 to 4. So on both fixtures the last binding constraint is now
downstream of the critic, not the budget. `criticMaxCandidates` (40) is the spend ceiling and is not reached
by a 52-minute source; a 90-minute one would reach it. `criticBudgetK` and `criticUnjudgedPool` are published per job so the next binding constraint
is visible in a job record rather than re-derived.

**The anaphora rule: right diagnosis, wrong remedy, reverted the same day.** The owner's second-best clip
ended on the first beat of a three-beat figure ("Планета еще и не такое видала" / "Планета видала
вулканические катастрофы" / "Планета видала астероидные импакты"), and he described it exactly as "it seems
to cut off". The detector was sound - measured, 3+ beats fires ONCE per episode, on the real figure; at 2+
beats it fires 8-9 times on echoes and self-repair, so the third beat is what makes a figure. The rule
extended the end to complete the run. Measured end to end it was NET NEGATIVE on every axis:

- ecology shipped 12 clips with the rule off and **11** with it on. The extended clip crossed the 30% NMS
  overlap bar against its neighbour and was deleted - so the repaired ending never shipped anywhere in the
  harness, and the owner lost the clip he had named as his second-best.
- Via the changed finalizer input set, a 0.90 clip's start moved onto "Руки в первом приближении можно такие
  же оставить" - an answer whose question ("Руки такие же оставим, как сейчас?") sits outside the clip. A fix
  for endings manufactured the owner's exact complaint about openings, on a top-scoring clip.

Reverting restored both: ecology 11 -> 12 with his clip back, and the 0.90 clip's start moved forward 13.3s
to include its own question.

**The lesson is about boundary changes generally, not about anaphora.** A rule that moves a boundary does not
act alone - it feeds NMS, the finalizer's input set, and the soft cap, and those interactions can destroy the
very clip the rule repairs. Before shipping any boundary rule, measure the SHIPPED SET with it on and off,
not just the boundary it targets. Two of the three fixes in that round were mis-evidenced in the same way:
the critic-budget numerator change was inert (reverting it reds one test; the whole measured gain came from
the rate), and the compression repair opened its headline case on an answer whose question sits outside,
which is the defect `orphansQuestion` already gates on the trim path - the engine now enforces two
contradictory policies on the same structure, and that is unfinished business.

**Hook geometry is critic variance, not signal.** `payoffAt <= hookEnd` fires on 5 of 6 clips in one fixture
and 2 of 10 in the other - same video, same engine, same config, different transcription run. It fires on the
highest-scoring clip in the set. Do not build a rule on it; a plan task that did was dropped for this reason.

### End extension (built 2026-08-04, ships OFF)

**The stage works and the clips did not get better.** Spec
`docs/superpowers/specs/2026-08-04-clip-quality-programme-design.md` §3.2, plan
`.../plans/2026-08-04-clip-endings.md`. `extendClipEnds` sits between `selectAndOrder` and FINALIZE, offers the
critic model a window of material past each shipped clip's end, and may move that end FORWARD only. It met its
acceptance bar on the deterministic criterion and **nothing in the judged quality of the output moved**. Read
the rest of this subsection before proposing it again: the honest summary is that the mechanism is sound, the
podcasts got better and the compilation reel got worse, and the instrument used to judge the compilation
cannot resolve a change of this size.

**Before, and the cap was never the culprit.** `sitcom-friends`, base, 12 clips: tail after payoff min 0.1s,
**median 0.3s**, max 1.8s, and **0 of 12** at the `payoffMaxTailSec` cap of 4. The cap never fired. The critic
was setting `end_node` to `payoff_node` and snap was honouring it, so raising the cap would have changed
nothing - the defect the audit named ("the engine ends clips before the payoff") lived in the PROMPT, not in a
constant. `scripts/eval-end-audit.ts` prints this distribution per fixture and is how the layer was
identified; it is worth running before any future boundary work for the same reason.

**After, against the scouts.** The audit's three blind scouts put five of six shared ends 17 to 55 seconds
later than the engine's. Acceptance was "at least three of those five move toward the consensus". Three moved:

| base clip | base end | extended end | scout consensus |
|---|---|---|---|
| 636.9 | 658.0 | **682.3** | 682.0 |
| 1413.3 | 1433.3 | **1451.0** | 1450.7 |
| 0.0 | 28.8 | **42.7** | 83.4 (one scout, not a consensus) |
| 175.1 | 190.6 | unmoved | 217.3 |
| 2148.0 | 2167.2 | unmoved | 2175.5 |

The first two are exact, not close: both land on the very NODE the scouts named, and the 0.3s residual is
`tailHoldSec`. Tail after payoff across the whole set went median **0.3s -> 7.0s**, max **1.8s -> 24.3s**, and
**7 of 11** clips now sit at or past the old 4s cap. Telemetry:
`offered 12, proposed 8, applied 8, refused 0, secondsGained 110.24`.

**The two that did not move were not gate refusals - the model declined them in writing.** `refused` is 0 on
this fixture; both clips were offered a window and answered `extend: false`. 175.1 got *"nothing after the
payoff adds a worthwhile beat"*, 2148.0 got *"the firing line is already the strongest beat"*. Their positions
are different and only one is a model error:

- **2148.0 is the honest miss.** Its consensus end is node 841, inside the window, word-bearing and a clean
  end. Every gate would have passed it. The model looked at a legal answer and preferred its own.
- **175.1 is unreachable at any window size.** The node carrying its consensus end is opaque, with no word
  timings, so `opaque_end` refuses it however wide the window is opened. Widening `endExtensionWindowSec` is
  not the fix for this clip and never will be.
- **0.0 missed by 1.0s.** It needed 54.6s of reach; the window ceiling on that clip is 53.6s. The one place a
  window widening would have paid.

**Podcasts improved, and this is the defect the owner named by eye.** `podcast-ecology`'s 87.4 clip ended at
157.0 on the bare claim `"Планета еще и не такое видала"` and now ends at 176.3, after its support:
`"Планета видала вулканические катастрофы. Планета видала астероидные импакты. Планете 4,5 миллиарда лет..."`
That is his 2026-07-26 "it seems to cut off" (§5b), and the same figure the reverted anaphora rule was built
for - repaired here by asking a model rather than by a detector. Two further podcast ends moved
(`podcast-answer-arc` 2289.2 and 2877.9) and read better too. Judged by reading the transcript, not by an
agent.

**Judged quality did not change.** The same 12 clips were re-rendered as real product output and put in front
of the same `clip-viewer` and `clip-editor` agents with the same prompts:

| | base, 12 clips | extended, 11 clips |
|---|---|---|
| `publish` | 0 | 0 |
| `publish after one fix` | 4 | 4 |
| `bin it` | 8 | 7 |
| mean viewer score | 3.2/10 | 2.8/10 |
| likes | 1 | 2 |

**And the instrument cannot resolve a change this size.** Two clips the model declined to extend entered the
second set BYTE-IDENTICAL, which makes them a free control. Both moved one step anyway: 175.1 scored 3 then 2
with the viewer, and 2148.0 went from `publish after one fix` to `bin it` with the editor. So the agents' own
variance on identical input is at least one step on both axes, and the table above is noise. **The
deterministic criterion - ends against the scout consensus - is the only thing here that measured anything.**
Any future project in this programme that plans to prove itself with those agents needs this control run
alongside it.

**Where it helped and hurt on the compilation.** Helped: 1413.3 now ends on *"Were you, or were you not, on a
gay cruise?"*, the line all three scouts named, and its editor verdict dropped from needing a re-crop AND a
caption to needing only a caption. Hurt: 1165.4 extended past its punchline into an unrelated scene. `"I chose
not to hear that."` is followed by a **3.82s** hole and then a Swedish-massage sketch; `sceneGapSec` is 5, so
the scene rail was blind to it and the editor called the result *"two unrelated scenes stapled into one
clip"*. Neither: 0.0 gained 15.4s and lands on the *"Tramp"* punchline, which is a real improvement and still
40 seconds short of what the scout wanted, and it cannot get there - the window ceiling on that clip is 53.6s.

**It also deleted a clip, which is the anaphora lesson repeating exactly.** `sitcom-friends` ships 12 clips in
base and **11** with the stage on. The extension is upstream of FINALIZE by design, so widening a clip changes
the finalizer's prompt - and the finalizer vetoed `c8` as `no_payoff`, the Pottery Barn clip, which is the very
clip the stage had just widened (*"the spilled-wine comeback tops the antique-table joke"*). Every other
fixture's shipped set moved too, mostly the other way: `podcast-ecology` goes **10 -> 12**,
`creator-challenge` **7 -> 8**, and `podcast-answer-arc` stays at 11 with two clips swapped out for two
others. Scanner and critic answers are shared byte for byte across the variants,
so the candidate set and the selection are provably identical and all of this churn is downstream of the moved
boundary. A boundary rule never acts alone - measure the SHIPPED SET, not the boundary.

**What the audit says is actually binding, measured on the extended set.** `broken framing` appears in **11 of
11** editor verdicts. `title is a recap` appears in **11 of 11**. Two clips are one caption rewrite from
publishable, with the editor stating no cut to the video is required. Early ends were real and were roughly
the fourth-largest defect in this material, not the first. That ordering is the useful output of the whole
exercise.

**The refusal population, measured across the four fixtures.** `opaque_end` is **11 of 15** refusals on the
three non-sitcom fixtures (ecology 3 of 5, answer-arc 5 of 6, creator-challenge 3 of 4); `sitcom-friends`
refuses nothing. The model keeps reaching for nodes Whisper left without word timings. So the lever for
reducing refusals is word-timing coverage - the same defect that silently drops a word from burned-in
subtitles. **The subtitle half of that is fixed as of 2026-08-05 (§8a), and the measurement corrects this
sentence: it is 10.7% of segments, not 13.8%, and it is the last word only in English - Russian loses the
first.** The refusal half is untouched. Two of the programme's six projects share that root cause, and
the refusal histogram is what makes it visible; a bare null would have said only that the gates and the model
disagree.

**`sceneGapSec` is 5**, and it is a rail, not a detector. Node-to-node holes measured on all four fixtures:
`podcast-ecology` and `podcast-answer-arc` max **4.26s** with **zero** holes at or above 5, `creator-challenge`
max 9.98s with 6, `sitcom-friends` max **17.0s** with 20 and a median gap of 0.44s. 5 is the smallest integer
that leaves both no-cut fixtures at zero boundaries; 4 would give each of them one. The errors are asymmetric -
a false cut costs one forgone extension, a missed cut ships two unrelated scenes - which is why it sits at the
bottom of the admissible range. It is **partial** by construction: a cut the audience laughs through gets a
segment from Whisper, becomes an opaque NODE, and leaves no hole at all, so of the 17 word-free stretches of
8s or more on `sitcom-friends` only 8 contain a true silence. The 1165.4 defect above is exactly that failure.

**On this evidence the stage should stay off until the scene rail is fixed.** It is net positive on podcasts
and net negative on compilation reels. That is the first concrete job for a genre profile (programme item 6):
one knob, two source types, opposite settings, with a measurement behind each. Rollout mechanics are in §8.

### The evidence gate stopped dropping clips for their copy (2026-08-04)

`evidenceGate` used to reject a whole verdict, pre-snap, whenever a title or description citation fell outside
the critic's own `[start_node, end_node]` - reasons `title_evidence_out_of_range` and
`description_evidence_out_of_range`. That contradicted §6's rule that a clip is never dropped for its copy, and
it had done so since the gate was written.

**What made it visible.** The `ca8dfec` critic/finalizer prompt change took the reason from 2 to 9 across the
eval suite in one commit, 0 to 3 on sitcom-friends, and cost that fixture 3 of 12 clips. All three losses have
one shape: the critic tightened its OWN range and reused the citations it had written for the wider one - c8
moved start 443 -> 447 still citing 443, c6 moved end 276 -> 267 still citing 274, c15 started at 639 still
citing 636. Gaps of 3, 4 and 7 nodes, just past the 2-node `EVIDENCE_BOUNDARY_SLACK_NODES` that
`widenRangeToEvidence` uses to pull the boundary out instead.

**The repair already existed, ten lines below.** `regroundCopy` asks the identical question against
`finalStartNode`/`finalEndNode` - the range that actually ships, after snap and any finalizer trim - with the
same slack, and answers it by voiding the offending FIELD's copy while keeping the clip. Every verdict that
leaves the gate alive and survives snap runs through it (`index.ts`, the loop over `critic.verdicts`); one that
does not survive snap was never going to ship. A citation far outside is not a separate case: it is stale
there too, and the field is replaced with the clip's own speech, verbatim. So the pre-snap rejection was
strictly redundant with a later check against a strictly better range.

**What changed.** The range test stays in the gate and now returns `outOfRange` instead of a rejection;
`index.ts` counts it into a new `evidenceOutOfRange` telemetry map, deliberately NOT into `gateDropReasons`,
which must keep meaning "this clip is gone". `toShape` carries it into the eval snapshots as `outOfRange`,
because the snapshot diff is how the 2 -> 9 jump was found and a counter that leaves the snapshot stops being
an alarm. Everything else the gate rejects - `critic_ungrounded`, `not_self_contained`, `*_evidence_missing`,
`*_evidence_invalid` - is a protocol failure with no repair and still costs the clip. The graph-membership
check must stay AHEAD of the range test: a citation naming node 999 of a 500-node graph is both, and reporting
it as drift would ship copy grounded in a node that does not exist.

**Measured with every stage live, after topping up the five stale pairs. +3 clips across the suite, 105 ->
108:**

| fixture | base | gpt51 | end-extension |
|---|---|---|---|
| creator-challenge | 8 -> 8, identical | - | 8 -> 8, identical |
| podcast-answer-arc | 12 -> 12, identical | 12 -> 12, one swap | 12 -> 12, identical |
| podcast-ecology | 12 -> 12, one swap | 12 -> 12, identical | **11 -> 12** |
| sitcom-friends | **9 -> 10** | - | **9 -> 10** |

**THE FINALIZER VETOES ONE OF THE THREE RECOVERED SITCOM CLIPS, AND A DIFFERENT ONE ON EACH VARIANT.** All
three reach it - 11 selected, 10 survive, on both variants - and:

- base drops c8 "Pottery Barn" for `no_payoff`; c6 and c15 ship.
- end-extension drops c15 for `broken_opening`; c8 and c6 ship, retitled "Pottery Barn Changes How They See
  Their Antique" and "Joey's Version of the Kissing Story Keeps Changing".

So each recovered clip ships somewhere, each veto is a content judgement about the moment rather than
anything to do with copy, and the honest gain is **+1 per sitcom variant, not the +2 a finalizer-dark control
predicted**. Record the live number: the finalizer holds the veto, and a clip it vetoes is not a recovery.
c15's recovery is worth its own line - it does not add a clip on base, it REPLACES 1610.3-1632.5 with
1568.8-1632.5, the same ending with the whole argument in front of it, and the score goes 0.73 -> 0.86.

**THE RECOVERED DESCRIPTIONS ARE RAW TRANSCRIPT, and this is the next question rather than a defect in the
fix.** Every recovered clip keeps its model-written TITLE - those citations were in range - and gets a
regrounded DESCRIPTION out of `snippetFallbackCopy`: *"Oh my God the design of our antique Wow Oh my God ours
must be worth much more than one in 50 50"*. Grounded, right language, on topic, and dull. Nothing downstream
rewrites it: the snippet repair pass after the finalizer is deliberately TITLE-ONLY (§4), so a voided
description is the last word. Before this change those clips were dropped, so nobody ever saw the description
- the gap is newly VISIBLE, not newly created.

**ONE THING THE OLD GATE CAUGHT THAT NOTHING CATCHES NOW.** `regroundCopy` measures against the SHIPPED range,
so a citation 3 nodes before the critic's start that snap's clean-start walk-back pulls to within 2 of the
shipped start is no longer regrounded at all. That is the intended reading - the range the viewer hears is the
one that matters, and the walk-back moved the clip to CONTAIN the cited material - but it is a real
behavioural difference from the old pre-snap test, not pure redundancy. It occurred on none of the nine drift
cases in the suite; all nine were regrounded downstream.

**A REPLAY CAVEAT worth knowing before the next engine change: adding a clip invalidates the fixture
recordings.** The finalizer prompt renders the clip set, so one extra clip in `selection.selected` changes the
request hash and the recorded answer no longer applies - same for end extension when it is on. Five of ten
(fixture, variant) pairs went stale on this change; topping them up cost 7 calls, 43.5k in / 9.6k out.
"Replay is free" holds for anything that only moves boundaries or copy; it does not hold for anything that
changes WHICH clips reach the last two stages. Budget a topup for those, and expect the fresh finalizer answer
to re-title and re-trim the WHOLE set, not just the new clip - most of the lines in those four snapshot diffs
are that, not the change under review.

### The mid-clause end defect: FIXED, and the obvious fix was inert (2026-08-05)

`isCleanEnd` certifies a node as a clean end whenever the NEXT node is opaque, justified in its doc comment as
"music follows". The justification is wrong - `hasWords=false` means Whisper's word timings were unreliable
(laughter, crosstalk, an unintelligible stretch), and the speaker usually continues. This is the defect behind
`eval-regressions`' "no clip ends mid-clause on a dangling comma", red at `efc007f` on exactly three shipped
clips: podcast-ecology 1905.71-1945.76 and podcast-answer-arc 1905.71-1945.76 both ending `"корабли,"`, and
podcast-answer-arc 2956.44-2976.06 ending `"воде,"`.

**THE OBVIOUS FIX IS A NO-OP. Measured, not reasoned.** The natural repair - when the next node is opaque, look
THROUGH it to the next word-bearing node and apply `isCleanStart` there - fixes NONE of the three, and changes
NOTHING anywhere. Dark-stage replay (finalizer and end extension held off on both sides, so no recorded prompt
can move) is byte-identical to baseline on all four fixtures: 12 / 12 / 11 / 9 clips, same ranges, same titles,
same snap drop reasons. It is not inert for lack of reach either - it flips 48 / 49 / 26 / 12 word-bearing
nodes from clean to dirty across the four graphs. It simply never touches a node any clip ends on.

**Why it cannot work, and this is the part worth keeping.** `isCleanStart` contains the SAME opaque-adjacency
assumption:

```
const boundaryOk = n.leadingStrength >= 0.8 || (index > 0 && nodes[index - 1].hasWords === false);
```

The node you reach by looking through a gap is BY CONSTRUCTION preceded by an opaque node, so `boundaryOk` is
automatically true and the only surviving test is capitalization. Looking through therefore deletes the
assumption from one function and immediately re-consumes it from the other. In all three offenders the
post-gap node is a genuinely new capitalized sentence (ecology #579 / answer-arc #586 "Человек же все таки
приостановил...", answer-arc #844 "Позвоночник стал балкой..."), so it is certified clean and the offender
survives.

**The continuation is INSIDE the opaque node, which is why looking past it is the wrong direction.** ecology
#576 ends "Без разумного вида строящего космические корабли"; the missing predicate is the opaque #577,
`"любая биосфера обречена, срок ее жизни ограничен сроком жизни звезды."` Same shape at answer-arc #841 ->
opaque #842 `"нагрузки на него были на сжатие."` Opaque nodes carry Whisper's PUNCTUATED segment text (§5a: only
2 of 609 word-bearing nodes carry a mark), so the opaque node is the one place the continuation is legible at
all. The rule has to read it, not skip it.

**The rule that reads the opaque node** - clean unless that node's own text starts lowercase - kills all three
offenders, but on its own it DROPS them rather than repairing them: 4 new `no_clean_end` snap drops (ecology c21
@0.86; answer-arc c35 @0.72, c22 @0.78, c23 @0.84). Snap's repair walks backward to the latest clean end at or
after the payoff, then forward; behind ecology #576 there is no clean end at or after the payoff, and the next
WORD-BEARING node is #579 at 1962.08s, 16.6s past. That is the "a fragment or nothing" reading, and it is a
false choice - see below.

**The strictest variant measured** (also refuse when any node in the opaque RUN starts lowercase, then still
look through) costs a fifth drop on ecology (c10 @0.84) and moves a second shipped clip; it buys nothing over
the simple rule on these four sources.

#### What shipped: end ON the opaque node

The completion is not 16.6s away. It is the very NEXT node, the opaque one, and it carries Whisper's punctuated
segment text ending in a full stop. Ending there is **not a new kind of clip**: 12 of the 44 clips the four
fixtures ship already end on an opaque node, at `"segment"` confidence, and `speechNodes` / `regroundCopy` /
`snippetFallbackCopy` have been skipping opaque nodes when building copy all along. This adds three members to
an existing population of twelve.

Three parts, and the third is not optional:

1. `isCleanEnd` - opaque successor is clean unless its text starts lowercase.
2. `snapNodes` - the forward clean-end repair may land on an opaque node **whose text closes a sentence**,
   marking the clip `"segment"` confidence. The guard is load-bearing: it refuses 46 / 47 / 52 / 11 opaque nodes
   per fixture, and without it the repair would end clips inside a laugh.
3. `CLEAN_END_REACH_SEC = 5`, a NEW constant. The completing opaque node sits **4.22s** past two of the three
   offenders, outside the old 3s.

Isolated knob attribution, dark stage, so neither knob is credited with the other's work:

| arm | new `no_clean_end` |
|---|---|
| rule only, 3s reach, no opaque tail | 4 |
| rule only, 5s reach, no opaque tail | 4 (the reach alone rescues **none**) |
| rule + opaque tail, 3s reach | 3 (rescues 1) |
| rule + opaque tail, 5s reach | **0** |

`SENTENCE_SLACK_SEC` stays at 3 and is now used only by the payoff-containment fallback. The reach was
deliberately given its own constant: sharing one number means widening the repair's arm silently widens the
payoff window too, which nothing measured. A test pins that separation.

**Dark-stage result, four fixtures.** Counts identical (12 / 12 / 11 / 9), zero swaps, zero backfills, and
`no_clean_end` goes **1 -> 0** - the fix also rescues a drop that predates it. Exactly three clips move, each
EXTENDED to finish its sentence:

```
ecology     1905.71-1945.76 (40.0s) [569..576] -> 1905.71-1949.98 (44.3s) [569..577]
answer-arc  1905.71-1945.76 (40.0s) [576..583] -> 1905.71-1949.98 (44.3s) [576..584]
answer-arc  2956.44-2976.06 (19.6s) [837..841] -> 2956.44-2977.76 (21.3s) [837..842]
```

The audible end is `endSecFor`'s ordinary arithmetic and bleeds into nothing: 0.78s / 0.92s / 0.10s of clearance
before the next node starts.

**LIVE, the counts move and it is NOT this change.** Zero `no_clean_end` drops on every live pair; every count
change is the finalizer's fresh roll vetoing clips, for `broken_opening` / `no_payoff` / `unanswered_title` /
`teaser_montage` - all opening and content reasons, none about ends.

| pair | snapshot -> live | finalizer vetoes | new `no_clean_end` |
|---|---|---|---|
| ecology base | 12 -> 12 | 2 | 0 |
| ecology gpt51 | 12 -> 12 | - | 0 |
| ecology end-extension | 12 -> **8** | **7** | 0 |
| answer-arc base | 12 -> **11** | 4 | 0 |
| answer-arc gpt51 | 12 -> 12 | - | 0 |
| answer-arc end-extension | 12 -> 12 | 1 | 0 |
| sitcom-friends, creator-challenge | unchanged, both variants | - | 0 |

**ecology end-extension losing 4 clips to 7 finalizer vetoes is the outlier and deserves its own look.** It is a
resampling artefact of this topup, not a boundary regression - the dark-stage control holds every count and the
stage ships OFF - but 7 of 15 vetoed is far above this fixture's usual rate and nothing here explains it.

Topup cost: **8 calls, $0.079** (luna 41,943 in / 8,357 out; gpt-5.1 15,845 in / 4,079 out). Far below the ~$0.60
the previous two boundary changes cost, because only the finalizer call per pair moved.

**THE GUARD'S WEAK POINT, sized rather than assumed.** `endsOnSentenceMark` trusts Whisper's punctuation on the
opaque node. On the four fixtures that trust is well placed - the opaque nodes really are punctuated, and the
guard's refusals are genuine unterminated clauses. But all four are sources Whisper handles well (two Russian
podcast transcriptions of one episode, one sitcom, one creator vlog). On a noisy stream, a heavily accented
speaker, or a language it punctuates worse, a spurious full stop would let a clip end inside a laugh. NOT
MEASURED, because no fixture in the repo can measure it. The blast radius is bounded - it can only affect clips
whose end node already failed the clean-end test, and the failure mode is a coarse end rather than a wrong one -
but the first badly-punctuated source is where to look for it.

**The dark-stage control, which is the instrument that made all of this cheap.** `isCleanEnd` has exactly two
consumers, `snapNodes` and `applyExtension`, and neither `prompts.ts` marker path nor the scanner/critic
prompts read it - so with the finalizer and end extension dark, a clean-end change moves no request hash at
all. That control is what makes this comparison free, and it is reusable for any future boundary-only change.

---

## 4. Approaches that were tried and failed

The expensive part of this session. Do not retry these without new information.

**Per-candidate similarity for intro-montage detection - failed twice.** The idea: an intro teaser montage is
copied from later speech, so a candidate whose text recurs later is a montage fragment. It cannot work:

- The motivating defect (a 3.03s clip, "Что убьет человечество / Собственная глупость конечно") is six words
  that occur **exactly once** in the 52-minute episode. It scores 0.000 on verbatim recurrence at full
  strength. There is nothing to match, so no threshold could ever flag it.
- A substitution-tolerant scorer built to rescue short fragments voted on a fixed word offset. One inserted
  word split the vote and took the score from 1.0000 to 0.0000 - defeated by the dominant jitter mode.
- Most fundamentally, per-candidate similarity cannot separate "montage copy" from "the speaker said it
  twice", because at the text level those are the same phenomenon. A cold open constructed from a sentence
  the guest genuinely repeats scored 1.0000 and was dropped on both fixtures.

**What works instead:** the unit of decision is the NEIGHBOURHOOD, not the candidate. A montage is a video
that OPENS with a run of sentences each reproducing speech from far away. Measured: the intro region has
**11 of 14 sentences** recurring later, identically across two independent transcriptions; the most any
ordinary stretch of conversation produced across 1623 offsets is **2**; a constructed legitimate cold open
gives **1**. The defect is dropped for where it sits, not for what it looks like. Separation 11 versus 2, not
a 0.059 margin.

The region is anchored at node 0, so a mid-video repetition cluster can never fire the rule by construction -
and the false-positive sweep was run UNANCHORED from all 1623 offsets, which is strictly more permissive, and
still fired zero times. Acceptance: the rule drops **6 of 6** real montage candidates across both fixtures,
**6 of 6** again under each of two adversarial jitter models (respell every fragment, insert filler into every
later original), and touches the constructed legitimate cold open **0 of 6** times. The previous per-candidate
filter dropped 14 of 18 and missed the owner's original defect under a single respelling.

The region is published as telemetry (`teaserRegion`, `teaserDrops` with seconds), which matters more than it
looks: this filter's failure mode is an invisible loss, so the decision has to leave a trace in the job record.

**The transferable lesson, and the reason two attempts failed:** conservatism belongs in the STRENGTH OF
STRUCTURE required to fire, not in the numeric threshold. Both failed attempts were conservative about the bar
while reckless about the unit of decision - they asked "is this six-word fragment a copy?", a question with no
reliable answer at any threshold, then tuned the bar. One of those bars was provably inert (on the short path
the minimum non-zero score is 5/w, always >= 0.5, so any bar in (0, 0.5] behaved identically - the knob was
theatre). Safety came from nowhere. The asymmetry that drives this: a false positive here is invisible,
unrecoverable and unfalsifiable in production - nobody ever reports the clip that was never made - while a
false negative is caught downstream by the finalizer's judge AND by the 6-second duration floor. The good clip
has no backstop; the bait fragment has two.

**A length floor on titles - proposed, measured, and provably inert. The `Плюсы` defect was ours, not the
model's.** The engine shipped a clip on `podcast-answer-arc` titled `Плюсы` - one word, "Pros" - at score
0.66. The obvious reading is that the model wrote a bad title and that a minimum length would have caught it.
**That reading is wrong and the measurement disproved it.**

150 titles were gathered across all four snapshots and every critic verdict in both `responses.json` - kept
and rejected, both models. 102 are distinct. Word counts: 3:1, 4:3, 5:9, 6:17, 7:28, 8:21, 9:10, 10:9, 11:2,
13:1. Characters: min 21, median 49, max 77. **Nothing at one or two words, from either model, kept or
rejected.** And `Плюсы` is not in `responses.json` at all. It is transcript node #316 verbatim, installed by
`regroundCopy` at the SHIPPED stage: the finalizer's trim moved the clip past the nodes its title cited, the
title was voided, and `snippetFallbackCopy` took the first speech node's text as-is. Nothing runs after that
point.

So the categorical unit is **provenance - authored or verbatim - not length**. A length floor inside the
model-authored population fires 0 times in 102 and is provably inert, the same kind of theatre knob as the
0.5 bar above. Inside the snippet population it is worse than inert: 788 clean-start nodes run smoothly
through 1 word:27, 2:53, 3:77 and on, so a floor there is a cutoff through a continuum, which this file
already documents as the wrong shape. The gap is BETWEEN the two populations - 3 words / 21 characters against
1 word / 3 characters - and only a provenance flag can see it.

Fixed in `25956a7` by tracking which titles are snippet-derived, clearing the flag when the finalizer rewrites
one, and giving whatever still carries it exactly one `repairCopy` call. Repair, never drop: the clip cleared
the critic, the evidence gate and the finalizer, and the copy broke only because our own code moved a
boundary. No character count and no word splitting appears anywhere in the path, so the rule behaves
identically across all six locales and in scripts without spaces.

**The transferable point, and the reason this belongs in this file at all:** this is a latent engine defect
that a more aggressive finalizer exposed. gpt-5.1's snapshots did not move when the fix landed - but that is
because gpt-5.1's finalizer happened to trim differently, NOT because gpt-5.1 was immune. Any future model
that trims harder will hit it. It also took a human reading 150 titles to establish that the model was
innocent; the cheap conclusion would have shipped an inert knob and left the real bug in place.

**Guards that turn a content answer into a technical failure - got it wrong four times.** Every round that
ADDED a failure-classification mechanism shipped a user-facing defect on its first attempt: a guard too loose
that billed unjudged work; a guard too tight that failed weak videos (the commonest honest answer there is,
and retries cannot heal it); copy that induced double billing; and an unrecoverable-error mechanism that
cancelled retries on a predicate that was wrong in two independent ways. **Prefer removing mechanism over
adding it, and when torn between asserting something about a failure and staying quiet and retrying, stay
quiet.** But note the one place that instruction went too far: removing the terminal state from the delivery
queue removed its only drain, and 20 permanently-failing rows starved every delivery for everyone. Bounded
mechanism, not no mechanism.

**Fake tests - shipped three times.** A test that re-implements the rule inside its own mock proves nothing;
a test that asserts against the same config constant the code reads is tautological. The discipline that
works: disable the guard by hand (copy the file to /tmp, edit in place, restore, md5-verify - never git) and
watch the test go red. If it stays green it is not a test. `apps/worker/src/__tests__/eval-regressions.test.ts`
carries a provenance comment per rule saying exactly which guard was disabled and what was observed; those
comments have themselves been falsified once and re-verified, so re-check them when the guards change.

---

## 5. The regression harness

The only end-to-end proof this engine has. Live under `apps/worker/src/__tests__/`.

**How it works.** The engine's only non-determinism is its LLM calls - scanner, critic, finalizer, and the
copy repairs that hang off the critic model. They are recorded per fixture, keyed by
`sha256(model, system, user)` - order-independent, because the scanner runs windows concurrently - and
replayed through a stub client. Every deterministic layer runs for real, at zero cost, in milliseconds.

- `helpers/replay-client.ts` - the stub. Records `truncated` and `refusal` outcomes as markers, because the
  critic's batch-splitting depends on them and a recording without them is unreplayable.
- `helpers/eval-fixture.ts` - `loadFixture`, `runFixture` (throws on a stale fixture), `toShape`.
- `helpers/eval-fingerprint.ts` - fingerprints the engine config into the fixture. Without it a knob change
  silently invalidates every recording while the suite stays green - which happened, and the harness
  certified an already-fixed bug as correct.
- `eval-snapshot.test.ts` - replays both fixtures and compares to the blessed shape.
- `eval-regressions.test.ts` - the named defects the owner found in real clips, each with its provenance.
- `eval-variants.test.ts` / `eval-variant-args.test.ts` - the whitelist, the per-variant snapshot routing, and
  the argument parser both scripts share. The parser is pinned because every way it can be wrong ends in a
  fixture silently skipped or work recorded under the wrong model, and in `eval-topup`'s case that is not
  visible until the bill arrives.
- `scripts/eval-record.ts` - records a fixture from a real job against the LIVE API. Costs money. Manual.
- `scripts/eval-topup.ts` - buys only the requests a fixture is missing, e.g. the single c8 re-ask that
  `e85bf6b` needed. `--variant NAME` tops up only what that variant adds. Costs money, but a few cents
  rather than a full re-record.
- `scripts/eval-bless.ts` - prints a readable diff before rewriting a snapshot. The diff is the review
  artefact: a human decides from it whether a change is desirable. `--variant NAME` blesses
  `snapshot.<NAME>.json`; base and variant never read or write each other's file.

**Variants: how one fixture holds two engines' answers.** `fixtures/eval/variants.json` declares named
variants that override only WHO ANSWERS - `criticModel`, `finalizerModel`, `criticModelFallback` - or WHICH
STAGES RUN, which since 2026-08-04 means `endExtensionEnabled` and nothing else. Never what an existing stage
is asked. The narrowness is enforced twice: a whitelist that throws at load, and a `satisfies` clause
that turns widening it into a `tsc` error. Widening it to windowing or batching would change every prompt,
therefore every request key, and turn the cross-variant diff back into the mixed signal the mechanism exists
to avoid. One fixture can hold both models' recorded answers because the model is part of the request key; the
scanner's keys are identical across variants, so its answers are shared byte for byte and the candidate set
entering the critic is provably the same one.

Since `88a4435`, **`base` is Luna and `gpt51` is the variant** holding gpt-5.1's answers, so the migration
comparison in §3 stays reproducible offline and for free. It also means the gpt-5.1 recordings are a live
asset, not history: deleting them deletes the only control this engine has for a model swap.

**The fixtures.** Four sources, ten replay cases (each fixture's base, plus `gpt51` on the two podcasts and
`end-extension` on all four).

- `podcast-ecology` (job `cmrzcqhl6000138lkg41n8bs0`) and `podcast-answer-arc` (job
  `cmrvawjxs00129pvw0oe1c1kv`). **These two are transcription runs of the SAME 52-minute Russian episode**, so
  they are one piece of source content and an honest A/B on transcription jitter at the same time. The A/B is
  unflattering: the same moment ships clean in one run and broken in the other. The clip-count spread has
  narrowed as the budget defects were fixed - 6 versus 10 when that gap was first recorded, then 12 versus 12
  on gpt-5.1, and 10 versus 11 on Luna today - but a matching count is not agreement, and the per-clip
  differences never went away.
- `sitcom-friends` (job `cmscht6rp001xq41s5rhjx6q0`, recorded 2026-08-03) - 41 minutes, English, and the first
  fixture that is not a podcast. It is a user-uploaded COMPILATION REEL: roughly 30 unrelated scenes with hard
  cuts and no through-line, which is a source class nobody had listed. It is the only fixture with scene
  boundaries in it and therefore the only one on which the scene rail (§3) does anything at all.
- `creator-challenge` (recorded 2026-08-03, also a real outside upload) - English, unscripted group banter,
  and the second source with hard cuts (max node-to-node hole 9.98s, 6 at or above `sceneGapSec`).

Two of the four are still the same episode, so a Russian, conversational, uncut source remains
over-represented, and §6a still wants a fifth of a different shape again. But the corpus is no longer
single-content, and that is what made the end-extension measurement mean anything: the stage is net positive
on the podcasts and net negative on the compilation, and a two-podcast corpus would have reported an
unqualified win.

**What the harness cannot do.** Replay uses the OLD recorded LLM responses, so it verifies that deterministic
layers did not regress - it cannot measure a prompt change. For that, re-record and read the diff, or upload
a real video. A green run is not "quality is fine".

**A green replay is evidence about the CORPUS, never about the code.** Measured 2026-08-04, and worth stating
as a general property because it is the reusable part: an eval fixture can only exercise the branches its own
recorded run happened to reach. The instance that produced it: the nested-word clamp in `endSecFor` is the
guard that stops a clip cutting its own last word, and deleting it leaves **all six replays then in the corpus
green** while failing exactly **one** test out of the 791 the worker suite held at the time. Deleting the tail
hold, the line directly beside it, reddens **all six** replays and 22 tests. So the harness does watch clip-edge
seconds; it is blind specifically to that branch, because no shipped clip on any of the four sources ends on a
node whose nested end overruns its successor. Until 2026-08-04 that clamp was guarded by nothing in this
repository. Confirmed twice, by the implementer and independently by a reviewer running the tail-hold control,
because a single mutation run that stays green is indistinguishable from a mutation that did not apply.

§6a already argues for a genuinely different source on RECALL grounds. This is the same argument from the
coverage side, now with a measured instance behind it: a fifth fixture buys branches, not just assertions.

**The harness is env-blind by construction, and a default-off stage is therefore invisible to it.** Every
config in `eval-fixture.ts` is built from `loadAnalyzeConfig({})` - an explicitly EMPTY env - so
`END_EXTENSION=on` in the environment cannot reach a replay no matter where it is set. That is deliberate: a
fixture must replay identically on any machine. The consequence is that measuring a stage that ships off
requires a declared VARIANT, which is why `endExtensionEnabled` was admitted to `VARIANT_OVERRIDE_KEYS` - a
variant may now change WHICH STAGES RUN, not only who answers. `endExtensionWindowSec` was deliberately
refused at the same time: a variant that tunes a threshold is a tuning door, and the whitelist exists to keep
the cross-variant diff to one changed thing.

---

## 5a. FINALIZE, and what it actually did

One LLM call over the whole shipped set, with every model decision code-gated. Landed 2026-07-26. Measured on
the fixtures by replaying the SAME scanner and critic answers twice, with the stage off and on - a git diff of
re-recorded snapshots mixes the stage's effect with LLM variance and cannot answer "what did the judge do".

**Everything in this section was measured with gpt-5.1 as the judge, which is now the `gpt51` variant and not
what ships.** The mechanism, the gates and the question-detection measurement below are model-independent and
stand. The behavioural claims - which rules fire, how often, how willing the judge is to drop - do not: Luna
vetoed 3 clips on `podcast-ecology` where gpt-5.1 vetoed 0 (§3). Read the rest of this section as a
characterisation of gpt-5.1's judging, and re-measure before quoting any of its frequencies about today's
engine.

What it earned:
- It caught the owner's flagship defect verbatim. A 62s malaria clip ends on `"летающих пауков ядовитых"` -
  grammatically clean, every boundary check passed - and `"Летающих пауков? Это откуда?"` falls **0.4s after
  the cut**. Dropped as `no_payoff`.
- It repaired a meandering opening, removing 10.2s of reply grammar and an on-air name search.
- It rewrote a title the critic had left ungrammatical and truncated mid-word. Nothing else in the engine
  reads a title back against the finished clip.
- A code gate refused a trim the judge proposed which would have pushed a question outside its own answer -
  the gate caught the model trying to fix defect 3 by manufacturing defect 5.

What it got wrong, and this is the useful part:
- **It created the defect its own rule 5 names.** Trimming answer-arc clip 5 from node 866 to 870 removed
  `#869 "какие претензии"` and left the clip opening on the answer. Every gate passed; the PROMPT failed,
  because rule 3 (trim the meandering opening) and rule 5 (do not open on a borrowed answer) are in tension
  and rule 3 won. Closed in code by `6d24a55`: a trim is refused when the first substantive thing in the
  removed run is a question.
- **Rule 5 fired zero times** across both fixtures - including on a clip sitting right there with exactly
  that defect.
- **Rule 4 is roughly a coin flip.** The same malaria moment, ending 0.4s before the same reaction, was
  dropped in one fixture and shipped in the other.
- **Its trims can void a title, and until `25956a7` nothing downstream could fix that.** A trim that moves the
  clip past the nodes its title cited leaves `regroundCopy` installing a raw transcript node as the title -
  the `Плюсы` defect, §4. This is the stage's most dangerous property: it is the last thing in the pipeline
  that moves a boundary, so anything its move breaks has to be repaired by code that runs after it.
- **Dropping is expensive medicine.** The malaria clip is otherwise strong; the real repair is three nodes on
  the END, but end-trimming is out of scope by spec (it protects payoffs), so `drop` is the only verb the
  stage has. Answered on 2026-08-04, and not by giving the judge a third verb: the repair lives in a separate
  stage that runs BEFORE it (§3), so the finalizer still gets the last word on a boundary and still has only
  `drop` and `trim`.

**Question detection, measured.** Word-bearing node text is virtually punctuation-free - 2 of 609 nodes on one
fixture, 2 of 584 on the other - because those nodes are assembled from Whisper WORD tokens while only opaque
nodes carry punctuated segment text. So a question-mark test can never fire on the nodes that matter;
`какие претензии` has no mark and never could. What works is an interrogative in ONSET position after skipping
discourse particles. Onset matters: `"Но вернуться к прошлому более высокому почему нет"` contains `почему`
but is not a question, so a contains-test refuses a correct repair. Particle-skipping matters because the two
fixtures transcribe the same question as `"какие претензии"` and `"Да А какие претензии"` - an anchored test
sees one and misses the other, defeated by the same indel jitter as everything else. Capitalization and
`leadingStrength` were both measured and rejected as signals.

## 5b. The only real-world verdict we have

2026-07-26. The owner uploaded a 52-minute Russian podcast (job `cms2c8ahm000droa7tcqh30ho`) and got 8 clips.
This is the only judgement of shipped output by anyone other than the engine's own tests, so treat it as the
scoreboard.

**Caveat added 2026-08-01: those 8 clips were chosen by gpt-5.1.** The critic and finalizer are Luna now, and
on the fixtures the two judges ship the same moment 9 times out of 12 on one and 6 out of 12 on the other
(§3). Nobody has looked at a Luna clip. The 2-of-8 hit rate is still the best number this project has, and it
is now a number about a judge that no longer runs - the defect vocabulary below is about the material and
survives the swap, but the rate itself is unverified on what ships today.

**He would post 2 of 8.** The reframing he called a clear win - wide two-person shots are stitched properly
now, and that half of the product is settled. On the clips: one he would definitely post ("Что на самом деле
может уничтожить человечество", 0.80, 43.3s), one probably ("Главные разрушители планеты?", 0.80, 69.5s), and
of the rest, in his words: **"either uninteresting, or the beginning or end is unclear."**

Two facts to carry forward from that:

**The score does not rank by postability.** The clip he would post scored 0.80, joint fourth. Two clips scored
higher and he would not post either. Whatever the critic's score tracks, it is not "would a clipper publish
this".

**Even his second pick was broken, and he spotted what no check did.** It ends on `"Планета еще и не такое
видала"` - grammatically complete, the question's answer inside the clip, payoff present, every gate happy -
and three sentences later the speaker delivers the specifics that substantiate it. His words: "it seems to cut
off". See §4 for the rule that tried to fix this and had to be reverted.

**The diagnosis, and its headline: the engine damages clips the critic gets right.** Three of the six weak
clips were broken AFTER the critic had approved a coherent arc - two by the over-length compression walking the
start forward and deleting the premise, one by end selection. The critic is doing better work than the code
that follows it. Fixed since: compression now uses the shared `isCleanStart` (it had its own weaker test), copy
evidence is re-checked against the boundaries that actually shipped, and the critic budget no longer withholds
half the pool.

### Defect vocabulary from that job

Names for things the engine could not previously talk about. Each has a real example in that transcript.

| Name | What it is | Real case |
|---|---|---|
| Orphaned cause | Opens on a consequence marker whose antecedent the length cap deleted | `"Поэтому все неафриканское человечество имеет…"`, its premise 0.1s outside |
| Orphaned premise | The question the clip answers was cut by compression | Survivability clip: compression walked the start forward 4 nodes / 30.7s past the question |
| Refuted conclusion | Ends on a claim the source overturns immediately after | `"мы самые живучие на планете"`, then `"по части устойчивости к ядам, крысы гораздо живучее нас"` |
| Cut inside an anaphoric run | Ends on the first beat of a rhetorical build | The `"Планета… Планета… Планете"` figure |
| Drag | An interior clarification ping-pong nothing can see - the critic reads a padded window, the finalizer has no verb for interior content | `"Надежда на эволюцию для кого? - Для человека. - Для человека? - Или только на прогресс?"` |
| Arc stacking | One clip carries several complete arguments; a viewer who came for one question is asked to sit through three | The 0.90, 86.9s clip: successful species -> closing the carbon cycle -> spaceflight as biosphere immortality |

**Arc stacking has a second and much sharper instance, from 2026-08-04.** On `sitcom-friends` the extended
clip at 1165.4 carries two UNRELATED SCENES, not two arguments in one conversation: the editor's phrasing is
"two unrelated scenes stapled into one clip" (§3). It is the same defect at a source-cut boundary rather than a
topic boundary, and it is worth having both cases under one name, because the compilation instance is
mechanically detectable (a silent hole in the timeline) where the podcast instance is not.

**Arc stacking and drag are the "uninteresting" half of his complaint, and NOTHING in the engine measures
them.** `maxSec` of 90 is a platform limit, not a taste bound. Every fix shipped so far addresses edges. If the
hit rate is to move, this is where the next work goes - the shape of the question would be "one clip, one
question" rather than another boundary rule.

## 6. Invariants that must not break

**Billing.** `usage.service.getMinutesUsedInPeriod` sums jobs whose status is NOT `FAILED`. So a job that
completes DONE with zero clips BILLS the user, and one stuck in a processing status bills forever. Therefore a
technical failure must never present as a content answer. The converse matters just as much: a weak video is
the commonest honest answer there is, and turning it into FAILED denies the user a real reply and burns three
retries that cannot help, because the critic rejects the same moments every time.

**Boundaries are code-owned.** Any boundary a model proposes goes back through `snapNodes` and is discarded
if snap rejects it. The one stage that does not re-run snap is end extension, and it is allowed to skip it
only because it can never shorten: it converts its own node index to seconds through `endSecFor`, the exact
function snap uses for the same job, so the two cannot place the same node differently, and it re-checks
opacity, `isCleanEnd` and `maxSec` itself. Widening also cannot invalidate copy - evidence already inside a
range stays inside a larger one - which is why it needs no `regroundCopy` re-run and why the same shortcut
would be wrong for anything that can pull a boundary back.

A rewritten title must cite evidence nodes inside the final range - and be re-checked
AFTER any accepted trim, because a trim can move the evidence outside. When that re-check voids a title the
replacement is a raw transcript node, so a boundary move can silently degrade copy that every gate already
passed; whatever still carries the snippet flag at ship time gets one repair call, and a clip is never dropped
for its copy (§4). That last clause became true of the WHOLE engine on 2026-08-04: `evidenceGate` had been
contradicting it pre-snap since it was written, and no longer does (§3).

**`NAME_TO_ISO` must cover everything Whisper can emit.** `analyze-v2/language.ts` maps Whisper's full
English language name onto the ISO code stored in `Job.language`. A missing name is not cosmetic: the lookup
returns null, `Job.language` stays unset, and `isoToLanguageName` then feeds ANALYZE and the critic
`"the transcript language"` instead of naming it - the one place the output language is stated explicitly
degrades to a hint. It held 41 names until 2026-07-27, silently dropping Persian, Malay, Urdu, Tagalog,
Bengali, Tamil and ~50 more; it now holds Whisper's whole set, with alternative spellings (castilian,
mandarin, burmese…) resolved through a separate alias map so they can never become the name used in a
prompt. One name per code - the map is reversed for `isoToLanguageName`, so a duplicate code would let key
order decide what the model is told.

**`lexicalOverlap` is telemetry, never a gate.** It penalises paraphrase and inflected languages; using it to
gate Russian copy would reject legitimate rewrites. This is documented at its definition; it has been
proposed as a gate once and rejected.

**Never touch `apps/web/lib/auth.ts` or `apps/web/lib/telegram-provider.ts`** while the owner's Telegram OIDC
work is uncommitted there (67 insertions / 9 deletions as of 2026-07-25). `git stash` disturbed them once.

---

## 6a. Open follow-ups on ANALYZE

Ordered by expected effect on the owner's 2-of-8 hit rate, most valuable first. That ordering is a guess and
was partly falsified on 2026-08-04: on the one source that has been audited clip by clip, broken framing and
recap titles each appear in 11 of 11 editor verdicts while early ends were roughly the fourth-largest defect.
`docs/superpowers/specs/2026-08-04-clip-quality-programme-design.md` §5 carries the measured order; this list
is the residue that programme does not cover.

- **Arc stacking and drag - the "uninteresting" half.** See §5b. No mechanism measures either. This is the
  only item here that plausibly moves the hit rate rather than the polish.
- **Nobody has judged a Luna clip.** The critic and finalizer swapped models on 2026-07-31 and the shipped
  sets overlap on 9 of 12 and 6 of 12 (§3). The swap was justified on cost and on token budget, both
  measured; whether Luna is a BETTER editor is unmeasured, and unmeasurable in the harness, which only proves
  the deterministic layers did not regress. One real upload put in front of the owner answers this, and it is
  cheap.
- **Compression and trims enforce contradictory policies on the same structure.** `tryTrim` refuses a boundary
  move that orphans a question (`orphansQuestion`, shipped `6d24a55`); `snapNodes` compression performs one -
  its headline repair opens on `"Ну как живучий смотря по каким параметрам сравнивать"` while the question
  `"…самый живучий вид на планете или все-таки нет?"` sits immediately outside. Unify them.
- **The punchline-outside case now has a repair, and it is switched off.** The owner lifted the
  protect-payoffs restriction on 2026-08-04 and `extendClipEnds` shipped (§3). What is still open is not the
  mechanism but the routing: it is net positive on podcasts, net negative on compilation reels, and off by
  default until the scene rail can see a cut the audience laughs through. Note also that FINALIZE itself still
  has only `drop` and `trim` - the extension is a separate stage upstream of it, so a clip the judge drops as
  `no_payoff` still has no repair path, and the extension made exactly one such drop happen.
- **Tell the finalizer's judge about the teaser region.** The detector publishes `teaserRegion`; passing it
  into the finalizer prompt ("the first N seconds of this video are a trailer montage") turns a deterministic
  drop into a prior the judge can weigh, and helps it reason about clips that start near the boundary.
  Suggested by the design that produced the detector; not implemented.
- **The corpus is still short of shapes.** Two English sources landed 2026-08-03 and immediately earned their
  keep (§5), so this is no longer "one episode" - but everything in it is people talking to each other in a
  room. A gameplay stream, a solo talk to camera, or a third language would each buy branches the current four
  cannot reach, which is the coverage half of the argument as well as the recall half.
- **Clips that open one node after a question, chosen by the CRITIC with no trim involved.** Two ship today.
  The trim gate cannot reach them; closing this means a rule on original critic boundaries, which is snap's
  territory and a strictly larger change than the gate was.
- **Scan windows are budgeted from `speechSec` too** (`buildScanWindows`, 600s of word-bearing speech per
  window). Same measurement error as the critic budget had: the window that counted 600s of speech actually
  renders ~1130s of transcript to the model, so this source yields 3-4 windows where it should yield 7-8.
  That halves both the per-window quota and the scanner's own 12-moments-per-window ceiling, so it costs
  recall twice over. NOT fixed with the critic budget: it changes every scanner prompt, roughly doubles the
  candidate pool, and would put K back into contention - it deserves its own measurement and its own
  re-record.
- **`regionMaxCandidates` now costs candidates for no gain on ordinary sources.** It exists to stop one
  10-minute stretch eating a scarce budget; with K no longer binding it dropped 3 and 5 pool candidates on the
  two fixtures purely as a diversity rule. Kept as-is because it is still the mechanism that spreads a budget
  that DOES bind on a long source, but it is now the largest unjudged residual.
- **The critic may return a node range outside the candidate it was given.** critic.ts validates node refs
  against `[0, maxNode]`, not against the candidate. Observed on answer-arc: candidate `c16` spans nodes
  313-319 and its shipped clip spans 324-332. Snap re-validates, so this is not a boundary-safety problem, but
  it does mean candidate-to-clip attribution is approximate and any analysis keyed on it should say so.

## 7. RENDER: smart reframe

Per-shot 9:16 framing. `apps/worker/src/reframe/`: ffmpeg `scdet` shot detection -> YuNet face tracks via a
thin Python sidecar -> pure-TS layout decision (single face-crop / split-screen stack / centre) -> one
ffmpeg filtergraph, single encode pass with the subtitle burn.

**Measured gotchas.**
- scdet at threshold 0.4 found ZERO cuts in a 44-second window that visibly contains five. Dark same-studio
  podcast cuts score 0.3-0.4. Default is now 0.3 with a half-threshold retry for zero-cut windows of 15s+.
  Under-segmentation is invisible and merges different camera angles into one mega-shot whose mixed face
  tracks force a centre crop - the "empty middle" the owner reported. Over-segmentation self-heals in the
  merge pass.
- ffmpeg's `av_expr` nesting fails at 100 segments (99 parses, 100 does not), so plans are capped at 90 shots.
- A split tile needs `ih*9/8` of width, roughly twice the single-crop width, so sources narrower than 9:8
  cannot split - they would emit `crop w > iw` and fail the ENCODE, bypassing every detection-time fallback.
- YuNet is trained on real human faces. Anime and stylised faces are expected to miss (believed, not
  measured). Faceless content gets a centre crop; a saliency or motion-based crop would serve gameplay,
  anime, sports and screencasts at once, and is the highest-value next step for RENDER.
- Known open defect: a human face inside an on-screen photo or infographic is detected as a second speaker
  and can trigger a false split. A static-face guard (a photo has zero mouth motion and zero box variance)
  would close it.

### 7a. Stream sources: the webcam-inset layout (built 2026-08-02)

Spec `docs/superpowers/specs/2026-08-02-stream-reframe-design.md`, plan `.../plans/2026-08-02-stream-reframe.md`.
Defaults **off**, but **`REFRAME_STREAM=on` is LIVE in prod since 2026-08-03** (in `.env`, which is not in
git; a backup of the previous file is at `.env.bak-pre-stream`). Rollback is `REFRAME_STREAM=off` followed by
`docker compose up -d worker-render` - `compose restart` does NOT re-read `env_file` - and then
`npx prisma generate --schema=/app/prisma/schema.prisma` inside the recreated container. The min-face guard
below is unconditional and unaffected by the flag.

**The defect it fixes, measured not assumed.** On a stream the streamer's webcam is a small inset over
gameplay, so the detector correctly finds a face that is **3.4% of frame width** (43x56 in 1280x720) against
15-30% for a podcast. The planner then centred a 9:16 window on it and produced a truncated webcam, the
streamer's chat overlay, and a slice of game floor - the game essentially absent. Rendered and inspected on a
real 55-minute CS2 VOD before any code was written.

**The min-face guard is the cheap half and it ships alone.** A face below `REFRAME_FACE_SMALL_FRAC` (0.06) of
frame width may not anchor a crop. That single rule removes the broken output on **every** unrecognised
stream layout - including chroma-key webcams that have no rectangle to detect at all - and needs no flag, no
detector and no plan-format change.

**Tile geometry inverts the obvious adjustment.** `Hg = Hs * 1080 / Wg` and `Hc = 1920 - Hg`, so a TALLER cam
tile needs a WIDER content window. When the window will not fit beside the inset, the cam share must be
REDUCED. Got backwards once during design.

**Four things that were wrong and are worth not rediscovering:**
- OpenCV's Sobel uses `BORDER_REFLECT_101`, so at column 0 the virtual column -1 *is* column 1 and the
  derivative is identically zero. `vx[:,0]` and `hy[0,:]` can never carry energy - and a corner-flush inset,
  the primary case, has its borders exactly there. As first specified the detector scored the true rectangle
  **0.00** and lost to an arbitrary interior box. Canvas-edge sides are now skipped rather than scored.
- The inset size cap bounded **width only**. Under area-based selection that let a box of the inset's correct
  width but the frame's full height beat every real candidate. That omission alone was the difference between
  26 correct rectangles out of 26 and **0 out of 26**.
- Selecting the highest-scoring rectangle rewards shrinking, because each border is a mean over the
  candidate's own span: trimming `x0` inward raises the top and bottom means. Right, bottom and top edges were
  exact in 26 of 26 windows while the left was exact in 16. Selection is by largest area among candidates
  clearing the bar.
- `evenRound` rounds UP, so using it on an upper bound raises the value past the ceiling it is clamping to.
  Bounds must tighten to even BEFORE the clamp, never after. Demonstrated escape: a crop reaching x=946 with
  a right edge of 1282 on a 1280-wide frame.

**`REFRAME_PIP_EDGE_MIN` = 4.0 is the only threshold here that was measured.** 40 windows of the fixture: 26
true detections scored 5.65-8.84, the strongest false candidate 1.54, and every threshold in 3.0-5.0 gave
identical output. **The corridor exists because of the size cap** - measured without the height cap the usable
gap was ~10% around 6.0. So 4.0 is robust GIVEN `PIP_MAX_FRAC = 0.5` on both axes; loosening the cap for a
source with a large inset requires re-measuring. Two knobs that read as independent are not.

**`setsar=1` after each `scale` is required, but not for the reason first recorded.** The segfault is real
with `vstack`; the shipped graph composes with `overlay` and does not crash without it. The actual reason is
that `scale` derives each tile's sample aspect from its own crop aspect, so the composite would be assembled
from three different pixel aspects. Recorded precisely because a wrong justification invites someone to delete
the filter, see no crash, and conclude it was superstition.

**Pre-existing, unrelated, and worth fixing separately:** every reframe clip ships `SAR 406:405` rather than
1:1, because `cropWidthFor` rounds the crop width to even (406 from a 720-high source) while `scale` preserves
display aspect. Output displays about 0.25% wide of true 9:16. The legacy `crop=ih*9/16` path is exact; the
split path drifts the same way. Found during the stream work's encode verification, not caused by it.

**Backlog, deliberately not fixed:** `buildCropPlan` computes `maxSamples` over ALL tracks, including ones the
min-face guard then discards, so `MIN_SAMPLE_FRAC` is measured against a track that will not survive. Never
produces a wrong anchor - only "more conservative than necessary" - but it bites in an unmeasured case: a
PODCAST with a persistently-detected background face plus an intermittently-detected speaker drops the
speaker for being rare relative to a track that is itself discarded. A two-line reorder, but it changes which
sources get anchored and needs its own measurement.

**What this rests on, stated plainly: ONE video, one streamer, one OBS layout, corner inset.** The mechanism
is validated end to end - detector, solver, classifier, filtergraph, and a real 1080x1920 encode. The numbers
are not. 26 of 26 is 26 windows of the same static compositing box. A second and third source of a different
shape are needed before any threshold here is treated as known.

**`apps/worker/src/scripts/eval-reframe.ts`** exists so the next framing question is seen rather than argued:
a video and a time range in, the computed plan as JSON and a contact sheet out. **The CS2 fixture VOD it was
developed against was deleted on 2026-08-03** at the owner's request (1 GB). The three 640-wide frames the
sidecar tests need are committed at `apps/worker/assets/reframe/testdata/`, and both suites pass without the
video - but the harness itself needs a video, so re-running it means sourcing a stream VOD again.

**Regression check on existing sources, done before enabling.** Nine pre-existing layout assertions in
`reframe-plan.test.ts` still carry byte-identical expected values (`x` of 496, 656, 596, 236, 96), still under
exact `toEqual`. One test's FIXTURE changed - the middle face in the dominant-pair case went 60px to 130px -
because the new min-face guard was silently discarding it and the test had begun passing through a different
branch, leaving `DOMINANCE_LEAD`'s accept side with no coverage at all. The asserted outcome is unchanged.
**No podcast was rendered end to end**, because this repository has no podcast VIDEO fixture, only transcripts.
The guard fires below 6% of frame width, which is 115px on a 1920-wide source against the 15-30% a podcast
actually shows, so the margin is wide - but it is an argument from geometry, not a measurement.

### 7b. The framing geometry, measured (2026-08-05)

Plan `docs/superpowers/plans/2026-08-05-reframe-geometry.md`, task 1. `broken framing` stood in 11 of 11
editor verdicts on the 2026-08-04 audit, and the diagnosis on offer named two branches of one condition
(`plan.ts:195`). One of the two reproduced, one did not, and the branch that actually does the damage was
named in neither.

**Method.** Two passes. The free one reads `Clip.cropPlan` for every rendered clip in the database that has
one - 9 jobs, 76 clips, **369 distinct shots** across four source sizes - which is the shipped plan and needs
no detector. The expensive one re-runs `detectShots` + `detectFaces` + `buildCropPlan` over the 12 clip ranges
of the audited sitcom job `cmsei6r190001zppef93vft6s`, because the face boxes and `mouthActivity` exist only
inside `computeCropPlan` and are persisted nowhere. **The replay reproduces all 12 shipped plans byte for
byte** - layout, `x`, `top.x`, `bottom.x` and every shot boundary - so the second pass measures the engine
that shipped rather than a re-derivation of it. All 12 cost **41 seconds** end to end, which is cheap enough
that the next framing question should be measured the same way rather than argued.

**Split tiles CANNOT be disjoint on any ordinary source, and this is arithmetic, not tuning.** `tileWidthFor`
is `h*9/8` and each tile's `x` is clamped into `[0, W - tileW]`, so the widest separation two tiles can ever
have is `W - tileW` and the narrowest overlap is `2*tileW - W`. As a fraction of a tile that floor is
`2 - 8*(W/h)/9`, which reaches zero only at an aspect of **2.25:1**. Every source we have is narrower:

| source | cropW | tileW | max tile separation | minimum possible overlap |
|---|---|---|---|---|
| 1280x720 | 406 | 810 | 470 | 340 px = **42.0%** |
| 640x360 | 202 | 406 | 234 | 172 px = **42.4%** |
| 640x352 | 198 | 396 | 244 | 152 px = **38.4%** |
| 848x464 | 262 | 522 | 326 | 196 px = **37.5%** |

So "split only when the tiles are genuinely separate" is not a threshold to derive - on 16:9 it is the
instruction to never split. **55 of the 124 shipped splits are already sitting on that floor**, both tiles
clamped hard to opposite edges, and all 54 splits of the 640x360 source measure exactly 42.4% because every
one of them is clamped. A design that wants disjoint tiles has to make the tiles narrower than `h*9/8`, which
means cropping them vertically as well, which is a different filtergraph.

**Measured split overlap, `(tileW - |bottom.x - top.x|) / tileW`.** Over all 124 split shots in the database:
min **37.5%**, p25 42.4%, **median 48.0%**, p75 53.5%, max **98.5%**, mean 49.4%. **124 of 124 exceed 25%**
and **49 of 124 exceed 50%**. The worst case is a 848x464 clip with tiles at 118 and 126 - eight pixels apart
out of 522, the same picture stacked on itself. Over the 19 splits of the audited sitcom set alone: min 39.4%,
median **51.0%**, max 62.6%, 19 of 19 over 25%, 12 of 19 over 50%, in **8 of 12 clips**.

The instance the diagnosis named reproduces. The sitcom's first clip splits at t=1.37 with tiles at `x = 0`
and `x = 202`; `tileW` is 396, not the 392 that was estimated, so the overlap is **49.0%** against a claimed
48%.

**The "55% at the commonest firing" arithmetic was right in direction and wrong in detail, and the error is
worth keeping.** It assumed tile centres land `FIT_MARGIN * cropW` apart at the gate. They do not: the gate
tests the face bbox **span** (outer edge to outer edge) while the tiles are centred on face **centres**, so
tile separation is the span minus one face width. Median anchorable face width here is 63px, so a shot
tripping the gate exactly would put its tiles 115px apart - **71% overlap, worse than the estimate**, not
better. The measured median is 48-51% because real firings clear the gate by a wide margin, not because the
mechanism is milder than described.

**The single branch does NOT point at furniture. This half of the diagnosis is disproved.** Of the 22 single
shots, only **4 have two or more anchorable faces at all**. In those four the chosen anchor sits **0.005,
0.047, 0.065 and 0.118 of `cropW`** from the nearest face centre - the worst is 23px on a 198px window - and
in all four *every* anchorable face centre is inside the window, none of them even in its outer fifth. Across
all 22 singles the median is 0.005 `cropW`. This is structural rather than lucky: the branch is only reached
when the whole span fits inside `0.9 * cropW`, which bounds the midpoint at `0.45 * cropW` from either
extreme, and measured single-branch spans run 0.25-0.69 `cropW`. **Task 3 as written is aimed at a defect
that is not there.**

**The crop that tracks the table is the CENTRE branch, and it is much bigger than the split.** 16 shots take
`layout: "center"`. Only 4 of them are faceless or below the 6% min-face guard. **The other 12 have anchorable
faces and are centred blind because the 3-plus-face `DOMINANCE_LEAD` test failed** - the top two do not lead
the third by 1.5x, so the planner gives up and centres. That is **147.8 seconds of 333.5 (44% of shot time)
spent on a blind centre crop over a shot with detected, anchorable faces**, in 9 of the 12 clips. The centre
of that window sits a median of **0.27 `cropW`** from the nearest face centre and a maximum of **0.59**, and
in **4 of the 12 the nearest face centre is more than half a crop width away, i.e. outside the window
entirely**. The longest single instance is 16.3 seconds of a 28.8-second clip. The weak-coffee clip whose
payoff frame the editor called a flower vase closes on 26.2 seconds of exactly this branch. Centre is
supposed to be the degradation path; on a four-person sitcom it is the *modal* layout by screen time
(47.2%, against 32.1% single and 20.7% split).

**The middle case is not a case, it is the whole population.** Of the 35 shots with two or more anchorable
faces, 4 fit inside the single gate and 31 do not. Of the 19 that reached the split branch, the chosen pair's
centre separation runs 147-390px against a `tileW` of 396 and a maximum achievable tile separation of 244:
**19 of 19 are in the band where the faces are too far apart for one window and too close for two tiles**, and
124 of 124 are corpus-wide. 8 of the 19 are clamped on at least one edge, so their tiles are already as far
apart as the frame permits. There is no separable population to carve off - whatever the middle case gets is
what the split layout becomes.

**`mouthActivity` is live, but `dominance` barely listens to it.** 126 anchorable-face observations: min
0.0116, p25 0.0368, **median 0.0492**, p75 0.0659, max 0.2492, and **no zeros**. Within a shot the max/min
ratio across faces has a median of **1.83** (range 1.02 to 6.04), so it does distinguish faces. The
`Math.min(1, m * 10)` cap saturates for only 7 of 126 (5.6%), all of them above the 75th percentile, so the
cap is not flattening the signal either. **What flattens it is the weight.** `0.2 * mouthTerm` spans
0.023-0.200 while area and centrality carry 0.8 between them: **deleting the mouth term outright would change
`dominance`'s argmax in only 3 of 35 multi-face shots**, and `dominance`'s argmax coincides with the
`mouthActivity` argmax in **17 of 35**. Anchoring "on the dominant face, which already carries
`mouthActivity`" therefore anchors on the largest, most central face and disagrees with the mouthiest one half
the time. Using this signal to pick a speaker means using `mouthActivity` directly or reweighting, not reusing
`dominance` as it stands.

**And the signal has never been validated as speech.** It is the mean absolute difference between consecutive
normalized mouth patches at a 2 fps sample rate. Head turns, laughter, gesture, a cut inside a shot and plain
detector box jitter all produce it. That it varies between faces is measured; that the higher value is the
person talking is **believed, not measured**, and nothing in this repository tests it. A fixture with
per-shot "who is speaking" labels would settle it, and any anchor-on-the-speaker work should buy that first.

### 7c. The split is gated on the tiles, and the blind centre is gone (2026-08-05)

Same plan, tasks 2 and 3, built together because they turned out to be one change: refusing a split
sends those shots into the branch task 3 fixes. `plan.ts`, two rules.

**A split now requires its two tiles to be disjoint AFTER the clamp - `bottom.x - top.x >= tileW` -
and nothing else.** That single test is the whole geometry: it is satisfiable only when
`2 * tileW <= sourceWidth`, i.e. an aspect at or past 2.25:1, and it subsumes the old
`tileW <= sourceWidth` encode guard, because tiles that far apart both fit in frame by construction.
It was deliberately written as the exact constraint rather than as the aspect test it implies: the
aspect test admits shots whose faces are close enough that the tiles still overlap on a wide source,
which is the same defect on a different source. **Narrower tiles are still not attempted** - they
need each tile cropped vertically as well, which is a different filtergraph.

Watch the rounding: `tileWidthFor` rounds UP to even, so on a 1080-high source the floor is a width
of 2432 and not the ideal 2430. At 720 high the arithmetic is exact and 1620x720 splits, 1618x720
does not.

**Every shot that cannot split, and every shot where `DOMINANCE_LEAD` fails, now anchors on the
faces one window can hold whole instead of centring blind.** `bestFaceGroup` enumerates the maximal
runs of faces whose bbox fits inside `0.9 * cropW` and takes the run with the most total face area,
ties to the run nearest the frame centre and then to the leftmost. The window is then the existing
single-crop rule (bbox midpoint, clamped), which §7b measured innocent.

**Total face area, and not `dominance`, deliberately.** How much face a window contains is a
measurable property of the frame. Who is speaking is not: §7b showed `mouthActivity` is a 2fps
frame difference that a head turn produces as readily as speech, unvalidated anywhere in this
repository, and that `dominance` agrees with it in 17 of 35 multi-face shots. So this anchor does
not claim to find the speaker - it claims to point the window where the faces are instead of where
they are not. **Anchoring on the speaker still needs a per-shot ground-truth fixture first**, and a
test pins that the chosen window does not move when `mouthActivity` moves, so the choice cannot
quietly acquire that dependency.

Three properties fall out and are pinned by tests: the chosen group is never sliced (a run fitting
in `0.9 * cropW` stays whole through the clamp), the answer does not depend on detector order, and
a face WIDER than the window - which used to reach the split branch with a one-element pair and
throw a TypeError, caught upstream as `scdet_failed` - now centres on that face.

**Measured on the same 12-clip sitcom replay as §7b**, both plans built from one run of the
detector, and the pre-change plan reproduces all 12 shipped plans exactly (float noise from the
JSONB round trip aside):

| | before | after |
|---|---|---|
| split shots | 18, overlap median 51.8% (39.4-62.6%), 18 of 18 over 25% | **0** |
| centre over anchorable faces | 12 shots, **147.8s** | **0 shots, 0s** |
| centre share of shot time | 47.2% | **2.8%** (9.4s, all genuinely faceless) |
| worst window-centre to nearest face | 0.59 `cropW` | **0.37** |
| clips with the nearest face outside the window | **4** | **0** |
| face-bearing shots holding at least one WHOLE face | 30 of 34 non-split | **52 of 53** |

Corpus-wide the 124 shipped splits measure min 37.5%, p25 42.4%, median 48.0%, p75 53.5%, max
98.5%, 124 of 124 over 25% - §7b reproduced exactly. Under the new gate **none of them would be
emitted**, because none of those sources reaches 2.25:1. The split layout is therefore live code
with zero live sources; it stays because the constraint is a property of the source, not of the
product, and an ultrawide source would use it correctly.

**Pixels, since §7 says these decisions are checked that way.** Sheets are regenerable via
`.eval-frames/geom/` (`measure.ts` replays the set, `sheets.ts` renders before/after strips).
- The corpus-worst split, 848x464 with tiles 8px apart: the before frames are literally the same
  man in the same pose stacked on himself, which is what "it looks like a player glitch" meant.
  After, one clean portrait crop.
- The sitcom's worst split (62.6%): both tiles show the same red-sweater two-shot, offset by a
  hand's width. After, a close-up of the speaker.
- The weak-coffee clip's closing 26.2s of blind centre: the before frame the editor called a flower
  vase is exactly that - the vase dead centre, both speakers sliced by the borders. After, Chandler
  is whole and centred and the vase is at the bottom edge.
- The 16.3s blind centre in clip 1: before, the second man's face is cut in half by the left border
  in 3 of 5 sampled frames with the furniture in the middle. After, the window holds both
  conversation partners.
- `cmsei811y` at 16.4s, one of the four out-of-window clips: before, half a head at the right edge
  and a door in the middle; after, both faces whole and in frame.

**Two things the sheets show that this change does NOT fix, and neither should be read as caused by
it.** A 26-second "shot" is one median face box, so a speaker who walks during it leaves the window
- visible in the last weak-coffee frame under both plans. And the dead opening frame is untouched
by design (a back of a head is still a back of a head, better framed).

**More adjacent shots merge now.** Merging needs the same layout, and almost everything is `single`
after this, so consecutive shots whose anchors differ by under 4% of `iw` collapse into one window
holding the FIRST shot's geometry. Plan-shot count barely moved (52 -> 51) but individual clips
changed a lot: the weak-coffee clip went from 5 plan shots to 1. That is the documented intent of
the merge pass ("the virtual camera stays put on soft scene cuts"), now reaching much further.

---

## 8. Operational facts

- Prod IS this host. Plain `docker compose up -d` (dev target) is production mode. **Do not use
  `TARGET=production`** - the production images lack the `next` CLI and the bind mounts shadow `dist/`.
- Source is bind-mounted and `tsx` hot-reloads, so a commit is live for the worker and bot immediately;
  `packages/shared` needs `npm run build -w @clipclap/shared` before consumers see a change. The web
  container reads the built `shared` dist - a change there is live as soon as it is built.
- After any container recreate: `prisma generate` per container, then rebuild shared.
- Host Node is v18 and cannot run vitest. Everything runs in containers. Bot tests MUST run in the `bot`
  container - the `web` container holds a stale `apps/bot` copy that silently passes.
- Prisma migrations only, never `db push`. Postgres is reachable only inside the compose network.
- `ANALYZE_ENGINE=recall-critic` and `REFRAME_ENGINE=faces` are set in the live `.env` (not in git).
- The critic/finalizer model swap rolls back through `OPENAI_CRITIC_MODEL` and `OPENAI_FINALIZER_MODEL` in
  `.env` followed by `docker compose up -d` - **not `restart`, which does not re-read `env_file`**. Both
  default to `gpt-5.6-luna` in `analyze-v2/config.ts`, and `finalizerModel` falls back to
  `OPENAI_CRITIC_MODEL` if only that one is set.
- **End extension ships OFF.** `END_EXTENSION` is not in the live `.env` and `endExtensionEnabled` defaults
  false, so the stage does not run in production. Turning it on is `END_EXTENSION=on` plus
  `docker compose up -d worker-analyze` (again, not `restart`), then `prisma generate` in whatever compose
  recreated; the kill switch is deleting the line and repeating. On the evidence in §3 it should stay off
  until the scene rail is fixed: it is net positive on podcast material and net negative on compilation
  reels, so a single global setting is wrong for one of the two. `END_EXTENSION_WINDOW_SEC` (25) and
  `SCENE_GAP_SEC` (5) are the other two knobs; both have measurements behind them and neither should move
  without a new one.

### DOWNLOAD: yt-dlp goes through Cloudflare WARP

YouTube refuses this host's datacenter address outright - `Sign in to confirm you're not a bot` - on IPv4
and IPv6 alike. Measured and failed: every player client, PO tokens, a real deno JS runtime, the
`yt-dlp-invidious` fallback, and the newest yt-dlp. **Routing yt-dlp through WARP is what worked**, so for
URL sources the `warp` service is not an optimisation - without it that path is dead. Uploaded files never
touch it.

- `YTDLP_PROXY=socks5://warp:1080` is the **kill switch**: clear it, `docker compose up -d`, and yt-dlp goes
  direct again exactly as before. Both call sites read it - `lib/source-probe.ts` (bot + web) and
  `processors/download.ts` (worker-download). Wiring only one means a link passes the gate and then fails
  the job.
- WARP exits are **shared** Cloudflare addresses, so one can pick up the bot check through no fault of ours.
  On that failure alone the call sites POST `WARP_CONTROL_URL/rotate` and retry **once**. Rotation is a
  global side effect - it drops every connection through the proxy - so the control server serializes it,
  coalesces concurrent callers, holds a 30s cooldown, and verifies the address actually moved. Callers retry
  only on `rotated: true`; a cooldown answer is not a rotation.
- Two rotation facts that contradict the obvious implementation: `warp-cli disconnect && connect` changes
  the exit only **sometimes** (anycast usually returns the same PoP - retry it), and `warp-cli registration
  new` **fails on its own** with "Old registration is still around", so `registration delete` first is
  mandatory or the escalation is a silent no-op.
- The `warp` service deliberately has **no volume** for `/var/lib/cloudflare-warp`: the stock entrypoint
  skips registration when `reg.json` exists, so persisting it would pin one exit forever. A fresh container
  is a fresh IP.
- yt-dlp is **pinned to the same version in all three images** (bot, worker, web) and installed as
  `yt-dlp[default]` so the deno challenge-solver scripts come with it. Unpinned, the images drifted to
  `2026.06.09` vs `2026.07.04` on build date alone - the bot probing with one version and the worker
  downloading with another. Bump all three together.
- **Heavy testing burns the exit.** A few dozen probes in a row earned an `HTTP Error 429` and then the bot
  check on that address. Measure sparingly, and read a sudden "0 formats" as a rate limit before believing
  it is a regression.

---

## 8a. SUBTITLES: the word Whisper did not time (fixed 2026-08-05)

Design `docs/superpowers/specs/2026-08-05-subtitle-word-restore-design.md`, plan
`.../plans/2026-08-05-subtitle-word-restore.md`. **Shipped without a flag**, deliberately: the output is
deterministic, the acceptance number is corpus-wide, and rollback is a `git revert` that goes live
immediately on bind-mounted source. A killswitch here would mean shipping the defect on by default.

**The defect.** `segmentsToCues` built each cue's text from the segment's `words[]` alone, so any word
Whisper transcribed but never gave a word timing was never drawn. It was in the transcript, in the analysis
and in the audio, and absent from the picture.

**Measured over every job in the database with clips and a transcript - 13 jobs, 1265 segments lying fully
inside a clip window:**

| | segments | first word lost | last word lost | other | loss |
|---|---|---|---|---|---|
| en | 748 | 10 | **64** | 1 | 10.0% |
| ru | 517 | **53** | 6 | 1 | 11.6% |
| all | 1265 | 63 | 70 | 2 | **10.7%** |

**The rate is the same in both languages and the position flips: English loses the last word, Russian the
first.** §3 above and the 2026-08-04 audit both say "almost always the sentence's last word" - true of
English only. Real losses included `fight` and `joke`, each carrying its clip's punchline, and `affair`,
whose loss left the chunk `an` alone on screen - the frame a judge singled out as "nonsense on its own".

**Acceptance: 135 of 1265 incomplete before, 2 after**, the survivors being the `unresolved` pair where text
is missing at both ends and the repair declines to guess. Reproducible with
`apps/worker/src/scripts/eval-subtitle-coverage.ts`, and confirmed in pixels on a real burn.

**Measure the CUES, not the transcript.** The repair never rewrites `words[]`, so re-running the survey that
found the defect reports the same number on a repaired engine as on a broken one. That mistake was made once
during design and is why the acceptance script exists in the shape it does.

### Four defects, all on one seam, none of them found by reasoning

Every one of these was found by measurement or mutation and none by reading the code. The seam is the joint
between `comparableText`, `splitAtComparable`, and the caller that spends a count produced by one inside the
other.

1. **The two helpers counted in different normal forms.** Either the `normalize("NFC")` was dead code or the
   split landed in the wrong place; both could not be true. Decomposed Cyrillic put the wrong letter in the
   head; Devanagari orphaned a vowel sign even in NFC, because U+093F is category Mc.
2. **They counted in different units.** `comparableText("𠮷").length` is 2 for one letter, so the split ran a
   character too far and restored `"ord"` for `"word"`. Callers pass `[...flat].length`, never `flat.length`.
3. **The seam rule was derived from examples that never occur.** A rule meant to keep `во-первых` and `y'all`
   whole tested the span's first character. Enumerated over the corpus, **all 45 restores it changed were
   `", bro."` shapes and none were continuations** - neither example occurs at a seam anywhere in the data. It
   folded up to 1.16s of speech into the previous word's entry. The correct test is whether the whole
   non-comparable run at the seam contains whitespace.
4. **The span repeated punctuation the boundary word already carried.** Whisper attaches punctuation to word
   tokens - 2,023 of 75,378 - so `"жизнь»"` plus a span opening `"»"` drew `"жизнь»»"`. Zero occurrences
   today, 45 tokens with the enabling shape.

**The merge is the common path, not the exception.** 698 of 743 tail gaps are exactly 0.000 and 45 are at
least 0.08, with nothing between; on the head side 14 of 560 do land inside `(0, 0.08)`, so `MIN_RESTORED_SEC`
is load-bearing on the head branch and inert on the tail. A distribution measured on one branch must not be
quoted about the other - we did exactly that once.

**Known limitations, recorded rather than papered over.** A seam with no separator at all merges, which is
right for `во-первых` and wrong for CJK and Thai; no heuristic is offered because the corpus contains no
material to validate one. Existing clips are not backfilled - `Clip.subtitleTrack` keeps its losses and only
new renders benefit. The chunker is untouched: 56 of 285 cues on the audited set are single-word, and some of
those were the residue of this defect while the rest come from `chunkWords` filling greedily to 3 words or 18
characters. That is separate work with its own measurement.

**Telemetry.** `renderManifest.subtitles` carries `segmentOccurrences`, `restoredHead`, `restoredTail`,
`unresolved` and `merged`. `unresolved` growing is the signal that Whisper's output shape has changed.
`segmentOccurrences` counts (clip, segment) pairs and not unique segments - 6 of 1265 in the corpus are the
same segment inside two clips.

---

## 9. Where the product actually stands

Measured 2026-07-25: **95 registered users, 3 have ever run a job, 8 jobs total, 38 clips ever made.** 92 of
95 never made a clip because `NONE_LIMITS` is zero on every field - there is no free tier, so a registered
user cannot process one second of video before paying. Every competitor examined offers a trial.

This matters for prioritisation more than any engine work: nobody except the owner has ever used this product,
so every quality judgement in this repo rests on one person's taste. The reliability work in
`docs/known-issues.md` is real but its expected cost is near zero at this scale - those bugs need many users
or an infrastructure outage to fire.

A free trial shipped briefly on 2026-07-25 and was **disabled the same day** (`d1ee79a`): it turned an
unauthenticated, unrate-limited `POST /api/register` into an unbounded compute faucet, its 30-minute cap was
enforced on a client-supplied duration that is absent on every URL submission, and `DELETE /api/projects/:id`
hard-deletes the Job rows that ARE the trial's ledger, so one account can reset itself forever. Zero
exploitation occurred (0 signups, 0 jobs in the window). Re-enabling needs those three holes closed AND the
owner's explicit approval of the commercial terms - it changes what customers are charged, which is not a
decision to infer from a brief reply.
