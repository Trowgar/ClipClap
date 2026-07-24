# Bot Support: Media Relay + Operator Note - Design

**Date:** 2026-07-24
**Status:** Approved (all decisions locked)
**Author:** Trowgar
**Extends:** 2026-07-24-bot-support-relay-design (the base support relay, shipped)

## Problem

Two gaps surfaced after the support relay shipped:

- **A. A user in a support session cannot send visual evidence.** Screenshots
  (photos) get a "text only" notice; video files are silently processed into clips
  instead of being handled in the support context. A screenshot of the error is
  the most common support attachment - this blocks it.
- **B. If the operator opens Support in their own chat, the UX is contradictory.**
  They see "Write your message..." then, because self-relay is (correctly)
  suppressed, get the "Send me a video" hint.

## Goal (UX priority: simplest, most predictable behavior for non-savvy users)

While a support session is open, the bot behaves consistently and never
surprises the user with an unexpected clip job:

| User sends (session OPEN) | Behavior |
|---|---|
| Text / link | Relayed to operator |
| Photo / screenshot | Copied to operator (with `#uid` caption) |
| **Video / video-document** | **NOT processed into a clip.** Bot replies with a clear notice: close the chat to make a clip, or send text/screenshot for support. |
| Other media (voice, doc, etc.) | Copied to operator; if the copy fails (e.g. sticker), a short "send a screenshot or text" notice |

When the session is CLOSED, everything is unchanged (videos -> clips, etc.).

**B.** When the operator taps Support in their own chat, show a short note instead
of opening a session.

## Key decision (confirmed)

**Video does NOT go to support.** In an open session a video is neither processed
into a clip NOR relayed - the bot shows a notice telling the user to close the chat
first (to make a clip) or use text/screenshot (for support). Chosen for maximum
predictability: "while in the support chat, nothing gets turned into a clip."

## Non-goals

- No changes to clip processing when support is CLOSED.
- No ticket tables, no attachment storage (Telegram hosts the media; we copy it).
- No worker/web changes.
- Video-to-support is intentionally NOT supported (only screenshots/photos and
  other copyable media go to the operator).

## Design

### A. Media relay + video notice

**TelegramClient** (`apps/bot/src/telegram-client.ts`):
- Add `copyMessage(chatId, fromChatId, messageId, options?: { caption?: string })`
  -> Bot API `copyMessage` (`chat_id`, `from_chat_id`, `message_id`, optional
  `caption`). Copies media into the operator chat with our own caption; no
  "forwarded from" header.

**Types** (`apps/bot/src/types.ts`):
- Add `caption?: string;` to `TelegramMessage` (to build the relayed caption and to
  read `#uid` from an operator's reply to a media ticket).

**Handlers** (`apps/bot/src/handlers.ts`):

- `parseSupportReply` reads the marker from `r.text ?? r.caption ?? ""` (media
  tickets carry `#uid` in their caption).

- New `relaySupportMedia(client, from, message): Promise<boolean>`:
  ```
  const chat = getSupportChatId();
  if (!chat) { console.warn(...); return true; }
  const name = <same stripped display name as relaySupportMessage>;
  const username = from.username ? ` (@${from.username})` : "";
  const caption =
    `${SUPPORT_MARKER}${from.id} ${name}${username}` +
    (message.caption ? `\n\n${message.caption}` : "");
  try {
    await client.copyMessage(chat, message.chat.id, message.message_id, { caption });
    return true;
  } catch (e) {
    console.error(`Failed to relay support media to ${chat}:`, e);
    return false;
  }
  ```
  `#uid` stays the FIRST token of the caption (same anchored `SUPPORT_UID_RE`,
  same spoof-proofing as text tickets).

- **Dispatch** in `handleUpdate`. Compute `const source = getVideoSource(message);`
  once, then branch on the session BEFORE the normal product path:
  ```
  const source = getVideoSource(message);

  if (supportOpen && String(message.chat.id) !== getSupportChatId()) {
    if (source) {
      // Video in a support session -> do NOT make a clip; explain what to do.
      await client
        .sendMessage(message.chat.id, dict.supportVideoInSession, {
          replyMarkup: supportKeyboard(dict),
        })
        .catch(() => undefined);
      return;
    }
    if (text) {
      await relaySupportMessage(client, from, text);
      return;
    }
    const ok = await relaySupportMedia(client, from, message);
    if (!ok) {
      await client
        .sendMessage(message.chat.id, dict.supportMediaUnsupported)
        .catch(() => undefined);
    }
    return;
  }

  // session CLOSED -> normal product path (unchanged):
  if (source) {
    await handleVideo(client, message, from, source, dict, config);
    return;
  }
  const url = extractVideoUrl(text);
  if (url) { await handleVideoUrl(...); return; }
  await client.sendMessage(message.chat.id, dict.sendVideoHint);
  ```
  Note: this REPLACES the current support guard (which sat after `getVideoSource`
  and used `dict.supportTextOnly`). The old `supportOpen` text/else block and the
  separate `getVideoSource` block are merged into the structure above.

**i18n** (EN + RU): remove the now-unused `supportTextOnly`; add:
- `supportVideoInSession`
  - RU: `⚠️ Ты сейчас в чате поддержки.\n\n• Чтобы сделать клип - нажми «⬅️ Закрыть диалог» внизу и пришли видео снова.\n• Чтобы описать проблему - напиши текстом или пришли скриншот.`
  - EN: `⚠️ You're in the support chat right now.\n\n• To make a clip - tap "⬅️ Close chat" below and send the video again.\n• To describe your issue - send text or a screenshot.`
- `supportMediaUnsupported`
  - RU: `Не удалось переслать это. Пришли скриншот или опиши текстом.`
  - EN: `Couldn't send that. Send a screenshot or describe it in text.`

(The close-button text embedded in `supportVideoInSession` must match
`supportCloseBtn`; keep them in sync.)

### B. Operator note

In the `matchHelpAction` `support` dispatch, before `openSupport`:
```
if (String(message.chat.id) === getSupportChatId()) {
  await client
    .sendMessage(
      message.chat.id,
      "Ты оператор - тикеты от пользователей приходят сюда. Отвечай reply'ем на сообщение тикета."
    )
    .catch(() => undefined);
  return;
}
await openSupport(client, message, from, dict);
```
Operator-facing, hardcoded RU (consistent with the other operator strings). No
`supportOpen` write for the operator.

## Edge cases

- **Video while support open** -> `supportVideoInSession` notice; not processed,
  not relayed.
- **Screenshot/photo/other copyable media** -> copied to operator with `#uid`
  caption.
- **Uncopyable media** (sticker, some types) -> `copyMessage` throws ->
  `supportMediaUnsupported`; nothing lost silently.
- **Operator replies to a media ticket** -> `reply_to_message.caption` holds the
  `#uid`; `parseSupportReply` reads it.
- **No `SUPPORT_CHAT_ID`** -> Support button says "unavailable"; media relay
  no-ops.
- **Caption spoofing** -> `#uid` is the first token and the name is `#uid`-stripped;
  a user caption cannot hijack routing.

## Testing (in the `bot` container)

- `copyMessage` sends the correct API params (chat_id/from_chat_id/message_id/
  caption).
- `parseSupportReply` reads `#uid` from `reply_to_message.caption` when `text` is
  absent (new) and still from `text` (regression).
- `relaySupportMedia`: caption starts `🆕 #uid<id>`, appends the user's caption
  when present, calls `copyMessage`, returns `false` when it throws; no-ops with no
  support chat.
- i18n: `supportVideoInSession` and `supportMediaUnsupported` exist in EN + RU;
  `supportTextOnly` is gone.
- Dispatch (where unit-testable): a `supportOpen` user sending a video -> the
  video notice, `handleVideo` NOT called; sending a video with support closed ->
  `handleVideo` (regression). Operator tapping Support -> note, no `supportOpen`
  write.

## Migration / deploy

- No schema change. Bot-only (client + types + i18n + handlers). Hot-reloads into
  the live bot; no container recreation needed.
- Commit identity `Trowgar <trowgar@yahoo.com>`, no trailer; plain hyphens only.
