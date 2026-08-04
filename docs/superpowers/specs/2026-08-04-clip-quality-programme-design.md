# Clip Quality: What Is Actually Broken, and In What Order

**Date:** 2026-08-04
**Status:** Draft - awaiting owner review
**Scope:** A programme, not one change. This document records the first measured audit of shipped
clip quality and decomposes the repairs into six independently shippable projects. **Each numbered
project gets its own design and its own implementation plan; this one authorises none of them to be
built.** What it does authorise is the order, and it records the evidence that produced that order so
the next session does not re-derive it.

Supersedes the framing this work started from - "add a genre classifier to ANALYZE" - which the
evidence demoted from first priority to sixth.

---

## 1. Why this exists

Before 2026-08-04, every quality judgement in this project rested on one person looking at eight
clips once, on 2026-07-26, from a model that no longer runs (`engine-notes.md` §5b). Every repair
since was reasoned about and verified by "the snapshots did not move" - which proves the code is
deterministic and says nothing about whether the clips got better.

Two outside users finished jobs on 2026-08-03. Neither uploaded a podcast. That is the whole reason
this audit happened, and the reason its findings do not look like the ones we expected.

---

## 2. What was measured, and how

**The material.** Job `cmscht6rp001xq41s5rhjx6q0` - 41 minutes, English, uploaded by telegram user
`1021588991`. Recorded as eval fixture `sitcom-friends` and replayed through the current engine
(Luna, no fallback), then rendered as real product output through the render stage under the owner's
account (`cmsei6r190001zppef93vft6s`, 12 clips).

**Three independent instruments, none of which existed before this session:**

| Instrument | What it sees | What it answers |
|---|---|---|
| `clip-viewer` agent | 6 frames + caption + spoken words | would a scroller stop, stay, react |
| `clip-editor` agent | same | would a clipper publish it, and what one fix |
| `clip-scout` agent ×3 | the FULL transcript, blind to the engine's choices | what did the engine MISS |

The scouts matter most and were the owner's idea. The first two judge only what the engine produced,
so they are structurally incapable of finding a missed moment. Three were run rather than one: if
they disagreed with each other, no comparison against the engine would mean anything.

**Both agents were told they cannot hear audio** and must say so wherever a verdict depends on
delivery. On a sitcom that is most of the joke, and every verdict below carries that limit.

---

## 3. What the audit found

### 3.1 Verdicts

12 clips, 24 verdicts. **Zero `publish`. Four `publish after one fix`. Eight `bin it`.** Mean
scroll-stopping score **3.2 / 10**. One `like` across twelve clips; eleven `nothing`; zero reposts,
comments or saves.

### 3.2 The engine ends clips before the payoff

The scouts' consensus (a moment at least 2 of 3 chose independently) produced 11 moments. Compared
against the engine's 12:

```
engine  175.1-190.6 (16s)   consensus 168.1-217.3 (49s)   ends 27s early
engine  636.9-658.0 (21s)   consensus 637.1-682.0 (45s)   ends 24s early
engine 1413.3-1433.3 (20s)  consensus 1413.4-1450.7 (37s) ends 17s early
engine 2148.0-2167.2 (19s)  consensus 2129.7-2175.5 (46s) starts 18s late
engine    0.0- 28.8 (29s)   scout C      0.0- 83.4 (83s)  ends 55s early
engine 1165.4-1186.0 (21s)  consensus 1159.3-1185.7 (26s) MATCHES
```

**Three of six starts agree to within a fifth of a second. Five of six ends are early**, by 17 to 55
seconds. The remaining three starts are 6, 7 and 18 seconds late - the engine is imperfect at both
ends, but its error at the end is an order of magnitude larger and always in the same direction.

This is not a model failure, it is the specification. `prompts.ts:115-117` defines `end_node` as the
**FIRST** node finishing a sentence at or after the payoff, with "no more than ~4s of talk after the
payoff". The reaction to a punchline lives precisely in those cut seconds. The FINALIZE stage cannot
repair it because its only verbs are `drop` and `trim`; it can shorten a clip and never lengthen one.

Independently reached by the editor agent, which filed `cut punchline` or `no payoff` on clips 02,
04, 05, 08 and 10.

### 3.3 The engine misses moments everyone else finds

Six of the eleven consensus moments are absent from the engine's output entirely. **Four were chosen
by all three scouts:** the wedding fund (858-915), the stranger waxing the Porsche (287-341), the
lying bet (102-133), and "Front and back!" (1575-1620).

All three scouts also reported, unprompted, that the source contains **more** postable moments than
twelve - their counts were 8, 16 and 18-20. The engine is under-selecting, not padding.

The mechanism is already documented and unfixed (`engine-notes.md` §6a): scan windows are budgeted
from `speechSec`, so a window that counts 600s of speech renders ~1130s of transcript to the model,
and this source yields 3-4 windows where it should yield 7-8. That halves both the per-window quota
and the scanner's 12-moments-per-window ceiling. Corroborating observation: the whole 41-minute
source consumed **9 API calls**.

### 3.4 Every title describes instead of selling - 12 of 12

`title is a recap` appears in every editor verdict without exception. In six it also **spoils**: the
caption states the payoff before playback. Examples, with the editor's replacement:

| Engine | Editor |
|---|---|
| The bachelor party was in a Pizza Hut basement | Their last bachelor party set an extremely low bar |
| Joey Heard "No Strippers" and Ignored It | Ross gave one rule for his bachelor party |
| They Beg Someone Not to Reveal Their Big News | Joey lasts about four seconds with a secret |
| The Weak Coffee Joke Needs Explaining | He didn't laugh at his boss's joke. His wife had to explain it. |

The prompt is not the obvious culprit: `prompts.ts:133` already asks for `curiosity-driven but
TRUTHFUL`. The model satisfies "truthful" and drops "curiosity", because the most truthful sentence
about a clip is a description of it. Nothing downstream checks which of the two it delivered.

### 3.5 RENDER has two systematic defects, both in one branch

`plan.ts:195` tests whether the span of detected faces exceeds `0.9 × cropW`. Both branches are wrong
for this material.

**Split branch.** `tileW = h·9/8` is exactly twice `cropW = h·9/16`. The gate fires on FACE SPAN and
never on TILE SEPARATION, so two faces just past the threshold produce two tiles whose centres are
`0.9 × cropW` apart while each tile is `2 × cropW` wide - an overlap of 55% at the commonest firing.
Measured on the real plan: tiles at x=0 and x=202 with tileW≈392, i.e. **48% of each tile is the same
pixels**. Present in 7 of 12 clips. Every agent independently read it as "this video is broken".

**Single branch.** When it declines to split, the window centres between the faces - and shows what
is between them. The editor's phrasing: *"the crop is tracking the table, not the speaker."* On
clip 12 the payoff frame is a flower vase with both speakers sliced by the borders.

Two further render findings: **11 of 12 clips open on a frame that loses the viewer** (empty room,
pure black, letterboxed wide shot, a back, a stacked duplicate) - only clip 08 opens on a face; and
layout geometry changes 3-4 times inside 13-21 seconds on ten of twelve.

The owner found both defects by eye within fifteen seconds of opening the set, before any agent ran.

### 3.6 Subtitles lose the punchline

Fragmentary cues throughout (`did but it`, `Barn has ripped`, `here is a`), and several frames carry
no cue at all while dialogue continues. Four clips lose the payoff word itself: `office`, `hut'`,
`fired`, `lied before`. This is the documented word-drop defect - captions omit any word Whisper left
un-timestamped, ~13.8% of segments, almost always the sentence's last word. **The last word of a
sentence is the punchline**, which is what makes a known cosmetic bug a quality bug.

Separately, and not a subtitle defect: clip 09's joke rests on `your` vs `you're`, and **Whisper
transcribed both identically**. The editor agent diagnosed this as a subtitle fault; verification
against the transcript showed the defect is in TRANSCRIBE. Recorded because it is a worked example of
why agent findings get verified before they enter a plan.

### 3.7 The source is a class nobody listed

All three scouts, independently: *this is not an episode. It is a stitched compilation of roughly 30
unrelated scenes, already pre-selected as highlights, with hard cuts and no through-line.*

The user uploaded an **already-cut highlight reel** in order to get clips out of it. This explains
several render findings directly: the black opening frame is an inter-scene cut in the source, the
geometry churn follows the source's own hard cuts, and `needs the series` recurs because characters
appear once and never return.

---

## 4. Decisions taken

**No refusal, ever.** The engine must return clips for any input, including cartoons and football.
Owner's decision, 2026-08-04: refusing sends users to competitors. Consequence for every design
below: any taxonomy must be total, with a working route for "we did not recognise this", and that
route is today's behaviour.

**End-extension is now permitted.** Extending a clip's end past the payoff to include the reaction
was previously out of scope, to protect payoffs from being trimmed away. All three scouts identify
that restriction as the single largest loss. Owner lifted it 2026-08-04.

**Classify broadly, act narrowly.** When the classifier ships, it may emit any label; the profile
registry carries entries only for genres validated against a fixture. Everything else routes to the
default. The label is still stored for unhandled genres, because after a month it answers "what do
people actually upload" from data rather than intuition - a question this audit already answered
surprisingly once.

**The `podcast` profile must build a byte-identical prompt to today's.** Fixture replay is keyed on
`sha256(model, system, user)`; one changed character in the podcast prompt invalidates both podcast
fixtures at the exact moment they are needed as proof that nothing regressed. Enforced by a test that
compares strings, not snapshots.

---

## 5. The programme, in order

Ordered by measured effect. Each item is a separate design + plan + branch.

**1. Clip endings.** Stop cutting before the reaction; give FINALIZE a verb that extends. Evidence:
§3.2, five of six overlapping picks. Acceptance: on `sitcom-friends`, the engine's ends move toward
the scout consensus on at least three of the five, and the podcast fixtures do not regress.

**2. Scanner recall.** Budget scan windows by rendered transcript size, not `speechSec`. Evidence:
§3.3, four unanimous moments missed. Expect roughly double the candidate pool and K back in
contention; needs its own measurement and a fixture re-record. Acceptance: at least two of the four
unanimous misses appear in the candidate pool.

**3. Titles.** A copy rule that sells, plus a deterministic spoiler gate. The mechanism already
exists: the critic must cite `titleEvidenceNodes`, and **a title whose evidence nodes sit in the last
third of the clip has quoted the payoff**. Code-checkable, no model involved. Evidence: §3.4, 12 of
12. Acceptance: zero shipped titles cite evidence from the final third.

**4. RENDER.** Gate the split on tile separation rather than face span; anchor the single-crop window
on the speaking face rather than the midpoint; refuse an in-point on a black or faceless frame; damp
geometry churn. Evidence: §3.5, plus the owner's own inspection.

**5. Subtitles.** Recover the word Whisper left un-timestamped; group cues by clause. Evidence: §3.6.

**6. Genre classifier and profiles.** Where this work started. Its first real class is not one of the
genres originally listed - it is **compilation reel**. Evidence: §3.7.

---

## 6. How we will know it worked

The same 12 clips, re-rendered after each project, re-judged by the same two agents with the same
prompts. **Absolute scores are an uncalibrated model opinion and are not evidence. The delta on
identical material is**, because the only thing that changed is the repair.

The owner is not asked to look again until the agent gate passes: **at least three clips at `publish`
with no qualifier, and mean viewer score ≥ 6.** Today: zero and 3.2.

Owner-facing calibration remains an open debt. He declined to rate the current set - reasonably, as
the set is bad - and he did not dispute the agents' verdicts, which is the only calibration point
this document has. It is weak. The first set that passes the gate must be rated by a human before any
of these agents is trusted as a measure rather than a filter.

---

## 7. Out of scope

Contacting the two outside users to ask what they posted. It is the only ground truth about
postability that exists, the support relay already reaches them, and it is the owner's decision, not
ours.

Judging English material by taste. The owner is a Russian speaker and said so; his verdicts on this
set are reliable about framing and structure and not about whether a sitcom line is funny. The taste
half of any future calibration needs Russian material - and `cms7jhcbz0003nb7fkfdki0lp` still has its
source artifact, so a Luna set on the Russian podcast can be rendered whenever that is wanted. The
other three Russian jobs have already been swept.

Audio. Every agent verdict here is made without hearing anything, and on comedy that is most of the
signal. Nothing in this programme changes that; it bounds how far the agent gate can be trusted.
