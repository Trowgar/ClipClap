/**
 * Music-hook window detector (task M2, spec 2026-08-23-music-shorts.md).
 *
 * Pure port of the measured python reference
 * `apps/worker/.corpus/music-shorts/chorus-detect.py`, which went 3/3 on
 * iTunes 30s-preview hook labels (Blinding Lights, Believer, Baby Shark -
 * the last on ENERGY ALONE, rep 0, which is why the score below is a SUM of
 * two signals rather than either gating the other). No ffmpeg, no LLM, no
 * I/O: segments, an already-computed per-second energy envelope, and a
 * duration go in; ranked hook windows come out.
 *
 * Two things this port adds over the python script, both from spec §2:
 *   - `count` is a caller parameter, not hardcoded to 3 (the build wants
 *     top-1/top-2 clips per source, not a printed top-3 report).
 *   - EDGE SNAPPING: the python script's windows sit wherever the 5s step
 *     grid put them; this port nudges each edge to the nearest energy
 *     valley within reach so a cut does not land mid-word/mid-beat. This
 *     half is NEW, not corpus-validated the way the rep/energy scoring is -
 *     see the constants below and `snapWindowEdges`.
 */

export interface MusicHookInput {
  /** Whisper segments - only start/end/text are read. */
  segments: Array<{ start: number; end: number; text: string }>;
  /** Per-second RMS dB, index = second offset from 0 (e.g. envelope[12] is
   *  the 12th second's average level). May be [] - no audio signal
   *  available, every window then scores on repetition alone. */
  energyEnvelope: number[];
  durationSec: number;
}

export interface HookWindow {
  startSec: number;
  endSec: number;
  /** Count of distant-repetition spans overlapping this window (pre-snap). */
  rep: number;
  /** Energy z-score of the window's mean RMS against the whole envelope
   *  (pre-snap; snapping only moves edges, it never rescoves the window). */
  energyZ: number;
  score: number;
}

/** Window length the detector scores over. chorus-detect.py WINDOW_SEC:
 *  wide enough to hold a chorus/hook - the unit the iTunes preview-position
 *  label was measured against (spec §1: 3/3 corpus tracks land an
 *  Apple-hook overlap >= 10s inside a top-3 20s window). */
const WINDOW_SEC = 20;

/** Grid the window slides on. chorus-detect.py STEP_SEC, unchanged. */
const STEP_SEC = 5;

/** Two occurrences of the same line closer than this are one performance,
 *  not a reprise. chorus-detect.py MIN_GAP_SEC - the song gate's own
 *  distance reasoning (song-gate.ts), applied here to hook-finding instead
 *  of song-refusal. The adjacent-hallucination fixture (a line repeated
 *  every 2s) must produce zero rep evidence at this threshold. */
const MIN_GAP_SEC = 25;

/** The song gate's own MIN_LINE_TOKENS lesson (song-gate.ts): a line under
 *  two tokens carries no textual evidence - a stray ASR token like "lol" or
 *  "3" repeating constantly would otherwise fake a chorus. Ported as its
 *  own constant rather than an import: this module has its own line shape
 *  ({start,end,text}, not WhisperSegment) and the spec asks for each
 *  constant re-measured/cited in place, not silently shared. */
const MIN_LINE_TOKENS = 2;

/** Score weights. chorus-detect.py REP_W/ENERGY_W: repetition outweighs
 *  energy 2:1, but energy alone still carries a window (Baby Shark: rep 0,
 *  hit on energy alone) because the two terms are SUMMED, never gating
 *  each other. */
const REP_WEIGHT = 2.0;
const ENERGY_WEIGHT = 1.0;

/** A candidate window overlapping an already-chosen one by this much or
 *  more is the same region, not a runner-up. chorus-detect.py's top-3-
 *  distinct pass, measured on Blinding Lights: without it, several 5s-
 *  shifted windows over the same chorus buried the second Apple-hook
 *  region out of the shortlist entirely. */
const DISTINCT_REGION_MIN_OVERLAP_SEC = WINDOW_SEC / 2;

/** NEW in this port (spec §2 "energy-valley edges", not in chorus-
 *  detect.py): how far either edge may move to reach the quietest nearby
 *  second. */
const EDGE_SNAP_RADIUS_SEC = 3;

/** A snap may never shrink a window under this floor. NEW, same spec
 *  paragraph. Note for whoever tunes WINDOW_SEC/EDGE_SNAP_RADIUS_SEC next:
 *  at the current 20s window and 3s radius the worst-case shrink from both
 *  edges moving inward is 6s (20 - 3 - 3 = 14), so this floor never
 *  actually fires through `selectHookWindows` today - it is exercised
 *  directly against `snapWindowEdges` in the test suite instead, as
 *  insurance for whenever those two numbers move. */
const MIN_WINDOW_SEC_AFTER_SNAP = 12;

/** lowercase, strip non-letter/digit/space (unicode), collapse whitespace.
 *  Same normalization as song-gate.ts's normalizeLine, kept as a private
 *  copy for the reason MIN_LINE_TOKENS above gives. */
function normalizeLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** python's `str.split()` (no args) drops empty tokens, so `"".split()`
 *  is 0 tokens, not 1. `.split(" ")` on an empty string would wrongly
 *  report 1, hence the explicit guard. */
function tokenCount(normalized: string): number {
  return normalized === "" ? 0 : normalized.split(" ").length;
}

interface RepSpan {
  start: number;
  end: number;
}

/**
 * Signal 1: lines that recur >= MIN_GAP_SEC apart. Faithful port of
 * chorus-detect.py's occs/rep_spans loop - lines under MIN_LINE_TOKENS
 * never enter the occurrence map at all (so they can never accumulate two
 * occurrences); for lines that do, a greedy walk keeps the first
 * occurrence, then only occurrences >= MIN_GAP_SEC past the *last kept*
 * one's start; a line needs >= 2 survivors after that walk before ANY of
 * its spans count as rep evidence, and when it does, ALL survivors go in
 * (not just the first two).
 */
function computeRepSpans(segments: MusicHookInput["segments"]): RepSpan[] {
  const occurrences = new Map<string, RepSpan[]>();
  for (const seg of segments) {
    const normalized = normalizeLine(seg.text);
    if (tokenCount(normalized) < MIN_LINE_TOKENS) continue;
    const list = occurrences.get(normalized);
    const span: RepSpan = { start: seg.start, end: seg.end };
    if (list) list.push(span);
    else occurrences.set(normalized, [span]);
  }

  const spans: RepSpan[] = [];
  for (const xs of occurrences.values()) {
    if (xs.length < 2) continue;
    const kept: RepSpan[] = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i].start - kept[kept.length - 1].start >= MIN_GAP_SEC) {
        kept.push(xs[i]);
      }
    }
    if (kept.length >= 2) spans.push(...kept);
  }
  return spans;
}

interface RawWindow {
  startSec: number;
  endSec: number;
  rep: number;
  energyZ: number;
  score: number;
}

/**
 * Signal 2 + combined score, one row per window on the STEP_SEC grid.
 * chorus-detect.py's window loop, including its `range(0, max(1, tsec -
 * WINDOW_SEC), STEP_SEC)` bound (a source shorter than WINDOW_SEC still
 * gets exactly one window, starting at 0).
 */
function scoreWindows(
  repSpans: RepSpan[],
  envelope: number[],
  durationSec: number
): RawWindow[] {
  let mean = 0;
  let sd = 1;
  if (envelope.length > 0) {
    mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
    const variance =
      envelope.reduce((a, b) => a + (b - mean) ** 2, 0) / envelope.length;
    sd = Math.sqrt(variance) || 1; // var 0 (flat envelope) -> sd 1, not div-by-zero
  }

  const tsec = Math.floor(durationSec);
  const stop = Math.max(1, tsec - WINDOW_SEC);
  const windows: RawWindow[] = [];
  for (let w0 = 0; w0 < stop; w0 += STEP_SEC) {
    const w1 = w0 + WINDOW_SEC;
    const rep = repSpans.filter((s) => s.start < w1 && s.end > w0).length;

    let energyZ = 0;
    if (envelope.length > 0) {
      let sum = 0;
      for (let s = w0; s < w1; s++) sum += s < envelope.length ? envelope[s] : -90;
      energyZ = (sum / WINDOW_SEC - mean) / sd;
    }

    windows.push({
      startSec: w0,
      endSec: w1,
      rep,
      energyZ,
      score: REP_WEIGHT * rep + ENERGY_WEIGHT * energyZ,
    });
  }
  return windows;
}

/**
 * Top-`count` windows over DISTINCT regions. Ranks by score descending
 * (ties keep the earlier-starting window: `scoreWindows` builds its list
 * w0-ascending and this sort is stable, exactly mirroring chorus-detect.py's
 * stable `rows.sort(key=lambda r: -r[4])` over a w0-ascending list), then
 * greedily accepts a candidate only when it overlaps EVERY already-chosen
 * window by less than half a window - the Blinding Lights fix.
 */
function pickDistinctTop(windows: RawWindow[], count: number): RawWindow[] {
  const ranked = [...windows].sort((a, b) => b.score - a.score);
  const chosen: RawWindow[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= count) break;
    const tooClose = chosen.some(
      (kept) =>
        Math.min(candidate.endSec, kept.endSec) -
          Math.max(candidate.startSec, kept.startSec) >=
        DISTINCT_REGION_MIN_OVERLAP_SEC
    );
    if (!tooClose) chosen.push(candidate);
  }
  return chosen;
}

/** The quietest envelope second within +-EDGE_SNAP_RADIUS_SEC of `edge`;
 *  ties go to the candidate nearest the original edge, and a further tie
 *  (equidistant on both sides, same level) to the earlier second - an
 *  arbitrary but deterministic pick, since the spec does not say. An empty
 *  envelope, or no second in range (edge near second 0), returns `edge`
 *  unchanged. */
function quietestSecondNear(edge: number, envelope: number[]): number {
  let best = edge;
  let bestVal = Infinity;
  let bestDist = Infinity;
  for (let s = edge - EDGE_SNAP_RADIUS_SEC; s <= edge + EDGE_SNAP_RADIUS_SEC; s++) {
    if (s < 0 || s >= envelope.length) continue;
    const v = envelope[s];
    const dist = Math.abs(s - edge);
    if (v < bestVal || (v === bestVal && dist < bestDist)) {
      bestVal = v;
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/**
 * Snaps both edges of one window to nearby energy valleys. Exported (over
 * and above the two required exports) so the MIN_WINDOW_SEC_AFTER_SNAP
 * floor - unreachable through `selectHookWindows` at today's WINDOW_SEC/
 * EDGE_SNAP_RADIUS_SEC (see that constant's comment) - can still be tested
 * directly, and so a future window-size change has a unit-level seam to
 * verify against rather than only the end-to-end pipeline.
 *
 * Start is attempted before end, each checked against the window's CURRENT
 * state (so an accepted start-move is what the end-move's floor/overlap
 * check sees) and against `finalized` - windows already returned at a
 * higher rank. Per spec: "when it would [violate], keep the un-snapped
 * edge" - a rejected edge is evaluated and reverted on its own, so one bad
 * move never costs the other edge its own valid snap.
 */
export function snapWindowEdges(
  window: { startSec: number; endSec: number },
  envelope: number[],
  finalized: Array<{ startSec: number; endSec: number }> = []
): { startSec: number; endSec: number } {
  if (envelope.length === 0) return { startSec: window.startSec, endSec: window.endSec };

  const overlapsFinalized = (start: number, end: number) =>
    finalized.some((f) => start < f.endSec && end > f.startSec);

  let start = window.startSec;
  let end = window.endSec;

  const candidateStart = quietestSecondNear(start, envelope);
  if (
    end - candidateStart >= MIN_WINDOW_SEC_AFTER_SNAP &&
    !overlapsFinalized(candidateStart, end)
  ) {
    start = candidateStart;
  }

  const candidateEnd = quietestSecondNear(end, envelope);
  if (
    candidateEnd - start >= MIN_WINDOW_SEC_AFTER_SNAP &&
    !overlapsFinalized(start, candidateEnd)
  ) {
    end = candidateEnd;
  }

  return { startSec: start, endSec: end };
}

/**
 * Ranked hook windows for a source. Pure, deterministic: same input always
 * produces the same output, no I/O.
 *
 * Returns [] only when there is truly no signal at all - no repetition
 * evidence AND no energy envelope (spec §2's explicit "no signal" case) -
 * rather than falling back to an arbitrary grid position, which is what
 * chorus-detect.py's script would do (it always has SOME envelope, being
 * fed real audio; this module has to handle the envelope arriving empty).
 */
export function selectHookWindows(input: MusicHookInput, count = 2): HookWindow[] {
  const repSpans = computeRepSpans(input.segments);
  if (repSpans.length === 0 && input.energyEnvelope.length === 0) return [];

  const scored = scoreWindows(repSpans, input.energyEnvelope, input.durationSec);
  const chosen = pickDistinctTop(scored, count);

  const finalized: Array<{ startSec: number; endSec: number }> = [];
  const result: HookWindow[] = [];
  for (const w of chosen) {
    const snapped = snapWindowEdges(w, input.energyEnvelope, finalized);
    finalized.push(snapped);
    result.push({
      startSec: snapped.startSec,
      endSec: snapped.endSec,
      rep: w.rep,
      energyZ: w.energyZ,
      score: w.score,
    });
  }
  return result;
}
