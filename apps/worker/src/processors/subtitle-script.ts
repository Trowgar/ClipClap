/** Which face draws a clip's subtitles.
 *
 *  The face used to be the constant `"Montserrat"` in subtitles.ts, calibrated
 *  on Latin and Cyrillic alone. That was invisible until an Arabic source came
 *  through: Montserrat has no Arabic glyphs, fontconfig inside the worker
 *  image has NO font database at all, and libass therefore cannot fall back -
 *  it draws .notdef boxes. Measured, both branches, see the spec §2.2. The
 *  only fix is to name the face explicitly, which is what this module is for.
 *
 *  Keyed on SCRIPT rather than on language: one file serves Arabic, Persian,
 *  Urdu and Pashto, and `fa` has already appeared in this database.
 *
 *  Only the FACE is script-dependent. The cue-length budget was expected to be
 *  too, and it is not - the measurement is recorded on MAX_CHUNK_CHARS in
 *  subtitles.ts. */

export const DEFAULT_FONT_NAME = "Montserrat";
export const ARABIC_FONT_NAME = "Tajawal";

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
