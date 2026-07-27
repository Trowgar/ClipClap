/** Whisper verbose_json returns full English language names ("russian").
 *
 *  This is the COMPLETE set Whisper can emit, not a shortlist. A name missing
 *  here is not a cosmetic gap: whisperLanguageToIso returns null, `Job.language`
 *  is left unset, and the ANALYZE prompt then instructs the model to write
 *  "STRICTLY in the transcript language" instead of naming it - so the one
 *  place we can be explicit about output language falls back to a hint. It
 *  used to hold 41 of these, which silently degraded Persian, Malay, Urdu,
 *  Tagalog, Bengali, Tamil and ~50 others.
 *
 *  One name per code: this map is reversed below to name the language in
 *  prompts, and a duplicate code would decide that name by key order. Whisper's
 *  alternative spellings live in NAME_ALIASES instead. */
const NAME_TO_ISO: Record<string, string> = {
  english: "en", russian: "ru", ukrainian: "uk", spanish: "es", french: "fr",
  german: "de", italian: "it", portuguese: "pt", polish: "pl", turkish: "tr",
  dutch: "nl", swedish: "sv", norwegian: "no", danish: "da", finnish: "fi",
  czech: "cs", slovak: "sk", romanian: "ro", bulgarian: "bg", greek: "el",
  hungarian: "hu", serbian: "sr", croatian: "hr", lithuanian: "lt", latvian: "lv",
  estonian: "et", hebrew: "he", arabic: "ar", hindi: "hi", indonesian: "id",
  vietnamese: "vi", thai: "th", chinese: "zh", japanese: "ja", korean: "ko",
  kazakh: "kk", uzbek: "uz", azerbaijani: "az", georgian: "ka", armenian: "hy",
  belarusian: "be",
  // Added 2026-07-27: the rest of Whisper's language set. Persian, Malay,
  // Urdu, Tagalog and Bengali are the ones with users or plausible reach
  // today; the remainder is here so this list never has to be topped up again.
  persian: "fa", malay: "ms", urdu: "ur", tagalog: "tl", bengali: "bn",
  tamil: "ta", telugu: "te", marathi: "mr", gujarati: "gu", kannada: "kn",
  malayalam: "ml", punjabi: "pa", sinhala: "si", nepali: "ne", assamese: "as",
  sanskrit: "sa", sindhi: "sd", pashto: "ps", tajik: "tg", turkmen: "tk",
  mongolian: "mn", tatar: "tt", bashkir: "ba", javanese: "jv", sundanese: "su",
  cantonese: "yue", khmer: "km", lao: "lo", myanmar: "my", tibetan: "bo",
  slovenian: "sl", macedonian: "mk", bosnian: "bs", albanian: "sq",
  icelandic: "is", faroese: "fo", nynorsk: "nn", maltese: "mt", welsh: "cy",
  breton: "br", basque: "eu", galician: "gl", catalan: "ca", occitan: "oc",
  luxembourgish: "lb", latin: "la", yiddish: "yi", swahili: "sw", amharic: "am",
  somali: "so", hausa: "ha", yoruba: "yo", shona: "sn", lingala: "ln",
  afrikaans: "af", malagasy: "mg", maori: "mi", hawaiian: "haw",
  "haitian creole": "ht",
};

/** Whisper's alternative spellings for languages already in the map above.
 *  Resolved on lookup only, so they never become the name used in a prompt. */
const NAME_ALIASES: Record<string, string> = {
  castilian: "es", mandarin: "zh", valencian: "ca", flemish: "nl",
  haitian: "ht", letzeburgesch: "lb", pushto: "ps", panjabi: "pa",
  moldavian: "ro", moldovan: "ro", sinhalese: "si", burmese: "my",
};

const ISO_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_TO_ISO).map(([name, iso]) => [
    iso,
    name.charAt(0).toUpperCase() + name.slice(1),
  ])
);

export function whisperLanguageToIso(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  return NAME_TO_ISO[key] ?? NAME_ALIASES[key] ?? null;
}

export function isoToLanguageName(iso: string): string {
  return ISO_TO_NAME[iso] ?? "the transcript language";
}

export type Script = "cyrillic" | "latin" | "cjk" | "arabic" | "none";

export function dominantScript(text: string): Script {
  const counts: Record<Exclude<Script, "none">, number> = {
    cyrillic: (text.match(/[Ѐ-ӿ]/g) ?? []).length,
    latin: (text.match(/[a-zA-Z]/g) ?? []).length,
    cjk: (text.match(/[぀-ヿ一-鿿가-힯]/g) ?? []).length,
    arabic: (text.match(/[؀-ۿ]/g) ?? []).length,
  };
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count >= 3 ? (best as Script) : "none";
}

/** True when copy and clip text carry clearly different scripts. */
export function scriptMismatch(copy: string, clipText: string): boolean {
  const a = dominantScript(copy);
  const b = dominantScript(clipText);
  if (a === "none" || b === "none") return false;
  return a !== b;
}
