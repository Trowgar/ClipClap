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

**Duplicates become structurally impossible**, which is the point. Today's code makes a partially delivered
row terminal (`clipsInChat > 0`) precisely because a re-pickup would repeat clips already in the chat. That
branch is deleted as part of this work - it exists only to guard a hazard this design removes.

**The summary is sent only when the row settles.** Without that, every poll that retried a missing clip would
drop another "Готово" into the chat. While retries are in flight the progress board stays up; that is what it
is for.

---

## 6. Which failures retry

Inside the per-clip catch:

- An error **about the chat** - bot blocked, chat deleted, i.e. the existing `isPermanentTelegramError` - is
  not about this clip. Rethrow it. The row-level handler retires the delivery immediately, as it does today.
  Retrying is futile and each attempt is charged against the bot's global rate limit.
- Any other error: log it, leave the clip unmarked, continue.

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

## 9. Testing

Bot tests run in the `bot` container and mock HTTP, so everything below is testable except a real upload.

- **Transport:** `sendVideoUpload` posts multipart, not JSON, and the body carries the file. Mutation-tested:
  reverting the call to a URL send must fail the test.
- **Partial failure - today's exact case:** of 12 clips the second throws; the other 11 are still sent, they
  carry a `file_id`, and the failed one does not.
- **No duplicates:** a second pass over the same row sends only the clip lacking a `file_id` and re-sends
  nothing.
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
