import {
  DEFAULT_LOCALE,
  LOCALES,
  detectLocale,
  isLocale,
  type Locale,
} from "@clipclap/shared";
import type { Dict } from "./types";
import en from "./en";
import ru from "./ru";
import uk from "./uk";
import es from "./es";
import pt from "./pt";
import id from "./id";

// Re-exported so the rest of the bot keeps importing its locale vocabulary
// from one module. The definitions live in @clipclap/shared because payment
// notifications are rendered there - see the note in shared/src/i18n/locales.
export { DEFAULT_LOCALE, LOCALES, detectLocale, isLocale, type Locale };
export type { Dict };

/** One dictionary per supported language, in its own file. Keyed by the full
 *  Locale union, so adding a code to LOCALES fails to compile here until the
 *  language has words - which is the whole point of the registry. */
const dictionaries: Record<Locale, Dict> = { en, ru, uk, es, pt, id };

export function t(locale: Locale): Dict {
  return dictionaries[locale];
}

export type LangChoice = Locale;

/** What a person may type after /lang besides the bare code, in any language
 *  they might be reading the bot in - "английский" is a Russian word for the
 *  English entry, so the aliases belong to the locale they SELECT, not to the
 *  locale they are written in. Keyed by Locale, so a new language cannot be
 *  added without deciding what its speakers are likely to type.
 *
 *  `pt-br` and `es-419` style tags are not listed: parseLangCommand only ever
 *  sees what the user typed, and detectLocale already resolves region tags off
 *  the wire. They are here only for the hand-typed forms. */
const LANG_ALIASES: Record<Locale, readonly string[]> = {
  en: [
    "english",
    "англ",
    "английский",
    "англійська",
    "ingles",
    "inglés",
    "inggris",
  ],
  ru: ["russian", "рус", "русский", "російська", "ruso", "russo", "rusia"],
  uk: [
    "ukrainian",
    "ukr",
    "укр",
    "українська",
    "украинский",
    "ucraniano",
    "ucraniana",
  ],
  es: ["spanish", "espanol", "español", "исп", "испанский", "espanhol"],
  pt: ["portuguese", "portugues", "português", "brasil", "br", "порт", "португальский"],
  id: ["indonesian", "indonesia", "bahasa", "инд", "индонезийский"],
};

export function parseLangCommand(text: string): LangChoice | "usage" | null {
  if (!/^\/lang(@\S+)?(\s|$)/.test(text)) return null;
  const arg = text
    .replace(/^\/lang(@\S+)?\s*/, "")
    .trim()
    .toLowerCase();
  if (!arg) return "usage";
  if (isLocale(arg)) return arg;
  return LOCALES.find((loc) => LANG_ALIASES[loc].includes(arg)) ?? "usage";
}

/** The choices /lang offers, rendered once from the registry instead of being
 *  spelled out inside every locale's usage string - those go stale the moment
 *  a language is added, and they go stale silently. Each language is named in
 *  itself ("Русский", not "Russian"), which is both the convention for
 *  language pickers and the only version a reader of that language is certain
 *  to recognise. */
export function langOptionsList(): string {
  return LOCALES.map((loc) => `/lang ${loc} - ${t(loc).langName}`).join(", ");
}
