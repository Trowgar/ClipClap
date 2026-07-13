# Highlight Core Redesign: Recall-Judge on a Sentence-Graph Spine

**Date:** 2026-07-13
**Status:** Approved (2026-07-13, post-review revision) - ready for implementation plan
**Scope:** ANALYZE stage rewrite + in-scope touchpoints in TRANSCRIBE (language capture, long-video chunking), DOWNLOAD (A/V normalization), RENDER (new Clip fields, duration/skew assertions), consumers (description slot, 0-clip and low-quality messaging).

## 1. Problem

The current highlight core produces complaints that map 1:1 to code:

| Complaint | Root cause |
|---|---|
| Always ~5 clips regardless of content | Prompt hardcodes "Find 3 to 5 best clips" (`analyze.ts`) |
| Every clip lands at ~31s | Prompt demands 30-90s AND `expandClipToMinDuration` pads anything shorter with neighbor Whisper segments, stopping the moment it crosses 30s. Short golden moments (e.g. an 11s punchline) get buried in filler |
| Boring moments, titles that overpromise | Single gpt-4o-mini pass skims the whole transcript, anchors on early moments, is told to "still return the best available moments" even from weak videos; no score, no threshold, no grounding check; final order is chronological, not by quality |
| Starts/ends cut mid-thought, payoff clipped | Boundaries snap to Whisper segment edges (not sentence edges); word-level timestamps exist but are unused; overlapping clips silently dropped; no payoff-containment check |
| Video timeline does not match transcript | yt-dlp merged files can carry container edit lists / non-zero `start_time`; audio extraction resets audio to t=0 while the video cut inherits the offset; nothing normalizes this |
| No clip descriptions | No `description` field anywhere (DB, web, bot caption) |
| Wrong-language titles | Whisper-detected language is discarded; prompt has English-only title examples and no language instruction |
| 0 moments = "Processing failed" | `analyze.ts` throws on empty results; job goes FAILED with a scary error |
| Videos over ~105 min fail | Extracted audio exceeds Whisper's 25MB limit; no chunking, though plans promise 180 min |

## 2. Fixed product decisions

Settled with the owner before design; the design must operate within these.

1. **Clip count is quality-driven.** Return every moment with `score >= threshold` (0.6 baseline, env-tunable), global soft cap 12, ordered by score. No per-plan cap now; design keeps a per-plan slice trivially addable later (`PlanLimits.clipsPerJob` + one slice before render).
2. **Weak-video fallback with an absolute floor.** If nothing passes the threshold, deliver top-1..2 candidates flagged `lowQuality` - but only candidates that clear the absolute floor: `score >= WEAK_FALLBACK_MIN_SCORE` (0.35), grounded, self-contained, valid boundaries. If nothing clears even that, complete DONE with 0 clips + machine-readable reason. Content outcomes never produce FAILED. **Technical outcomes never produce silent emptiness:** if analysis models are unavailable after all fallbacks, the job fails retryable (FAILED does not burn quota and BullMQ retries it) - unjudged output is never shipped.
3. **Two-stage LLM architecture**, budget ~$0.05-0.15 per source hour. OpenAI stays; models env-configurable. Whisper (~$0.36/hr) is separate and unchanged.
4. **Clip length matches the moment - length is never a reason to add content.** Hard floor 6s: shorter drops. 6-8s ships flagged as a short moment. 8-90s is the normal band. Over 90s: start moves forward toward the hook only along strong boundaries, else the clip drops. There is no length-driven extension in either direction, ever.
5. **Titles and one-sentence descriptions in the transcript's language**, grounded in what is actually said inside the clip window. No clickbait the clip does not deliver.
6. **Boundaries land on sentence/phrase ends** using word-level timestamps; the payoff is never cut; clips must be self-contained.
7. **In scope:** A/V timeline normalization; Whisper chunking up to 180 min. **Out of scope (next iteration):** content-aware 9:16 crop (speaker framing). Center crop stays for now.
8. Prisma migrations only (no `db push`); new Clip/Job columns nullable or defaulted.

## 3. Architecture overview

Separate **recall** (find every plausible moment, cheaply, in overlapping windows) from **judgment** (score hard, refine boundaries, write grounded copy, with a strong model over a small candidate set). Both LLM stages address moments by **node index** on a code-built sentence graph, so no model ever emits a timestamp and every cut lands on a real word or segment edge.

**Guarantee, stated precisely:** mid-word cuts and hallucinated timestamps are impossible by construction (models emit node indices only; every node edge is a real word or segment edge). Mid-thought cuts are *minimized* - not impossible - through boundary strength on both edges, critic boundary selection, and code-side validation; node edges include weak clause/phrase boundaries and forced splits, so they are not all sentence-final.

This architecture won a 4-design panel (map-reduce, single-strong-read, boundary-first, minimal-evolution) judged on clip quality, boundary accuracy, robustness, cost fit, and implementation fit. Grafts adopted from the non-winning designs are noted inline; rejected alternatives are in §12.

```
DOWNLOAD
  └─ normalizeSource()  [NEW]  ffprobe skew/edit-list probe -> conditional -c copy remux
        -> verify reprobe -> re-encode fallback only if verify fails
        -> idempotent on retry; writes Job.normalizedArtifactKey (raw preserved)

TRANSCRIBE  (reads normalizedArtifactKey ?? sourceArtifactKey)
  ├─ chunkAudioIfNeeded()  [NEW]  silence-aligned ~20-min chunks when >24MB / >95min
  ├─ language locked from a speech-rich probe (up to 60s of detected speech), passed to every chunk
  ├─ whisper-1 verbose_json [segment,word] per chunk
  ├─ re-offset chunk times; word-aligned seam dedup; monotonicity asserts
  └─ capture language (name -> ISO), store Job.language/languageRaw + coverage fields

ANALYZE  (analyzeHighlightsV2; V1 kept verbatim behind a flag)
  ├─ 0. degenerate guard [CODE]  <5 words / <4s speech / no word nodes -> DONE 0 clips;
  │        5-24 words -> tiny path: skip scanner, whole transcript = 1 candidate to critic
  ├─ 1. buildSentenceGraph()  [CODE]  words+segments -> nodes[] with leading/trailingStrength,
  │        opaque flags; one global monotonic node index space
  ├─ 2. buildScanWindows()   [CODE]  node-indexed slices, ~600s speech + ~90s overlap
  ├─ 3. SCANNER (map)  gpt-4o-mini x N parallel, json_schema strict, recall-tuned
  │        per window -> {startNode,endNode,payoffNode,interest,type,thread?}
  ├─ 4. collateThreads() + mergeCandidates()  [CODE]  union overlaps, link threads,
  │        span-guard resplit  (ALL merging happens here, before the critic)
  ├─ 4b. selectCriticCandidates()  [CODE]  stratified: per-window quota + global extras
  │        + per-region cap  (coverage-aware, not naive global top-K)
  ├─ 5. CRITIC (reduce)  gpt-5.1 batched parallel, json_schema strict,
  │        reasoning_effort=low, output cap + incomplete/refusal handling -> per candidate
  │        {id,keep,score,grounded,self_contained, startNode,payoffNode,endNode,
  │         hookStartNode,hookEndNode, title,description,
  │         title_evidence_nodes,description_evidence_nodes, language}
  ├─ 6. snapNodes()  [CODE]  clean-start check; payoff containment; strong-end selection;
  │        epsilon-tolerant invariants; duration policy (drop, never extend)
  ├─ 7. evidenceGate()  [CODE]  evidence nodes in range + speech-bearing; copy-language
  │        script check with one repair retry -> verbatim-snippet fallback copy
  └─ 8. selectAndOrder()  [CODE]  eligibility -> strong tier (>=0.6) -> weak tier (>=0.35)
           -> keep-or-drop NMS (no post-critic trim/merge) -> sort by score -> cap 12
  -> writes Job.highlights (v2 shape) + language + noClipsReason
     + real token-usage cost + telemetry

RENDER  (cuts from normalizedArtifactKey; crop/burn unchanged; persists new Clip fields)
  └─ assertions [NEW]  renderDurationErrorMs + renderAvStartSkewMs per clip

FINALIZE  (tolerates 0 clips -> DONE with reason, never FAILED for content)
```

## 4. Sentence graph (code, the spine)

Input: `WhisperSegment[]` with optional `words[]`. Output: ordered `nodes[]`, each a sentence or phrase whose edges are real word onsets/offsets.

```
GAP_SENTENCE = 0.60   // s of silence -> sentence boundary (trailingStrength 0.8)
GAP_PHRASE   = 0.30   // s -> weak phrase boundary (0.4)
TERMINAL     = /[.!?…。！？]$/     // strong end -> trailingStrength 1.0
CLAUSE       = /[,;:-]$/          // weak end
NODE_MAX_SEC = 12     // force-split long nodes at largest interior pause (0.3)
MICRO_SEC    = 0.40   // merge sub-0.4s fragments forward into neighbor

for each segment:
  if segment has NO words (music / crosstalk / Whisper dropped them):
     emit ONE opaque node { start, end, text, trailingStrength: 0.2, hasWords: false }
     continue
  walk words in time order; close current node when:
     - word.text matches TERMINAL                -> strength 1.0
     - gap(word_i -> word_{i+1}) >= GAP_SENTENCE -> strength 0.8
     - word.text matches CLAUSE or gap >= GAP_PHRASE -> strength 0.4
     - running length >= NODE_MAX_SEC            -> split at largest interior gap, 0.3
  node.start = firstWord.start ; node.end = lastWord.end ; node.hasWords = true
post-pass: merge MICRO nodes forward; node.leadingStrength = prevNode.trailingStrength
index nodes 0..M-1 monotonically across the whole (re-offset, stitched) transcript
```

A node's word track is marked **unreliable** (treated as opaque for boundary purposes) if any word has `end <= start`, times are non-monotonic, or one word spans more than 3s. This deletes `snapToSegmentBoundaries` and `expandClipToMinDuration` from the V2 path.

## 5. LLM stages

### Degenerate and tiny inputs (before any window building)

- **Degenerate** (`< 5` words total, or `< 4s` of word-bearing speech, or zero word-bearing nodes): DONE with 0 clips, `noClipsReason = NO_USABLE_SPEECH`, zero LLM cost. A 20-word video is NOT degenerate - a tight 10s moment can live there.
- **Tiny** (5-24 words): skip the scanner; the whole transcript becomes a single candidate sent straight to the critic (one cheap call). Normal path otherwise.

### Scan windows

Window = contiguous node slice covering ~600s of speech with ~90s overlap (`SCAN_WINDOW_SEC=600`, `SCAN_OVERLAP_SEC=90`; ~7 windows per hour, ~21 for 3h). Window body is node lines `#<idx> <text>` with no timestamps (the scanner cannot hallucinate a second; also ~30% fewer tokens than the old `[12.3s - 15.6s]` format).

### Stage 1: SCANNER (map)

| Field | Value |
|---|---|
| Model | `OPENAI_SCAN_MODEL`, default `gpt-4o-mini` (recall lever: `gpt-5-mini`) |
| Calls | one per window, parallel, `ANALYZE_MAX_CONCURRENCY=5` |
| response_format | `json_schema`, `strict: true` |
| Temperature | 0.4 |
| Output | `{candidates: [{start_node, end_node, payoff_node, interest, type, thread?}]}` - node indices only; max 12 candidates per window |
| Posture | FIND, do not judge; over-select on purpose; missing a good moment is the only real mistake |
| Failure | strict schema holds for completed responses; truncated/refused/API-error -> 1 backoff retry -> skip that window, log, continue (one dead window costs a sliver of recall, never the job). Code validates `0 <= start_node <= end_node < M`, `payoff_node` in range (else `start_node`), `interest` clamped [0,1]; invalid rows dropped. Per-window candidate counts recorded (coverage telemetry) |

### Candidate merge (code - ALL merging happens here, pre-critic)

1. Drop index-invalid rows; concatenate across windows.
2. **Thread collation:** group candidates sharing a `thread` label; attach `threadSetupNode` (earliest referenced node). This is how a cross-window callback survives windowing.
3. **Merge:** sort by `start_node`; union two candidates when node ranges overlap >50% of the shorter, or payoff nodes are within 1 node AND the ranges overlap by at least 1 node (zero-overlap adjacent moments never merge). Merged range `[min, max]`, `interest = max`, `type` from the higher-interest one. **Merge gate:** a union whose speech span would exceed ~130s is not created - the candidates stay separate (the critic sees near-duplicates; post-critic NMS dedups). This bounds transitive merge chains at the source.
4. **Span guard (iterative):** any remaining candidate over ~130s of speech (a single oversized scanner range) splits repeatedly: at its payoff when the payoff is strictly inside and the head fits <=130s, otherwise at the midpoint node with the payoff assigned to the containing half; iterate until every piece fits.

After the critic runs, candidates are only ever kept or dropped - never trimmed or merged (§7, §12).

### Candidate selection into the critic (stratified, coverage-aware)

Scanner `interest` is an uncalibrated hunch from a model told not to judge - a naive global top-K by interest can starve whole regions of a long video and let one dense stretch monopolize the budget. Instead:

```
guaranteed = for each scan window (candidate assigned to the window of its payoff node):
                top PER_WINDOW_MIN_CANDIDATES (2) by interest
extras     = remaining candidates, global sort by interest desc,
             skipping any 10-min region that already holds REGION_MAX_CANDIDATES (6)
selected   = dedupe(guaranteed ++ extras) up to K
K          = clamp(round(sourceMinutes / 2), 8, CRITIC_MAX_CANDIDATES (40))
```

Every window is represented, no region floods the critic, and cost stays linear and bounded. `CRITIC_MAX_CANDIDATES` is env-tunable; the offline eval (§11) decides whether 3h videos need it raised (50-60) - the user-facing cap stays 12 regardless.

### Stage 2: CRITIC (reduce)

| Field | Value |
|---|---|
| Model | `OPENAI_CRITIC_MODEL`, default `gpt-5.1` (budget lever: `gpt-5-mini`) |
| Calls | candidates batched `CRITIC_BATCH_SIZE=6`, parallel, concurrency 4 |
| Reasoning | `reasoning_effort: "low"` (`SELECTION_REASONING_EFFORT` env) |
| Output cap | `max_output_tokens ≈ CRITIC_BATCH_SIZE * 400` (covers JSON + evidence arrays + reasoning tokens) |
| response_format | `json_schema`, `strict: true` |
| Input per candidate | local node window `[start_node-4 .. end_node+8]` (clamped) as `#<idx> [<start>s-<end>s] <text>`, plus word-level lines for the first 2 and last 2 nodes (the boundary zones); plus a one-line `thread:` note when the candidate references a collated thread |
| Output | `{results: [{id, keep, score, grounded, self_contained, start_node, payoff_node, end_node, hook_start_node, hook_end_node, title, description, title_evidence_nodes, description_evidence_nodes, language}]}` - node indices, never seconds |
| Posture | judge hard; `keep: false` for weak/contextless/mid-thought/weak-ending; "a 0.55 is a reject"; length matches the moment; title <= 70 chars + one truthful description, both in the source language |
| Truncation/refusal | strict schema holds only for completed responses. Truncated (`finish_reason: length` / incomplete): split the batch in half and retry (down to single-candidate batches), then double the output cap once. Refusal: retry once, then drop that batch's candidates with telemetry. |
| Model failure | API error -> backoff retry -> `CRITIC_MODEL_FALLBACK` (gpt-5-mini) -> batch-split retry. Terminal failure -> job fails **retryable** (technical FAILED; quota untouched). Scanner output is never shipped unjudged - the scanner cannot produce titles, descriptions, grounding, or calibrated scores, so "scanner-as-critic" is not a fallback (§12). |
| Business invariants (code) | every input candidate id present exactly once; no unknown/duplicate ids; node ids within that candidate's allowed context; non-empty title/description; finite `score` in [0,1]; evidence nodes inside `[start_node, end_node]` |

## 6. Production prompts

`{{LANGUAGE_NAME}}` / `{{LANGUAGE_ISO}}` are interpolated from `Job.language` before the critic call. The scanner writes no prose and needs no language injection.

### SCANNER system prompt

```
You are a fast recall scanner for a short-form video clipping tool. You read a
slice of a long-video transcript and list EVERY moment that could plausibly
become a standalone vertical clip (TikTok / Reels / Shorts). Your users are
"clippers" who cut viral moments from long streams, podcasts, and VODs.

Your job is to FIND, not to judge. Over-select on purpose. A borderline moment
must still be returned with a low interest score - a later, stronger model does
the strict judging. Missing a good moment is the only real mistake here.

Each transcript line is:  #<index> <text>
Refer to moments ONLY by these integer node indices. NEVER output timestamps,
seconds, or any number that is not a node index shown to you.

Return a moment when it contains any of:
- a strong emotional reaction (rage, shock, laughter, excitement)
- a funny beat, a fail, a clutch, a reveal, an unexpected outcome
- conflict, disagreement, a hot take, a controversial claim
- a surprising statement or a genuinely useful insight
- a question followed by an interesting answer
- a clear setup that pays off (a self-contained mini story)
- a curiosity hook: an unfinished thought that makes you want the answer

For each moment give:
- start_node: index where the setup/hook begins
- end_node: index where the payoff/punchline lands (be generous, include the payoff)
- payoff_node: the single index that is the core - the punchline, reaction, or answer
- interest: 0.0-1.0 rough hunch (0.3 = "maybe", 0.6 = "looks good", 0.9 = "must clip").
  Do NOT be strict. When unsure, lean higher and let the judge cut it.
- type: one of reaction, conflict, insight, story, funny, reveal, question, opinion, other
- thread: OPTIONAL short label (2-4 words) if this moment sets up or pays off a running
  joke, callback, or promise that spans the video (e.g. "never-sell-rares"). Omit if none.

Return at most 12 moments per slice - if you found more, keep the 12 with the
highest interest.

Ignore ONLY pure filler: greetings, intros, outros, sponsor reads, dead air.
Everything else with a spark: return it.

Output ONLY the JSON object described by the schema.
```

### CRITIC system prompt

```
You are a ruthless short-form editor. You are handed a small set of candidate
moments already flagged by a scanner. JUDGE HARD, refine the exact edges, and
kill the weak ones. Quality over quantity - it is correct and expected to reject
most candidates.

Each candidate arrives as a window of numbered transcript nodes:
  #<index> [<start>s-<end>s] <text>
with word-level timings at the edge nodes:
  [<start>s-<end>s] <word>
Address everything by node index. NEVER output a timestamp, a second, or an index
you were not shown. The window is padded with surrounding context so you can judge
self-containment and find where a clean sentence actually begins.

Score each candidate 0.0-1.0 for SCROLL-STOPPING potential:
- Would a stranger who never saw the source stop scrolling in the first 2-3 seconds?
- Is there real tension, emotion, curiosity, or payoff - not just information?
- Is it SELF-CONTAINED: does it make full sense with no prior context?
- Does it deliver on its own hook? (No bait it does not pay off.)

For EACH candidate return, in the clip's OWN language ({{LANGUAGE_NAME}}, {{LANGUAGE_ISO}}):

1. keep: false for anything generic, context-dependent, weak-ending, or mid-thought.
   Be strict. A 0.55 is a reject.
2. score: your calibrated 0.0-1.0. Judge THIS window in isolation; do not inflate.
3. grounded: true only if the title AND description are fully supported by text inside
   [start_node, end_node]. If you cannot ground a claim, drop it or lower the score.
4. self_contained: true only if the clip makes full sense to a stranger with no prior
   context - no dangling references, no missing setup.
5. Boundary nodes (LENGTH MATCHES THE MOMENT - roughly 8-90s, NEVER pad to a minimum):
   - start_node: the node that begins the opening line (a sentence onset, a clean
     1-2s lead-in is fine; never a dangling pronoun or mid-answer fragment).
   - payoff_node: the node where the punchline / answer / reaction completes.
   - end_node: the FIRST node that finishes a sentence AT or AFTER payoff_node. End on
     a complete sentence. NEVER end before the payoff. Do not trail more than ~4s of
     talk after the payoff - trim filler, goodbyes, topic changes.
   - hook_start_node / hook_end_node: the untouchable core (reaction/punchline). Must
     satisfy start_node <= hook_start_node <= hook_end_node <= end_node.
   Do NOT choose a node marked as music / no-speech as the start or end.
6. title: <= 70 characters, curiosity-driven but TRUTHFUL to what the clip delivers.
   No clickbait the clip does not pay off.
7. description: ONE grounded sentence describing what actually happens. No hype.
8. title_evidence_nodes / description_evidence_nodes: 1-3 node indices each, inside
   [start_node, end_node], containing the words that directly support your title and
   description. If you cannot point at supporting nodes, the copy is not grounded -
   rewrite it or set grounded: false.

Echo "language":"{{LANGUAGE_ISO}}". Include EVERY candidate id, kept or not.
Output ONLY the JSON object described by the schema.
```

## 7. Boundary precision (code owns final boundaries)

`snapNodes(result, nodes)`:

```
LEAD_IN = 0.15s   TAIL_HOLD = 0.30s   PAYOFF_MAX_TAIL_SEC = 4   SENTENCE_SLACK_SEC = 3
MAX_START_EXPANSION_SEC = 3   EPS = 0.05
CLIP_HARD_MIN_SEC = 6   CLIP_TARGET_MIN_SEC = 8   CLIP_MAX_SEC = 90

s = nodes[start_node]; p = nodes[payoff_node]; e = nodes[end_node]

// 1. clean start (the mid-thought guard the end already has via trailingStrength)
if s.leadingStrength < 0.8 and s.index > 0:
   s = nearest earlier node with leadingStrength >= 0.8
       within MAX_START_EXPANSION_SEC   ?? drop("no_clean_start")

// 2. payoff containment, then end selection with bounded tail.
//    The critic's end_node is HONORED when its tail past the payoff is within
//    PAYOFF_MAX_TAIL_SEC; the pull-back below fires only on genuine rambling.
if e.index < p.index: e = p
if (e.end - p.end) > PAYOFF_MAX_TAIL_SEC:
   e = strongest-boundary node in [p.end, p.end + PAYOFF_MAX_TAIL_SEC]    // prefer >= 0.8
       ?? strongest-boundary node in [p.end, p.end + PAYOFF_MAX_TAIL_SEC + SENTENCE_SLACK_SEC]
       ?? p                                 // ending right at the payoff is always legal
if e.hasWords == false:
   e = lastWordBearingNodeBefore(e)
   if e == null or e.index < p.index: drop("opaque_end")   // re-check containment

// 3. seconds from real node edges (lead-in/tail-hold only ever move within silence)
startSec = max(prevNode(s)?.end ?? 0, s.start - LEAD_IN)
endSec   = min(e.end + TAIL_HOLD, nextNode(e)?.start ?? e.end + TAIL_HOLD)
hookStart = nodes[hook_start_node].start ; hookEnd = nodes[hook_end_node].end

// 4. epsilon-tolerant invariants (violation -> drop, better lost than broken)
assert startSec <= hookStart + EPS          // hook may open the clip exactly
assert hookStart <  hookEnd
assert hookEnd   <= endSec + EPS
assert startSec  <  p.end and p.end <= endSec + EPS

// 5. duration policy - length is NEVER extended to satisfy a minimum
duration = endSec - startSec
if duration < CLIP_HARD_MIN_SEC: drop("too_short")
shortMoment = duration < CLIP_TARGET_MIN_SEC        // 6-8s ships, flagged in highlights JSON
if duration > CLIP_MAX_SEC:
   move start forward along strong (>= 0.8) boundaries only, while hook and payoff
   both remain inside; if still > CLIP_MAX_SEC -> drop("too_long")
```

**Unreliable word timings (music/crosstalk):** such regions are opaque nodes. A boundary may pass *through* an opaque region only when it is interior to the clip, never at an edge - code walks to the nearest word-bearing node (re-checking payoff containment, step 2). If a candidate's payoff node is opaque, or both edge nodes are opaque/unreliable, the candidate drops - better lost than a cut whose edges we cannot trust. (The earlier anchor-text fallback is removed - see §12.)

**Evidence gate (replaces the lexical grounding gate):** code validates `title_evidence_nodes` / `description_evidence_nodes`: present, inside `[start_node, end_node]`, word-bearing, non-opaque. Missing or invalid evidence, or critic `grounded=false` / `self_contained=false` -> candidate is ineligible. A lexical title-vs-transcript overlap score is still computed but **only as telemetry** - word matching penalizes honest paraphrase and collapses on inflected languages (Russian morphology), so it must not gate.

**Subtitle alignment (free win):** cut boundaries equal node/word edges, so `segmentsToCues` can never orphan a half-word and the karaoke timeline stays synced. One render assertion: `cues[0].start >= 0 && last.end <= duration`.

## 8. Language handling

- **Capture:** Whisper `verbose_json` returns `language` as a full English name ("russian"). Normalize via a ~40-entry name -> ISO-639-1 map. **Two fields, honest contract:** `Job.language` holds ISO-639-1 or null (never a raw name); `Job.languageRaw` holds Whisper's raw string verbatim (kept even when unmapped).
- **Speech-rich probe, not "first 60 seconds":** the first minute is often music, countdowns, sponsor bumpers, or silence. Reuse the `silencedetect` output (§9) to locate speech intervals; collect up to 60s of actual speech from the first ~10 minutes and probe language on that. The result is passed as `language:` to every chunk transcription, so a music-heavy stretch cannot flip detection mid-video.
- **Prompts:** ISO -> human name, interpolate into the critic prompt. Instruction prose stays English (house i18n policy); only generated title/description are localized.
- **Per-clip language:** the critic echoes `language` per candidate; that value is authoritative for the clip (bilingual videos exist) and is persisted to `Clip.language`. `Job.language` remains the dominant language. A mismatch increments `language_mismatch` telemetry.
- **Wrong-language copy is repaired, not just counted:** code runs a script check (Cyrillic/Latin character-class ratio) comparing title+description against the clip's transcript window. On mismatch: one copy-repair retry through the stage-2 model (same critic call shape, single candidate, "rewrite title/description in {{LANGUAGE_NAME}}"); if still mismatched, fall back to verbatim-snippet copy (title = first clause of the clip's own transcript, description = next sentence, truncated) - grounded and correctly-languaged by construction. A good clip is never dropped over copy language.
- **Downstream:** web renders title+description as-is; the bot picks UI strings by user locale but always shows the clip's title/description in the source language.

## 9. Long videos

**Whisper chunking (up to 180 min):** at 16kHz/mono/32kbps, 25MB ≈ 104 min. Chunk when extracted audio > 24MB or duration > 95 min.
- One `ffmpeg -af silencedetect=noise=-30dB:d=0.3` pass (output reused by the language probe, §8); place each ~20-min (`WHISPER_CHUNK_SEC=1200`, ≈4.7MB) boundary at the nearest detected silence within ±15s (fallback: hard cut with 3s overlap).
- Extract chunks from the normalized source; transcribe with the locked `language:`, `verbose_json`, `[segment, word]`; concurrency 3.
- **Re-offset (correctness-critical):** chunk k starting at source time t_k -> add t_k to every segment and word time.
- **Word-aligned seam dedup (not midpoint):** two Whisper runs can transcribe the same overlap differently ("I never said that" vs "I didn't say that"); a midpoint segment cut can drop half a sentence, keep a duplicate, or splice incompatible word sequences - and the sentence graph is built directly on this word track. Instead: normalize the overlap text on both sides, find the longest common token sequence, place the seam between matched tokens; only when no textual match exists fall back to the temporal midpoint. **Post-stitch asserts:** word times strictly monotonic (`word[i].start >= word[i-1].start`, `word[i].end > word[i].start`), duplicate rate below threshold; violations fix locally or mark the region unreliable (opaque).
- Cost unchanged per audio-minute; parallel chunk transcription partly offsets analyze's added latency.

**Partial transcripts are explicit, never silent:** a failed chunk is retried; if it still fails:
- Persist `Job.transcriptCoverage` (0..1, share of source duration covered) and `Job.transcriptPartial = true`; store `missingRanges: [{start, end, reason}]` inside `transcriptJson`.
- `transcriptCoverage < TRANSCRIPT_MIN_COVERAGE` (0.9) -> the job fails **retryable** (technical, quota untouched) - analyzing a video with a 30-minute hole is not a legitimate result.
- Above the floor: proceed, but no scan window and no candidate may cross a missing range, and consumers show a partial-processing note.
- A 0-clip outcome on a partial transcript reports `noClipsReason = PARTIAL_TRANSCRIPT`, never "no strong moments" - we do not claim the video is weak when we did not hear all of it.

**LLM context at 3h:** the map phase is the answer - ~21 scan windows of ~3k tokens run in parallel; the critic sees only ~6 short candidate windows per call. Context length is a non-issue at any duration; stratified selection (§5) keeps critic cost bounded while covering the whole timeline.

## 10. A/V sync normalization

Root cause: yt-dlp merges carry a container edit list / non-zero `start_time`; audio extraction resets audio to t=0 while the video cut inherits the offset -> constant shift between transcript and rendered frame. Fix once, upstream, so transcribe and render share one timeline.

`normalizeSource()` at the end of DOWNLOAD:

1. **Probe:** `ffprobe -v error -show_entries format=start_time -show_entries stream=index,codec_type,start_time -of json in.mp4`; also flag mp4 edit lists.
2. **Conditional no-op:** if every `start_time` is within 0.05s of 0 and no edit list -> skip remux, `normalizedArtifactKey = sourceArtifactKey`. Most direct uploads are clean.
3. **Fast remux (when needed):** `ffmpeg -ignore_editlist 1 -i in.mp4 -map 0:v:0 -map 0:a:0? -c copy -avoid_negative_ts make_zero -muxpreload 0 -muxdelay 0 -movflags +faststart normalized.mp4` (`0:a:0?` - optional mapping, see edge cases).
4. **Verify:** re-probe; require both streams `start_time ≈ 0` and `|v_start - a_start| < 40ms`.
5. **Re-encode fallback (only if verify fails):** `ffmpeg -ignore_editlist 1 -i in.mp4 -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 160k -af aresample=async=1 -avoid_negative_ts make_zero -movflags +faststart normalized.mp4`.
6. Store under **new** `Job.normalizedArtifactKey`; raw `sourceArtifactKey` preserved. Transcribe and both render paths read `normalizedArtifactKey ?? sourceArtifactKey`. Normalized artifact follows the same retention/cleanup lifecycle as the source artifact.

**Edge cases (explicit):**
- **No audio stream:** `-map 0:a:0?` keeps the remux from failing; the pipeline then short-circuits at the degenerate guard (`noClipsReason = NO_USABLE_SPEECH`) without calling Whisper.
- **Audio-only input:** cannot produce video clips; reject at submit/download with a clear user-facing error (not a pipeline failure).
- **Multiple audio streams:** take the default/first (`0:a:0`); log stream count.
- **`start_time = N/A`:** treat as 0 for the skip decision but force the verify re-probe path.
- **Rotation metadata:** `-c copy` preserves it; the re-encode fallback must apply the rotation (autorotate) so the crop stage sees upright frames.
- **VFR sources:** not a normalization trigger by themselves; the re-encode fallback's `aresample=async=1` handles the audio side when verify fails.
- **Remux failure (incompatible codec/container):** fall through to the re-encode path.
- **Idempotency:** if `normalizedArtifactKey` exists and its verify probe passes, skip normalization entirely (BullMQ retry safety).

**Render-time assertions (two metrics - duration error is not A/V skew):**
- `renderDurationErrorMs = |actual container duration - (end - start)|` - catches cut math regressions.
- `renderAvStartSkewMs = |video stream start_time - audio stream start_time|` probed on the rendered clip - catches real lip-sync offset (a clip can have perfect duration and 400ms skew).
Both logged per clip; alert thresholds set from the eval baseline.

`cut.ts` keeps `-ss start -to end` input-seek + re-encode unchanged.

## 11. Data model, consumers, failure modes, cost, rollout

### Prisma (additive, nullable/defaulted; migration timestamp must sort after `20260713120000`)

```prisma
enum AnalyzeEngine {
  LEGACY
  RECALL_CRITIC
}

enum NoClipsReason {
  NO_USABLE_SPEECH     // degenerate input, LLM never called
  NO_VIABLE_MOMENTS    // nothing cleared even the weak-fallback floor
  PARTIAL_TRANSCRIPT   // 0 clips but transcript had holes - not a quality verdict
}
```

**Job:**
```prisma
language               String?        // ISO-639-1 ONLY (null if unmapped)
languageRaw            String?        // Whisper's raw language name, verbatim
noClipsReason          NoClipsReason?
normalizedArtifactKey  String?
analyzeEngine          AnalyzeEngine?
highlightsVersion      Int      @default(1)   // 1 = legacy shape, 2 = recall-critic shape
transcriptCoverage     Float?         // 0..1 share of source duration transcribed
transcriptPartial      Boolean  @default(false)
analysisInputTokens    Int?           // aggregate; per-call breakdown in JobStep.outputJson
analysisOutputTokens   Int?           // incl. reasoning tokens
```

**Clip** (all source-absolute seconds fields share the existing `startTime`/`endTime` convention - same timeline, no prefix, documented in schema comments):
```prisma
description  String?
score        Float?
language     String?  // per-clip, from the critic echo (bilingual videos exist)
lowQuality   Boolean  @default(false)
hookStart    Float?   // source-absolute seconds, same convention as startTime/endTime
hookEnd      Float?   // source-absolute seconds
payoffAt     Float?   // source-absolute seconds
clipKind     String?  // TS union ClipKind in shared types; DB stays String for evolvability
@@index([jobId, score(sort: Desc)])
```

`Job.highlights` v2 item shape (worker-internal; `Job.highlightsVersion = 2`): `{ start, end, hookStart, hookEnd, payoffAt, score, title, description, language, lowQuality, shortMoment, kind, selfContained, _startNode, _endNode, _titleEvidenceNodes, _descriptionEvidenceNodes, _grounded, _boundaryConfidence }`.

**Shared types:** `TranscriptionResult.language?` + `languageRaw?`; `Highlight` gains the optional fields above (`reason` becomes optional - keeps `renderTrim`'s inline highlight typechecking); `ClipKind` TS union mirrors the scanner `type` enum.

**Token telemetry:** `JobStep.outputJson` stores the per-call breakdown (`scanInputTokens`, `scanOutputTokens`, `criticInputTokens`, `criticOutputTokens`, `criticReasoningTokens`, `retryTokens`, `modelIds`, `requestCount`); Job keeps the two aggregate columns.

### Consumer touchpoints

- `stages/render.ts`: persist new Clip fields; clip lists order by `score desc, startTime asc`.
- `stages/analyze.ts` + `finalize.ts`: content-empty results -> DONE with `noClipsReason`; the content-throw paths are removed. Technical analysis failure stays a retryable FAILED.
- **Bot:** caption becomes `title\n\ndescription`, clamped to Telegram's 1024-char limit (truncation guard is mandatory - today none exists). `lowQuality` prepends a localized "best available" note. 0-clip DONE copy is keyed by `noClipsReason` (honest bilingual variants for no-speech / no-moments / partial). Onboarding copy "Get 5-15 short clips" (EN+RU) updated to match quality-driven counts.
- **Web:** description line on `ClipCard` and the clip page; `lowQuality` badge; empty-state copy for 0-clip DONE keyed by `noClipsReason`; partial-processing note when `transcriptPartial`. Web UI stays English-only; clip title/description render in source language.

### Selection flow (normative)

```
1.  build sentence graph
2.  build windows (~600s speech, capped token budget)
3.  scanner per window (max 12 candidates, retry, coverage telemetry)
4.  merge/dedup/thread-collate/span-split          <- ALL merging, pre-critic
5.  stratified critic selection (per-window quota + global extras + region cap)
6.  critic (evidence nodes, self_contained, truncation/refusal handling)
7.  snapNodes: clean start, payoff containment, strong end, invariants,
    duration policy (drop, never extend)
8.  eligibility gate: keep && grounded && self_contained && valid boundaries
    && valid copy (evidence gate + language script check with repair)
9.  strong tier: eligible && score >= CLIP_SCORE_THRESHOLD (0.6)
10. weak tier (only if strong tier empty): eligible && score >= WEAK_FALLBACK_MIN_SCORE
    (0.35), top 1-2, lowQuality = true; nothing clears -> 0 clips, NO_VIABLE_MOMENTS
11. overlap NMS: keep-or-drop ONLY (higher score wins when overlap > 30% of the
    shorter clip); no post-critic trim, no post-critic merge - the critic's copy and
    grounding were produced for exact ranges and do not survive range edits
12. sort by score desc (startTime asc tiebreak) -> soft cap 12
```

### Failure modes

| Failure | Handling |
|---|---|
| Degenerate input (<5 words / <4s speech) | Code guard before any LLM call -> DONE, `NO_USABLE_SPEECH`, zero API cost |
| Tiny input (5-24 words) | Critic-only single-candidate path; normal gates apply |
| Scanner truncated/refused/API error | retry -> skip window, log, continue |
| Critic truncated (`finish_reason: length`) | split batch (down to 1) -> double output cap once |
| Critic refusal | retry once -> drop that batch's candidates + telemetry |
| Critic API/model failure | backoff retry -> `CRITIC_MODEL_FALLBACK` -> batch-split -> **retryable technical FAILED**; scanner output never ships unjudged |
| Hallucinated timestamp | Impossible by construction (node indices only; out-of-range -> drop row) |
| Cut mid-word | Impossible (node edges are word edges) |
| Cut mid-thought | Minimized: clean-start check (leadingStrength >= 0.8 or walk-back <= 3s, else drop) + strong-end selection + critic boundary rules |
| Cut payoff | Critic rule + `e.index >= p.index` re-checked after every end adjustment (incl. opaque walk-back) + epsilon invariants |
| Ramble past payoff | End = strongest boundary within payoff+4s, else within +7s (sentence-completion slack), else the payoff node itself |
| Opaque payoff or both edges opaque | Drop the candidate |
| Overlaps | Keep-or-drop NMS by score (no trim/merge after critic) |
| Ungrounded copy | Evidence-node gate (in-range, word-bearing) + critic `grounded` flag; lexical overlap is telemetry only |
| Wrong-language copy | Script check -> one repair retry -> verbatim-snippet fallback copy; clip never dropped for copy language |
| Duration < 6s | Drop (never extend); 6-8s ships flagged `shortMoment` |
| Duration > 90s | Start moves forward on strong boundaries only (hook+payoff intact), else drop |
| All below 0.6 | Weak tier: top 1-2 with floor 0.35 + full eligibility; else 0 clips `NO_VIABLE_MOMENTS` |
| Whisper chunk failure | Retry; coverage < 0.9 -> retryable technical FAILED; else proceed with explicit `missingRanges`, candidates never cross holes |
| Critic model down (terminal) | Retryable technical FAILED; kill switch `ANALYZE_ENGINE=legacy` |

Code is the final authority for: index validity, monotonic times, duration bounds, `score in [0,1]`, title <= 70 (truncate), non-empty description, evidence validity, boundary snapping, overlap resolution, threshold/floor/cap/fallback.

### Cost and latency (per 1h source; prices per 1M tokens: gpt-4o-mini $0.15/$0.60, gpt-5-mini $0.25/$2.00, gpt-5.1 $1.25/$10.00)

Assumptions: ~11k words -> ~2000 nodes -> ~26k node tokens; 7 scan windows (~28k in with overlap); K≈28 candidates in ~5 critic batches. Critic output budget raised to ~400 tokens/candidate (JSON + evidence arrays + reasoning at `reasoning_effort=low`).

| Call | Model | In | Out (incl. reasoning) | Cost |
|---|---|---|---|---|
| Scanner x7 | gpt-4o-mini | 28k | 3.5k | $0.0063 |
| Critic x5 | gpt-5.1 | 18k | ~8k | $0.1025 |
| **Total (recommended)** | | | | **≈ $0.11/hr** (worst, with repair retries ≈ $0.14) |
| Total (budget: gpt-5-mini critic) | | | | ≈ $0.024/hr |

3h scales sub-linearly (K capped): ≈ $0.16 total ≈ $0.055/hr. Latency: analyze ≈ 20-25s at 1h (vs ~5s today), ≈ 30-35s at 3h - acceptable in an async stage; parallel Whisper chunking claws time back on long videos. Replace the flat `ANALYSIS_COST_PER_MINUTE` estimate in `cost-telemetry.ts` with real `usage` token accounting.

### Rollout

```
ANALYZE_ENGINE=legacy|recall-critic|shadow     ANALYZE_V2_PCT=0..100 (hash(jobId)%100)
OPENAI_SCAN_MODEL=gpt-4o-mini                  OPENAI_CRITIC_MODEL=gpt-5.1
CRITIC_MODEL_FALLBACK=gpt-5-mini               SELECTION_REASONING_EFFORT=low
CLIP_SCORE_THRESHOLD=0.6   WEAK_FALLBACK_MIN_SCORE=0.35   CLIP_SOFT_CAP=12
CLIP_HARD_MIN_SEC=6        CLIP_TARGET_MIN_SEC=8          CLIP_MAX_SEC=90
SCAN_WINDOW_SEC=600        SCAN_OVERLAP_SEC=90            CRITIC_BATCH_SIZE=6
CRITIC_MAX_CANDIDATES=40   PER_WINDOW_MIN_CANDIDATES=2    REGION_MAX_CANDIDATES=6
ANALYZE_MAX_CONCURRENCY=5  MAX_START_EXPANSION_SEC=3
GAP_SENTENCE=0.60  GAP_PHRASE=0.30  NODE_MAX_SEC=12
LEAD_IN_SEC=0.15   TAIL_HOLD_SEC=0.30  PAYOFF_MAX_TAIL_SEC=4
WHISPER_CHUNK_SEC=1200     TRANSCRIPT_MIN_COVERAGE=0.9
```

Current `analyzeHighlights` kept verbatim as `analyzeHighlightsV1`; `stages/analyze.ts` dispatches on `ANALYZE_ENGINE` + deterministic `hash(jobId)%100` bucketing (stable across BullMQ retries), persisted to `Job.analyzeEngine`. `shadow` runs V2 alongside legacy, writing V2 output to `JobStep.outputJson` only.

**Offline eval gate - required BEFORE any production percentage.** Retrim rate and download rate are noisy proxies (a retrim can be a format preference; downloads depend on topic and creator), so the ramp is gated on a labeled set first:

- **Eval set (~80 sources):** 25 podcasts, 20 streams, 10 gaming VODs, 10 short/weak videos (expected 0 or near-0 clips), 10 multilingual/music-heavy, 5 long (2-3h) including known A/V-offset yt-dlp merges.
- **Labels per source:** human-marked interesting moments, acceptable start/end ranges, payoff point, expected language, expected zero/non-zero outcome.
- **Go/no-go thresholds:**

| Metric | Gate |
|---|---|
| Candidate recall on labeled moments (post-selection, pre-critic) | >= 90% |
| Final precision (human-judged good among shipped) | >= 70% |
| Median start/end boundary error | <= 1.0s |
| P95 boundary error | <= 3.0s |
| Payoff containment | >= 98% |
| Wrong-language copy after repair | <= 1% |
| Rendered A/V start skew P95 | < 80ms |
| 0-clip false negatives on non-empty labeled sources | <= 1 of the eval set |
| Analyze cost P95 | <= $0.15/source hour |

Only after gates pass: ramp 5% -> 25% -> 100%, watching production telemetry (below) per `analyzeEngine`. Rollback is env-only.

**Production telemetry** (JobStep.outputJson + existing columns): window/candidate/kept counts per stage of the selection flow, grounding/evidence drops, score distribution, `lowQuality`/`shortMoment` rates, 0-clip rate by reason, duration spread (fraction pinned at 6s floor / 90s cap - detects the old "everything ~31s" pathology), boundary-strength distribution (fraction of ends on `trailingStrength >= 0.8`, target >95%), `renderDurationErrorMs`, `renderAvStartSkewMs`, truncation/refusal/retry/skipped-window counts, `language_mismatch` + repair/fallback-copy counts, token usage. Secondary product signals: retrim rate per engine (via `Clip.parentClipId`), download rate, delivery success.

### Files touched

- `apps/worker/src/processors/analyze.ts` - V2 engine (graph, windows, scanner, merge, stratified selection, critic, snap, gates); V1 kept verbatim.
- `apps/worker/src/processors/transcribe.ts` - language capture + probe, silence-aligned chunking, re-offset, word-aligned seam dedup, coverage tracking.
- `apps/worker/src/processors/download.ts` (+ new normalize helper) - conditional A/V normalization with edge cases.
- `apps/worker/src/processors/cut.ts` / `subtitles.ts` - unchanged logic; benefit from normalized timeline.
- `apps/worker/src/stages/{analyze,transcribe,render,finalize}.ts` - engine dispatch, new fields, DONE-with-reason path, duration/skew assertions, `normalizedArtifactKey ?? sourceArtifactKey`.
- `apps/worker/src/cost-telemetry.ts` - token-usage-based analysis cost.
- `packages/shared/src/types/index.ts` - `TranscriptionResult.language/languageRaw`, extended optional `Highlight` fields, `ClipKind` union.
- `prisma/schema.prisma` + migration - enums + Job/Clip fields above.
- `apps/bot/src/handlers.ts` / `i18n.ts` - caption template + 1024 clamp, low-quality/0-clip copy keyed by reason, onboarding copy.
- `apps/web/components/clip-card.tsx`, `app/(dashboard)/dashboard/clips/[id]/page.tsx`, `components/project-detail.tsx` - description, badges, empty/partial states.

## 12. Rejected alternatives

- **Whole-arc single strong read as the base.** Best narrative insight (setups/payoffs across the hour), but one pass over an hour courts exactly the lost-in-the-middle under-recall this redesign exists to fix, and its >2h fallback path put a recall cliff on the biggest jobs. Its grounding intent, structured-outputs discipline, and thread awareness were grafted instead.
- **A third VERIFY LLM stage** (endorsed by all three panel judges). Violates the two-stage decision; its mechanisms are absorbed by the critic's isolated-context judging plus the code-side evidence gate.
- **Boundary-first as the base.** Best-in-class boundaries but selection was openly a "boring afterthought" - no strong model ever judged the full slate; risks well-cut-but-boring clips. Its sentence graph was taken as the spine instead.
- **Scanner-as-critic fallback** (was in the first draft). The scanner is prompted to over-select and cannot produce titles, descriptions, grounding, or calibrated scores - shipping its raw candidates on critic failure would deliver exactly the junk the critic exists to remove. Replaced by the model-fallback chain + retryable technical failure.
- **Post-critic trim/merge of overlapping clips** (was in the first draft). The critic's title, description, grounding, and self-containment verdicts are produced for exact node ranges; editing a range after the fact silently invalidates all of them (a trimmed setup, a description referencing removed content, two moments under one moment's copy). Post-critic overlap handling is keep-or-drop only.
- **Anchor-text boundary fallback** (was in the first draft). It was never wired into the critic schema, and with opaque-payoff-drop and keep-or-drop NMS it only rescued the rare both-edges-unreliable candidate - at the cost of extra schema fields, validation, and a fuzzy text-matching path. Dropping such candidates is safer than locating boundaries inside audio we already distrust.
- **Lexical word-match as the grounding gate** (was in the first draft). Penalizes honest paraphrase, collapses on inflected languages (Russian morphology), and can pass a misleading title whose words happen to appear. Replaced by critic-cited evidence nodes validated in code; lexical overlap demoted to telemetry.
- **Fixed-time Whisper chunking.** Splits words at seams; silence-aligned costs one `silencedetect` pass.
- **Temporal-midpoint seam dedup** (was in the first draft). Two Whisper runs transcribe overlaps differently; midpoint cuts can produce duplicated or non-monotonic word tracks that poison the sentence graph. Replaced by longest-common-token-sequence seam with midpoint as last resort + monotonicity asserts.
- **Post-hoc majority-vote language detection.** A music-heavy chunk can out-vote; speech-rich probe + `language:` param is deterministic.
- **Overwriting `sourceArtifactKey` with the normalized file.** A separate `normalizedArtifactKey` preserves the raw original and keeps pre-migration re-trims working.
- **Embedding rerankers / dedup models.** Deterministic score-based overlap resolution suffices; an embedding dependency adds infra and hurts rollback for marginal gain.
- **Critic emitting raw seconds.** Snapping LLM floats is good; node indices make hallucinated and mid-word boundaries impossible by construction - strictly better at no cost.

## 13. Explicitly out of scope (next iterations)

1. **Content-aware 9:16 crop** (speaker detection/tracking) - first item of the next iteration; render-side only, does not touch this algorithm.
2. **Per-plan clip caps / locked-clip upsell** - addable later via `PlanLimits.clipsPerJob` + a slice before render + UI.
3. Non-OpenAI providers for analysis.
