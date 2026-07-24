# Bot Support Relay + Help Sub-menu - Design

**Date:** 2026-07-24
**Status:** Pending approval (revised after adversarial review)
**Author:** Trowgar

## Problem

The Telegram bot's "❓ Help" button just prints a static instruction text. There
is no way for a user to reach a human. Oleg wants an in-bot support channel: a
user writes a message, it is delivered to the operator (Oleg), the operator
replies, the reply lands back in the user's bot chat, and the user can either
continue the conversation or close it.

## Goal

- Split "❓ Help" into a small sub-menu: `[❓ How it works] [💬 Support]`, `[⬅️ Menu]`.
  - "How it works" -> the existing `helpText` (unchanged content).
  - "Support" -> opens a persistent support conversation.
- **Support relay:** the user's text messages are forwarded to the operator's DM
  with the bot; the operator answers by Telegram-replying to the forwarded
  message; the reply is delivered to the user.
- The support session stays open until the user closes it (via the Close button)
  or navigates away (any command / menu button). While open, the user's text
  messages route to the operator.

## Non-goals

- **No worker / web changes.**
- **No ticket tables.** The only persisted state is a single boolean flag on
  `User`. The user<->operator routing key lives inside the forwarded message text,
  so it survives bot restarts without a lookup table.
- **No attachments in tickets** (text only at launch). Uploaded video/document
  files are still processed into clips (unambiguous product intent); other media
  (photos, voice, stickers) get a "text only" notice while support is open.
- **No rate-limiting / anti-spam** at launch (YAGNI).
- **No multi-operator routing.** A single operator private DM.
  `SUPPORT_CHAT_ID` MUST be a private chat (a group would make ordinary group
  chatter hit the normal user pipeline).

## Approach: DB flag for inbound routing, leading `#uid` marker for outbound

Add `User.supportOpen Boolean @default(false)`.

- **Inbound (user -> operator):** when `user.supportOpen` is true, a plain text
  message that matched no navigation is relayed to the support chat.
- **Outbound (operator -> user):** the forwarded message the operator sees starts
  with a `#uid<digits>` marker. When the operator Telegram-replies to it, the
  incoming update carries `reply_to_message` whose text starts with that marker;
  the bot parses the id and delivers the operator's text to that user. **No
  mapping table** - the routing key rides Telegram's own reply-to metadata, immune
  to bot restarts (which happen on every hot-reload).

Rejected: a full `SupportTicket`/`SupportMessage` schema (overkill for launch);
in-memory session + message map (lost on every restart).

## Configuration

```ts
function getSupportChatId(): string | null {
  const explicit = process.env.SUPPORT_CHAT_ID?.trim();
  if (explicit) return explicit;
  const first = (process.env.REFERRAL_ADMIN_TELEGRAM_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)[0];
  return first ?? null;
}
```

If `null`, the "💬 Support" button answers `supportUnavailable` and relay is a
no-op with a `console.warn`. New optional env `SUPPORT_CHAT_ID` (documented in
`.env.example`). **Prod today has no `REFERRAL_ADMIN_TELEGRAM_IDS`**, so
`SUPPORT_CHAT_ID` MUST be set explicitly to Oleg's Telegram id for the feature to
work end-to-end.

## Components

### 1. Schema (`prisma/schema.prisma` + migration)

- `User.supportOpen Boolean @default(false)`.
- Migration `prisma/migrations/20260724140000_user_support_open/migration.sql`
  (14-digit timestamp, matching the existing convention):
  `ALTER TABLE "users" ADD COLUMN "supportOpen" BOOLEAN NOT NULL DEFAULT false;`
  (table is `users` per `@@map("users")`).

### 2. Types (`apps/bot/src/types.ts`)

- Add `reply_to_message?: TelegramMessage;` to `TelegramMessage`.
  (`TelegramUser.is_bot?` already exists and is used as a guard below.)

### 3. i18n (`apps/bot/src/i18n.ts`, EN + RU)

| key | EN | RU |
|-----|----|----|
| `helpMenuPrompt` | `❓ Help - choose:` | `❓ Помощь - выбери:` |
| `helpHowBtn` | `❓ How it works` | `❓ Как это работает` |
| `helpSupportBtn` | `💬 Support` | `💬 Поддержка` |
| `supportPrompt` | `Write your message - we'll pass it to support and reply right here.` | `Напиши сообщение - передадим в поддержку, ответим здесь же.` |
| `supportCloseBtn` | `⬅️ Close chat` | `⬅️ Закрыть диалог` |
| `supportClosed` | `Chat closed. Send a video anytime to make clips.` | `Диалог закрыт. Пришли видео - нарежу клипы.` |
| `supportReplyPrefix` | `💬 Support:` | `💬 Поддержка:` |
| `supportUnavailable` | `Support is temporarily unavailable. Please try again later.` | `Поддержка временно недоступна. Попробуй позже.` |
| `supportTextOnly` | `Support takes text only for now - please describe your issue in a message.` | `Поддержка пока принимает только текст - опиши вопрос сообщением.` |

The Help sub-menu reuses the existing `settingsBackBtn` (`⬅️ Menu` / `⬅️ Меню`)
for its back button, which is already handled by `matchSettingsAction("menu")`.
`helpText` is unchanged.

Operator-facing strings (the forwarded header, delivery-failure notices, the
"reply with text" notice) are hardcoded Russian - single RU operator, not
localized.

### 4. handlers (`apps/bot/src/handlers.ts`)

**Constants:**
- `const SUPPORT_UID_RE = /^🆕 #uid(\d+)/;` (anchored to the start of the header)

**Matchers / keyboards:**
- `export function matchHelpAction(text): "how" | "support" | null`
  (matches `helpHowBtn`, `helpSupportBtn` in EN + RU; NOT the back button - that
  is `settingsBackBtn`, handled by the existing settings path).
- `export function matchSupportAction(text): "close" | null`
  (matches `supportCloseBtn` in EN + RU).
- `function helpKeyboard(dict): ReplyKeyboardMarkup` ->
  `[[helpHowBtn, helpSupportBtn], [settingsBackBtn]]`, persistent, resize.
- `function supportKeyboard(dict): ReplyKeyboardMarkup` ->
  `[[supportCloseBtn]]`, persistent, resize.

**Help sub-menu:**
- `handleMenuAction` case `"help"`: send `helpMenuPrompt` + `helpKeyboard(dict)`
  (instead of `helpText`).
- `matchHelpAction` dispatch: `how` -> `sendMessage(helpText(appUrl))` (keeps the
  Help keyboard); `support` -> `openSupport(...)`.

**Session open/close:**
- `async function openSupport(client, message, from, dict)`:
  - If `getSupportChatId()` is `null` -> `sendMessage(supportUnavailable)`, return
    (do NOT set the flag).
  - `resolveTelegramUser(from)`; `prisma.user.update({ where:{ id }, data:{ supportOpen: true } })`;
    `sendMessage(supportPrompt, { replyMarkup: supportKeyboard(dict) })`.
- `async function closeSupport(client, chatId, userId, dict)`:
  - `prisma.user.update({ where:{ id: userId }, data:{ supportOpen: false } })`;
    `sendMessage(chatId, supportClosed, { replyMarkup: buildMainMenu(dict) })`.

**Inbound relay:**
- `async function relaySupportMessage(client, from, text)`:
  - `const chat = getSupportChatId(); if (!chat) { console.warn(...); return; }`
  - `name` = `[first_name, last_name].filter(Boolean).join(" ")` with any
    `#uid\d+` sequences stripped (defensive), fallback to the id; `username`
    appended as `(@username)` when present.
  - Header (marker FIRST, so a spoofed name cannot precede it):
    `🆕 #uid${from.id} ${name}${username}` on line 1.
  - `sendMessage(chat, `${header}\n\n${text}`)`. User's text passed verbatim.

**Outbound routing:**
- `function parseSupportReply(message): { uid: string } | null`:
  - `const r = message.reply_to_message; if (!r?.from?.is_bot) return null;`
  - `const m = SUPPORT_UID_RE.exec(r.text ?? ""); return m ? { uid: m[1] } : null;`
- `async function deliverSupportReply(client, uid, text, supportChatId)`:
  - `const target = await prisma.user.findUnique({ where:{ telegramId: uid }, select:{ telegramLocale: true } });`
  - If `!target` -> notify operator `⚠️ #uid${uid}: пользователь не найден, ответ не доставлен`, return.
  - `const dict = t(detectLocale(target.telegramLocale ?? undefined));`
  - `try { await sendMessage(uid, `${supportReplyPrefix}\n${text}`, { replyMarkup: supportKeyboard(dict) }); }`
    `catch { notify operator `⚠️ #uid${uid}: не удалось доставить (юзер мог заблокировать бота)`; return; }`
  - Only AFTER a successful send: `prisma.user.update({ where:{ telegramId: uid }, data:{ supportOpen: true } })`
    (re-opens the session; the re-sent `supportKeyboard` makes the Close button
    visible so the user is never silently trapped in relay mode).

### 5. `handleUpdate` dispatch order (message path)

The `existing` select in `handleUpdate` gains `supportOpen`:
`select: { id: true, telegramLocale: true, supportOpen: true }`.

After `dict` is computed:

1. **Operator reply** (before anything else): if
   `String(message.chat.id) === getSupportChatId()` and
   `parseSupportReply(message)` returns a uid:
   - if `!text` (operator replied with a photo/voice/etc.) -> notify operator
     `⚠️ Ответ должен быть текстом` and return (never fall through).
   - else `deliverSupportReply(client, uid, text, message.chat.id)`, return.
   (A non-reply operator message returns `null` here and flows on as a normal
   user message - Oleg's own usage is unaffected.)
2. **Support close button:** if `matchSupportAction(text) === "close"` ->
   `resolveTelegramUser`, `closeSupport(...)`, return.
3. **Central navigation clear:** compute `isCommand = text.startsWith("/")`,
   `menuAction`, `settingsAction`, `referralAction`, `helpAction`. If
   `existing?.supportOpen && (isCommand || menuAction || settingsAction ||
   referralAction || helpAction)` -> `prisma.user.update({ data:{ supportOpen:
   false } }).catch(() => {})`. This guarantees any recognized navigation exits
   the session, so no path leaves the flag stuck on. (No handler signatures
   change; the clear is centralized here.)
4. Existing command dispatch: `/start`, `/link`, `/lang`, `/menu`, `/referral`,
   `/balance`, admin commands (unchanged).
5. `menuAction` -> `handleMenuAction` (help -> Help sub-menu).
6. `settingsAction` -> `handleSettingsAction` (unchanged; also serves the Help
   sub-menu back button via "menu").
7. `matchReferralAction` -> withdraw stub (unchanged).
8. `matchHelpAction` -> how / support.
9. `const source = getVideoSource(message); if (source) -> handleVideo`, return.
   (Video/document files always process, even during support.)
10. **Support relay / media guard:** if `existing?.supportOpen`:
    - `if (text) -> relaySupportMessage(client, from, text)`, return.
    - else (photo/voice/sticker/non-video doc) -> `sendMessage(supportTextOnly)`,
      return.
11. URL extraction -> `handleVideoUrl` (unchanged).
12. `sendVideoHint` fallback (only reached when support is closed).

> Reachability: steps 4-8 return inside their handlers; the central clear in
> step 3 already flipped the flag for those, so a user who navigates lands in the
> normal pipeline. Only genuinely unmatched text from a support-open user reaches
> step 10's relay.

## Flows

**Open + message:**
```
User taps 💬 Support (Help sub-menu)
  -> supportOpen=true; bot: supportPrompt + [⬅️ Close chat]
User: "ссылка не работает"
  -> operator DM: "🆕 #uid575308044 Ivan (@ivan)\n\nссылка не работает"
```
**Operator answers:**
```
Operator replies to that message: "пришли ссылку ещё раз"
  -> bot delivers to user: "💬 Поддержка:\nпришли ссылку ещё раз" + [⬅️ Close chat]
  -> user's supportOpen re-set true (after successful send)
User: keeps typing (relays) OR taps Close (-> supportClosed + main menu)
```

## Edge cases (decisions)

- **Video/URL while open:** uploaded video/document -> processed into clips (step
  9, not relayed). Plain text (incl. pasted URLs) -> relayed (step 10). Other
  media -> `supportTextOnly`.
- **Reply to an old/closed ticket:** still delivered; re-opens the session (with
  the Close keyboard, so it is visible).
- **Operator == user** (their DM is both roles): disambiguated by
  `reply_to_message.from.is_bot` + the anchored `#uid` marker. Non-reply operator
  messages are handled normally.
- **Spoofing the marker:** the marker is the FIRST token of the header and the
  regex is anchored to `^`; the user-controlled name follows it and is also
  stripped of `#uid\d+`. So neither the name nor the quoted user text can inject a
  false id.
- **Delivery failure** (user blocked the bot / no row): operator gets a `⚠️`
  notice; the user's flag is not flipped on a failed send.
- **No support chat configured:** button -> `supportUnavailable`; relay no-ops
  with a warning.

## Error handling

- User/operator sends are best-effort (`.catch(() => undefined)`) where a failure
  must not break the poll loop, matching existing handlers.
- `deliverSupportReply` uses `findUnique` (not `update`) for the lookup so a
  missing row does not throw; the send is wrapped and reports failure to the
  operator.
- DB failures toggling `supportOpen` in open/close propagate to the poll loop's
  catch (same as `handleSubtitlesToggle`).
- No external services beyond the Telegram API.

## Testing (in the `bot` container)

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/<file>`;
typecheck `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`.

- `matchHelpAction` maps `helpHowBtn`/`helpSupportBtn` (EN+RU) to `how`/`support`,
  unrelated text (incl. `settingsBackBtn`) to `null`.
- `matchSupportAction` maps `supportCloseBtn` (EN+RU) to `close`, else `null`.
- `getSupportChatId`: prefers `SUPPORT_CHAT_ID`, falls back to first
  `REFERRAL_ADMIN_TELEGRAM_IDS`, `null` when neither set.
- `parseSupportReply`: `reply_to_message.from.is_bot` + text starting
  `🆕 #uid575308044` -> `{ uid: "575308044" }`; a name-spoofed body like
  `🆕 #uid999 #uid575308044 ...` still yields `999` only via the anchored header
  (test that a user-supplied `#uid` in the quoted text does NOT win); missing
  marker / non-bot reply / no reply -> `null`.
- `relaySupportMessage`: sends to the support chat id; header starts with
  `🆕 #uid<id>`; a `first_name` containing `#uid123` is stripped so the header id
  is the real sender.
- `deliverSupportReply`: unknown uid -> operator notice, no user send, flag not
  set; known uid -> `supportReplyPrefix` + text + `supportKeyboard`, flag set
  after send.
- Dispatch: a `supportOpen=true` user sending plain text -> `relaySupportMessage`,
  no `sendVideoHint`; sending a video file -> normal processing, not relayed;
  sending a photo -> `supportTextOnly`, not `sendVideoHint`; tapping any menu /
  settings / referral button or a command -> flag cleared.
- `openSupport` with `getSupportChatId()` null -> `supportUnavailable`, flag NOT
  set. Close button and `closeSupport` set the flag false and restore the main
  menu.

## Migration / deploy notes

- Prisma migrate (not `db push`); `migrate deploy` + `generate` run per-container
  (web + bot + worker) because the client type gains `supportOpen`; rebuild
  `@clipclap/shared` (worker runs its `dist`).
- **Env rollout:** add `SUPPORT_CHAT_ID=<Oleg's Telegram id>` to prod `.env`.
  Env changes are NOT hot-reloaded - they require `docker compose up -d` to
  recreate the bot container, after which re-run `prisma generate` per-container
  and the shared build (per the project's deploy ritual).
- Source is bind-mounted and hot-reloads code into the live bot.
- Commit identity `Trowgar <trowgar@yahoo.com>`, no attribution trailer; plain
  hyphens only.

## Accepted pre-existing behavior (noted, not changed)

- `openSupport` calls `resolveTelegramUser`, which auto-creates a user row for a
  brand-new person who reaches Support before onboarding - the same pre-existing
  behavior as `handleSettingsAction("video")`. Accepted for consistency.
- `/help` now opens the Help chooser; its registered command description stays
  "Limits and how it works" (cosmetic).
