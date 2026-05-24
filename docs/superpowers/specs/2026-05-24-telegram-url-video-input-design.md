# Telegram Bot - URL-based Video Input

**Date:** 2026-05-24
**Status:** Approved, ready for implementation
**Scope:** Accept video URLs (YouTube, Twitch, TikTok, Twitter, Vimeo and ~1000 other yt-dlp-supported sites) pasted into the bot chat, validate via fast yt-dlp probe, then enqueue the job for normal processing.

## Goal

Today the only way to get a video into the bot is via Telegram attachment. The web app has had URL input from day one - clippers prefer pasting a podcast/stream link over downloading-then-uploading. This brings parity to the bot.

A user who pastes a YouTube link should get clips back the same way they would after uploading the file: bot acknowledges, probes the URL, enqueues a job, and delivers clips when ready.

## Non-goals

- Limiting to a whitelist of platforms. yt-dlp supports ~1000 sites; we delegate platform support entirely to it.
- Live-stream handling. yt-dlp will fail the probe (no fixed duration) and the user gets `urlAccessFailed`.
- Web-side parity changes. The web already accepts URLs - this spec is bot-only.
- Background/queued probing. The probe is a synchronous step on the bot's message-handling thread.
- Caching or rate-limiting URL probes. Per-user rate-limiting and abuse prevention live in `getSubmissionBlocker` (existing).

## Architecture

The worker already downloads via yt-dlp when `Job.sourceUrl` is set (see `apps/worker/src/processors/download.ts`). The bot just needs to detect URLs, run a fast probe, and create a job with `sourceUrl` instead of uploading to R2 first.

```
User text → URL regex → Probe (yt-dlp simulate) → Enqueue job with sourceUrl → Worker downloads + processes → Clips delivered
```

The probe step runs in the bot container, so `yt-dlp` must be installed there too.

## URL detection

Helper `extractVideoUrl(text: string): string | null`:
- Finds the first `https?://\S+` token in the message
- Returns it as-is (no normalization)
- Returns `null` if no http(s) URL found

Examples:
- `"https://youtube.com/watch?v=abc"` → `"https://youtube.com/watch?v=abc"`
- `"check this out https://twitch.tv/videos/123 lol"` → `"https://twitch.tv/videos/123"`
- `"ftp://example.com/file.mp4"` → `null`
- `"hello world"` → `null`

## URL probe

Helper `probeVideoUrl(url: string, timeoutMs = 10_000): Promise<ProbeResult>`:

```ts
type ProbeResult =
  | { ok: true; durationSec: number; title: string }
  | { ok: false; reason: "timeout" | "yt-dlp-error" | "no-duration" };
```

Implementation:
- Spawns `yt-dlp` with args:
  ```
  --simulate
  --no-playlist
  --print "%(duration)s||%(title)s"
  --socket-timeout 10
  <url>
  ```
- Wraps the `execFile` Promise in a `Promise.race` with a `setTimeout(timeoutMs)` reject.
- On success: parse the single line of stdout, split by `||`, return `{ ok: true, durationSec, title }`.
- On `NaN` duration (e.g. live stream returns `NA`): `{ ok: false, reason: "no-duration" }`.
- On execFile error (non-zero exit, killed): `{ ok: false, reason: "yt-dlp-error" }`.
- On timer fire: `{ ok: false, reason: "timeout" }` and kill the child process.

The 10 s budget is a balance - most YouTube/Twitch probes return in 1–3 s. Network blips can push it to 5–8 s. Anything past 10 s feels broken to the user.

## Handler flow

In `handleUpdate` (after slash-command checks, after menu-action checks, before `getVideoSource`):

```
const url = extractVideoUrl(text)
if url:
  await handleVideoUrl(client, message, from, url, dict, config)
  return
```

`handleVideoUrl(client, message, from, url, dict, config)`:

1. `client.sendMessage(chatId, dict.checkingLink)` - acknowledge so the user sees the bot is doing something.
2. `const probe = await probeVideoUrl(url)`.
3. If `!probe.ok` - `client.sendMessage(chatId, dict.urlAccessFailed)` and return.
4. Resolve user via `resolveTelegramUser(from)`.
5. Run `getSubmissionBlocker(user.id, probe.durationSec)` - same path as the file flow. If blocked, send `dict.blocked(reason, appUrl)` and return.
6. `await jobService.createJob({ userId: user.id, sourceUrl: url, originalFilename: probe.title, subtitles: true, subtitlePreset: "tiktok", sourceDurationSec: probe.durationSec })`.
7. `await createTelegramDelivery({ jobId: job.id, userId: user.id, chatId: String(chatId) })`.
8. `client.sendMessage(chatId, dict.queued)`.

No upload-to-R2 step - the worker pulls directly from the URL.

## i18n additions

Add to `Dict`:
- `checkingLink: string`
- `urlAccessFailed: string`

EN:
- `checkingLink: "Checking link…"`
- `urlAccessFailed: "Couldn't access the video at that link. Try a different URL or upload the file directly."`

RU:
- `checkingLink: "Проверяю ссылку…"`
- `urlAccessFailed: "Не удалось получить видео по этой ссылке. Попробуй другую ссылку или загрузи файл напрямую."`

`/help` text is also extended to mention URL support - one extra line in both locales.

## Dockerfile change

`apps/bot/Dockerfile`, base stage - same install line as the worker:

```dockerfile
RUN apk add --no-cache openssl python3 py3-pip
RUN pip3 install --break-system-packages yt-dlp
```

(No `ffmpeg` - probe doesn't need it; the worker keeps its `ffmpeg` install for the rendering pipeline.)

## Error handling

| Case | User-facing outcome |
|---|---|
| Probe times out (>10 s) | `urlAccessFailed` |
| yt-dlp exits non-zero (unsupported platform, private, geo-blocked, DRM, deleted, paywall) | `urlAccessFailed` |
| yt-dlp returns NA duration (live stream) | `urlAccessFailed` |
| Duration exceeds plan's `maxSourceDurationMinutes` | existing `blocked()` with reason - same as upload path |
| Subscription blocker (NONE plan, DUNNING, daily-limit, concurrent-limit) | existing `blocked()` reason - same as upload path |
| URL detected but malformed (e.g. `https://` with no host) | yt-dlp errors → `urlAccessFailed` |
| Text has no URL | unchanged: existing `sendVideoHint` fallback |

The probe call is the only synchronous network egress the bot makes for this flow. If yt-dlp itself is missing from the container (deployment failure), `execFile` rejects with `ENOENT` → reason `"yt-dlp-error"` → user sees `urlAccessFailed`. Not friendly, but not catastrophic.

## Testing

`apps/bot/src/__tests__/extract-video-url.test.ts`:
- Returns URL for `https://youtube.com/...`
- Returns URL for embedded `"text https://... text"`
- Returns the FIRST URL when two are present
- Returns `null` for plain text, for `ftp://`, for `"https"` without scheme separator
- Trims trailing punctuation that isn't part of the URL (TBD: keep simple for v1 - accept any `\S+` even with trailing dots; yt-dlp handles minor pollution)

`apps/bot/src/__tests__/url-probe.test.ts`:
- Mock `execFile` (via `vi.mock("child_process")`) to return stdout `"3661||Test Video"` → assert `{ ok: true, durationSec: 3661, title: "Test Video" }`
- Mock to throw → `{ ok: false, reason: "yt-dlp-error" }`
- Mock to return `"NA||Live now"` → `{ ok: false, reason: "no-duration" }`
- Use `vi.useFakeTimers()` to test the timeout path - fire setTimeout, assert `{ ok: false, reason: "timeout" }` and that the child process was killed

`apps/bot/src/__tests__/i18n.test.ts` (extend):
- `t("en").checkingLink` and `t("ru").checkingLink` are non-empty
- `t("en").urlAccessFailed` and `t("ru").urlAccessFailed` are non-empty

No integration test for the full handler flow (DB + Telegram). Existing pattern in the bot's tests is pure-function only.

## Out of scope (deferred)

- Showing probe-extracted title in the "queued" message - UX nicety, not required for MVP.
- Caching probe results (same URL submitted twice in a row probes twice).
- Bot Telegram command `/url <link>` as an explicit alternative - paste-and-go is the natural UX.
- Web-side URL improvements.
- Telegram inline mode (`@clipclapbot https://...`).
