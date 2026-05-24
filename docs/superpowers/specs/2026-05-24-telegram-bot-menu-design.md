# Telegram Bot Menu - Onboarding & Discovery Design

**Date:** 2026-05-24
**Status:** Approved, ready for implementation plan
**Scope:** All Telegram-side discovery surfaces of the ClipClap bot - pre-Start (description, about, commands list), welcome flow, reply keyboard, in-chat menu actions.

## Goal

A new user opening @clipclapbot for the first time should immediately understand:
- What the bot does (turns long video into vertical subtitled clips)
- How the flow works (pick plan → send video → receive clips)
- What's available from the persistent menu

The bot is **positioned as a tool**, not a full clone of the web dashboard. Main flow is "drop video → get clips"; account / plan / help are secondary and live in the persistent reply keyboard.

## Non-goals

- Telegram Web App (mini-dashboard inside TG) - deferred. Out of scope.
- Changing the existing payment flow (Tribute inline buttons stay as-is).
- Changing the Plans / Account / Help action contents (already clear and working).
- Replacing the reply keyboard layout (current 2×2 is the right shape).

## Surfaces being designed

| Surface | Visible | Purpose |
|---|---|---|
| Bot description (≤512) | On empty chat, above START button | Value-prop pitch + 3-step explainer |
| Bot about (≤120) | Bot profile bio | One-line tagline |
| Commands list | `/` autocomplete popup | Discoverability of all available commands |
| Welcome message (new) | After first /start | Pitch + how-it-works + account-choice CTA |
| Welcome message (returning, has plan) | After /start | Brief "send video" prompt + reply keyboard |
| Welcome message (returning, NONE plan) | After /start | Plan-picker + reply keyboard hint |
| Reply keyboard | Persistent under input | Secondary actions: Plans / Account / Help / Language |
| Menu action: Language | On tap of 🌐 Language | Inline EN / RU / Auto buttons (improvement) |

## Section 1 - Pre-Start surfaces

Set once at bot startup via `setMyDescription`, `setMyShortDescription`, `setMyCommands`. Provide separate `en` and `ru` content via the `language_code` parameter.

### Bot description (EN, ≤512)

```
ClipClap turns long videos into short vertical clips with subtitles - ready for TikTok, Reels and Shorts.

Send a video (up to 3 hours) - I'll find the highlights, cut them and burn in subtitles automatically.

How it works:
1. Pick a plan
2. Send a video
3. Receive your clips

Tap START to begin.
```

### Bot description (RU, ≤512)

```
ClipClap нарезает длинные видео на короткие вертикальные клипы с субтитрами - для TikTok, Reels и Shorts.

Пришли видео (до 3 часов) - найду самые цепляющие моменты, нарежу и наложу субтитры автоматически.

Как это работает:
1. Выбери тариф
2. Пришли видео
3. Получи клипы

Жми START.
```

### Bot about (≤120)

- **EN:** `Long video → vertical clips with subtitles. Send a video to start.`
- **RU:** `Длинное видео → вертикальные клипы с субтитрами. Пришли видео - нарежу.`

### Commands list

Same six entries, localized descriptions. Commands themselves stay English (per project i18n policy).

| Command | EN description | RU description |
|---|---|---|
| `start` | Show main menu | Главное меню |
| `plans` | Choose a subscription | Выбрать тариф |
| `account` | Your plan and stats | Тариф и статистика |
| `help` | Limits and how it works | Лимиты и как работает |
| `lang` | Switch language | Сменить язык |
| `link` | Connect your clipclap.io account | Привязать аккаунт clipclap.io |

Notes:
- `/menu` is omitted from the published list - it's a redundant alias for `/start` (which already shows the reply keyboard for returning users). The handler keeps accepting `/menu` so existing users aren't broken.
- `/start` is included because it's the canonical Telegram entry point and useful for re-discovery.

## Section 2 - Welcome flow

Three branches, only the **new user** branch is being rewritten.

### Branch: new user (no DB record)

**Current copy** (`welcomeFirstChoice`): friendly "How would you like to get started?" + inline buttons - but doesn't explain what the bot does before asking the user to pick an account type.

**New copy (EN):**

```
Hi! I turn long videos into vertical clips with subtitles - ready for TikTok, Reels and Shorts.

How it works:
1. Pick a plan
2. Send a video (up to 3 hours)
3. Get 5–15 short clips back

First - how do you want to set up?

[ ✨ Create new account ]
[ 🔗 I already have an account ]
```

**New copy (RU):**

```
Привет! Нарезаю длинные видео на вертикальные клипы с субтитрами - для TikTok, Reels и Shorts.

Как это работает:
1. Выбери тариф
2. Пришли видео (до 3 часов)
3. Получи 5–15 коротких клипов

Сначала - как тебе удобнее начать?

[ ✨ Создать новый аккаунт ]
[ 🔗 У меня уже есть аккаунт ]
```

### Branch: returning user with active plan

Unchanged: `welcomeBack` text + reply keyboard.

### Branch: returning user with NONE plan

Unchanged: `welcomeNeedsPlan` text + tariff inline keyboard, followed by `menuHint` + reply keyboard.

### Post-callback behavior

After "Create new account" callback, the bot edits the original message to `newAccountCreated` (with tariff inline buttons) and follows up with `menuHint` + reply keyboard. Two-message flow is intentional - keeps tariff buttons visually separated from the keyboard.

## Section 3 - Reply keyboard

**No changes.** The current 2×2 layout is correct:

```
┌──────────────┬──────────────┐
│  💎 Plans    │  📊 Account  │
├──────────────┼──────────────┤
│  ❓ Help     │  🌐 Language │
└──────────────┴──────────────┘
```

Rationale:
- Labels are short and visually scanable
- 2×2 is the minimum useful grid (1 row feels sparse, 3+ rows crowds the chat)
- All four actions are equal-priority account management; no need for hierarchy
- No "📹 Send video" button - Telegram doesn't allow attaching a file from a reply keyboard button, so such a button would be bait-and-switch

## Section 4 - Menu action behavior

Three of four menu actions are unchanged:

- **Plans** → tariff inline keyboard (Tribute URLs) - unchanged
- **Account** → renders plan + billing cycle + period end + clips total - unchanged
- **Help** → renders `helpText` with limits, commands, website link - unchanged
- **Language** → **changed** (see below)

### Language action - replace text prompt with inline buttons

**Current:** sends `languageMenuPrompt` text asking the user to type `/lang en|ru|auto`.

**New:** sends a short prompt with three inline buttons:

```
Pick a language:

[ 🇬🇧 English ]
[ 🇷🇺 Русский ]
[ 🤖 Auto-detect ]
```

```
Выбери язык:

[ 🇬🇧 English ]
[ 🇷🇺 Русский ]
[ 🤖 Авто-определение ]
```

Callback data: `lang_en` / `lang_ru` / `lang_auto`. Handler:
1. Resolve user (`resolveTelegramUser` - creates if missing).
2. Write to `User.telegramLocale` (string `"en"` / `"ru"` for explicit, `null` for auto).
3. Acknowledge in the newly-effective locale (`langSetEn` / `langSetRu` / `langSetAuto`).

The `/lang` slash command stays as-is for power-users - both paths go through the same persistence logic.

## Section 5 - Implementation

### File changes

| File | Change |
|---|---|
| `apps/bot/src/i18n.ts` | Add `botDescription`, `botShortDescription`, `commands[]`, `langBtnEn`, `langBtnRu`, `langBtnAuto` fields to `Dict`. Rewrite the existing `languageMenuPrompt` copy to a short "Pick a language" line (it will now be paired with inline buttons, not asking the user to type a command). Update `welcomeFirstChoice` copy per Section 2. Provide EN + RU values for all new keys. |
| `apps/bot/src/telegram-client.ts` | Add methods: `setMyDescription(description, languageCode?)`, `setMyShortDescription(short, languageCode?)`, `setMyCommands(commands, languageCode?)`. |
| `apps/bot/src/setup.ts` *(new)* | Export `configureBotProfile(client)` that loops `["en", "ru"]` and pushes description / short / commands. Idempotent. Failures are logged but non-fatal. |
| `apps/bot/src/index.ts` | Call `configureBotProfile(client)` once at startup, before entering the long-polling loop. |
| `apps/bot/src/handlers.ts` | (a) `handleMenuAction` ‒ `language` case sends an inline keyboard instead of text prompt. (b) `handleCallbackQuery` ‒ three new cases `lang_en` / `lang_ru` / `lang_auto` that reuse the persistence path. |

### Constants

Add to `handlers.ts` alongside existing callback constants:

```ts
export const CALLBACK_LANG_EN = "lang_en";
export const CALLBACK_LANG_RU = "lang_ru";
export const CALLBACK_LANG_AUTO = "lang_auto";
```

### Tests (`apps/bot/src/__tests__/`)

Extend `i18n.test.ts`:
- `t(locale).botDescription.length <= 512` for `en` and `ru`
- `t(locale).botShortDescription.length <= 120` for `en` and `ru`
- `t(locale).commands` non-empty, each entry has `command` matching `^[a-z]+$` (no slash prefix) and `description.length <= 256`
- `welcomeFirstChoice` contains expected localized markers (e.g. EN: `"vertical clips"` and the digits `"1"`, `"2"`, `"3"`; RU: `"вертикальные клипы"` and the same digits)

New `lang-callback.test.ts`:
- Parsing `lang_en` / `lang_ru` / `lang_auto` callback data maps to the right effective locale (auto → falls back to `from.language_code`)
- Returned acknowledgement string matches the new locale

New `configure-bot-profile.test.ts`:
- With a mocked `TelegramClient`, `configureBotProfile` calls `setMyDescription` / `setMyShortDescription` / `setMyCommands` twice - once with `language_code: "en"` and once with `language_code: "ru"`
- Content matches `t("en")` and `t("ru")` respectively
- A throwing client does not propagate (warn-and-continue)

### Deployment

1. `npm run build -w @clipfast/bot` - local typecheck.
2. `docker compose up -d --build bot` - rebuild image.
3. On bot startup, log line `Bot profile synced (en, ru)` (or warn line on failure).
4. Manual verification: open the bot in a fresh Telegram account; confirm new description, new commands list, new welcome message, and tappable language switch.

## Error handling

- **Bot profile sync failure** - log a warning, continue startup. The bot remains functional with stale descriptions; user-visible degradation is cosmetic only.
- **Language callback for unknown user** - `resolveTelegramUser` handles missing records (creates one). No special case needed.
- **Length overruns in copy** - caught by unit tests at build time; we never ship copy that violates Telegram's limits.

## Out of scope (deferred / explicit non-goals)

- Telegram Web App / mini-dashboard
- Inline mode (`@clipclapbot query`)
- Group-chat support
- Bot profile picture / cover photo (set manually via BotFather, not via API)
- Animated start sticker
