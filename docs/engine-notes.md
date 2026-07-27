# Engine notes

Working notes on the ANALYZE and RENDER engines, written for whoever picks this up next - including a future
me. This is not a spec. Specs say what should be true; this says what IS true, what was measured, and what
was tried and failed. Its purpose is to stop the next session re-deriving what this one paid for.

Rules for this file: every number here came from a measurement, not from reasoning. When a claim is
reproduced, say how. When something is believed but unmeasured, mark it. Delete an entry when it stops being
true - a stale note is worse than none, and this file has already caught two of its own.

Last substantive update: 2026-07-27.

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
  -> runCritic               gpt-5.1, batches of 6, strict json_schema, returns NODE INDICES
  -> evidenceGate            [code] title/description must cite nodes inside the range
  -> snapNodes               [code] OWNS ALL BOUNDARIES - clean start, payoff containment, clean end
  -> selectAndOrder          [code] tier thresholds + surcharges + time-overlap NMS + soft cap
```

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

**Critic token budget.** gpt-5.1 spends `max_completion_tokens` on reasoning BEFORE writing any JSON. On the
real critic prompt at `reasoning_effort: low`, reasoning costs **330-450 tokens per candidate** (measured:
354-603 for one candidate, 918-1478 for three, 1979-2677 for six). The visible JSON is small and stable, about
**150 tokens per verdict**. The original budget of 400 tokens per candidate was BELOW the reasoning floor at
every batch size, so roughly half of all critic calls truncated, the batch-splitting recovery inherited the
same starvation, and candidates were silently dropped. After sizing the budget from these numbers, truncations
per fixture went **7 -> 0**, batch splits **6 -> 0**, API calls **18 -> 6**, and shipped clips went **5 -> 6**
and **7 -> 10** with the survivors spread across the whole source instead of clustering on weak early
material. Per-call variance is the same order as the headroom (a later run measured 2184 completion at a 6000
budget, below the 2857 seen at 5000), which is why a truncation can genuinely heal on a retry.

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
and **$0.110 -> $0.239** per 52-minute job. Shipped clips went **7 -> 12** and **10 -> 12**, and 5 of
ecology's 12 come from candidates the old budget would have withheld.

**What limits clip count today.** Before this change it was K. After it, on `podcast-answer-arc` it is the
soft cap: 21 keep-verdicts -> 16 handed to the finalizer (= `softCap + finalizerHeadroom`, binding) -> 15
survivors -> 12 shipped. On `podcast-ecology` the gate/snap/NMS funnel binds first: 20 keep-verdicts -> 12.
`criticMaxCandidates` (40) is the spend ceiling and is not reached by a 52-minute source; a 90-minute one
would reach it. `criticBudgetK` and `criticUnjudgedPool` are published per job so the next binding constraint
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

**How it works.** The engine's only non-determinism is two LLM calls. They are recorded per fixture, keyed by
a hash of (model, system, user) - order-independent, because the scanner runs windows concurrently - and
replayed through a stub client. Every deterministic layer runs for real, at zero cost, in milliseconds.

- `helpers/replay-client.ts` - the stub. Records `truncated` and `refusal` outcomes as markers, because the
  critic's batch-splitting depends on them and a recording without them is unreplayable.
- `helpers/eval-fixture.ts` - `loadFixture`, `runFixture` (throws on a stale fixture), `toShape`.
- `helpers/eval-fingerprint.ts` - fingerprints the engine config into the fixture. Without it a knob change
  silently invalidates every recording while the suite stays green - which happened, and the harness
  certified an already-fixed bug as correct.
- `eval-snapshot.test.ts` - replays both fixtures and compares to the blessed shape.
- `eval-regressions.test.ts` - the named defects the owner found in real clips, each with its provenance.
- `scripts/eval-record.ts` - records a fixture from a real job against the LIVE API. Costs money. Manual.
- `scripts/eval-bless.ts` - prints a readable diff before rewriting a snapshot. The diff is the review
  artefact: a human decides from it whether a change is desirable.

**The fixtures.** `podcast-ecology` (job `cmrzcqhl6000138lkg41n8bs0`) and `podcast-answer-arc`
(job `cmrvawjxs00129pvw0oe1c1kv`). **They are two transcription runs of the SAME 52-minute episode.** The
regression net therefore stands on ONE piece of source content - any content-level claim is single-sample. A
genuinely different third source (a gameplay stream, a solo talk, another language) would add more than any
number of further assertions on this one. The upside is that the pair is an honest A/B on transcription
jitter, and it is unflattering: the same moment ships clean in one run and broken in the other, and the two
runs yield 6 versus 10 clips from identical audio.

**What the harness cannot do.** Replay uses the OLD recorded LLM responses, so it verifies that deterministic
layers did not regress - it cannot measure a prompt change. For that, re-record and read the diff, or upload
a real video. A green run is not "quality is fine".

---

## 5a. FINALIZE, and what it actually did

One LLM call over the whole shipped set, with every model decision code-gated. Landed 2026-07-26. Measured on
the fixtures by replaying the SAME scanner and critic answers twice, with the stage off and on - a git diff of
re-recorded snapshots mixes the stage's effect with LLM variance and cannot answer "what did the judge do".

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
- **Dropping is expensive medicine.** The malaria clip is otherwise strong; the real repair is three nodes on
  the END, but end-trimming is out of scope by spec (it protects payoffs), so `drop` is the only verb the
  stage has. That is a product decision the owner has not made: a broken-ending clip, or no clip.

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
if snap rejects it. A rewritten title must cite evidence nodes inside the final range - and be re-checked
AFTER any accepted trim, because a trim can move the evidence outside.

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

Ordered by expected effect on the owner's 2-of-8 hit rate, most valuable first.

- **Arc stacking and drag - the "uninteresting" half.** See §5b. No mechanism measures either. This is the
  only item here that plausibly moves the hit rate rather than the polish.
- **Compression and trims enforce contradictory policies on the same structure.** `tryTrim` refuses a boundary
  move that orphans a question (`orphansQuestion`, shipped `6d24a55`); `snapNodes` compression performs one -
  its headline repair opens on `"Ну как живучий смотря по каким параметрам сравнивать"` while the question
  `"…самый живучий вид на планете или все-таки нет?"` sits immediately outside. Unify them.
- **The punchline-outside case has only a drop, not a repair.** Extending an end to a reaction the engine can
  already identify would turn a dropped clip into a good one. Blocked on an owner decision: end-trimming was
  ruled out of scope to protect payoffs, and lifting that is his call.

- **Tell the finalizer's judge about the teaser region.** The detector publishes `teaserRegion`; passing it
  into the finalizer prompt ("the first N seconds of this video are a trailer montage") turns a deterministic
  drop into a prior the judge can weigh, and helps it reason about clips that start near the boundary.
  Suggested by the design that produced the detector; not implemented.
- **The fixtures are one episode.** A genuinely different third source - a gameplay stream, a solo talk,
  another language - would strengthen the regression net more than any further assertion on this one.
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
- **The punchline-outside case has no repair, only a drop.** Extending an end to a reaction the engine can
  already identify would turn a dropped clip into a good one. Blocked on an owner decision, because
  end-trimming was ruled out of scope to protect payoffs.

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
