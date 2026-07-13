# Highlight Core Redesign: Recall-Judge on a Sentence-Graph Spine

**Date:** 2026-07-13
**Status:** Approved (design), pending implementation plan
**Scope:** ANALYZE stage rewrite + in-scope touchpoints in TRANSCRIBE (language capture, long-video chunking), DOWNLOAD (A/V normalization), RENDER (new Clip fields, drift assertion), consumers (description slot, 0-clip and low-quality messaging).

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
2. **Weak-video fallback.** If nothing passes the threshold, deliver top-1..2 candidates flagged `lowQuality` so bot/web can message honestly ("no strong moments; here is the best available"). Degenerate input (no usable speech) completes DONE with 0 clips + machine-readable reason. Never FAILED for content reasons.
3. **Two-stage LLM architecture**, budget ~$0.05-0.15 per source hour. OpenAI stays; models env-configurable. Whisper (~$0.36/hr) is separate and unchanged.
4. **Clip length matches the moment.** Min 8s floor (6s hard drop), max 90s. No padding to a minimum, ever. A tight 11s punchline ships as ~11s.
5. **Titles and one-sentence descriptions in the transcript's language**, grounded in what is actually said inside the clip window. No clickbait the clip does not deliver.
6. **Boundaries land on sentence/phrase ends** using word-level timestamps; the payoff is never cut; clips must be self-contained.
7. **In scope:** A/V timeline normalization; Whisper chunking up to 180 min. **Out of scope (next iteration):** content-aware 9:16 crop (speaker framing). Center crop stays for now.
8. Prisma migrations only (no `db push`); new Clip/Job columns nullable or defaulted.

## 3. Architecture overview

Separate **recall** (find every plausible moment, cheaply, in overlapping windows) from **judgment** (score hard, refine boundaries, write grounded copy, with a strong model over a small candidate set). Both LLM stages address moments by **node index** on a code-built sentence graph, so no model ever emits a timestamp and every cut lands on a real word or segment edge - hallucinated, mid-word, and mid-sentence cuts are impossible by construction, not by validation.

This architecture won a 4-design panel (map-reduce, single-strong-read, boundary-first, minimal-evolution) judged on clip quality, boundary accuracy, robustness, cost fit, and implementation fit. Grafts adopted from the non-winning designs are noted inline; rejected alternatives are in §12.

```
DOWNLOAD
  └─ normalizeSource()  [NEW]  ffprobe skew/edit-list probe -> conditional -c copy remux
        -> verify reprobe -> re-encode fallback only if verify fails
        -> writes Job.normalizedArtifactKey  (raw sourceArtifactKey preserved)

TRANSCRIBE  (reads normalizedArtifactKey ?? sourceArtifactKey)
  ├─ chunkAudioIfNeeded()  [NEW]  silence-aligned ~20-min chunks when >24MB / >95min
  ├─ language locked from a 60s probe of chunk 0, passed to every chunk
  ├─ whisper-1 verbose_json [segment,word] per chunk
  ├─ re-offset each chunk's segment+word times by chunk start; seam-dedup overlaps
  └─ capture language (name -> ISO), store Job.language + transcriptJson.language

ANALYZE  (analyzeHighlightsV2; V1 kept verbatim behind a flag)
  ├─ 0. degenerate guard [CODE]   <25 words or no word-bearing content
  │        -> { highlights: [], noClipsReason } ; skip both LLM calls
  ├─ 1. buildSentenceGraph()  [CODE]  words+segments -> nodes[] with trailingStrength,
  │        opaque flags for music/crosstalk; one global monotonic node index space
  ├─ 2. buildScanWindows()   [CODE]  node-indexed slices, ~600s speech + ~90s overlap
  ├─ 3. SCANNER (map)  gpt-4o-mini x N parallel, json_schema strict, recall-tuned
  │        per window -> {startNode,endNode,payoffNode,interest,type,thread?}
  ├─ 4. collateThreads() + mergeCandidates()  [CODE]  union overlaps, link threads,
  │        span-guard resplit, rank by interest, top-K into critic
  ├─ 5. CRITIC (reduce)  gpt-5.1 batched parallel, json_schema strict,
  │        reasoning_effort=low, max_output_tokens capped -> per candidate
  │        {id,keep,score,grounded, startNode,payoffNode,endNode,
  │         hookStartNode,hookEndNode, title,description,language}
  ├─ 6. snapNodes()  [CODE]  node idx -> seconds via word edges; lead-in/tail-hold;
  │        payoff-containment invariants; opaque-edge fallback
  ├─ 7. groundingGate()  [CODE]  critic grounded flag + lexical grounding check
  └─ 8. selectAndOrder()  [CODE]  threshold 0.6 -> overlap-by-score -> thread-merge
           -> sort by score -> soft cap 12 -> weak-video fallback / 0-clip DONE
  -> writes Job.highlights (new shape) + Job.language + Job.noClipsReason
     + real token-usage cost + telemetry

RENDER  (cuts from normalizedArtifactKey; crop/burn unchanged; persists new Clip fields)
  └─ avSyncDriftMs assertion  [NEW]  probe cut clip duration vs (end-start), log drift

FINALIZE  (tolerates 0 clips -> DONE with reason, never FAILED)
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

A node's word track is marked **unreliable** (treated as opaque for boundary purposes) if any word has `end <= start`, times are non-monotonic, or one word spans more than 3s. Every node edge is a real word or segment edge, so any range built from node indices is sentence-complete and word-aligned by construction. This deletes `snapToSegmentBoundaries` and `expandClipToMinDuration` from the V2 path.

## 5. LLM stages

### Scan windows

Window = contiguous node slice covering ~600s of speech with ~90s overlap (`SCAN_WINDOW_SEC=600`, `SCAN_OVERLAP_SEC=90`; ~7 windows per hour, ~21 for 3h). Window body is node lines `#<idx> <text>` with no timestamps (the scanner cannot hallucinate a second; also ~30% fewer tokens than the old `[12.3s - 15.6s]` format).

### Stage 1: SCANNER (map)

| Field | Value |
|---|---|
| Model | `OPENAI_SCAN_MODEL`, default `gpt-4o-mini` (recall lever: `gpt-5-mini`) |
| Calls | one per window, parallel, `ANALYZE_MAX_CONCURRENCY=5` |
| response_format | `json_schema`, `strict: true` |
| Temperature | 0.4 |
| Output | `{candidates: [{start_node, end_node, payoff_node, interest, type, thread?}]}` - node indices only |
| Posture | FIND, do not judge; over-select on purpose; missing a good moment is the only real mistake |
| Failure | schema guarantees shape; API error -> 1 backoff retry -> skip that window, log, continue (one dead window costs a sliver of recall, never the job). Code validates `0 <= start_node <= end_node < M`, `payoff_node` in range (else `start_node`), `interest` clamped [0,1]; invalid rows dropped |

### Candidate merge (code)

1. Drop index-invalid rows; concatenate across windows.
2. **Thread collation:** group candidates sharing a `thread` label; attach `threadSetupNode` (earliest referenced node). This is how a cross-window callback survives windowing.
3. **Merge:** sort by `start_node`; union two candidates when node ranges overlap >50% of the shorter, or payoff nodes are within 1 node. Merged range `[min, max]`, `interest = max`, `type` from the higher-interest one.
4. **Span guard:** if a merged region exceeds ~130s of speech, split back at the strongest constituent's `payoff_node`.
5. Rank by `interest` desc; take top `K = clamp(round(sourceMinutes / 2), 8, 40)` (`CRITIC_MAX_CANDIDATES=40`) into the critic. Critic cost is linear and bounded at any video length.

### Stage 2: CRITIC (reduce)

| Field | Value |
|---|---|
| Model | `OPENAI_CRITIC_MODEL`, default `gpt-5.1` (budget lever: `gpt-5-mini`) |
| Calls | candidates batched `CRITIC_BATCH_SIZE=6`, parallel, concurrency 4 |
| Reasoning | `reasoning_effort: "low"` (`SELECTION_REASONING_EFFORT` env) |
| Output cap | `max_output_tokens ≈ CRITIC_BATCH_SIZE * 260` (hard cost ceiling incl. reasoning tokens) |
| response_format | `json_schema`, `strict: true` |
| Input per candidate | local node window `[start_node-4 .. end_node+8]` (clamped) as `#<idx> [<start>s-<end>s] <text>`, plus word-level lines for the first 2 and last 2 nodes (the boundary zones); plus a one-line `thread:` note when the candidate references a collated thread |
| Output | `{results: [{id, keep, score, grounded, start_node, payoff_node, end_node, hook_start_node, hook_end_node, title, description, language}]}` - node indices, never seconds |
| Posture | judge hard; `keep: false` for weak/contextless/mid-thought/weak-ending; "a 0.55 is a reject"; length matches the moment; title <= 70 chars + one truthful description, both in the source language |
| Failure | schema guarantees shape; API error -> backoff retry -> fallback: reuse scanner `interest` as `score`, mark `lowQuality`, ship rather than lose the candidate |

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
4. Boundary nodes (LENGTH MATCHES THE MOMENT - range 8-90s, NEVER pad to a minimum):
   - start_node: the node that begins the opening line (a sentence onset, a clean
     1-2s lead-in is fine; never a dangling pronoun or mid-answer fragment).
   - payoff_node: the node where the punchline / answer / reaction completes.
   - end_node: the FIRST node that finishes a sentence AT or AFTER payoff_node. End on
     a complete sentence. NEVER end before the payoff. Do not trail more than ~4s of
     talk after the payoff - trim filler, goodbyes, topic changes.
   - hook_start_node / hook_end_node: the untouchable core (reaction/punchline). Must
     satisfy start_node <= hook_start_node <= hook_end_node <= end_node.
   Do NOT choose a node marked as music / no-speech as the start or end.
5. title: <= 70 characters, curiosity-driven but TRUTHFUL to what the clip delivers.
   No clickbait the clip does not pay off.
6. description: ONE grounded sentence describing what actually happens. No hype.

Echo "language":"{{LANGUAGE_ISO}}". Include EVERY candidate id, kept or not.
Output ONLY the JSON object described by the schema.
```

## 7. Boundary precision (code owns final boundaries)

`snapNodes(result, nodes)`:

```
LEAD_IN = 0.15s   TAIL_HOLD = 0.30s   PAYOFF_MAX_TAIL_SEC = 4
s = nodes[start_node]; p = nodes[payoff_node]; e = nodes[end_node]

// 1. payoff containment (never cut the payoff)
if e.index < p.index: e = p
if (e.end - p.end) > PAYOFF_MAX_TAIL_SEC:            // don't ramble past the punchline
   e = firstNodeAtOrAfter(p) with trailingStrength >= 0.8 within +4s, else e

// 2. end must land on a strong boundary; extend up to +3s if weak
if e.trailingStrength < 0.8:
   e = firstNodeWithin(e, +3.0s, trailingStrength >= 0.8) ?? e
if e.hasWords == false:                              // never END on music/opaque
   e = lastWordBearingNodeBefore(e) ?? e

// 3. seconds from real node edges (lead-in/tail-hold only ever shrink toward silence)
startSec = max(prevNode(s)?.end ?? 0, s.start - LEAD_IN)
endSec   = e.end + TAIL_HOLD
endSec   = min(endSec, nextNode(e)?.start ?? endSec) // don't bleed into next speaker
hookStart = nodes[hook_start_node].start ; hookEnd = nodes[hook_end_node].end

// 4. hard invariants (assert; drop clip on violation - better lost than broken)
assert startSec < hookStart < hookEnd <= endSec
assert startSec < p.end <= endSec
duration = endSec - startSec
if duration < CLIP_MIN_SEC(8):
   // floor takes precedence over the 4s tail cap; prefer context before the hook
   extend start backward node-by-node to a strong (>= 0.8) boundary while >= 8s unmet;
   then extend end forward to the next sentence-final boundary if still short;
   if still < 6s hard floor -> drop
if duration > CLIP_MAX_SEC(90): pull start forward toward hook (never into it); else drop
```

**Unreliable word timings (music/crosstalk):** such regions are opaque nodes. A boundary may pass *through* an opaque region only when it is interior to the clip, never at an edge - code walks back to the last word-bearing node. If a candidate's payoff node is opaque, the clip drops (better lost than a cut whose end we cannot trust).

**Tertiary anchor fallback:** the critic's response schema always includes `start_anchor` / `end_anchor` (3-6 verbatim words from the chosen boundary nodes). Code uses them only when an edge node is opaque/unreliable: `locateAnchorWords` normalizes and contiguous-matches them against the word stream within ±2s of the target node before falling back to raw segment edges. Anchors are a locator, never a source of numbers.

**Subtitle alignment (free win):** cut boundaries equal node/word edges, so `segmentsToCues` can never orphan a half-word and the karaoke timeline stays synced. One render assertion: `cues[0].start >= 0 && last.end <= duration`.

## 8. Language handling

- **Capture:** Whisper `verbose_json` returns `language` as a full English name ("russian"). Read it, normalize via a ~40-entry name -> ISO-639-1 map, fall back to the raw string if unmapped. Thread onto `TranscriptionResult.language`.
- **Store:** nullable `Job.language`, `transcriptJson.language`; denormalized onto `Clip.language` at render.
- **Chunked video:** language locked from a 60s probe of chunk 0 and passed as `language:` to every chunk, so a music-heavy stretch cannot flip detection mid-video.
- **Prompts:** ISO -> human name, interpolate into the critic prompt. Instruction prose stays English; only generated title/description are localized.
- **Validate:** critic echoes `language`; on mismatch with `Job.language`, keep the clip, increment `language_mismatch` telemetry.
- **Downstream:** web renders title+description as-is; the bot picks UI strings by user locale but always shows the clip's title/description in the source language.

## 9. Long videos

**Whisper chunking (up to 180 min):** at 16kHz/mono/32kbps, 25MB ≈ 104 min. Chunk when extracted audio > 24MB or duration > 95 min.
- One `ffmpeg -af silencedetect=noise=-30dB:d=0.3` pass; place each ~20-min (`WHISPER_CHUNK_SEC=1200`, ≈4.7MB) boundary at the nearest detected silence within ±15s (fallback: hard cut with 3s overlap) so no word is split.
- Extract chunks from the normalized source; transcribe with the locked `language:`, `verbose_json`, `[segment, word]`; concurrency 3.
- **Re-offset (correctness-critical):** chunk k starting at source time t_k -> add t_k to every segment and word time.
- **Seam dedup:** silence-snapped cuts put the seam in silence; in each overlap keep chunk k's segments with midpoint < overlap midpoint, chunk k+1's otherwise.
- Cost unchanged per audio-minute; parallel chunk transcription partly offsets analyze's added latency.

**LLM context at 3h:** the map phase is the answer - ~21 scan windows of ~3k tokens run in parallel; the critic sees only ~6 short candidate windows per call. Context length is a non-issue at any duration; `K <= 40` keeps critic cost bounded. Cross-window callbacks are partially recovered via thread collation and further mooted by the self-containment requirement.

## 10. A/V sync normalization

Root cause: yt-dlp merges carry a container edit list / non-zero `start_time`; audio extraction resets audio to t=0 while the video cut inherits the offset -> constant shift between transcript and rendered frame. Fix once, upstream, so transcribe and render share one timeline.

`normalizeSource()` at the end of DOWNLOAD:

1. **Probe:** `ffprobe -v error -show_entries format=start_time -show_entries stream=index,codec_type,start_time -of json in.mp4`; also flag mp4 edit lists.
2. **Conditional no-op:** if every `start_time` is within 0.05s of 0 and no edit list -> skip remux, `normalizedArtifactKey = sourceArtifactKey`. Most direct uploads are clean.
3. **Fast remux (when needed):** `ffmpeg -ignore_editlist 1 -i in.mp4 -map 0:v:0 -map 0:a:0 -c copy -avoid_negative_ts make_zero -muxpreload 0 -muxdelay 0 -movflags +faststart normalized.mp4`.
4. **Verify:** re-probe; require both streams `start_time ≈ 0` and `|v_start - a_start| < 40ms`.
5. **Re-encode fallback (only if verify fails):** `ffmpeg -ignore_editlist 1 -i in.mp4 -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 160k -af aresample=async=1 -avoid_negative_ts make_zero -movflags +faststart normalized.mp4`.
6. Store under **new** `Job.normalizedArtifactKey`; raw `sourceArtifactKey` preserved for debugging and pre-migration re-trims. Transcribe and both render paths read `normalizedArtifactKey ?? sourceArtifactKey`.
7. **Render-time drift assertion:** after each cut, probe the clip's real duration vs `end - start`; log `avSyncDriftMs` so normalization regressions surface.

`cut.ts` keeps `-ss start -to end` input-seek + re-encode unchanged.

## 11. Data model, consumers, failure modes, cost, rollout

### Prisma (additive, nullable/defaulted; migration timestamp must sort after `20260713120000`)

**Job:**
```prisma
language               String?   // ISO-639-1
noClipsReason          String?   // "no_usable_speech" etc -> DONE-with-0, not FAILED
normalizedArtifactKey  String?
analyzeEngine          String?   // "legacy" | "recall-critic"
analysisInputTokens    Int?
analysisOutputTokens   Int?      // incl. reasoning tokens
```

**Clip:**
```prisma
description  String?
score        Float?
language     String?
lowQuality   Boolean  @default(false)
hookStart    Float?   // source-absolute seconds
hookEnd      Float?
payoffAt     Float?
clipKind     String?
@@index([jobId, score(sort: Desc)])
```

`Job.highlights` Json shape (worker-internal, free to change): `{ start, end, hookStart, hookEnd, payoffAt, score, title, description, language, lowQuality, kind, _startNode, _endNode, _grounded, _boundaryConfidence }`.

**Shared types:** `TranscriptionResult.language?`; `Highlight` gains optional `score, description, payoffAt, language, lowQuality, kind`; `reason` becomes optional (keeps `renderTrim`'s inline highlight typechecking).

### Consumer touchpoints

- `stages/render.ts`: persist new Clip fields; clip lists order by `score desc, startTime asc`.
- `stages/analyze.ts` + `finalize.ts`: 0 clips -> DONE with `noClipsReason`; the throw paths are removed.
- **Bot:** caption becomes `title\n\ndescription`, clamped to Telegram's 1024-char limit (truncation guard is mandatory - today none exists). `lowQuality` prepends a localized "best available" note. 0-clip DONE gets honest bilingual copy ("no strong moments found"), not `processingFailed`. Onboarding copy "Get 5-15 short clips" (EN+RU) updated to match quality-driven counts.
- **Web:** description line on `ClipCard` and the clip page; `lowQuality` badge; empty-state copy for 0-clip DONE driven by `noClipsReason`. Web UI stays English-only; clip title/description render in source language.

### Failure modes

| Failure | Handling |
|---|---|
| Degenerate input (<25 words) | Code guard before any LLM call -> DONE, `noClipsReason`, zero API cost |
| Scanner bad JSON / API error | strict schema; backoff retry -> skip window, continue |
| Critic bad JSON / API error | strict schema; backoff retry -> reuse scanner `interest` as score + `lowQuality`, ship |
| Hallucinated timestamp | Impossible by construction (node indices only; out-of-range -> drop row) |
| Cut mid-word / mid-sentence | Impossible (node edges are word/segment edges) |
| Cut payoff | Triple guard: critic rule + `e.index >= p.index` + invariant assert |
| Ramble past payoff | `PAYOFF_MAX_TAIL_SEC=4` snap (8s floor takes precedence when they conflict) |
| End on music/opaque | Walk back to last word-bearing node; opaque payoff -> drop |
| Overlaps | Resolved by score, not chronology; when overlap exceeds 30% of the shorter clip, keep the higher score - the lower one trims to abut if its payoff survives, else drops; adjacent same-thread clips (gap <3s, merged <= 90s) merge |
| Clickbait title | `groundingGate()`: critic `grounded=false` -> drop/demote; lexical check: title content words must appear in the clip's transcript window |
| Duration out of [8,90] | Clamp per §7; never pad |
| All below threshold | Top 1-2 by score, `lowQuality=true`, honest messaging |
| Whisper chunk failure | Retry chunk; stitch the rest, flag partial transcript rather than fail a 3h job |
| Critic model down | Fallback chain `gpt-5.1 -> gpt-5-mini -> scanner-as-critic`; kill switch `ANALYZE_ENGINE=legacy` |

Analyze never throws for content reasons. Code is the final authority for: index validity, monotonic times, duration bounds, `score in [0,1]`, title <= 70 (truncate), non-empty description, boundary snapping, overlap resolution, threshold/cap/fallback.

### Cost and latency (per 1h source; prices per 1M tokens: gpt-4o-mini $0.15/$0.60, gpt-5-mini $0.25/$2.00, gpt-5.1 $1.25/$10.00)

Assumptions: ~11k words -> ~2000 nodes -> ~26k node tokens; 7 scan windows (~28k in with overlap); K≈28 candidates in ~5 critic batches. gpt-5.1 output modeled including reasoning tokens (`reasoning_effort=low`, capped `max_output_tokens`).

| Call | Model | In | Out (incl. reasoning) | Cost |
|---|---|---|---|---|
| Scanner x7 | gpt-4o-mini | 28k | 3.5k | $0.0063 |
| Critic x5 | gpt-5.1 | 18k | ~5.5k | $0.078 |
| **Total (recommended)** | | | | **≈ $0.084/hr** (worst ≈ $0.11) |
| Total (budget: gpt-5-mini critic) | | | | ≈ $0.021/hr |

3h scales sub-linearly (K capped at 40): ≈ $0.13 total ≈ $0.043/hr. Latency: analyze ≈ 20s at 1h (vs ~5s today), ≈ 30s at 3h - acceptable in an async stage; parallel Whisper chunking claws time back on long videos. Replace the flat `ANALYSIS_COST_PER_MINUTE` estimate in `cost-telemetry.ts` with real `usage` token accounting; persist `analysisInputTokens` / `analysisOutputTokens`.

### Rollout

```
ANALYZE_ENGINE=legacy|recall-critic|shadow     ANALYZE_V2_PCT=0..100 (hash(jobId)%100)
OPENAI_SCAN_MODEL=gpt-4o-mini                  OPENAI_CRITIC_MODEL=gpt-5.1
CRITIC_MODEL_FALLBACK=gpt-5-mini               SELECTION_REASONING_EFFORT=low
CLIP_SCORE_THRESHOLD=0.6   CLIP_SOFT_CAP=12    CLIP_MIN_SEC=8   CLIP_MAX_SEC=90
SCAN_WINDOW_SEC=600        SCAN_OVERLAP_SEC=90 CRITIC_BATCH_SIZE=6
CRITIC_MAX_CANDIDATES=40   ANALYZE_MAX_CONCURRENCY=5
GAP_SENTENCE=0.60  GAP_PHRASE=0.30  NODE_MAX_SEC=12
LEAD_IN_SEC=0.15   TAIL_HOLD_SEC=0.30  PAYOFF_MAX_TAIL_SEC=4
WHISPER_CHUNK_SEC=1200
```

Current `analyzeHighlights` kept verbatim as `analyzeHighlightsV1`; `stages/analyze.ts` dispatches on `ANALYZE_ENGINE` + deterministic `hash(jobId)%100` bucketing (stable across BullMQ retries), persisted to `Job.analyzeEngine`. Ramp 5% -> 25% -> 100%; rollback is env-only. `shadow` runs V2 alongside legacy, writing V2 output to `JobStep.outputJson` only, for zero-risk comparison.

**Telemetry** (JobStep.outputJson + existing columns): window/candidate/kept counts, grounding drops, score distribution, `lowQuality` rate, 0-clip rate, duration spread (fraction pinned at 8s floor / 90s cap - detects the old "everything ~31s" pathology), boundary-strength distribution (fraction of ends on `trailingStrength >= 0.8`, target >95%), `avSyncDriftMs`, retry/skip counts, `language_mismatch`, token usage.

**Ground-truth quality metric:** retrim rate per `analyzeEngine` (via existing `Clip.parentClipId` relation - a retrim is a labeled boundary failure), plus download rate and delivery success. V2 wins if clips/job and downloads rise while retrim, 0-clip, and FAILED rates fall.

### Files touched

- `apps/worker/src/processors/analyze.ts` - V2 engine (graph, windows, scanner, merge, critic, snap, gates); V1 kept verbatim.
- `apps/worker/src/processors/transcribe.ts` - language capture, silence-aligned chunking, re-offset, seam dedup.
- `apps/worker/src/processors/download.ts` + new normalize helper - conditional A/V normalization.
- `apps/worker/src/processors/cut.ts` / `subtitles.ts` - unchanged logic; benefit from normalized timeline.
- `apps/worker/src/stages/{analyze,transcribe,render,finalize}.ts` - engine dispatch, new fields, DONE-with-0, drift assertion, `normalizedArtifactKey ?? sourceArtifactKey`.
- `apps/worker/src/cost-telemetry.ts` - token-usage-based analysis cost.
- `packages/shared/src/types/index.ts` - `TranscriptionResult.language`, extended optional `Highlight` fields.
- `prisma/schema.prisma` + migration - Job/Clip fields above.
- `apps/bot/src/handlers.ts` / `i18n.ts` - caption template + 1024 clamp, low-quality/0-clip copy, onboarding copy.
- `apps/web/components/clip-card.tsx`, `app/(dashboard)/dashboard/clips/[id]/page.tsx`, `components/project-detail.tsx` - description, badge, empty state.

## 12. Rejected alternatives

- **Whole-arc single strong read as the base.** Best narrative insight (setups/payoffs across the hour), but one pass over an hour courts exactly the lost-in-the-middle under-recall this redesign exists to fix, and its >2h fallback path put a recall cliff on the biggest jobs. Its grounding intent, structured-outputs discipline, anchor-text locator, and thread awareness were grafted instead.
- **A third VERIFY LLM stage** (endorsed by all three judges). Violates the two-stage decision; its mechanisms are absorbed by the critic's isolated-context judging plus the deterministic code-side grounding gate.
- **Boundary-first as the base.** Best-in-class boundaries but selection was openly a "boring afterthought" - no strong model ever judged the full slate; risks well-cut-but-boring clips. Its sentence graph was taken as the spine instead.
- **Fixed-time Whisper chunking.** Splits words at seams; silence-aligned costs one `silencedetect` pass.
- **Post-hoc majority-vote language detection.** A music-heavy chunk can out-vote; chunk-0 lock + `language:` param is deterministic.
- **Overwriting `sourceArtifactKey` with the normalized file.** A separate `normalizedArtifactKey` preserves the raw original and keeps pre-migration re-trims working.
- **Embedding rerankers / dedup models.** Deterministic score-based overlap resolution suffices; an embedding dependency adds infra and hurts rollback for marginal gain.
- **Critic emitting raw seconds.** Snapping LLM floats is good; node indices make bad boundaries impossible by construction - strictly better at no cost.

## 13. Explicitly out of scope (next iterations)

1. **Content-aware 9:16 crop** (speaker detection/tracking) - first item of the next iteration; render-side only, does not touch this algorithm.
2. **Per-plan clip caps / locked-clip upsell** - addable later via `PlanLimits.clipsPerJob` + a slice before render + UI.
3. Non-OpenAI providers for analysis.
