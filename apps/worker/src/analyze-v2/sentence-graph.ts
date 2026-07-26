import type { WhisperSegment, SubtitleWord } from "@clipclap/shared";
import type { AnalyzeConfig } from "./config";
import type { SentenceNode } from "./types";

const TERMINAL = /[.!?…。！？]$/;
const CLAUSE = /[,;:-]$/;
const MICRO_SEC = 0.4;
const MAX_WORD_SPAN_SEC = 3;

function wordsUnreliable(words: SubtitleWord[]): boolean {
  let prevStart = -Infinity;
  for (const w of words) {
    if (w.end <= w.start) return true;
    if (w.start < prevStart) return true;
    if (w.end - w.start > MAX_WORD_SPAN_SEC) return true;
    prevStart = w.start;
  }
  return false;
}

/** A node opens cleanly when its leading boundary is strong (>= 0.8: after
 *  terminal punctuation or a sentence-length pause) or it follows an opaque
 *  music/silence region. This is THE clean-start semantics - snap's guard and
 *  the critic's ¶ window markers must agree, so both consume this helper. */
/** First LETTER of the text is lowercase - Whisper capitalizes real sentence
 *  starts, so a lowercase onset is strong evidence of a mid-sentence fragment
 *  (hesitation pauses mint fake 0.8 boundaries; capitalization vetoes them). */
function startsLowercase(text: string): boolean {
  const m = text.match(/\p{L}/u);
  return m !== null && /\p{Ll}/u.test(m[0]);
}

export function isCleanStart(nodes: SentenceNode[], index: number): boolean {
  const n = nodes[index];
  if (!n) return false;
  // The node itself must be word-bearing: an opaque node has no reliable onset
  // to cut at, no matter how strong its leading boundary is. Without this
  // guard the critic's window markers advertise starts snap must reject.
  if (!n.hasWords) return false;
  // Terminal-punctuation boundaries (leading 1.0) are trustworthy as-is.
  // Pause/segment boundaries (0.8) and post-opaque starts also need the
  // capitalization signal - a hesitation pause before "глаза на все её
  // хотелки" is not a sentence start. (A transcript with punctuation but no
  // capitals still yields clean starts through the 1.0 path.)
  if (n.leadingStrength >= 1.0) return true;
  const boundaryOk =
    n.leadingStrength >= 0.8 ||
    (index > 0 && nodes[index - 1].hasWords === false);
  return boundaryOk && !startsLowercase(n.text);
}

/** Terminal question mark, tolerating a trailing quote or bracket. THE
 *  punctuation question test - snap's `endsOnQuestion` telemetry and the
 *  finalizer's orphaned-question gate must agree, so both consume this. */
export function endsOnQuestionMark(text: string): boolean {
  return /[?？]["»')\]]*\s*$/u.test(text.trim());
}

/**
 * Discourse particles: the class engine-notes §3 measured as the dominant
 * transcription-jitter mode - indels outnumber substitutions 3.8:1 and are
 * almost all of these. Anything keying on token position has to see through
 * them or it decides differently on two runs of the same audio.
 */
const PARTICLE: ReadonlySet<string> = new Set([
  "а", "ага", "ах", "вот", "да", "же", "и", "значит", "короче", "кстати",
  "ладно", "мм", "но", "ну", "нет", "ой", "окей", "слушай", "так", "там", "угу", "эм",
  "and", "but", "hey", "no", "oh", "ok", "okay", "so", "uh", "um", "well", "yeah", "yes",
]);

/** Interrogative pronouns and adverbs. Russian first (the measured language),
 *  then the English wh-words. Deliberately broad: see orphansQuestion. */
const INTERROGATIVE: ReadonlySet<string> = new Set([
  "кто", "кого", "кому", "кем", "что", "чего", "чему", "чем", "чей", "чья", "чьё", "чье", "чьи",
  "какой", "какая", "какое", "какие", "какого", "какую", "каким", "каких", "какими", "каком",
  "каков", "какова", "каково", "каковы", "где", "куда", "откуда", "докуда", "когда",
  "почему", "отчего", "зачем", "как", "сколько", "насколько", "разве", "неужели",
  "what", "why", "how", "who", "whom", "whose", "where", "when", "which",
]);

/** `что-то`, `когда-то`, `какой-нибудь` - indefinites, never questions. This
 *  transcript drops the hyphen, so they arrive as a bare wh-token plus "то". */
const INDEFINITE_TAIL: ReadonlySet<string> = new Set(["то", "нибудь", "либо"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/u)
    .filter(Boolean);
}

/** Nothing here but discourse particles - "Да", "Ну вот", "" - so this node
 *  carries no answer, no matter which run of the audio produced it. */
export function carriesOnlyFiller(text: string): boolean {
  return tokenize(text).every((w) => PARTICLE.has(w));
}

/**
 * A question, judged from what was SAID rather than from how Whisper punctuated
 * it. Two branches, because neither covers this transcript alone:
 *
 * - Terminal "?" - the signal snap already used. It only ever fires on OPAQUE
 *   nodes, which carry Whisper's punctuated segment text. Word-bearing nodes are
 *   assembled from word tokens, and those are measured to be virtually
 *   punctuation-free: 2 of 609 nodes on podcast-answer-arc, 2 of 584 on
 *   podcast-ecology. A punctuation-only test therefore cannot see a question the
 *   speaker asked mid-flow, which is exactly the case that motivated this.
 * - An interrogative in ONSET position, reached after skipping discourse
 *   particles. "какие претензии" (answer-arc #869) has no question mark at all;
 *   the same question in the other run reads "Да А какие претензии" (ecology
 *   #845), so the wh-word is not reliably the first token either.
 *
 * Onset, not anywhere: "Но вернуться к прошлому более высокому почему нет"
 * (ecology #332) is a rhetorical tag, not a question, and a contains-test would
 * refuse the correct repair that trim performs.
 */
export function looksLikeQuestion(text: string): boolean {
  if (endsOnQuestionMark(text)) return true;
  const words = tokenize(text);
  for (let i = 0; i < words.length; i++) {
    if (PARTICLE.has(words[i])) continue;
    if (!INTERROGATIVE.has(words[i])) return false;
    return !(i + 1 < words.length && INDEFINITE_TAIL.has(words[i + 1]));
  }
  return false;
}

/** A node ENDS cleanly when its own trailing boundary is terminal, the
 *  transcript ends, music follows, or the next node opens cleanly. Mirrors
 *  isCleanStart - "…искала ты его потому," followed by a lowercase
 *  continuation is a mid-clause cut, not an ending. */
export function isCleanEnd(nodes: SentenceNode[], index: number): boolean {
  const n = nodes[index];
  if (!n) return false;
  if (n.trailingStrength >= 1.0) return true;
  if (index === nodes.length - 1) return true;
  if (nodes[index + 1].hasWords === false) return true;
  return isCleanStart(nodes, index + 1);
}

export function buildSentenceGraph(
  segments: WhisperSegment[],
  cfg: AnalyzeConfig
): SentenceNode[] {
  // guard against out-of-order input: node indices must track time
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const raw: Omit<SentenceNode, "index" | "leadingStrength">[] = [];

  for (const seg of ordered) {
    const words = seg.words ?? [];
    if (words.length === 0 || wordsUnreliable(words)) {
      raw.push({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        hasWords: false,
        trailingStrength: 0.2,
      });
      continue;
    }

    let current: SubtitleWord[] = [];
    const emit = (run: SubtitleWord[], strength: number) => {
      raw.push({
        start: run[0].start,
        // max, not last: word timings may nest (a long word containing a short
        // one passes the reliability check), and the node must cover its tail
        end: Math.max(...run.map((w) => w.end)),
        text: run.map((w) => w.text).join(" "),
        hasWords: true,
        trailingStrength: strength,
      });
    };
    const close = (strength: number) => {
      if (current.length === 0) return;
      emit(current, strength);
      current = [];
    };
    // Length-limit split: close at the largest interior gap (the most natural
    // pause seen so far) and carry the remaining words forward - they stay
    // open and may close again on punctuation, gaps, or another force-split.
    const forceSplit = () => {
      if (current.length < 2) {
        close(0.3);
        return;
      }
      let splitAfter = 0;
      let bestGap = -Infinity;
      for (let k = 0; k < current.length - 1; k++) {
        const g = current[k + 1].start - current[k].end;
        // >= so ties prefer the latest gap: with uniform gaps this keeps the
        // head close to nodeMaxSec instead of shaving single-word slivers
        if (g >= bestGap) {
          bestGap = g;
          splitAfter = k;
        }
      }
      emit(current.slice(0, splitAfter + 1), 0.3);
      current = current.slice(splitAfter + 1);
    };

    for (let i = 0; i < words.length; i++) {
      current.push(words[i]);
      const w = words[i];
      const next = words[i + 1];
      const gap = next ? next.start - w.end : 0;
      const runningLen = w.end - current[0].start;

      if (TERMINAL.test(w.text)) close(1.0);
      else if (next && gap >= cfg.gapSentence) close(0.8);
      else if (CLAUSE.test(w.text) || (next && gap >= cfg.gapPhrase)) close(0.4);
      else if (runningLen >= cfg.nodeMaxSec) forceSplit();
    }
    close(0.8); // segment end is a Whisper boundary
  }

  // micro-merge: keep folding word-bearing neighbors forward while the
  // accumulated node is still shorter than MICRO_SEC, so chains of 3+
  // tiny fragments collapse into one node instead of pairing greedily
  const merged: typeof raw = [];
  let i = 0;
  while (i < raw.length) {
    let node = raw[i];
    i += 1;
    while (
      node.hasWords &&
      node.end - node.start < MICRO_SEC &&
      i < raw.length &&
      raw[i].hasWords
    ) {
      const next = raw[i];
      node = {
        start: node.start,
        end: Math.max(node.end, next.end),
        text: `${node.text} ${next.text}`,
        hasWords: true,
        trailingStrength: next.trailingStrength,
      };
      i += 1;
    }
    merged.push(node);
  }

  return merged.map((n, index) => ({
    ...n,
    index,
    leadingStrength: index === 0 ? 1.0 : merged[index - 1].trailingStrength,
  }));
}
