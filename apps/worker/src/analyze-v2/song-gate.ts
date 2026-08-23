/**
 * Song-lyric source refusal (spec 2026-08-10 "Clip arc audit...", task 8).
 *
 * Deterministic, pre-scan gate: a transcript whose segments look like sung
 * verse resolves to a `NO_USABLE_SPEECH`-class refusal instead of clips,
 * BEFORE the scanner ever runs - a firing gate costs zero LLM calls, the
 * same "free" property the degenerate guard at the top of `index.ts` has for
 * an empty transcript. Motivation (engine-notes §5c): one outside user
 * uploaded the same 90s film scene four times and got a clip cut from the
 * SONG's lyrics each time - a source class the engine should refuse rather
 * than clip.
 *
 * MEASURED, not designed from intuition - the spec's own instruction
 * ("Signal design is the task's job"). `scripts/eval-song-gate.ts` ran six
 * candidate signals (♫/♪ token share, line-repetition rate, median segment
 * length, median words/segment, opaque-node share, word-timing coverage)
 * against the eight job ids the spec labels SONG and against 20 real speech
 * transcripts (15 outside-user jobs created after 2026-08-11 15:00 with
 * clipsGenerated > 0, plus the five eval fixtures). Findings, 2026-08-17 (the
 * measured table lives in the executor's report, not duplicated here):
 *
 *   - Two of the eight spec-labeled SONG ids (the "film scene" pair,
 *     cmsp7y0om.../cmsp80iqk...) measure as 100% ordinary movie dialogue:
 *     zero music tokens, 6.8% line repetition (below even the speech
 *     ceiling), and their shipped highlights are dialogue clips, not lyric
 *     clips. Treated as the BOUNDARY case the spec itself anticipates ("if
 *     the table shows them looking like speech... treat them as the boundary
 *     case, not as a failure of the gate") and excluded from the
 *     required-fire pool the thresholds below are sized against.
 *   - Neither remaining candidate signal separates alone. The pure-music job
 *     (segment text IS literally "♫") scores 100% on the token signal and 0%
 *     on repetition (an empty normalized line is never counted as a
 *     repeat). The SUNG-AS-WORDS jobs (Whisper transcribes the lyrics as
 *     ordinary text, no note glyph at all) score 0% on the token signal and
 *     25.0-66.7% on repetition (chorus lines recur verbatim). The two
 *     signals catch two DIFFERENT song shapes, so the rule needs both.
 *   - `lineRepRate > LINE_REP_RATE_THRESHOLD` (0.20) fires on 5 of the 6
 *     remaining SONG jobs (min firing value 25.0%, the Farsi verse job) and
 *     on ZERO of 20 speech transcripts (max 13.8%, the creator-challenge
 *     fixture) - 11.2 points of margin on both sides of the threshold.
 *   - `musicTokenShare > MUSIC_TOKEN_SHARE_THRESHOLD` (0.30) fires on the 6th
 *     (the pure-♫ job, 100%) and on ZERO speech transcripts (max 0%, every
 *     one of them) - full separation, no measured value anywhere near the
 *     threshold on either side.
 *   - The two boundary dialogue rows fire on NEITHER signal, exactly as they
 *     should: they are speech, not song, and the gate must not refuse them.
 *
 * So the rule is a DISJUNCTION of two independently-measured thresholds, not
 * a single signal and not a conjunction - the two song shapes in this corpus
 * (literal ♫ glyphs vs. sung words with no glyph at all) are mutually
 * exclusive on the signal that catches the other one, so an AND would miss
 * both.
 *
 * Median segment length and opaque-node share (two of the spec's four named
 * candidates) are deliberately NOT part of the rule: both overlap the SONG
 * and SPEECH ranges in the measured table (e.g. medSegDur 1.2-5.2s on speech
 * vs 0.0-5.2s on the required-fire song pool; opaqueNodeShare 1.7-42.1% on
 * speech vs 0.0-39.8% on song) - leaving them out is a measured decision, not
 * an oversight.
 *
 * The two thresholds are plain constants, not `AnalyzeConfig` fields: the
 * spec names exactly one env knob for this task (`SONG_GATE=on`, the
 * enabled switch), and unlike `endExtensionWindowSec` / `startExtension
 * WindowSec` (windows a future measurement genuinely needs to move) these
 * two numbers are the whole output of this task's own measurement - exposing
 * them as tunable would be a tuning door onto a number this task exists to
 * fix, the same refusal already on record for the other window constants.
 *
 * Deliberately config-free otherwise: "policy in index.ts, mechanism in the
 * module that owns the data" (spec §4) - the ON/OFF decision belongs at the
 * call site (`stages/analyze.ts`, `cfg.songGateEnabled`), not inside this
 * predicate, so `detectSong` never needs to know whether it is allowed to
 * run.
 */
import type { WhisperSegment } from "@clipclap/shared";

/** A token that is nothing but music-note glyphs - "♫", "♪", "♫♫♫". Whisper
 *  emits these as whole segment texts on purely instrumental stretches
 *  (measured on cmspy9brs00anuhfjecmby2u2: every segment is literally "♫").
 *  Does NOT catch sung words transcribed as ordinary text with no note glyph
 *  at all - `lineRepRate` exists for that shape, which is why the gate is a
 *  disjunction of the two rather than trusting this alone. */
const MUSIC_NOTE_TOKEN = /^[♫♪]+$/u;

/** Measured margin: SONG min (excluding the pure-♫ job, which this signal
 *  does not apply to) irrelevant here - this signal is binary in the
 *  corpus (0% or 100%), so any threshold strictly between the two would
 *  work; 0.30 leaves comfortable room either side. SPEECH max measured: 0%
 *  on all 20 transcripts. */
export const MUSIC_TOKEN_SHARE_THRESHOLD = 0.3;

/** Measured margin: SONG min (required-fire pool) 25.0% (cmsptnpxd00afuhfj
 *  rtv10ie4, Farsi verse) vs SPEECH max 13.8% (creator-challenge fixture) -
 *  0.20 sits with 5.0 points of margin below the SONG floor and 6.2 points
 *  above the SPEECH ceiling. */
export const LINE_REP_RATE_THRESHOLD = 0.2;

/** Case/punctuation-insensitive line key for the chorus-repetition signal.
 *  Strips everything but letters/digits/whitespace so "Let it go!" and
 *  "let it go" collide, the way a real chorus would even if Whisper
 *  re-punctuates it differently between repeats. An empty result (a segment
 *  with no letters/digits at all - "♫", "[Music]") is never counted as
 *  either a line or a repeat: it carries no textual evidence either way, and
 *  counting empties as automatic matches would make `lineRepRate` fire on
 *  any long silent/instrumental stretch regardless of what is actually said,
 *  which is exactly the false-positive shape this task exists to avoid on
 *  real podcasts with music beds. */
function normalizeLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The fewest words a normalised line must have before a repeat of it counts
 *  as chorus evidence.
 *
 *  Added 2026-08-23 after a production job was refused wrongly: a 36-minute
 *  Hindi conversation from YouTube transcribed completely - 688 segments,
 *  11,041 characters, coverage 1.000 - but 252 of those segments normalised to
 *  the single character "3" and 13 more to "i". That junk alone put
 *  `lineRepRate` at 0.473 against a 0.2 threshold, so the gate refused the
 *  whole video as NO_USABLE_SPEECH and the person got nothing. Excluding
 *  one-token lines takes the same transcript to 0.065, a three-fold margin
 *  under the threshold, and the 22 repeats that remain are real repeated
 *  phrases, which ordinary conversation contains.
 *
 *  Two words, not three: it is the smallest exclusion that fixes the measured
 *  failure, and a genuine chorus line is a phrase, so nothing that the gate is
 *  meant to catch lives at one token. It is the same reasoning the empty-line
 *  rule already applies - a line with no textual evidence is evidence of
 *  nothing, in either direction. */
export const MIN_LINE_TOKENS = 2;

/** Whether a normalised line carries enough text to count as chorus evidence. */
function countsAsLine(normalized: string): boolean {
  if (!normalized) return false;
  return normalized.split(" ").length >= MIN_LINE_TOKENS;
}

export interface SongGateSignals {
  musicTokenShare: number;
  lineRepRate: number;
  segCount: number;
}

export interface SongGateResult {
  fired: boolean;
  signals: SongGateSignals;
}

/** The two raw signals, with no threshold applied - split out so
 *  `eval-song-gate.ts` (and anything else that wants to re-derive the table
 *  this module's own doc comment cites) reads the SAME computation the gate
 *  runs on a real job, rather than a second implementation that could drift
 *  from it. Pure: no I/O, no config, no LLM. */
export function computeSongSignals(segments: WhisperSegment[]): SongGateSignals {
  let totalTokens = 0;
  let musicTokens = 0;
  for (const seg of segments) {
    const toks = seg.text.trim().split(/\s+/).filter(Boolean);
    totalTokens += toks.length;
    musicTokens += toks.filter((t) => MUSIC_NOTE_TOKEN.test(t)).length;
  }
  const musicTokenShare = totalTokens > 0 ? musicTokens / totalTokens : 0;

  const normCounts = new Map<string, number>();
  const normPerSeg: string[] = [];
  for (const seg of segments) {
    const n = normalizeLine(seg.text);
    normPerSeg.push(countsAsLine(n) ? n : "");
    if (countsAsLine(n)) normCounts.set(n, (normCounts.get(n) ?? 0) + 1);
  }
  let repeatedSegs = 0;
  let normedSegs = 0;
  for (const n of normPerSeg) {
    if (!n) continue;
    normedSegs++;
    if ((normCounts.get(n) ?? 0) > 1) repeatedSegs++;
  }
  const lineRepRate = normedSegs > 0 ? repeatedSegs / normedSegs : 0;

  return { musicTokenShare, lineRepRate, segCount: segments.length };
}

/**
 * Pure: segments in, verdict out. No I/O, no LLM, no config. The ONLY caller
 * is `stages/analyze.ts`, gated on `cfg.songGateEnabled` and placed BEFORE
 * `analyzeHighlightsV2` is invoked - `analyze-v2/index.ts` already owns the
 * degenerate/`NO_USABLE_SPEECH` decision for a transcript with no usable
 * words at all, and this task's hard rules keep `index.ts` off limits (other
 * agents editing it concurrently), so this is a second, narrower pre-scan
 * check for a transcript that has plenty of words but is verse.
 */
export function detectSong(segments: WhisperSegment[]): SongGateResult {
  const signals = computeSongSignals(segments);
  const fired =
    signals.musicTokenShare > MUSIC_TOKEN_SHARE_THRESHOLD ||
    signals.lineRepRate > LINE_REP_RATE_THRESHOLD;
  return { fired, signals };
}
