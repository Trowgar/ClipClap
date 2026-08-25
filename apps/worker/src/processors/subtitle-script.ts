/** Which face draws a clip's subtitles.
 *
 *  The face used to be the constant `"Montserrat"` in subtitles.ts, calibrated
 *  on Latin and Cyrillic alone. That was invisible until an Arabic source came
 *  through: Montserrat has no Arabic glyphs, fontconfig inside the worker
 *  image has NO font database at all, and libass therefore cannot fall back -
 *  it draws .notdef boxes. Measured, both branches, see the spec §2.2. The
 *  only fix is to name the face explicitly, which is what this module is for.
 *
 *  The same defect recurred for ja/zh/ko/hi (spec
 *  docs/superpowers/specs/2026-08-25-cjk-subtitles.md): none of those had a
 *  face with their glyphs either, and the same mechanism applies - the face
 *  has to be added and named, not discovered by fallback.
 *
 *  Keyed on SCRIPT rather than on language: one file serves Arabic, Persian,
 *  Urdu and Pashto (and `fa` has already appeared in this database), one
 *  serves Hindi, Marathi, Nepali and Sanskrit (all Devanagari), and Chinese's
 *  entry serves Cantonese and Mandarin's ISO codes too.
 *
 *  For Arabic and Devanagari, only the FACE is script-dependent - the
 *  cue-length budget is not, see MAX_CHUNK_CHARS in subtitles.ts. CJK is the
 *  first script where that stops being true: Whisper's single-character
 *  Japanese "words" and full-width glyph widths both break the Latin/Cyrillic
 *  cue-length assumptions, so isCjkLanguage below exists for subtitles.ts to
 *  key a second, CJK-specific budget off. */

export const DEFAULT_FONT_NAME = "Montserrat";
export const ARABIC_FONT_NAME = "Tajawal";
export const JP_FONT_NAME = "Noto Sans JP";
export const SC_FONT_NAME = "Noto Sans SC";
export const KR_FONT_NAME = "Noto Sans KR";
export const DEVANAGARI_FONT_NAME = "Noto Sans Devanagari";

/** Primary subtags, lowercase. Whisper returns ISO-639-1, and all four of
 *  these are in its language set. */
const ARABIC_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "fa",
  "ur",
  "ps",
]);

/** Japanese. Its own branch rather than folded into the CJK set below because
 *  it gets its own face (Noto Sans JP) - "CJK" here names a rendering
 *  property (see isCjkLanguage), not a shared font. */
const JP_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set(["ja"]);

/** Chinese, in every guise Whisper or a nullable Job.language field has been
 *  seen to carry: bare "zh", a region/script-tagged "zh-Hant"/"zh-TW"/"zh-CN"
 *  (only the primary subtag ever reaches this set - see primarySubtag), and
 *  the two ISO-639-1 codes for Cantonese and Mandarin as spoken macrolanguages.
 *  All route to the SC face. Traditional readers get Simplified glyph forms -
 *  accepted for v1 and recorded in OFL.txt and the spec, not an oversight. */
const CHINESE_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set(["zh", "yue", "cmn"]);

const KOREAN_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set(["ko"]);

/** Devanagari-script languages Whisper's language set includes. */
const DEVANAGARI_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  "hi",
  "mr",
  "ne",
  "sa",
]);

/** Job.language is nullable and has held region tags. Anything unrecognised
 *  must land on the pre-existing behaviour: an unknown language rendering in
 *  Montserrat is exactly what shipped before, whereas a throw here would fail
 *  a render over a metadata value. */
function primarySubtag(language?: string | null): string | null {
  const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
  return primary || null;
}

function isArabicScript(language?: string | null): boolean {
  const primary = primarySubtag(language);
  return primary ? ARABIC_SCRIPT_LANGUAGES.has(primary) : false;
}

/** ja / zh-family / ko - the three scripts this file maps to a CJK-family font.
 *  Exported so the chunker (subtitles.ts) can key its per-script cue-length
 *  params off the same test the font map uses, rather than keeping a second,
 *  driftable copy of these language sets. */
export function isCjkLanguage(language?: string | null): boolean {
  const primary = primarySubtag(language);
  if (!primary) return false;
  return (
    JP_SCRIPT_LANGUAGES.has(primary) ||
    CHINESE_SCRIPT_LANGUAGES.has(primary) ||
    KOREAN_SCRIPT_LANGUAGES.has(primary)
  );
}

function isDevanagariScript(language?: string | null): boolean {
  const primary = primarySubtag(language);
  return primary ? DEVANAGARI_SCRIPT_LANGUAGES.has(primary) : false;
}

export function fontForLanguage(language?: string | null): string {
  const primary = primarySubtag(language);
  if (!primary) return DEFAULT_FONT_NAME;
  if (JP_SCRIPT_LANGUAGES.has(primary)) return JP_FONT_NAME;
  if (CHINESE_SCRIPT_LANGUAGES.has(primary)) return SC_FONT_NAME;
  if (KOREAN_SCRIPT_LANGUAGES.has(primary)) return KR_FONT_NAME;
  if (isDevanagariScript(language)) return DEVANAGARI_FONT_NAME;
  if (isArabicScript(language)) return ARABIC_FONT_NAME;
  return DEFAULT_FONT_NAME;
}
