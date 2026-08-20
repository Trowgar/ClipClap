# Per-clip feedback - design

Date: 2026-08-20. Status: designed, not built.
Surfaces: Telegram bot and web, each behind its own kill switch.

## Problem

ClipClap ships clips and hears nothing back. The owner's own sampling puts roughly 2 of 8
clips at "postable", but that number comes from one person looking at one batch. Nothing in
the product asks the user what happened to a clip, so every engine decision - moment
selection, clip boundaries, framing, subtitles, render - is tuned against internal rubrics
and agent panels that are known to be unstable per clip. Revenue is zero and the user base is
small, which makes each real answer disproportionately valuable and makes response rate, not
sample size, the thing the design must optimise.

Two failure modes to avoid, both of which have precedent in this repo:

- **A form nobody fills in.** Anything past one tap loses most respondents.
- **An answer nobody can act on.** "Bad clip" without a routable cause and without the video
  itself is a row in a table, not a fix.

## Goal

One tap gives a usable verdict. A second optional tap routes the complaint to a subsystem. An
optional free-text reply carries anything the buttons cannot. Every answer lands with enough
context - and with the video itself - that an agent can open it weeks later and know exactly
which clip is being complained about and why.

## Decisions

### D1. Three verdicts, and the middle one means "I would edit it first"

```
Would you post this?     [ As is ] [ I'd edit ] [ No ]
```

Binary 👍/👎 loses the diagnostic middle. A neutral middle ("meh", "so-so") is worse than
useless: it is the socially cheapest answer and becomes the bucket everything falls into,
destroying the separation between the other two. Anchoring the middle to what a clipper
actually does - re-cut it by hand before posting - makes it the most valuable class rather
than the mushiest: the clip is nearly right, and the reason chip then points at one precise
defect.

Metric consequence: **postable rate = `AS_IS` only**. `AS_IS + EDIT` is a second line
("salvageable by hand"). Do not equate `AS_IS` with the owner's own 2-of-8 sampling: the owner
judged clips as delivered, a user pressing `EDIT` is judging a clip they intend to change. The
button copy ("as is") is what keeps those two readings apart.

Verdict codes: `AS_IS`, `EDIT`, `NO`.

### D2. Reasons are symptoms, not pipeline stages

The first draft named the reasons after our own pipeline ("wrong moment", "trim", "framing").
A user does not experience a pipeline. "Cut off mid-sentence" and "wrong moment chosen" feel
like one thing - "they showed me the wrong bit" - and are only separable by symptom words:
boredom versus truncation.

| Code    | RU                    | EN                  | Routes to              |
| ------- | --------------------- | ------------------- | ---------------------- |
| BORING  | Скучный момент        | Boring moment       | ANALYZE (selection)    |
| CUTOFF  | Обрывается            | Cut off             | ANALYZE (boundaries)   |
| FRAMING | Не видно лицо         | Face off-screen     | REFRAME (cropPlan)     |
| SUBS    | Ошибки в субтитрах    | Subtitle errors     | SUBTITLES              |
| QUALITY | Плохое качество       | Bad quality         | RENDER (and source)    |

`QUALITY` deliberately merges "our render is bad" with "your source was bad". The user cannot
tell those apart; we can, from `Job.sourceDurationSec`, the render manifest and the source
itself, at analysis time.

Reasons are **single-select**: the user names the worst problem. Multi-select needs a "Done"
button, which is a third mandatory tap. Free text covers the rest.

Layout is three rows of 2/2/1. Five buttons in one Telegram row truncate to three or four
characters on a phone.

### D3. Free text is a reply to the clip video

No `force_reply`, no per-user pending state, no Redis key. The delivered video's `message_id`
is stored on the clip, and **any reply to that video is recorded as a note on that clip**.
Lazy path stays one tap; motivated users do what Telegram users already do naturally.

Known constraints, all verified in code:

1. `sendVideoUpload` currently discards the send response's `message_id`
   (`apps/bot/src/telegram-client.ts:226`) and cannot attach `reply_markup` at all, and the
   client has no `editMessageReplyMarkup`. All three are additions this spec requires.
2. `handlers.ts:1362` writes `telegramFileId: fileId ?? "sent"` - there are real deliveries
   where Telegram confirmed and the id was not parsed. `Clip.telegramMessageId` is therefore
   **nullable**, and the reply path silently does not exist for those clips. Buttons still
   work: the keyboard travels in the send request, not in a follow-up.
3. Lookup is by the pair `(userId, telegramMessageId)`, never by `message_id` alone.
   `message_id` is unique per chat and is a small integer; a unique index on the bare column
   would be a bug.
4. An open support session captures text before any of our branches
   (`handlers.ts:704`). **Support wins** - the session was opened deliberately.
5. Our interception must sit strictly **above** the "text looks like a source URL" branch, and
   a lookup miss on a reply to one of the bot's own videos must be swallowed. Otherwise a
   reply containing a link starts a submission the user never asked for.
6. Replies to the job summary ("Done, N clips") do not map to a clip. Accepted loss; not fixed.
7. Forwards, albums and cleared chats are not problems: clips are sent one per message, a
   forward carries no reply, and a cleared message cannot be replied to.

### D4. Evidence is an R2 copy, not a retention pin

**Reversed from the first draft, which pinned the clip via a new `Clip.pinnedUntil` and an
extra clause in the sweep selector.** That design is wrong, and the reason is written in the
file it would have edited: Rule A soft-deletes precisely because `usage.service` counts stored
clips as `deletedAt: null` (`retention.service.ts:50-56`, `usage.service.ts:130`). Delaying
the sweep for a pinned clip keeps `deletedAt` null, so a clip the user disliked would occupy
their storage quota for another 30 days. Fixing that means decoupling row soft-delete from
object deletion inside the most dangerous file in the repo.

Instead: on the **first** feedback for a clip, server-side `CopyObject` within R2 from
`Clip.storageKey` to `feedback/<clipId>.mp4`, with no expiry, and store the key on the
feedback row as `evidenceKey`. Clips are 5-20 MB; at an expected feedback rate the standing
cost is cents per month, and the copy is inside R2, so there is no egress.

Properties this buys: the retention sweep is not touched by a single line, the user's quota is
untouched, and the evidence survives both `deleteProject` and the per-clip delete button.

Copy failure is logged and swallowed. Feedback must record even when the copy does not.

### D5. The feedback row has no foreign keys

`deleteProject` hard-deletes the job (`project.service.ts:378`) and `Clip` cascades from it;
`clip.service.ts:83` hard-deletes a single clip, which is the delete button in the clip card.
A relation with `onDelete: Cascade` would therefore erase "I rejected this clip and then
deleted it" - the single most informative event the system can capture.

The repo already solved this twice. `FunnelEvent` and `UploadRefusal` hold plain string ids
with no relations, on purpose and with the reason in the schema comment. This follows them.

The same fact kills the first draft's other claim - that no context snapshot is needed because
everything is reachable by `clipId`. It is reachable only while the job exists.
`Job.transcriptJson`, `Clip.cropPlan` and the timings all cascade away, and the source object
is swept at 7 days. So the snapshot is taken **at the moment of the tap**.

### D6. The kill switch gates rendering, not acceptance

`CLIP_FEEDBACK_BOT=on` and `CLIP_FEEDBACK_WEB=on`, fail-closed (`=== "on"`), matching
`SUBMISSION_QUEUE`.

Switching a surface off stops new keyboards and buttons from being drawn. It does **not** stop
the callback handler or the API route from recording, because keyboards already sitting in
other people's chats cannot be recalled - refusing them would turn those chats into a
graveyard of buttons that answer with an error. `resend:` already lives this way.

The web has no stale-button problem - a page re-renders - so gating its route too would be
harmless. It is left accepting anyway so that both surfaces have one contract, and so that a
reader never has to remember which of the two behaves differently.

If the switch is ever thrown because writes are broken rather than because the feature is
unwanted, that is a different need and gets a different lever; say so rather than reusing this
one.

## Data model

```prisma
/// One row per (clip, user) verdict. No relations on purpose - see the same reasoning on
/// FunnelEvent and UploadRefusal. deleteProject hard-deletes jobs and Clip cascades from
/// them, and clip.service deletes single clips outright, so a relation would erase exactly
/// the strongest signal this table exists to hold: a rejected clip the user then deleted.
model ClipFeedback {
  id         String   @id @default(cuid())
  /// Plain ids, not relations. jobId is denormalised because grouping answers by job is
  /// needed from day one and the job row may be gone by then.
  clipId     String
  jobId      String
  userId     String
  /// "bot" | "web" - same convention as funnel_events.
  surface    String
  /// "AS_IS" | "EDIT" | "NO". String, not enum: a new verdict must not be a migration.
  verdict    String
  /// "BORING" | "CUTOFF" | "FRAMING" | "SUBS" | "QUALITY", or null when the user stopped
  /// after the verdict. Cleared when the verdict changes - a reason belongs to the verdict
  /// it was given under.
  reason     String?
  /// Free text. Telegram: a reply to the clip video. Web: the optional field.
  note       String?  @db.Text
  /// Clip and job context frozen at tap time, because the sources cascade away:
  /// startTime, endTime, duration, title, score, clipKind, lowQuality, hookStart, hookEnd,
  /// payoffAt, analyzeEngine, highlightsVersion, language, transcript slice for
  /// [startTime, endTime] capped at 4000 chars, and a cropPlan digest: keyframe count,
  /// layout kind, and whether the plan moved at all. The full cropPlan is not copied -
  /// it is large, and the digest is what a framing complaint is read against.
  snapshot   Json?
  /// R2 key of the never-expiring copy of the clip, or null if the copy failed.
  evidenceKey String?
  locale     String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([clipId, userId])
  @@index([verdict, createdAt])
  @@index([reason, createdAt])
  @@index([jobId])
  @@map("clip_feedback")
}
```

One new column on `Clip`:

```prisma
  /// message_id of the delivered video, so a user's reply to it maps back to this clip.
  /// Nullable: some deliveries land without a parsed id (see telegramFileId ?? "sent").
  telegramMessageId Int?
```

Upsert on `(clipId, userId)`: changing one's mind overwrites the verdict and clears `reason`;
`note` is never cleared by a verdict change. Upsert keeps no history, so **every tap is logged
to stdout with clipId, old verdict and new verdict** - at this volume, changes of mind are
themselves signal.

## Telegram flow

```
[ video ]
Clip title · 0:42
Would you post this?
┌───────────┬─────────────┬──────────┐
│  As is    │  I'd edit   │    No    │
└───────────┴─────────────┴──────────┘

As is    -> keyboard replaced by "Thanks."                          done, one tap
I'd edit -> keyboard replaced by the reason rows
No       -> keyboard replaced by the reason rows
┌────────────────┬──────────────┐
│ Boring moment  │  Cut off     │
├────────────────┼──────────────┤
│ Face off-screen│  Subtitles   │
├────────────────┴──────────────┤
│      Bad quality              │
└───────────────────────────────┘
reason -> "Noted: framing. Reply to this clip if you want to add anything - I read these."
```

The reason row can be ignored; the verdict is already stored.

`callback_data`: `fb:a|e|n:<clipId>` and `fr:<code>:<clipId>`. With a 25-character cuid the
longest (`fr:FRAMING:<cuid>`) is 36 bytes against Telegram's 64-byte ceiling. The test asserts
the ceiling rather than the current number, so a longer reason code fails loudly.

Ownership is checked on the clip row (`clip.userId === user.id`), exactly as `resend:` does -
`callback_data` comes from the client and is forgeable. A refusal is logged, not answered.

Two send paths need the keyboard, not one: the normal delivery loop in `clip-delivery.ts`, and
the duplicate-source path at `handlers.ts:2114`, which re-sends cached clips via
`sendVideo(file_id)`. Both must also capture `message_id`.

`answerCallbackQuery` is already called at the top of the router, so a throw from the write
must not propagate: record failures are logged and swallowed.

## Web flow

The same three buttons under the player in `apps/web/components/clip-card.tsx`, then the same
five reason chips, then an optional one-line note that saves on Enter or blur. The chosen
button stays highlighted and the others dim; a check mark on the chosen button is the only
symbol in either surface, because the web has no confirmation line the way the bot does.

`POST /api/clips/[id]/feedback` - `auth()` session, ownership checked on the clip row, same
upsert, same snapshot, same evidence copy. The flag is read server-side and passed down as a
prop; no `NEXT_PUBLIC_` variable.

English only, matching the rest of the web interface.

## Owner loop

Feedback that carries **text** is relayed to `SUPPORT_CHAT_ID` immediately - verdict, reason,
the text, clip title and a link. Both surfaces use the existing
`sendTelegramMessage` in `packages/shared/src/services/telegram-notification.service.ts`, so
the web route needs no new channel of its own. Taps without text are
not relayed - twelve clips per job would make that a firehose - and live only in the digest
and the admin page.

The reason is response rate, not convenience. At this user count, one person who sees their
"face off-screen" complaint answered personally, and later fixed, is worth more than any
button mechanic.

## Admin page

A `Feedback` section on `/admin`, fed by new `getFeedbackSummary` / `getFeedbackRows` exports
in `packages/shared/src/services/analytics.service.ts` alongside `getFunnel` and
`getRefusals`, rendered by a `feedback-table.tsx` next to `guests-table.tsx`. It shows the
verdict split with postable rate, a reason histogram, response rate (rated clips over
delivered clips), and the most recent rows with text, each linking to its evidence object.
The existing surface filter (Combined / Telegram / Web) applies.

## Digest for the agent

`packages/shared/scripts/feedback-digest.ts`, run through `docker compose run --no-deps`
against a service that has the shared workspace mounted (the same route the other
`packages/shared` scripts already take; container binaries live under `/app/node_modules/.bin`),
writing
`apps/worker/.corpus/feedback/` (outside git - these rows contain user text): one markdown
report plus `feedback.jsonl`.

Per clip: verdict, reason, note, surface, locale, timestamp, then everything in `snapshot`,
then a presigned URL to `evidenceKey`. **Presigned URLs are generated at run time, not stored
in the report** - a stored link is dead in seven days, a regenerated one always works because
the evidence copy never expires.

Grouped by reason and sorted by count, with a header carrying the verdict split, postable
rate and response rate.

## i18n

Bot copy is six locales (en/ru/uk/es/pt/id) through the existing single dictionary - about ten
strings. Web is English only. Splitting the bot dictionary across locales is not an option;
the registry is shared.

## Testing

- `callback_data` round trip, including an explicit 64-byte assertion.
- Ownership: a forged `clipId` belonging to another user is refused and logged.
- Flag off renders no keyboard; flag off still records an incoming callback.
- Upsert idempotency, and verdict change clearing `reason` while preserving `note`.
- Reply routing: support session wins; a reply to a bot video with an unmatched id is
  swallowed and does **not** reach URL submission; lookup keys on `(userId, messageId)`.
- Because mocked Prisma hides wrong `where`/`select`/`data`, these assert the **shape** of the
  upsert and the lookup, and are mutation-tested before being trusted.
- Bot tests run in the `bot` container; the `web` container holds a stale `apps/bot` copy that
  passes silently.

## Rollout

1. Prisma migration (`migrate deploy` inside the container, not `db push`).
2. `npm run build -w @clipclap/shared`, then rebuild **every** service - the shared barrel is
   eager.
3. `prisma generate` per container after any recreate.
4. `next build` for web, then restart it: web serves `next start` from a named volume, so
   there is no hot reload.
5. Flags into `.env`, then `docker compose up -d` - `restart` ignores `env_file`.

Rollback: unset both flags and `up -d`. Rows and evidence stay; nothing is lost, and no
migration is reversed.

## Availability and expired clips

Feedback is offered on every clip with no time limit, and stays available after the clip's own
retention has passed - a user scrolling back to an old video in Telegram can still answer.
When the object is already gone from R2 the evidence copy simply fails, is logged, and the row
records with `evidenceKey` null. A tap is never refused because the video expired.

## Accepted limitations

- Replies to the job summary message are not attributable to a clip.
- Deliveries whose `message_id` was not parsed have no reply channel; buttons still work.
- `QUALITY` merges our render defects with bad source material, resolved during analysis
  rather than at the tap.
- One verdict per (clip, user), with no history beyond the stdout log.
- At the current user count this system is an instrument for later. The fastest 80% of the
  signal today is the owner writing to each active user personally. Build the buttons; do not
  expect statistics from them this month.
