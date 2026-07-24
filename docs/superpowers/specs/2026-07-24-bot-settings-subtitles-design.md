# Bot Settings Sub-menu + Subtitle Toggle - Design

**Date:** 2026-07-24
**Status:** Pending approval
**Author:** Trowgar

## Problem

The Telegram bot's Settings is language-only: tapping "⚙️ Settings" immediately
shows an inline keyboard with En / Ru / **Auto**. There is no place for other
settings, and a Telegram user cannot turn subtitles off - both video-submission
paths hardcode `subtitles: true` (`apps/bot/src/handlers.ts:894`, `:940`), even
though the web app already lets users choose per-upload and the worker already
supports it.

## Goal

Restructure Settings into a small nested menu and add a video setting:

- **Settings** -> a reply-keyboard sub-menu: `[🌐 Language] [🎬 Video settings]`,
  `[⬅️ Menu]`.
- **Language** -> inline choice of **Russian / English only** (remove "Auto").
- **Video settings** -> an inline **subtitles on/off toggle** (default ON, since
  users rarely disable subtitles).
- The subtitle preference is persisted per user and makes output clips have no
  burned-in subtitles when off.

## Key finding (scope)

The worker already gates subtitle burn-in on `Job.subtitles` (Boolean, default
true): `renderClips` does `if (job.subtitles && cues.length > 0) { ...burn... }`
(`apps/worker/src/stages/render.ts`). `Job.subtitles` already exists and
`jobService.createJob({ subtitles })` already accepts it. So **no worker/render
changes are needed** - the only gap is that the bot hardcodes `subtitles: true`
instead of reading a user preference.

## Non-goals

- **No worker / render changes.** The `job.subtitles` gate is correct as-is.
- **No web changes.** The web upload's per-upload subtitle toggle is untouched.
- **No new video settings yet** (only subtitles now; the menu leaves room for
  more later).
- **Auto-detect stays as the default**, just not explicitly selectable (below).

## Approach: persist on User, snapshot onto Job

Add `User.subtitlesEnabled Boolean @default(true)`. At video submission the bot
reads it and passes it into `createJob({ subtitles: user.subtitlesEnabled })`,
snapshotting the preference onto `Job.subtitles`. This mirrors the existing
`telegramLocale` user-preference pattern and the existing `Job.subtitles`
snapshot field; the worker keeps reading only `job.subtitles`. Snapshotting means
a preference change applies to *future* submissions, not already-queued jobs -
the intended behavior.

## Design

### Navigation (reply keyboards + text matching)

Reply-keyboard buttons are matched by their text (like the existing
`matchMenuAction`), so navigation is stateless.

```
⚙️ Settings  (main-menu reply button)
   -> message "⚙️ Settings" + settings reply keyboard:
        [ 🌐 Language ] [ 🎬 Video settings ]
        [ ⬅️ Menu ]

🌐 Language  -> message + inline keyboard [ 🇷🇺 Русский ] [ 🇬🇧 English ]
   choose -> store telegramLocale, edit message to "Language: Русский ✅"

🎬 Video settings -> message + inline toggle reflecting current state:
        [ Subtitles: on ✅ ]     (tap toggles)
   toggle -> flip User.subtitlesEnabled, edit button to "Subtitles: off ⬜"

⬅️ Menu  -> restore the main menu (buildMainMenu)
```

The settings reply keyboard stays visible while choosing language / toggling
subtitles (both are separate inline messages); `⬅️ Menu` restores the main menu.

### Components

**Schema** (`prisma/schema.prisma` + migration):
- `User.subtitlesEnabled Boolean @default(true)`.

**i18n** (`apps/bot/src/i18n.ts`, EN + RU):
- Add: `settingsLangBtn` ("🌐 Language" / "🌐 Язык"), `settingsVideoBtn`
  ("🎬 Video settings" / "🎬 Настройки видео"), `settingsBackBtn`
  ("⬅️ Menu" / "⬅️ Меню"), `settingsPrompt` (the "⚙️ Settings" header),
  `videoSettingsPrompt`, `subtitlesToggleBtn(enabled: boolean)` (the button
  label with on/off state), `subtitlesAck(enabled: boolean)`.
- Remove: `langBtnAuto`, `langSetAuto` (and their usages).

**handlers** (`apps/bot/src/handlers.ts`):
- `settings` menu action -> send `settingsPrompt` + a new `settingsKeyboard`
  (reply keyboard with the three buttons above).
- New `matchSettingsAction(text)` -> `"lang" | "video" | "menu" | null` (matches
  the three button labels in EN + RU), dispatched in `handleUpdate` alongside
  `matchMenuAction`. `"menu"` -> restore `buildMainMenu`; `"lang"` -> inline
  language keyboard; `"video"` -> inline subtitle toggle (reads
  `user.subtitlesEnabled` for current state).
- Language: `languageKeyboard` -> only `[Русский] [English]`;
  `parseLangCallback` -> `"en" | "ru" | null` (drop `auto`); `applyLangChoice`
  -> `en | ru` only; drop `CALLBACK_LANG_AUTO`.
- Subtitles: new `CALLBACK_SUBTITLES_TOGGLE`; a `subtitlesKeyboard(dict, enabled)`
  inline button; on the callback, load the user, flip `subtitlesEnabled`, persist,
  and `editMessageText` with the new state + `subtitlesAck`.
- Video submission: `handleVideo` (`:894`) and `handleVideoUrl` (`:940`) read the
  user's `subtitlesEnabled` and pass it as `subtitles` to `jobService.createJob`
  instead of hardcoding `true`. Implementation must confirm the resolved user
  object in these paths includes `subtitlesEnabled`; if the load uses a `select`,
  add the field (otherwise fetch it).

**Worker:** no changes.

### Auto-language removal

Removing the "Auto" button does not change locale detection: `telegramLocale`
stays nullable and `null` still means "auto-detect from Telegram `language_code`"
(via `detectLocale`) for users who have not chosen. New users still start
auto-detected; they simply pick EN or RU explicitly instead of "Auto". Existing
users with `telegramLocale = null` keep auto-detect behavior.

## Error handling

Settings actions are best-effort UI (consistent with the existing settings /
language handlers): a failed `editMessageText`/`sendMessage` is caught and
ignored, as today. A DB failure toggling `subtitlesEnabled` propagates to the
poll loop's catch (same as the current `applyLangChoice`). No external calls.

## Testing (in the `bot` container)

- `matchSettingsAction` maps the three button labels (EN + RU) to
  `lang`/`video`/`menu`, and unrelated text to `null`.
- `languageKeyboard` contains only Русский + English (no Auto);
  `parseLangCallback("lang_auto")` is `null`.
- `subtitlesKeyboard(dict, true)` renders an "on ✅" button with
  `CALLBACK_SUBTITLES_TOGGLE`; `(dict, false)` renders an "off" button.
- The subtitle toggle handler flips `subtitlesEnabled` and edits to the new state
  (mock prisma + client).
- Job submission uses `user.subtitlesEnabled` (mock a user with
  `subtitlesEnabled: false` -> `createJob` called with `subtitles: false`).

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/<file>`
(host Node cannot run vitest). Migration via `prisma migrate` (not `db push`).
