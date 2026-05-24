# Telegram Bot URL Video Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept video URLs pasted into the Telegram chat, validate them via a fast `yt-dlp --simulate` probe, then enqueue them for processing using the existing `Job.sourceUrl` pipeline.

**Architecture:** Add a URL detection regex + a synchronous `yt-dlp` probe step before enqueueing. The bot Docker image gains `yt-dlp` (already installed in the worker). The worker side is unchanged — it already pulls from `sourceUrl` via `yt-dlp`.

**Tech Stack:** TypeScript, yt-dlp (Python CLI), Vitest, child_process.

**Spec:** [docs/superpowers/specs/2026-05-24-telegram-url-video-input-design.md](../specs/2026-05-24-telegram-url-video-input-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `apps/bot/Dockerfile` | modify | Install python3 + pip + yt-dlp in the base stage. |
| `apps/bot/src/url-probe.ts` | create | `extractVideoUrl(text)` regex helper, `probeVideoUrl(url, timeoutMs)` execFile wrapper with timeout. |
| `apps/bot/src/handlers.ts` | modify | New `handleVideoUrl(...)` function; wire URL detection into `handleUpdate` flow before the no-video-source fallback. |
| `apps/bot/src/i18n.ts` | modify | Add `checkingLink` + `urlAccessFailed` to `Dict` with EN+RU values; mention URL support in `helpText`. |
| `apps/bot/src/__tests__/url-probe.test.ts` | create | Unit tests for `extractVideoUrl` regex (5+ cases) and `probeVideoUrl` (mocked execFile — success, error, no-duration, timeout). |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | Assert new strings are non-empty per locale and helpText mentions URL. |

---

## Task 1: i18n strings (`checkingLink`, `urlAccessFailed`, helpText line)

**Files:**
- Modify: `apps/bot/src/i18n.ts`
- Test: `apps/bot/src/__tests__/i18n.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/bot/src/__tests__/i18n.test.ts`, append before the closing `});` of the `describe("bot i18n", ...)` block:

```ts
it("exposes checkingLink in both locales", () => {
  expect(t("en").checkingLink).toBe("Checking link…");
  expect(t("ru").checkingLink).toBe("Проверяю ссылку…");
});

it("exposes urlAccessFailed with platform-agnostic fallback hint in both locales", () => {
  expect(t("en").urlAccessFailed).toContain("Couldn't access");
  expect(t("en").urlAccessFailed).toContain("upload");
  expect(t("ru").urlAccessFailed).toContain("Не удалось");
  expect(t("ru").urlAccessFailed).toContain("загрузи");
});

it("helpText mentions URL support in both locales", () => {
  expect(t("en").helpText("https://clipclap.io").toLowerCase()).toContain("url");
  expect(t("ru").helpText("https://clipclap.io").toLowerCase()).toContain("ссылк");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `/srv/saas/clipclap.io`:
`npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: 3 new tests fail with `t("en").checkingLink is undefined` etc., and helpText test fails because URL isn't mentioned yet.

- [ ] **Step 3: Add the two new fields to `Dict`**

In `apps/bot/src/i18n.ts`, add to the `Dict` interface (placement doesn't matter — append at end is fine):

```ts
  checkingLink: string;
  urlAccessFailed: string;
```

- [ ] **Step 4: Add EN values + extend helpText**

In `apps/bot/src/i18n.ts`, inside `const en: Dict = { ... }`, add:

```ts
  checkingLink: "Checking link…",
  urlAccessFailed:
    "Couldn't access the video at that link. Try a different URL or upload the file directly.",
```

And REPLACE the existing `helpText` in the `en` dict with:

```ts
  helpText: (url) =>
    `Send me a video — I'll cut it into vertical clips with subtitles.\nYou can also paste a URL (YouTube, Twitch, TikTok, Vimeo, X and more).\n\nLimits: up to 3 hours source, up to 2 GB file size.\n\nCommands:\n• /start — main menu\n• /link — connect an existing clipclap.io account\n• /lang en|ru|auto — switch language\n\nWebsite: ${url}/dashboard`,
```

- [ ] **Step 5: Add RU values + extend helpText**

In `apps/bot/src/i18n.ts`, inside `const ru: Dict = { ... }`, add:

```ts
  checkingLink: "Проверяю ссылку…",
  urlAccessFailed:
    "Не удалось получить видео по этой ссылке. Попробуй другую ссылку или загрузи файл напрямую.",
```

And REPLACE the existing `helpText` in the `ru` dict with:

```ts
  helpText: (url) =>
    `Пришли видео — нарежу вертикальные клипы с субтитрами.\nМожно также прислать ссылку (YouTube, Twitch, TikTok, Vimeo, X и др.).\n\nЛимиты: до 3 часов исходник, до 2 ГБ размер файла.\n\nКоманды:\n• /start — главное меню\n• /link — привязать существующий аккаунт clipclap.io\n• /lang en|ru|auto — сменить язык\n\nСайт: ${url}/dashboard`,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w @clipfast/bot`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/__tests__/i18n.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): add checkingLink + urlAccessFailed i18n; mention URL input in /help"
```

---

## Task 2: `url-probe.ts` — extractor + yt-dlp probe

**Files:**
- Create: `apps/bot/src/url-probe.ts`
- Test: `apps/bot/src/__tests__/url-probe.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/__tests__/url-probe.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { extractVideoUrl, probeVideoUrl } from "../url-probe";

describe("extractVideoUrl", () => {
  it("returns a clean https URL", () => {
    expect(extractVideoUrl("https://youtube.com/watch?v=abc")).toBe(
      "https://youtube.com/watch?v=abc"
    );
  });

  it("returns a clean http URL", () => {
    expect(extractVideoUrl("http://example.com/v.mp4")).toBe(
      "http://example.com/v.mp4"
    );
  });

  it("finds a URL embedded in surrounding text", () => {
    expect(
      extractVideoUrl("check this out https://twitch.tv/videos/123 lol")
    ).toBe("https://twitch.tv/videos/123");
  });

  it("returns the first URL when two are present", () => {
    expect(
      extractVideoUrl("https://a.com/1 and https://b.com/2")
    ).toBe("https://a.com/1");
  });

  it("returns null for non-http schemes", () => {
    expect(extractVideoUrl("ftp://example.com/file.mp4")).toBeNull();
    expect(extractVideoUrl("magnet:?xt=...")).toBeNull();
  });

  it("returns null for plain text without URLs", () => {
    expect(extractVideoUrl("hello world")).toBeNull();
    expect(extractVideoUrl("")).toBeNull();
    expect(extractVideoUrl("just talking about https")).toBeNull();
  });
});

describe("probeVideoUrl", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns durationSec and title on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "3661||Test Video Title\n", "");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://youtube.com/abc");
    expect(result).toEqual({
      ok: true,
      durationSec: 3661,
      title: "Test Video Title",
    });
  });

  it("returns ok=false with reason 'yt-dlp-error' on non-zero exit", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(new Error("exit code 1"), "", "ERROR: unavailable\n");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://invalid.example/x");
    expect(result).toEqual({ ok: false, reason: "yt-dlp-error" });
  });

  it("returns ok=false with reason 'no-duration' when duration is NA", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "NA||Live Stream\n", "");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://twitch.tv/live/x");
    expect(result).toEqual({ ok: false, reason: "no-duration" });
  });

  it("returns ok=false with reason 'no-duration' when stdout is empty", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return { kill: vi.fn() } as never;
    });
    const result = await probeVideoUrl("https://example.com/x");
    expect(result).toEqual({ ok: false, reason: "no-duration" });
  });

  it("returns ok=false with reason 'timeout' when probe exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    const killSpy = vi.fn();
    execFileMock.mockImplementation((_cmd, _args, _opts, _cb: any) => {
      // Never invoke callback — simulates a hung process
      return { kill: killSpy } as never;
    });

    const resultPromise = probeVideoUrl("https://slow.example/x", 100);
    await vi.advanceTimersByTimeAsync(150);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(killSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/bot/src/__tests__/url-probe.test.ts`
Expected: Module not found — `../url-probe` doesn't exist yet.

- [ ] **Step 3: Create `url-probe.ts`**

Create `apps/bot/src/url-probe.ts`:

```ts
import { execFile } from "child_process";
import type { ChildProcess } from "child_process";

export function extractVideoUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : null;
}

export type ProbeResult =
  | { ok: true; durationSec: number; title: string }
  | { ok: false; reason: "timeout" | "yt-dlp-error" | "no-duration" };

export function probeVideoUrl(
  url: string,
  timeoutMs = 10_000
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child: ChildProcess = execFile(
      "yt-dlp",
      [
        "--simulate",
        "--no-playlist",
        "--print",
        "%(duration)s||%(title)s",
        "--socket-timeout",
        "10",
        url,
      ],
      { timeout: timeoutMs + 1000 },
      (err, stdout) => {
        if (err) {
          finish({ ok: false, reason: "yt-dlp-error" });
          return;
        }
        const line = stdout.split("\n").find((l) => l.trim().length > 0);
        if (!line) {
          finish({ ok: false, reason: "no-duration" });
          return;
        }
        const [durRaw, ...titleParts] = line.split("||");
        const durationSec = Number(durRaw);
        if (!Number.isFinite(durationSec) || durationSec <= 0) {
          finish({ ok: false, reason: "no-duration" });
          return;
        }
        finish({
          ok: true,
          durationSec,
          title: titleParts.join("||").trim() || "Untitled",
        });
      }
    );

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/bot/src/__tests__/url-probe.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @clipfast/bot`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/url-probe.ts apps/bot/src/__tests__/url-probe.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): add extractVideoUrl + probeVideoUrl via yt-dlp simulate"
```

---

## Task 3: Handler — wire URL detection into `handleUpdate`

**Files:**
- Modify: `apps/bot/src/handlers.ts`

- [ ] **Step 1: Add import**

In `apps/bot/src/handlers.ts`, add this import alongside the others:

```ts
import { extractVideoUrl, probeVideoUrl } from "./url-probe";
```

- [ ] **Step 2: Wire URL detection in `handleUpdate`**

In `apps/bot/src/handlers.ts`, find the existing fall-through logic in `handleUpdate` (around line 151):

```ts
  const source = getVideoSource(message);
  if (!source) {
    await client.sendMessage(message.chat.id, dict.sendVideoHint);
    return;
  }

  await handleVideo(client, message, from, source, dict, config);
}
```

Replace it with:

```ts
  const source = getVideoSource(message);
  if (source) {
    await handleVideo(client, message, from, source, dict, config);
    return;
  }

  const url = extractVideoUrl(text);
  if (url) {
    await handleVideoUrl(client, message, from, url, dict, config);
    return;
  }

  await client.sendMessage(message.chat.id, dict.sendVideoHint);
}
```

- [ ] **Step 3: Add `handleVideoUrl` function**

In `apps/bot/src/handlers.ts`, add this function. Place it just below the existing `handleVideo` function:

```ts
async function handleVideoUrl(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  url: string,
  dict: Dict,
  config: BotRuntimeConfig
) {
  await client.sendMessage(message.chat.id, dict.checkingLink);

  const probe = await probeVideoUrl(url);
  if (!probe.ok) {
    await client.sendMessage(message.chat.id, dict.urlAccessFailed);
    return;
  }

  const user = await resolveTelegramUser(from);
  const blockedReason = await getSubmissionBlocker(user.id, probe.durationSec);
  if (blockedReason) {
    await client.sendMessage(
      message.chat.id,
      dict.blocked(blockedReason, config.appUrl)
    );
    return;
  }

  const job = await jobService.createJob({
    userId: user.id,
    sourceUrl: url,
    originalFilename: probe.title,
    subtitles: true,
    subtitlePreset: "tiktok",
    sourceDurationSec: probe.durationSec,
  });

  await createTelegramDelivery({
    jobId: job.id,
    userId: user.id,
    chatId: String(message.chat.id),
  });

  await client.sendMessage(message.chat.id, dict.queued);
}
```

- [ ] **Step 4: Typecheck + full test run**

Run from repo root:
```
npm run typecheck -w @clipfast/bot && npx vitest run apps/bot/src/__tests__/
```
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/handlers.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): accept video URLs — probe via yt-dlp and enqueue with sourceUrl"
```

---

## Task 4: Dockerfile — install yt-dlp in bot container

**Files:**
- Modify: `apps/bot/Dockerfile`

- [ ] **Step 1: Add yt-dlp install to the base stage**

Find the base stage at the top of `apps/bot/Dockerfile`:

```dockerfile
# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl
```

Replace with:

```dockerfile
# --- Base ---
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl python3 py3-pip
RUN pip3 install --break-system-packages yt-dlp
```

(Same approach as `apps/worker/Dockerfile`. No `ffmpeg` — probe-only doesn't need it.)

- [ ] **Step 2: Rebuild the bot container**

Run from repo root:
```
docker compose up -d --build bot
```
Expected: image builds successfully (yt-dlp install adds ~5 s + ~50 MB), container starts, logs show `Bot profile sync complete (en, ru)`.

- [ ] **Step 3: Verify yt-dlp is callable inside the running container**

```
docker compose exec bot yt-dlp --version
```
Expected: prints a version number (e.g., `2024.x.x`).

- [ ] **Step 4: Commit**

```bash
git add apps/bot/Dockerfile
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "build(bot): install yt-dlp in container for URL probe"
```

---

## Task 5: Manual verification

**No new code.** Smoke test in Telegram.

- [ ] **Step 1: Send a YouTube URL**

In Telegram, paste a YouTube video URL (e.g., a short clip). Expect:
- Bot replies "Checking link…" / "Проверяю ссылку…"
- Within ~1–5 seconds: "Queued. I'll send the clips back here when rendering finishes."
- Eventually clips arrive (full pipeline test).

- [ ] **Step 2: Send a bad URL**

Send `https://example.com/no-video-here`. Expect: "Couldn't access the video at that link. Try a different URL or upload the file directly."

- [ ] **Step 3: Send plain text**

Send `hello bot`. Expect: existing `sendVideoHint` ("Send me a video and I'll turn it into vertical clips. Use /start to get going.")

- [ ] **Step 4: Send a Twitch VOD URL**

Send a Twitch VOD URL (e.g., `https://www.twitch.tv/videos/...`). Expect: same flow as YouTube — works because yt-dlp supports Twitch.

- [ ] **Step 5: Send a very long URL (over 3 h)**

Send a 4-hour YouTube video URL. Expect: the existing `blocked()` message with "Source exceeds max duration (180 min)".

- [ ] **Step 6: Confirm regressions**

- Attached video upload still works as before.
- /start, 📊 Account, ❓ Help, ⚙️ Settings behavior unchanged.

---

## Self-review notes

**Spec coverage:**
- "URL detection" → Task 2 (`extractVideoUrl`).
- "URL probe" → Task 2 (`probeVideoUrl`).
- "Handler flow" → Task 3 (`handleVideoUrl`).
- "i18n additions" → Task 1.
- "Dockerfile change" → Task 4.
- "Testing" — extract URL + probe (Task 2), i18n strings (Task 1).
- "Error handling" — `probeVideoUrl` reasons map directly to `urlAccessFailed`; duration limit goes through `getSubmissionBlocker` reusing the existing path. All cases from spec table covered.

**Risks / things to watch:**
- Probe is synchronous on the bot's message-handling thread. With long-polling (single concurrent batch from `getUpdates`), one slow probe blocks the next message for up to 10 s. Acceptable for v1 — bot is light traffic. If it becomes a problem, fire-and-forget the probe with an explicit "processing your link…" message and a per-user lock.
- yt-dlp's `--print "%(duration)s||%(title)s"` format: titles can theoretically contain `||`. We `.join("||")` to recover the title — safe.
- If the user types `/help` or another command that happens to contain a URL substring (unlikely), the command parsing runs first (lines 122–149 in `handleUpdate`), so URL detection only fires when nothing else claimed the message.
- yt-dlp version drift — `pip3 install yt-dlp` in the Dockerfile gets the latest at build time. Periodic image rebuilds are needed; otherwise the worker's pinned-by-build version may diverge from the bot's. Live with it for now; a follow-up could pin a specific version in both Dockerfiles.
