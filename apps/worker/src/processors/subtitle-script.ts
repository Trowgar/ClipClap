/** Which face draws a clip's subtitles, and how many characters fit on a line.
 *
 *  Both used to be constants in subtitles.ts, and both were calibrated on
 *  Latin and Cyrillic alone. That was invisible until an Arabic source came
 *  through: Montserrat has no Arabic glyphs, fontconfig inside the worker
 *  image has NO font database at all, and libass therefore cannot fall back -
 *  it draws .notdef boxes. Measured, both branches, see the spec §2.2. The
 *  only fix is to name the face explicitly, which is what this module is for.
 *
 *  Keyed on SCRIPT rather than on language: one file serves Arabic, Persian,
 *  Urdu and Pashto, and `fa` has already appeared in this database. */

export const DEFAULT_FONT_NAME = "Montserrat";
export const ARABIC_FONT_NAME = "Tajawal";

/** The Cyrillic-calibrated budget, unchanged. Its derivation lives in the
 *  comment on MAX_CHUNK_WORDS in subtitles.ts. */
export const DEFAULT_MAX_CHUNK_CHARS = 18;

/** Set by measurement in Task 7 of the Arabic plan. Placeholder value here is
 *  deliberately just above the default so the intent is visible; the real
 *  figure and the strings it came from replace this comment. */
export const ARABIC_MAX_CHUNK_CHARS = 19;

/** Primary subtags, lowercase. Whisper returns ISO-639-1, and all four of
 *  these are in its language set. */
const ARABIC_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "fa",
  "ur",
  "ps",
]);

/** Job.language is nullable and has held region tags. Anything unrecognised
 *  must land on the pre-existing behaviour: an unknown language rendering in
 *  Montserrat is exactly what shipped before, whereas a throw here would fail
 *  a render over a metadata value. */
function isArabicScript(language?: string | null): boolean {
  const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
  return primary ? ARABIC_SCRIPT_LANGUAGES.has(primary) : false;
}

export function fontForLanguage(language?: string | null): string {
  return isArabicScript(language) ? ARABIC_FONT_NAME : DEFAULT_FONT_NAME;
}

export function maxChunkCharsForLanguage(language?: string | null): number {
  return isArabicScript(language)
    ? ARABIC_MAX_CHUNK_CHARS
    : DEFAULT_MAX_CHUNK_CHARS;
}
