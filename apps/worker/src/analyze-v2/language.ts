/** Whisper verbose_json returns full English language names ("russian"). */
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
};

const ISO_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(NAME_TO_ISO).map(([name, iso]) => [
    iso,
    name.charAt(0).toUpperCase() + name.slice(1),
  ])
);

export function whisperLanguageToIso(raw: string): string | null {
  return NAME_TO_ISO[raw.trim().toLowerCase()] ?? null;
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
