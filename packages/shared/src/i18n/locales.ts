/** The one list of interface languages the product speaks.
 *
 *  Everything locale-shaped derives from it: the `Locale` union, the bot's
 *  dictionary registry (`Record<Locale, Dict>`), the reply-keyboard matchers,
 *  the /lang keyboard and the Telegram profile sync. Adding a language becomes
 *  a list of compile errors to work through instead of a hunt through five
 *  files - the previous shape had eight separate literal `["en", "ru"]` sites,
 *  five of which (the keyboard-text matchers) fail SILENTLY when one is
 *  missed: the user's menu buttons simply stop responding.
 *
 *  It lives in @clipclap/shared rather than in apps/bot because payment
 *  notifications are rendered here too (telegram-notification.service). A
 *  second private copy of `"en" | "ru"` is how a new language degrades back to
 *  English on the one message a paying user is guaranteed to read. */
export const LOCALES = ["en", "ru", "uk", "es", "pt", "id", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

/** What an unknown, missing or no-longer-supported language code falls back
 *  to. English rather than "first in LOCALES" so reordering the list above
 *  cannot quietly change what a German speaker sees. */
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Language tags that are not one of our codes but should still land on a
 *  language the person can actually read. Deliberately empty: mapping, say,
 *  `kk` or `be` onto Russian is a product call about who the audience is, not
 *  a technical default, and guessing it wrong is worse than falling back to
 *  English. Add entries here when that call gets made.
 *
 *  Ukrainian used to be the standing example here. It is not one any more -
 *  `uk` has its own dictionary, so nothing has to decide on its speakers'
 *  behalf what language they would rather read. */
const LOCALE_ALIASES: Record<string, Locale> = {};

/** Accepts anything Telegram puts in `language_code` (`ru`, `ru-RU`, `pt-BR`,
 *  `zh-hans`) as well as whatever sits in `User.telegramLocale`, which is a
 *  free-text column that may hold a raw tag from telegram-auth.service or a
 *  code from a build older than the current list. Unknown -> DEFAULT_LOCALE. */
export function detectLocale(languageCode?: string | null): Locale {
  const primary = languageCode?.trim().toLowerCase().split(/[-_]/)[0];
  if (!primary) return DEFAULT_LOCALE;
  if (isLocale(primary)) return primary;
  return LOCALE_ALIASES[primary] ?? DEFAULT_LOCALE;
}

export type PluralCategory =
  | "zero"
  | "one"
  | "two"
  | "few"
  | "many"
  | "other";

/** `other` is mandatory. It is the category CLDR selects for fractions and for
 *  every distinction a language does not make, so requiring it means a count
 *  can never render as an empty string in a language whose rules we guessed
 *  wrong. The rest are optional - a two-form language only writes one/other. */
export type PluralForms = Partial<Record<PluralCategory, string>> & {
  other: string;
};

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** CLDR plural selection, so no dictionary has to carry its own arithmetic.
 *
 *  This replaces a hand-written one/few/many helper bound to Russian: correct
 *  there, wrong for every non-Slavic language, and with no seam to add a
 *  second rule. Node ships full ICU (`process.config.variables.icu_small` is
 *  false), so `select` is right for any locale we add - sanity-check a new one
 *  with `new Intl.PluralRules("<code>").select(n)` before writing its forms. */
export function plural(locale: Locale, n: number, forms: PluralForms): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return forms[rules.select(n) as PluralCategory] ?? forms.other;
}
