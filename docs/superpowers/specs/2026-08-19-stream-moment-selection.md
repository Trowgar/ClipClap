# Stream moment selection: does the engine see what clippers clip? (2026-08-19, MEASUREMENT PHASE)

## PHASE 1 RESULTS (measured 2026-08-19 evening; artifacts in .corpus/moment-selection/)

**Engine recall on 11 human-labeled moments: 0/11.** Both sources shipped a
full "strong"-tier set (4 and 6 clips) - NONE matching what viewers clipped.
Death distribution: 4 NEVER_CANDIDATED (scanner blind - incl. recrent's top
label, 1669 views), 4 keep_false (critic scores 0.12-0.39 vs threshold 0.6),
3 lost_to_budget - including the corpus's most viral moment ("осуждаю",
15,847 views): the scanner FOUND it, selectCriticCandidates rationed it out
(133 merged candidates vs criticMaxCandidates 40 on a 3h stream). Merge also
produced a 3.2-second stub of a real moment (ГОЛЫЙ КОРОЛЬ).

**Scout panel (3 blind agents per source, same transcripts): the fork answer
is BOTH.** Scouts unanimously found the biggest text-visible labels the
engine lost - "осуждаю" 3/3 (the budget victim), "НУ НЕЕЕЕЕАД" 3/3 as their
RANK-1 pick (the critic gave it 0.18) - proving those losses are
engine-internal (budget ranking + critic taste + fragmentation), fixable in
text. But 6-7 of 11 labels are TEXT-INVISIBLE (one-word screams, game-visual
beats: ЧТООО, ПСИХ, рыбкой, ГОЛЫЙ КОРОЛЬ, ваня) - no prompt can recover
them; that half needs non-transcript signals (chat-replay density, audio
energy). Panel stability was high (near-identical picks across runs), so
transcript-level scouting is a reliable oracle for this corpus.

Phase-2 candidates, in measured-value order: (1) critic-budget ranking that
correlates with virality + a stream-aware critic rubric (reaction bursts,
not story arcs) + merge fragmentation - all measurable against this corpus
with no new signals; (2) chat-replay density as a candidate generator (GQL
comments are downloadable; the labels themselves prove chat spikes at these
moments); (3) audio energy/laughter. Each phase gets its own spec.

## 0. Why

The ANALYZE engine is transcript-driven and story-arc-tuned (scanner hunts
narrative candidates in speech; the critic demands hook/payoff/self-contained).
The audience is clippers of STREAMS, and a stream's moment is typically a game
event + reaction - screams, laughter, chat interplay - often nearly
speechless. Measured smoking gun: job cmstdck6 was a real Twitch CLIP (a
moment a human viewer already judged clip-worthy, 60s) - the critic scored its
4 candidates 0.05-0.34, all keep:false, threshold 0.6. A human-labeled viral
moment, rejected decisively.

## 1. Labeled corpus for free: Twitch clips ARE human labels

Twitch GQL (public web client-id) exposes per-clip `videoOffsetSeconds` +
`video.id` - every viewer-created clip is a human "this moment" label on the
VOD timeline. No annotation work.

Phase-1 corpus (`apps/worker/.corpus/moment-selection/`):
- strogo VOD 2837805012 (CS2, 7.9h) - window 4129-14929s, 6 labels inside
  (incl. "осуждаю", 15,847 views).
- recrent VOD 2829435250 (Elden Ring, 9.4h) - window 3944-14744s, 5 labels.

Windows are 3h CONTIGUOUS slices (the paid product cap - the engine never
legally sees longer sources) chosen to maximize label count; labels.json
stores window-relative offsets. Full month pull (93+99 clips with offsets)
in twitch-clip-labels-raw.json for later expansion.

## 2. The measurements

A. **Recall autopsy** (engine): audio-only download -> the worker's own
   transcribeVideo (production chunking, whisper-1) -> an offline autopsy run
   that replicates analyzeHighlightsV2's stage order via the SAME exported
   functions, recording what full-pipeline telemetry does not keep: every
   scanner candidate's TIME RANGE, every critic verdict, then the
   deterministic downstream (gates/snap/selection) on those verdicts. Map
   each label to its fate: never-candidated (scanner recall miss) /
   candidated-but-unjudged / keep:false / score-below / gate / snap /
   selection / SHIPPED. One table per source.
B. **Signal-existence test** (the fork in the road): clip-scout agents read
   the same transcripts blind and pick moments. If humans-from-transcript
   cannot find the labeled moments either, the signal is NOT IN THE TEXT -
   prompt work cannot fix it and the design must add non-transcript signals
   (chat-replay density, audio energy/laughter - eval-laugh-probe groundwork
   exists). If scouts DO find them, the gap is prompt/threshold shaped.
   Scouts run 3x per source (agent panels measure ~40% unstable per clip).

## 3. Deliberately NOT in phase 1

Chat-replay download, audio-energy probes, any engine change, any prompt
change. Phase 1 buys the death table and the fork decision; building comes
after, with these numbers in hand.

## 4. Costs

Whisper-1 on 2x3h = ~$2.2; one scan+critic run per source ~ $0.1-0.3 each;
scouts are agent tokens. No jobs created, no user rows, no R2 writes.
