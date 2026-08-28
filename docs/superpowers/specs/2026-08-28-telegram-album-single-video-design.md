# Telegram album single-video guard

## Problem

Telegram delivers every item in an album as a separate message with the same
`media_group_id`. The bot currently ignores that field and processes every item
independently. A real user sent an album containing ten videos under 60 seconds
and one 65-second video. The bot sent ten detached refusal messages, processed
the valid item, and repeated the same mixed result when the album was resent.

The product accepts one source video at a time. It does not concatenate an
album and must not silently choose one item from a group.

## Decision

Reject the entire Telegram media group before any item reaches `handleVideo`.
Process zero files from the group and send one explanation for the whole group:

> Я работаю с одним видео за раз. Ты отправил несколько файлов одновременно. Пришли одно видео отдельным сообщением - не альбомом и не подборкой.

All new user-facing strings and code comments in this change use the ordinary
ASCII hyphen `-`, never an en dash or em dash.

## Behavior

- Add optional `media_group_id` to `TelegramMessage`.
- After extracting a video source and before calling `handleVideo`, detect a
  non-empty `media_group_id`.
- Return immediately for every item in the group, so no account, upload, job,
  free-tier charge, or duplicate lookup is created for any item.
- Send the localized explanation only for the first update observed for a
  `(chat.id, media_group_id)` pair.
- Remember recent group keys for five minutes in a small in-memory timestamp
  map. Insert the key before awaiting the send, so concurrently arriving album
  items cannot each send a reply. Prune expired entries during later album
  handling. The production bot currently has one process; cross-process
  deduplication is outside this change.
- A new media group receives its own reply. Repeated updates from the same group
  during the retention window stay silent.
- A single video without `media_group_id` follows the existing path unchanged.
- Non-video albums remain outside this change and follow their existing paths.

## Localization

Add one required dictionary key for the album rejection to every existing bot
locale. The Russian text above is authoritative. Other locales carry the same
meaning: one video at a time, the received group was not processed, resend one
chosen video as a separate message. An unknown Telegram language code resolves
through the existing locale detector and receives the English message.

## Telemetry

Record one refusal for the first item of each rejected album with a dedicated
`MEDIA_GROUP` code and the safe detail `{ source: "file" }`. Do not record one
refusal per item because that recreates the inflation this guard is meant to
remove. The funnel event name is `upload_rejected_media_group`.

The first update cannot know the final album size without buffering, and the
message does not need that number. Buffering the whole group adds latency and
state without changing the decision, so it is deliberately excluded.

## Tests

- Two video updates with the same group id send exactly one localized message,
  record exactly one `MEDIA_GROUP` refusal, and create no job.
- Concurrent handling of two items from the same group still sends and records
  once.
- Two different group ids each receive one response.
- The same group id in different chats is treated as two groups.
- A normal single-video update remains unchanged.
- An unsupported Telegram language code receives the English message.
- The exact Russian message contains an ASCII hyphen and contains no `U+2013`
  or `U+2014` characters.

## Acceptance criteria

1. A Telegram album containing any number or duration of videos produces one
   explanatory message and zero jobs.
2. The bot never processes an arbitrary first or longest album item.
3. The refusal ledger contains one row per album, not one row per item.
4. Existing single-video and URL behavior remains unchanged.
5. All bot tests, type checking, and relevant shared-service tests pass.
