# i18n notes

How the bot's interface languages are wired, and what adding one costs. Same rules as
`engine-notes.md`: state what is true, mark what is believed but unverified, and delete an entry when it
stops being true.

Refactored 2026-07-27 from a shape where "add a language" meant eight hand-edits across five files.

---

## 1. The registry

`packages/shared/src/i18n/locales.ts` holds the single list:

```ts
export const LOCALES = ["en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
```

Everything locale-shaped derives from it - the `Locale` union, the bot's `Record<Locale, Dict>`
registry, the reply-keyboard matchers, the `/lang` keyboard, the Telegram profile sync, and the payment
notification copy in `packages/shared/src/services/telegram-notification.service.ts`.

It lives in `@clipclap/shared`, not in `apps/bot`, because payment notifications are rendered by the web
app's billing webhooks, which never load `apps/bot`. That file used to keep its own private
`type Locale = "en" | "ru"` and its own `detectLocale`, with English falling out of the bottom of an
`if (locale === "ru")` - so a new language would have silently degraded to English on the one class of
message a paying user is guaranteed to read.

`apps/bot/src/i18n.ts` re-exports `LOCALES`, `Locale`, `detectLocale` and `isLocale`, so bot code keeps
importing its locale vocabulary from one place.

## 2. Adding a language

1. Add the code to `LOCALES` in `packages/shared/src/i18n/locales.ts`.
2. Run the typechecker. Two `Record<Locale, ...>` maps now fail to compile, and they are the whole job:
   - `dictionaries` in `apps/bot/src/i18n.ts` - the ~92-key `Dict` (interface strings, buttons,
     `commands` for the Telegram menu, `botDescription`, the per-`JobErrorCode` failure map).
   - `PAYMENT_COPY` in `telegram-notification.service.ts` - four billing messages.
   - `LANG_ALIASES` in `apps/bot/src/i18n.ts` - what someone might type after `/lang` besides the bare
     code. Aliases belong to the locale they **select**, not the one they are written in: "английский"
     is a Russian word and sits under `en`.
3. Nothing else. The `/lang` keyboard, the `/lang` usage text, the reply-keyboard matchers and the
   Telegram profile sync all iterate `LOCALES`.

There is no database migration: `User.telegramLocale` is a free-text `String?`. `detectLocale` accepts
whatever is in it, including raw IETF tags written by `telegram-auth.service` (`en-US`, `pt-BR`) and
codes from a build older than the current list.

### What is NOT compile-enforced

- **Telegram profile sync** (`setMyCommands` / `setMyDescription`, `apps/bot/src/setup.ts`) sends the
  locale as the API's `language_code`. Our codes are two-letter IETF, which is what Telegram wants, but
  a locale code that is not a language tag it recognises fails at runtime - the loop catches and warns
  per locale, so a bad one degrades to "no localized profile", not to a dead bot.
- **The web interface is English-only** and is not part of this registry.

## 3. Plurals

`plural(locale, n, forms)` in the registry selects a CLDR category via `Intl.PluralRules`:

```ts
plural("ru", 2, { one: "клип", few: "клипа", many: "клипов", other: "клипов" })  // "клипа"
```

`other` is mandatory in `PluralForms` - it is the category CLDR picks for fractions and for every
distinction a language does not make, so a count can never render as an empty string in a language whose
rules we guessed wrong.

This replaced a hand-written one/few/many helper bound to Russian: correct there, wrong for every
non-Slavic language, with no seam for a second rule. `pluralizeRu(n, one, few, many)` survives as a thin
Russian-bound wrapper so the ~15 call sites in the Russian dictionary did not have to churn.

**Verified 2026-07-27** in the `bot` container: Node 20.20.2, `process.config.variables.icu_small` is
`false` (full ICU), and `new Intl.PluralRules("ru").select()` returns `few` for 2, `many` for 5, `one`
for 21. `packages/shared/src/__tests__/locales.test.ts` asserts the Russian rule including the teens
exception, which doubles as a guard: a small-icu Node would silently apply English rules to every
language and that test would catch it.

Sanity-check a new language with `new Intl.PluralRules("<code>").select(n)` before writing its forms.

## 4. How a user's language is chosen (verified 2026-07-27)

The resolution is one expression, evaluated on every incoming message and callback:

```ts
detectLocale(existing?.telegramLocale ?? from.language_code)
```

Stored choice first, Telegram client second, `DEFAULT_LOCALE` last. Three properties make it work:

- **`telegramLocale` is written on create only.** `findOrCreateTelegramUser` returns an existing row
  untouched, so nothing refreshes the column from the Telegram profile behind the user's back. If that
  ever changes, every `/lang` choice silently reverts on the user's next message.
- **The raw IETF tag is what gets stored** (`ru-RU`, `de`, `en-US`), not the resolved locale.
  `detectLocale` normalizes on read. This is deliberate: an unsupported language is kept verbatim, so
  the day it is added, that account picks it up instead of being frozen on the English it happened to
  resolve to at signup.
- **`??`, not `||`.** A user created through web Google OAuth has `telegramLocale: null`; the nullish
  coalescing falls through to the client tag rather than treating null as "English on purpose".

`locale-detection.test.ts` drives the real `handleUpdate` over all of it: `ru` and `ru-RU` answered in
Russian, `de` and a missing `language_code` answered in English, the raw tag written on account
creation, the settings picker persisting a choice and confirming it in the newly chosen language, and
the stored choice beating the client language on later messages.

**Fixed during the check:** linking an existing clipclap.io account dropped the language. The bot-side
row is the only place `telegramLocale` exists - a web account has none - and `linkTelegramToUser`
deletes that row after moving jobs, clips and deliveries, writing only `telegramId` onto the target.
Someone who had chosen a language in the bot on purpose got it reverted to their client's language the
moment they linked. The merge now carries the orphan's locale over when the target has none, and
leaves a locale the target already has alone.

**Known and accepted:** an explicit choice and an auto-detected one are stored in the same column with
no flag distinguishing them. The only case where that is visible: a user whose client is German, who is
therefore reading English today, will flip to German the day German ships - even if they were content
with English. Adding an "explicit" flag would be the fix if that ever matters; it does not yet.

## 5. What is still hardcoded (audited 2026-07-27)

Every path that talks to a **customer** goes through `dict`. Swept: clip delivery and its failure
copy, job errors (rendered from `JobErrorCode`, never from `Job.error`), submission blocks, account
linking, plans/checkout, referral and balance, the user side of support, menus and settings. No raw
string reaches a customer chat, and `renderPaymentNotification` covers the billing messages sent by the
web app's webhooks.

What remains hardcoded is operator- and admin-facing only:

- **Support operator lines - Russian**, sent to `SUPPORT_CHAT_ID`: `handlers.ts:249, 330, 344, 456, 563`
  ("закрыл диалог поддержки", "Ответ должен быть текстом", "Ты оператор - тикеты…").
- **Referral admin commands - English**, gated by `isReferralAdmin`: `handlers.ts:1893-1982`
  ("No pending withdrawals.", "Referrer not found.", the `/approve` `/paid` `/reject` usage lines).
- **`"📊 Analytics"`** - the Mini App keyboard button, added only when `adminWebAppUrl` is set
  (`handlers.ts:377`).
- **`"Untitled"`** - project-title fallback in `url-probe.ts:59`. Lands in the database and the web
  dashboard, not in a chat.

These are a deliberate non-goal: they are read by the people running the product, not by customers. If
that ever stops being true - a second operator who does not read Russian, an admin who does not read
English - they need dictionaries like everything else.

**Fixed during the audit:** `accountText` took the raw billing cycle and each dictionary mapped it
itself, with the English one interpolating the lowercased enum straight into the sentence
(`STARTER (weekly)`). It now takes `billingCycleLabel`, resolved by the caller from
`cycleWeekly`/`cycleMonthly`, so a new language cannot inherit an English word by copying the English
dictionary's shape. Guarded by "names the billing cycle in every locale" in `i18n.test.ts`.

**Already fixed before it, for the record:** `getSubmissionBlocker` used to return the bare English
`"Active subscription required to process videos."` straight to the chat. It returns a block code
rendered from `dict` now, with `assertBlockCodeHandled(code: never)` making a new code a compile error.
`free-trial.test.ts` asserts the sentence cannot come back.

## 6. The trap this refactor was paying off

Five of the eight hardcoded `["en", "ru"]` sites were keyboard-text matchers -
`matchMenuAction`, `matchSettingsAction`, `matchReferralAction`, `matchHelpAction`,
`matchSupportAction` in `apps/bot/src/handlers.ts`. They resolve a reply-keyboard button by comparing
the text Telegram sends back against every locale's label.

Miss one when adding a language and there is no error anywhere: the user's menu buttons simply stop
doing anything when tapped. They all iterate `LOCALES` now. If a new matcher is written, it must too.

The same silence applies to `callback_data`: Telegram does not complain about a button whose data
nothing handles. Language callbacks are `lang_<code>`, built by `langCallbackData()` and parsed by
`parseLangCallback()`, which still checks membership explicitly so a retired code - or the `lang_auto`
this bot used to send, still sitting in old chat histories - is rejected rather than written to the
database.
