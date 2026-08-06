# Telegram clip delivery: upload the file, and let one bad clip cost only itself

**Status:** design, approved to write 2026-08-06. No implementation yet.

**One sentence.** Clips are handed to Telegram as a presigned R2 URL, which Telegram refuses above
20,000,000 bytes, and the send loop has no per-clip catch - so one oversized clip took ten deliverable ones
down with it.

---

## 1. The defect, measured

Job `cmshc1olm000le3zk8f2etco2` (12 clips). The user received one clip and the line
"Отправил 1 из 12 клипов". `telegram_deliveries.error` carried Telegram's own words:

```
Bad Request: failed to get HTTP URL content
```

`handlers.ts:1322` signs a presigned R2 URL per clip and `:1333` passes it as the `video` argument of
`sendVideo`. Telegram caps a URL fetch at **20,000,000 bytes - decimal, not MiB**. Exact byte counts, in
delivery order:

| # | bytes | over 20e6 | outcome |
|---|---|---|---|
| 1 | 10,975,067 | no | delivered |
| 2 | **20,557,490** | **yes** | threw, aborted the loop |
| 3 | 13,282,420 | no | never attempted |

Clip 2 is 19.61 **MiB**. It reads as "under 20" and is not. Counting bytes rather than trusting the unit is
what turned this from a mystery into a one-line diagnosis.

**Ruled out empirically, so nobody re-tests them:** R2 serves every clip (ranged GET, 206, 3.3-36.1 MB); the
`telegram-bot-api` container resolves DNS, reaches R2 and Telegram on 443, and `wget`s the very same
presigned URL to completion (200, 10.9 MB); the presigned TTL is 3600s against a loop that takes a minute.
Three other deliveries the same morning succeeded - one of them also 12 clips, whose largest was 15.3 MB and
none of which exceeded 20e6.

**Measurement trap.** A HEAD request against a presigned GET URL returns **403** - the signature covers the
method. The first size measurement returned 403 on all twelve and looked like "the files are gone". Measure
with a ranged GET (`Range: bytes=0-0`) and read `content-range`.

**Two defects, and the second is the expensive one.**

1. Clips over 20e6 bytes cannot be sent by URL at all.
2. `for (const video of videos) { await client.sendVideo(...) }` has no per-clip catch. The first failure
   throws and every later clip - all under the limit, all deliverable - is never attempted.

---

## 2. What this is, and what it is not

**Is:** a transport change (URL -> multipart upload), a per-clip catch, a per-clip delivered marker, a
resend button, and the removal of two copy strings that leak the web dashboard to bot users.

**Is not:**

- not a change to which clips are produced, their order, or their captions
- not a re-encode to shrink clips (considered and rejected in section 3)
- not a new delivery queue, poller, or attempt budget - the existing ones are reused unchanged
- not a change to web delivery, which does not go through this path

---

## 3. Approaches considered

**A. Multipart upload from the bot - CHOSEN.** The bot fetches the clip from R2 and posts it to the local
Bot API server as `multipart/form-data`. The server runs with `TELEGRAM_LOCAL=1` (docker-compose.yml:127) and
in local mode accepts uploads up to **2000 MB**; the 20 MB cap lives only on the URL-fetch path. No compose
change, no new volume. Cost: bytes travel R2 -> bot -> API server instead of R2 -> API server, one extra hop
on the local docker network.

**B. Shared volume and a local file path.** In local mode the server also accepts an absolute path and reads
the file itself - no HTTP upload at all, the cheapest option at runtime. Rejected: it needs a new writable
shared volume (`telegram-bot-api-data` is mounted `:ro` into the bot today) and requires both containers to
agree on one path. A mismatch fails silently as "file not found", and this project already carries a
documented scar from per-container file-visibility differences. Not worth it to save one local hop.

**C. Re-encode so nothing exceeds 20 MB.** No delivery change at all. Rejected: 90 seconds of 1080p inside
20 MB is about 1.8 Mbit/s and visibly worse, and it would degrade exactly the long, detailed clips this
product exists to produce. Fixing delivery by damaging the product is the wrong trade.

**One code path, not two.** Keeping URLs for clips under 20 MB and multipart above was considered and
rejected: the rare branch would be the one that breaks and the one nobody exercises. Every clip goes through
the path we test.

---

## 4. Transport

A second low-level method on `TelegramClient`, beside `request()`, because that one is hard-wired to
`Content-Type: application/json` (telegram-client.ts:220):

- `requestMultipart(method, fields, file)` - posts `multipart/form-data`.
- `sendVideoUpload(chatId, source, caption)` - built on it, replacing the `sendVideo(chatId, url, ...)` call
  in the delivery loop.

**Memory, bounded by measurement rather than by assumption.** `FormData` + `Blob` in Node reads the whole
file into memory, which raised the question of how many uploads can overlap. Checked rather than guessed:
`deliverReadyTelegramJobs` iterates rows with `for (const delivery of deliveries)` and awaits inside, and the
poller sleeps 10s between passes (apps/bot/src/index.ts:71) - so **exactly one upload is ever in flight**.
Resident memory is therefore one clip, and one clip is bounded by `CLIP_MAX_SEC` (90s), with 36 MB the
largest yet observed.

Buffering one clip is acceptable. The requirement this places on the implementation is narrow and worth
stating because it is easy to violate later: **do not make the send loop concurrent** - not across rows, not
across clips within a row. If a future change wants parallel delivery, the buffering has to become streaming
first. A temp file, if used, is removed in `finally`, matching how `assPath` and clip cuts are already
handled in the render stage.

**One upload at a time is not a size bound, and `CLIP_MAX_SEC` is not one either.** 90 seconds caps duration;
the encoder is CRF-based (libx264, CRF 23), so bytes per second are set by the content and nothing caps them.
"36 MB is the largest observed" is a fact about history, not a limit - a bitrate, codec, resolution or
source-quality change moves it silently, and a delivery worker that OOMs is a worse failure than the one this
spec repairs.

So the bound is explicit: **`TELEGRAM_UPLOAD_MAX_BYTES`, checked against R2's `content-length` BEFORE any
bytes are read.** Over it, the clip is a clip-level permanent failure (section 6) - reported, not retried,
and never buffered. The value is a deployment knob rather than a law of nature; it needs to be comfortably
above real clips and comfortably below what the bot container can hold. It is the one number in this design
that should be revisited if clip encoding changes.

---

## 5. Per-clip state

`Clip` gains one nullable column: **`telegramFileId String?`**. Non-null means the clip is in the chat.

It is a marker and a capability at once: Telegram returns a `file_id` for every uploaded file, and re-sending
by `file_id` is instant and costs no bandwidth. The column is therefore worth having even if nothing ever
fails.

The delivery loop becomes:

1. Load the job's clips, skip every clip that already has a `telegramFileId`.
2. Send each remaining clip inside **its own try/catch**. On success, persist the returned `file_id`. On
   failure, leave it null and continue to the next clip.
3. After the loop: all clips marked -> settle `DELIVERED`. Any clip unmarked -> the row is not done; the
   existing `markTelegramDeliveryAttemptFailed` path applies and the next poll retries **only the missing
   ones**.

### The guarantee, stated honestly: at-least-once, not exactly-once

An earlier draft of this section claimed duplicates become "structurally impossible". That is wrong and the
claim is withdrawn. The send and the write cannot be atomic: Telegram offers no idempotency key, so there is
always a window where

```
Telegram accepted the upload and put the clip in the chat
  -> the process dies, or Postgres is briefly unreachable
  -> telegramFileId was never written
  -> the next poll sees an unmarked clip and sends it again
```

A timeout is the same hazard from the other side: the request may have reached Telegram and delivered the
clip while the client never saw the `file_id`.

What `telegramFileId` actually buys is this, and it is still most of the value: **duplicates are eliminated
for every ordinary retry, i.e. every case where the previous attempt's outcome was recorded.** Today that
number is zero, because a partially delivered row is simply abandoned. Crash and timeout windows remain, and
are handled by policy in section 6 rather than pretended away.

Today's `clipsInChat > 0` branch - which makes a partially delivered row terminal - is deleted as part of
this work. It exists to guard a hazard that the marker reduces from "certain on every retry" to "possible
across a crash boundary", and the cost of keeping it is the defect this spec exists to fix.

### Why the marker belongs on `Clip`, proven rather than assumed

A per-clip marker is only correct if a clip has exactly one delivery destination. That was checked against
the schema, not assumed:

- `TelegramDelivery.jobId` is **`@unique`** (prisma/schema.prisma:482) - at most one delivery row per job.
- The row is created with `prisma.telegramDelivery.create`, never upserted, and `chatId` is written once at
  creation and updated nowhere.
- A `Clip` belongs to exactly one `Job`.

So clip -> job -> one delivery row -> one chat is closed, and `telegramFileId` cannot mean "sent somewhere,
once". A separate `TelegramDeliveryClip` table would carry the same information with an extra join.

**The invariant this rests on, written down so breaking it is a decision rather than an accident:** a clip is
delivered to exactly one chat, by one bot token. If the product ever grows multi-chat delivery, forwarding to
a second recipient, or re-delivery after a chat id change, this column silently starts meaning the wrong
thing, and the state must move to a delivery-item row keyed by `(deliveryId, clipId, chatId)`.

**The summary is sent only when the row settles.** Without that, every poll that retried a missing clip would
drop another "Готово" into the chat. While retries are in flight the progress board stays up; that is what it
is for.

---

## 6. Which failures retry

"Not a chat error, therefore retry twelve times" is too coarse. Four cases, and they behave differently:

| Case | Example | Behaviour |
|---|---|---|
| **Chat-level permanent** | bot blocked, chat deleted | Rethrow. The row-level handler retires the delivery at once, as today. Retrying is futile and each attempt is charged against the bot's global rate limit. |
| **Clip-level permanent** | corrupt media, unsupported container, over `TELEGRAM_UPLOAD_MAX_BYTES` | Do not retry this clip. Mark it failed, keep sending the others, and count it in the final summary. Twelve doomed uploads of the same broken file help nobody. |
| **Transient** | 429, R2 5xx, Postgres pool timeout | Leave the clip unmarked and continue. The next poll retries only it, inside the existing budget. |
| **Ambiguous** | timeout or connection reset after the request was sent | Retry, log distinctly, accept a possible duplicate. See below. |

**Distinguishing them is mechanical, not a guess.** If a Telegram error response was parsed, Telegram saw the
request and rejected it, so the clip is definitely not in the chat and retrying is safe. If no response was
ever received - timeout, socket error - the send may have landed. That is the ambiguous case, and the client
knows which of the two happened by whether it got a payload.

**Policy for the ambiguous case: retry, and accept the duplicate risk.** A duplicated clip is an annoyance;
a silently missing clip is content the user paid minutes for and never receives. Given that, the failure
direction is chosen deliberately toward duplication. Ambiguous sends get their own log line so the rate is
observable rather than assumed - if it turns out to be common, the trade can be revisited with numbers.

A clip-level permanent failure needs its own marker so the loop does not retry it and the summary can count
it. `telegramFileId` alone cannot express "tried and impossible" - a nullable `telegramSendError String?`
alongside it is enough, and keeps the two states distinguishable without a second table.

The existing budget is unchanged: 12 attempts at a 10s poll, about two minutes, sized against 429 backoff,
Postgres failover and R2 5xx bursts. It was never the problem - the problem was that a partial delivery could
not be retried at all.

---

## 7. The resend button

Attached to the partial summary as an **inline keyboard** (`InlineKeyboardMarkup`), one button, callback data
`resend:<jobId>`, dispatched by prefix beside the existing `sub:` and `lang:` handlers
(handlers.ts:1614).

Inline and not a reply keyboard, for two reasons. The button must know *which* job to resend, and only
`callback_data` carries that - a reply keyboard is global to the chat and cannot tell two in-flight videos
apart. And the reply keyboard already holds the main menu; adding failure buttons there would either
overwrite it or accumulate debris.

The handler does exactly one thing: verify the job belongs to this user, then return the delivery row to
`PENDING` with `attempts = 0`. Everything else follows from section 5 - the poller picks it up, the loop skips
delivered clips, the rest go out. **The button re-arms the existing path; it does not add a second one.**

---

## 8. Copy

Two strings currently point bot users at a web dashboard the owner deliberately hides from them:

- `donePartial` - "All N are ready in your dashboard" / "Все N готовы в личном кабинете".
- `deliveryGivenUp` - prints `{url}/dashboard` outright. The worse leak of the two.

Both are rewritten to name no dashboard. `donePartial` states the count and carries the button.
`deliveryGivenUp` keeps the warning it already carries and must not lose - *do not resend this video, a second
run bills your minutes twice* - and replaces "go and look" with the button.

Six locales: en, ru, uk, es, pt, id.

**Known limitation, recorded rather than solved:** these strings are shared, and the web surface does not hide
its dashboard. Removing the mention costs web users a useful pointer. Splitting the copy per surface is a
separate change and is deliberately out of scope here.

---

## 8a. Rollout: what happens to deliveries that predate the column

Every existing clip has `telegramFileId = NULL`, including clips that are already sitting in someone's chat.
"Skip clips that carry a file id" therefore says nothing useful about them, and re-sending such a row would
duplicate whatever landed before the migration.

**Measured, so the policy can be exact instead of defensive.** The whole table is 16 `DELIVERED`,
1 `FAILURE_NOTIFIED` and **2 `FAILED`** rows. Both failures are this same defect - `cmshc1olm000le3zk8f2etco2`
from today and `cmrv9t0x5000y9pvweq9c8j78` from 2026-07-21, which means this bug has been live since at least
July and was simply never diagnosed.

**The rows cannot resurrect themselves.** `getPendingTelegramDeliveries` selects only `PENDING` (with the job
`DONE`/`FAILED`) and `FAILURE_NOTIFIED` (with the job `DONE`). `FAILED` appears in neither, so no poll will
ever pick these two up. Nothing needs to be done to make the rollout safe.

The policy is therefore one rule: **the resend button is only ever attached to summaries sent by the new
code.** Legacy `FAILED` rows stay terminal and carry no button, so no user action can re-arm them.

Re-arming one by hand remains possible and is the only path to a duplicate. For the two rows above we know
the risk exactly - `cmshc1olm000le3zk8f2etco2` has one clip already in its chat, so a manual resend duplicates
one clip and recovers eleven. That is a judgement call for whoever runs it, not something the code should
decide silently; the count is recorded here so the call can be made with the number in hand.

---

## 9. Testing

Bot tests run in the `bot` container and mock HTTP, so everything below is testable except a real upload.

- **Transport:** `sendVideoUpload` posts multipart, not JSON, and the body carries the file. Mutation-tested:
  reverting the call to a URL send must fail the test.
- **Partial failure - today's exact case:** of 12 clips the second throws; the other 11 are still sent, they
  carry a `file_id`, and the failed one does not.
- **No duplicates on an ordinary retry:** a second pass over the same row sends only the clip lacking a
  `file_id` and re-sends nothing. This is the guarantee section 5 actually claims - the crash window is not
  testable here and is not claimed.
- **Error classification:** a parsed Telegram rejection, a network timeout, an over-cap clip and a blocked
  bot each take their own branch from section 6, and the over-cap clip is refused *before* its bytes are
  read.
- **Clip-level permanent failure:** a clip marked with `telegramSendError` is not retried on the next pass
  and is counted in the summary.
- **Chat-level error:** a blocked bot propagates out of the loop and retires the row at once, rather than
  attempting eleven more doomed sends.
- **Summary once:** while the row is unsettled, no "Готово" is sent.
- **Button:** a callback for another user's job is refused; the owner's returns the row to `PENDING` with
  `attempts = 0`.
- **Sequential sends:** the loop sends one clip at a time, asserted so a future edit cannot quietly make it
  concurrent while the body is still buffered whole (section 4).

**Live check after deploy:** re-run a real job containing the 36 MB clip that produced this defect. Passing
tests are not the acceptance criterion; that clip arriving in the chat is.

---

## 10. Priority note, recorded honestly

The job that exposed this was the owner's own, not a customer's. Over the preceding days six people received
clips and none returned. This work is still correct - a clip that does not arrive is worth zero, and the
failure mode is silent and total - but by lost users the running cost of this bug is zero, while "people do
not come back for their clips" stands at six. Recorded so the next session can weigh the two without
re-deriving the numbers.
