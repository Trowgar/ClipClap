# Telegram Bot - Menu Consolidation (Account + Settings)

**Date:** 2026-05-24
**Status:** Approved, ready for implementation
**Scope:** Collapse the 💎 Plans button into 📊 Account (which now handles both subscription info and tariff purchase). Rename 🌐 Language to ⚙️ Settings so future per-user preferences have a natural home. Reply keyboard drops from 4 buttons to 3.

## Goal

Two reply-keyboard buttons (💎 Plans and 📊 Account) currently overlap heavily for active subscribers. Both show plan + cycle + renewal. The information is duplicated, and adding a "Manage subscription" button to one but not the other made the split feel arbitrary.

The 🌐 Language button is single-purpose. We expect to add more settings (notification preferences, default subtitle preset) in the future. Renaming it to ⚙️ Settings and making language its first sub-option lets us grow without another menu reshuffle.

## Final layout

Reply keyboard becomes a 2-row, 3-button grid:

```
┌──────────────┬──────────────┐
│  📊 Account  │  ❓ Help     │
├──────────────┴──────────────┤
│      ⚙️ Settings            │
└─────────────────────────────┘
```

Russian: 📊 Аккаунт / ❓ Помощь / ⚙️ Настройки.

## 📊 Account behavior (extended)

Tap behavior branches on plan state:

**NONE plan (or no DB record):** text is the current `accountText` NONE variant ("Plan: no active plan / Pick a plan to start clipping / Total clips created: N"), followed by an **inline keyboard with Tribute tariff buttons** (the same `plansKeyboard` helper used today). This is the path NONE-users currently get from the Plans button - it now lives inside Account.

**Active plan:** text is the current `accountText` active variant (plan, renews, minutes, storage, total). Followed by an inline button `🔧 Manage subscription` whose URL is routed by `usage.paymentProvider`:
- `tribute` → `https://t.me/tribute`
- otherwise → `${appUrl}/dashboard/plans`

## ⚙️ Settings behavior

Tap shows:
- Header text "Settings:" / "Настройки:" (replacing the old "Pick a language:" / "Выбери язык:")
- Inline keyboard with the three language buttons (🇬🇧 English / 🇷🇺 Русский / 🤖 Auto-detect)

Future settings (notifications, default subtitle preset) will be additional rows in the same inline keyboard or sub-menus opened via callback. None added now (YAGNI).

The `lang_en` / `lang_ru` / `lang_auto` callback handlers stay unchanged - they were already keyed by `CALLBACK_LANG_*`.

## Removed

- **💎 Plans reply button** - gone from the keyboard.
- **`MenuAction = "plans"`** - removed; its branch logic moves into the "account" handler.
- **`/plans` slash command** - removed from the autocomplete commands list AND from `parseMenuCommand`'s regex. (`/plans` typed manually now falls through to "send video hint" - a clean break.)
- **`languageMenuPrompt` string** - replaced by `settingsMenuPrompt`.
- **`menuLanguage` string** - replaced by `menuSettings`.

## Added

- **`menuSettings`** in `Dict` (EN: `"⚙️ Settings"`, RU: `"⚙️ Настройки"`)
- **`settingsMenuPrompt`** in `Dict` (EN: `"Settings:"`, RU: `"Настройки:"`)
- **`/settings`** in autocomplete commands list (EN: `"Open settings"`, RU: `"Настройки"`)
- **`parseMenuCommand`** matches `/settings` and `/account`, `/help` (drops `/plans`)
- **`MenuAction = "settings"`** (renames the old "language")

## Slash commands

Final autocomplete list (6 entries):
- `/start` - main menu
- `/account` - plan & usage
- `/help` - limits and how it works
- `/settings` - settings
- `/lang` - switch language directly (power-user shortcut, separate from `/settings`)
- `/link` - connect clipclap.io account

`/lang en|ru|auto` continues to work as before - it's not going through the menu, so the rename doesn't affect it.

## Tests

In `apps/bot/src/__tests__/i18n.test.ts`:
- Update existing "has unique menu button labels per locale" test: replace `menuPlans`/`menuLanguage` with `menuAccount`/`menuHelp`/`menuSettings` (set size = 3)
- Update existing "exposes localized language-button labels" stays unchanged (callbacks still language-keyed)
- Rename test "renders accountText..." stays unchanged
- New test: `menuSettings` and `settingsMenuPrompt` have correct localized strings
- Update existing commands-list test: expected list is `["start", "account", "help", "settings", "lang", "link"]`

In `apps/bot/src/__tests__/match-menu-action.test.ts`:
- Replace assertions for `💎 Plans` and `🌐 Language` with `⚙️ Settings`
- The 3 remaining menu actions: `account`, `help`, `settings`

## File changes

| File | Status | Change |
|---|---|---|
| `apps/bot/src/i18n.ts` | modify | Rename `menuLanguage` → `menuSettings`, `languageMenuPrompt` → `settingsMenuPrompt`. Update string values. Update commands list (drop `plans`, add `settings`). |
| `apps/bot/src/handlers.ts` | modify | `buildMainMenu`: drop Plans column, replace Language with Settings (row 1: Account/Help, row 2: Settings). `MenuAction` type: remove "plans", rename "language" → "settings". `matchMenuAction`: match against `menuSettings`. `parseMenuCommand`: support `/settings`, drop `/plans`. `handleMenuAction`: remove "plans" case; "account" case absorbs the NONE-plan tariff keyboard logic plus active-plan management button; "settings" case shows `settingsMenuPrompt` + language keyboard. |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | Update menu-label uniqueness test, commands-list test, add `menuSettings` / `settingsMenuPrompt` assertions. |
| `apps/bot/src/__tests__/match-menu-action.test.ts` | modify | Update assertions for new menu. |

No service or schema changes needed.

## Out of scope

- Adding new settings (notifications, default presets) - those land later.
- Web-dashboard parity - separate effort.
- Migrating users away from old Plans / Language button taps (Telegram caches reply keyboards client-side; users will see the new keyboard on the next bot message that attaches one, or after `/start` / `/menu`).
