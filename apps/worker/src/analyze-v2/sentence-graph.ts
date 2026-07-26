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

/**
 * ANAPHORIC RUNS - three or more consecutive sentences opening on the same word.
 *
 * The thresholds below are not tuned, they are read off two measured
 * distributions over both fixture transcripts (1747 nodes, 1193 word-bearing,
 * 788 clean starts - the same 52-minute episode transcribed twice, one of the
 * two being job cms2c8ahm's own transcript):
 *
 *   3+ beats  1 run per episode, and it is the real figure: "Планета еще и не
 *             такое видала / Планета видала вулканические катастрофы / Планета
 *             видала астероидные импакты / Планете 4 5 миллиарда лет".
 *   2+ beats  8 and 9 runs per episode. The extra population is NOT rhetoric:
 *             "Серьезно / Серьезно" (an echo), "Создаем обороты / Создаем
 *             культуру да" (a self-repair), "Свой собственный / Свой Хороший
 *             вопрос" (crosstalk), "Значит если это отмасштабировать / Да если
 *             это отмасштабировать" (the host repeating the guest). A pair is
 *             also no evidence of a BUILD - it is the third beat that makes a
 *             cut after the first one audible.
 *
 * MIN_STEM_CHARS is what keeps the common-function-word false positive out, and
 * it does the job by LENGTH rather than by a stop list: every opener short
 * enough to recur by coincidence is short itself - "это", "как", "там", "и",
 * "но", "the", "it", "we", "so". Nothing at 4+ characters repeated three times
 * in a row is an accident of speech. A stop list would need a per-language
 * edition and would still miss the next one.
 *
 * Onsets are compared by STEM because the real case inflects on its last beat
 * (Планета -> Планете); an exact-string test sees a three-beat figure where the
 * speaker built four, and stops one sentence early. The suffix allowance is
 * bounded at both ends - a shared prefix of at least MIN_STEM_CHARS, and at most
 * MAX_INFLECTION_CHARS beyond it per token - so "планета"/"планетарный" (4 chars
 * of suffix) does not match. That is a cheap stand-in for a lemmatizer and it
 * transfers to any suffixing language (English "planet/planets" matches, "the"
 * is under the floor); for a prefixing or unsegmented language it degrades to
 * "the first four characters are identical", which is stricter, not looser.
 */
const ANAPHORA_MIN_BEATS = 3;
const ANAPHORA_MIN_STEM_CHARS = 4;
const ANAPHORA_MAX_INFLECTION_CHARS = 3;

/** First token that carries meaning, ё/е-normalized. Particles are skipped for
 *  the reason they are skipped in looksLikeQuestion: the two transcription runs
 *  of this episode disagree about whether a sentence opens "Планета" or "Ну
 *  Планета", and a rule anchored on token 0 would decide differently on two
 *  runs of the same audio. */
function onsetStem(text: string): string | null {
  for (const word of tokenize(text.replace(/ё/g, "е").replace(/Ё/g, "Е"))) {
    if (!PARTICLE.has(word)) return word;
  }
  return null;
}

function sameOnsetLemma(a: string, b: string): boolean {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  if (shared < ANAPHORA_MIN_STEM_CHARS) return false;
  return (
    a.length - shared <= ANAPHORA_MAX_INFLECTION_CHARS &&
    b.length - shared <= ANAPHORA_MAX_INFLECTION_CHARS
  );
}

/**
 * The LAST beat of the anaphoric run `index` sits inside, or null when `index`
 * is not inside one, or is already its last beat - i.e. exactly the cases where
 * ending a clip at `index` cuts a rhetorical figure in half.
 *
 * The window is maximal around `index` and every member is compared against
 * `index`'s own onset rather than chained pairwise, so a long chain cannot drift
 * onto a different word.
 */
export function anaphoricRunEnd(nodes: SentenceNode[], index: number): number | null {
  const isBeat = (i: number, stem: string) => {
    const n = nodes[i];
    if (!n || !n.hasWords || !isCleanStart(nodes, i)) return false;
    const own = onsetStem(n.text);
    return own !== null && sameOnsetLemma(own, stem);
  };
  const stem = nodes[index] ? onsetStem(nodes[index].text) : null;
  if (stem === null || !isBeat(index, stem)) return null;
  let first = index;
  while (isBeat(first - 1, stem)) first -= 1;
  let last = index;
  while (isBeat(last + 1, stem)) last += 1;
  if (last - first + 1 < ANAPHORA_MIN_BEATS) return null;
  return last > index ? last : null;
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
