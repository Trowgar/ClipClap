/**
 * Onset classifier for eval-arc-audit.ts (spec 2026-08-10 M2, task 1).
 *
 * Pure text-in/flags-out, no engine dependency beyond PARTICLE (exported for
 * this purpose, sentence-graph.ts) and looksLikeQuestion (already exported).
 * TELEMETRY ONLY - design doc §3, M2: "the onset counters are TELEMETRY, not
 * gates - 'А помогают ли...' opens on a particle and is a fine hook; the
 * counter measures, the audit judges." Nothing here moves a boundary.
 *
 * Kept in its own module (rather than exported from the script) so
 * arc-audit-onset.test.ts can unit-test the classifier without importing the
 * script's CLI/`main()` path.
 */
import { PARTICLE, looksLikeQuestion } from "../analyze-v2/sentence-graph";

/**
 * Coordinating/discourse connectives that plausibly open a clip onto
 * something the clip itself does not contain (design doc §0: five of the
 * owner's twelve clips open this way).
 *
 * Deliberately EXCLUDES "а", even though "а" is a PARTICLE and reads like a
 * connective. Measured (arc-audit-onset.test.ts, the "А помогают ли..."
 * case): "а" routinely opens a perfectly fine, self-contained question - it
 * is the design doc's own example of a particle-opened clip that is not
 * broken. "и" / "но" / "вот" / "значит" are ALSO members of PARTICLE and are
 * kept in this set anyway, because those are the tokens the owner's actually
 * defective opens use ("И можно ли ее избежать", "И проверять это на
 * практике"). This is a real asymmetry between two similarly-shaped words,
 * not an oversight - it is the reason this set exists as its own thing
 * instead of reusing PARTICLE.
 *
 * "и вот" / "то есть" / "ну и" are two-token phrases. `rawFirst` is always a
 * single token (tokenize splits on whitespace/hyphen), so these members can
 * only ever match a first "token" that literally contains a space, which
 * tokenize never produces - they are permanently inert against `rawFirst`.
 * Kept anyway: this set is documented as unmeasured telemetry, not a precise
 * instrument, and a future two-token check (checking `tokens[0]+" "+tokens[1]`)
 * can reuse it without a second list to keep in sync.
 */
export const CONNECTIVE: ReadonlySet<string> = new Set([
  "и", "но", "вот", "поэтому", "значит", "то есть", "и вот", "ну и",
  "and", "so", "but", "because",
]);

/**
 * Pronouns / demonstratives whose antecedent, if any, sits BEFORE the clip -
 * the dangling-anaphora signal from design doc §0 ("Это миллиарды..." /
 * "И можно ли ее избежать"). TELEMETRY ONLY, same caveat as CONNECTIVE.
 *
 * "ее" (no ё) sits alongside "её" on purpose: engine-notes §3 measured ё/е as
 * a transcription-jitter coin flip ("всё/все, ещё/еще both appear within one
 * run"), and the podcast-nuclear fixture's own defect case ("И можно ли ее
 * избежать") is transcribed without the diaeresis - an exact-match set
 * carrying only "её" would silently never fire on the fixture it was written
 * to measure.
 */
export const PRONOUN: ReadonlySet<string> = new Set([
  "он", "она", "оно", "они", "его", "её", "ее", "их",
  "это", "этот", "эта", "эти", "такой", "такая", "такое",
  "he", "she", "it", "this", "that", "these", "they",
]);

/** How many tokens AFTER skipping particles count toward the pronoun check.
 *  Small and arbitrary on purpose: a pronoun ten tokens into the opening
 *  belongs to a different clause than "the onset". */
const PRONOUN_WINDOW = 6;

/**
 * Duplicated from sentence-graph.ts's private `tokenize` rather than
 * exported: the task spec's only permitted engine-file edit is exporting
 * PARTICLE/INTERROGATIVE (a pure visibility change), so this three-line
 * regex is copied verbatim instead of reached for. Any drift between the two
 * would only ever affect this telemetry, never a gate.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/u)
    .filter(Boolean);
}

export interface OnsetAnalysis {
  /** The literal first token, NOT particle-skipped - "а" stays "а". */
  rawFirst: string;
  /** rawFirst is a member of CONNECTIVE. */
  conn: boolean;
  /** Any of the first PRONOUN_WINDOW tokens, after dropping every PARTICLE
   *  token from the whole opening (not just a leading run), is a member of
   *  PRONOUN. */
  pron: boolean;
  /** looksLikeQuestion(text) verbatim - imported, not reimplemented, so this
   *  is always exactly what the engine's own onset-question test says. */
  q: boolean;
}

/** Classifies one opening (or closing) text. TELEMETRY, not a gate - see the
 *  module doc comment. */
export function classifyOnset(text: string): OnsetAnalysis {
  const tokens = tokenize(text);
  const rawFirst = tokens[0] ?? "";
  const conn = CONNECTIVE.has(rawFirst);
  const afterParticles = tokens.filter((t) => !PARTICLE.has(t));
  const pron = afterParticles.slice(0, PRONOUN_WINDOW).some((t) => PRONOUN.has(t));
  return { rawFirst, conn, pron, q: looksLikeQuestion(text) };
}
