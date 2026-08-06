# Telegram Clip Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every clip regardless of size, and make one failed clip cost only itself.

**Architecture:** Clips stop being handed to Telegram as presigned R2 URLs (capped at 20,000,000 bytes) and are uploaded as `multipart/form-data` to the local Bot API server, which accepts 2000 MB in `TELEGRAM_LOCAL` mode. Each clip is sent inside its own try/catch and marked with the returned `file_id`, so a retry re-sends only what is missing. A size precheck refuses absurd files before a byte is read, and a resend button re-arms the existing delivery row.

**Tech Stack:** TypeScript, Node 20 (`fs.openAsBlob`, global `FormData`/`Blob`), Prisma/Postgres, vitest, grammY-free hand-rolled Telegram client.

**Spec:** `docs/superpowers/specs/2026-08-06-telegram-clip-delivery-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Two nullable columns on `Clip`: `telegramFileId`, `telegramSendError` |
| `packages/shared/src/lib/r2.ts` | `getObjectSize(key)` - byte count without downloading |
| `apps/bot/src/telegram-client.ts` | `TelegramApiError`, `requestMultipart`, `sendVideoUpload` |
| `apps/bot/src/clip-delivery.ts` | **New.** Error classification + the per-clip send loop, isolated so it is testable without the poller |
| `apps/bot/src/handlers.ts` | Calls the new unit; loses the `clipsInChat > 0` terminal branch; gains the `resend:` callback |
| `apps/bot/src/i18n/*.ts` + `types.ts` | Copy that names no dashboard, plus the button label |

`clip-delivery.ts` is new rather than more code in `handlers.ts` (1700+ lines): the send loop is the part with real branching, and it deserves to be reachable from a test without standing up a poller.

---

## Task 1: Per-clip delivery state on Clip

**Files:**
- Modify: `prisma/schema.prisma:543` (after `deletedAt`)
- Create: migration via `prisma migrate dev`

- [ ] **Step 1: Add the columns to the schema**

In `prisma/schema.prisma`, inside `model Clip`, after the `deletedAt` line:

```prisma
  /// Telegram's id for this clip once it is in the user's chat. Non-null means
  /// delivered, and a retry skips it - which is what stops a re-pickup from
  /// repeating clips already sent.
  ///
  /// Correct on Clip rather than on a delivery item ONLY because a clip has one
  /// destination: TelegramDelivery.jobId is @unique, the row is created not
  /// upserted, and chatId is written once. Multi-chat delivery, forwarding, or
  /// re-delivery after a chat id change all break that, and would force this
  /// state onto a (deliveryId, clipId, chatId) row instead.
  telegramFileId   String?
  /// Set when this clip can never be delivered - oversized, corrupt, refused on
  /// its own merits. Distinct from a null telegramFileId, which means "not sent
  /// yet, try again": without the distinction the loop retries a broken file
  /// for the whole attempt budget.
  telegramSendError String?
```

- [ ] **Step 2: Generate and apply the migration**

Run:
```bash
docker compose exec -T worker-download sh -lc 'cd /app && /app/node_modules/.bin/prisma migrate dev --name clip_telegram_delivery_state --skip-seed'
```
Expected: `The following migration(s) have been created and applied`.

- [ ] **Step 3: Regenerate the client everywhere that runs Prisma**

Run:
```bash
for c in bot web worker-download worker-transcribe worker-analyze worker-render worker-finalize; do
  docker compose exec -T $c sh -lc 'cd /app && /app/node_modules/.bin/prisma generate >/dev/null 2>&1' && echo "$c ok"
done
```
Expected: seven `ok` lines. (Prisma clients are per-container; skipping this leaves stale types.)

- [ ] **Step 4: Verify the columns exist**

Run:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c '\d clips' | grep -E "telegramFileId|telegramSendError"
```
Expected: both columns, type `text`, nullable.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(delivery): per-clip delivery state, so a retry can skip what already landed"
```

---

## Task 2: Object size without downloading

**Files:**
- Modify: `packages/shared/src/lib/r2.ts`
- Test: `packages/shared/src/lib/__tests__/r2-size.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/lib/__tests__/r2-size.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = sendMock;
    },
  };
});

import { getObjectSize } from "../r2";

describe("getObjectSize", () => {
  it("returns the byte count from ContentLength", async () => {
    sendMock.mockResolvedValueOnce({ ContentLength: 20557490 });
    await expect(getObjectSize("clips/a/b.mp4")).resolves.toBe(20557490);
  });

  // A HEAD that answers without a length is not "zero bytes" - treating it as 0
  // would wave an unmeasured file straight past the size gate.
  it("returns null when the store gives no length", async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(getObjectSize("clips/a/b.mp4")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run packages/shared/src/lib/__tests__/r2-size.test.ts'
```
Expected: FAIL - `getObjectSize` is not exported.

- [ ] **Step 3: Implement**

In `packages/shared/src/lib/r2.ts`, add `HeadObjectCommand` to the existing `@aws-sdk/client-s3` import, then append:

```typescript
/** Byte count of a stored object, or null when the store does not report one.
 *
 *  Exists so the delivery path can refuse an absurd file BEFORE reading it.
 *  Note a presigned GET URL cannot be probed with HTTP HEAD - the signature
 *  covers the method, so HEAD answers 403 - which is why this asks the S3 API
 *  directly instead. */
export async function getObjectSize(key: string): Promise<number | null> {
  const head = await getS3Client().send(
    new HeadObjectCommand({ Bucket: getBucket(), Key: key })
  );
  return typeof head.ContentLength === "number" ? head.ContentLength : null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run packages/shared/src/lib/__tests__/r2-size.test.ts'
```
Expected: 2 passed.

- [ ] **Step 5: Build shared and verify against real R2**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && npm run build -w @clipclap/shared'
docker compose exec -T bot node -e '
const { getObjectSize } = require("/app/packages/shared/dist/lib/r2.js");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const c = await p.clip.findFirst({ where: { storageKey: { not: undefined } }, select: { storageKey: true } });
  console.log("bytes:", await getObjectSize(c.storageKey));
  process.exit(0);
})();'
```
Expected: a plausible byte count (millions), not null.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/lib/r2.ts packages/shared/src/lib/__tests__/r2-size.test.ts
git commit -m "feat(r2): read an object's size without downloading it"
```

---

## Task 3: A Telegram error that says whether Telegram answered

**Files:**
- Modify: `apps/bot/src/telegram-client.ts:220-233`
- Test: `apps/bot/src/__tests__/telegram-api-error.test.ts` (create)

The four-way classification in the spec hinges on one distinction: did Telegram reject the request, or did we never hear back? Today both arrive as a bare `Error` and are indistinguishable.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/telegram-api-error.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { TelegramApiError, TelegramClient } from "../telegram-client";

afterEach(() => vi.restoreAllMocks());

describe("TelegramApiError", () => {
  // Telegram answered and refused: the request definitely did not take effect,
  // so a retry is safe. That is the whole reason this type exists.
  it("is thrown when Telegram returns ok:false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
    );
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendMessage(1, "hi")).rejects.toBeInstanceOf(TelegramApiError);
  });

  // No answer at all: the send may have landed. It must NOT look like a refusal.
  it("is NOT thrown when the request never got a response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendMessage(1, "hi")).rejects.not.toBeInstanceOf(TelegramApiError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/telegram-api-error.test.ts'
```
Expected: FAIL - `TelegramApiError` is not exported.

- [ ] **Step 3: Implement**

At the top of `apps/bot/src/telegram-client.ts`, after the imports:

```typescript
/** Telegram answered and refused.
 *
 *  The distinction this type carries is load-bearing for delivery: a parsed
 *  refusal means the call did NOT take effect, so retrying cannot duplicate
 *  anything. An error that is not this one means we never heard back, the send
 *  may have landed, and a retry risks a duplicate. Nothing else can tell those
 *  two apart after the fact. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}
```

Then replace the throw inside `request` (line 229):

```typescript
    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(
        payload.description || `Telegram API failed: ${method}`,
        method
      );
    }
```

- [ ] **Step 4: Run the test and watch it pass**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/telegram-api-error.test.ts'
```
Expected: 2 passed.

- [ ] **Step 5: Run the whole bot suite - nothing else may break**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot'
```
Expected: all pass. `TelegramApiError extends Error`, so existing `instanceof Error` checks are unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/telegram-client.ts apps/bot/src/__tests__/telegram-api-error.test.ts
git commit -m "feat(bot): tell a Telegram refusal apart from never hearing back"
```

---

## Task 4: Multipart upload

**Files:**
- Modify: `apps/bot/src/telegram-client.ts`
- Test: `apps/bot/src/__tests__/send-video-upload.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/send-video-upload.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TelegramClient } from "../telegram-client";

afterEach(() => vi.restoreAllMocks());

function tempVideo(bytes = "video-bytes"): string {
  const path = join(tmpdir(), `clipclap-test-${Date.now()}.mp4`);
  writeFileSync(path, bytes);
  return path;
}

describe("sendVideoUpload", () => {
  // The whole point of the change: the body is the FILE, not a link to it.
  // Telegram caps a URL fetch at 20,000,000 bytes and a 20,557,490-byte clip
  // is what broke delivery.
  it("posts multipart with the file in the body, not a JSON url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { video: { file_id: "FID" } } }), { status: 200 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");

    await client.sendVideoUpload(42, path, "a caption");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("42");
    expect(form.get("caption")).toBe("a caption");
    expect(form.get("video")).toBeInstanceOf(Blob);
    // A JSON content-type here would mean the old path is still in use.
    expect((init.headers as Record<string, string> | undefined)?.["Content-Type"]).toBeUndefined();
    unlinkSync(path);
  });

  it("returns the file_id Telegram assigned", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { video: { file_id: "FID-123" } } }), { status: 200 })
    );
    const path = tempVideo();
    const client = new TelegramClient("token", "http://local");
    await expect(client.sendVideoUpload(42, path, "c")).resolves.toBe("FID-123");
    unlinkSync(path);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/send-video-upload.test.ts'
```
Expected: FAIL - `sendVideoUpload` is not a function.

- [ ] **Step 3: Implement**

Add `openAsBlob` to the `fs` import at the top of `apps/bot/src/telegram-client.ts`:

```typescript
import { createReadStream, createWriteStream, openAsBlob } from "fs";
```

Add both methods to the class, beside `sendVideo`:

```typescript
  /** Upload a file as multipart/form-data.
   *
   *  Separate from `request()` because that one is hard-wired to
   *  `Content-Type: application/json`. The header is deliberately NOT set here:
   *  fetch derives the multipart boundary from the FormData, and setting it by
   *  hand produces a body Telegram cannot parse. */
  private async requestMultipart<T>(
    method: string,
    form: FormData
  ): Promise<T> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      body: form,
    });
    const payload = (await response.json()) as TelegramApiResponse<T>;

    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(
        payload.description || `Telegram API failed: ${method}`,
        method
      );
    }

    return payload.result as T;
  }

  /** Send a local video file and return the file_id Telegram assigned it.
   *
   *  `openAsBlob` rather than reading the file: it hands fetch a file-backed
   *  Blob, so a 36 MB clip is streamed off disk instead of sitting in the
   *  worker's heap. The size gate in clip-delivery.ts is still the guard - this
   *  just means the ordinary case costs no memory. */
  async sendVideoUpload(
    chatId: string | number,
    filePath: string,
    caption?: string
  ): Promise<string | undefined> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    form.set("supports_streaming", "true");
    form.set("video", await openAsBlob(filePath), "clip.mp4");

    const sent = await this.requestMultipart<{ video?: { file_id?: string } }>(
      "sendVideo",
      form
    );
    return sent.video?.file_id;
  }
```

- [ ] **Step 4: Run the test and watch it pass**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/send-video-upload.test.ts'
```
Expected: 2 passed.

- [ ] **Step 5: Mutation-test the transport assertion**

Temporarily change `form.set("video", await openAsBlob(filePath), "clip.mp4")` to `form.set("video", "https://example.test/x.mp4")` and re-run. Expected: the first test FAILS on `toBeInstanceOf(Blob)`. Revert the change and re-run; expected: pass. A test that cannot see the old path returning is not protecting anything.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/telegram-client.ts apps/bot/src/__tests__/send-video-upload.test.ts
git commit -m "feat(bot): upload the clip instead of handing Telegram a link"
```

---

## Task 5: Classify a failed send

**Files:**
- Create: `apps/bot/src/clip-delivery.ts`
- Test: `apps/bot/src/__tests__/clip-delivery-classify.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/clip-delivery-classify.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { TelegramApiError } from "../telegram-client";
import { classifySendFailure } from "../clip-delivery";

describe("classifySendFailure", () => {
  // Not about this clip - about the chat. Retrying eleven more clips into a
  // blocked chat burns the bot's global rate limit for nothing.
  it("calls a blocked bot a chat-level failure", () => {
    const e = new TelegramApiError("Forbidden: bot was blocked by the user", "sendVideo");
    expect(classifySendFailure(e)).toBe("chat-permanent");
  });

  // Telegram answered, so the send did not take effect: safe to try again.
  it("calls any other Telegram refusal transient", () => {
    const e = new TelegramApiError("Too Many Requests: retry after 30", "sendVideo");
    expect(classifySendFailure(e)).toBe("transient");
  });

  // No answer: the clip may already be in the chat. Retrying risks a duplicate,
  // which is the trade the spec chose deliberately - but it must be VISIBLE.
  it("calls a lost connection ambiguous", () => {
    expect(classifySendFailure(new Error("socket hang up"))).toBe("ambiguous");
    expect(classifySendFailure(new Error("The operation was aborted"))).toBe("ambiguous");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/clip-delivery-classify.test.ts'
```
Expected: FAIL - cannot find module `../clip-delivery`.

- [ ] **Step 3: Implement**

Create `apps/bot/src/clip-delivery.ts`:

```typescript
import { isPermanentTelegramError } from "@clipclap/shared";
import { TelegramApiError } from "./telegram-client";

/** What a failed send means for what happens next.
 *
 *  `clip-permanent` is not produced here: an unusable clip is caught by the
 *  size gate before anything is sent, so this function only ever sees failures
 *  that came back from a send attempt. */
export type SendFailureKind =
  | "chat-permanent"
  | "transient"
  | "ambiguous";

/** Did Telegram answer, and if so, was the answer about the chat?
 *
 *  A parsed refusal (TelegramApiError) proves the call did not take effect, so
 *  a retry cannot duplicate. Anything else means no response arrived, the send
 *  may have landed, and a retry risks a duplicate - the "ambiguous" case the
 *  spec accepts on purpose, because a missing clip costs the user minutes they
 *  already paid while a duplicate costs them a scroll. */
export function classifySendFailure(error: unknown): SendFailureKind {
  if (!(error instanceof TelegramApiError)) return "ambiguous";
  return isPermanentTelegramError(error.message) ? "chat-permanent" : "transient";
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/clip-delivery-classify.test.ts'
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/clip-delivery.ts apps/bot/src/__tests__/clip-delivery-classify.test.ts
git commit -m "feat(bot): classify a failed clip send by whether Telegram answered"
```

---

## Task 6: The per-clip send loop

**Files:**
- Modify: `apps/bot/src/clip-delivery.ts`
- Modify: `.env.example`, `.env`
- Test: `apps/bot/src/__tests__/clip-delivery-loop.test.ts` (create)

- [ ] **Step 1: Add the size ceiling to both env files**

Append to `.env.example`:

```bash
# Largest clip the bot will upload to Telegram, in bytes. Checked against R2's
# reported size BEFORE any bytes are read, so an absurd file is refused rather
# than buffered. CLIP_MAX_SEC caps a clip's DURATION, not its size - the encoder
# is CRF-based, so bytes per second are set by the content and nothing else
# bounds them. Raise this only alongside the bot container's memory headroom.
TELEGRAM_UPLOAD_MAX_BYTES=262144000
```

Append the same `TELEGRAM_UPLOAD_MAX_BYTES=262144000` line to `.env` (without the comment block).

- [ ] **Step 2: Write the failing test**

Create `apps/bot/src/__tests__/clip-delivery-loop.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getObjectSizeMock = vi.hoisted(() => vi.fn());
const downloadToFileMock = vi.hoisted(() => vi.fn());
const markSentMock = vi.hoisted(() => vi.fn());
const markUnsendableMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", () => ({
  getObjectSize: getObjectSizeMock,
  isPermanentTelegramError: (m: string) => m.includes("blocked"),
}));

vi.mock("../clip-file", () => ({ downloadToFile: downloadToFileMock }));

import { TelegramApiError } from "../telegram-client";
import { deliverClips } from "../clip-delivery";

const clip = (id: string, fileId: string | null = null) => ({
  id,
  storageKey: `clips/${id}.mp4`,
  title: `t-${id}`,
  description: null,
  lowQuality: false,
  telegramFileId: fileId,
  telegramSendError: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  getObjectSizeMock.mockResolvedValue(1_000_000);
  downloadToFileMock.mockResolvedValue("/tmp/x.mp4");
  process.env.TELEGRAM_UPLOAD_MAX_BYTES = "262144000";
});
afterEach(() => vi.restoreAllMocks());

function harness(sendImpl: (clipId: string) => Promise<string | undefined>) {
  const sent: string[] = [];
  return {
    sent,
    client: {
      sendVideoUpload: vi.fn(async (_chat: unknown, _path: string, caption: string) => {
        const id = caption.replace("t-", "");
        const fid = await sendImpl(id);
        sent.push(id);
        return fid;
      }),
    },
    deps: { markSent: markSentMock, markUnsendable: markUnsendableMock },
  };
}

describe("deliverClips", () => {
  // THE DEFECT. Clip 2 threw and clips 3-12 were never attempted.
  it("keeps sending after one clip fails", async () => {
    const h = harness(async (id) => {
      if (id === "b") throw new TelegramApiError("Too Many Requests", "sendVideo");
      return `FID-${id}`;
    });

    const result = await deliverClips(
      h.client as never,
      "chat-1",
      [clip("a"), clip("b"), clip("c")],
      (c) => c.title,
      h.deps as never
    );

    expect(h.sent).toEqual(["a", "b", "c"]);
    expect(result.delivered).toBe(2);
    expect(result.pending).toBe(1);
    expect(markSentMock).toHaveBeenCalledWith("a", "FID-a");
    expect(markSentMock).toHaveBeenCalledWith("c", "FID-c");
  });

  it("never re-sends a clip that already has a file id", async () => {
    const h = harness(async (id) => `FID-${id}`);
    await deliverClips(
      h.client as never,
      "chat-1",
      [clip("a", "FID-old"), clip("b")],
      (c) => c.title,
      h.deps as never
    );
    expect(h.sent).toEqual(["b"]);
  });

  it("refuses an oversized clip before reading a byte of it", async () => {
    getObjectSizeMock.mockResolvedValue(300_000_000);
    const h = harness(async () => "unused");

    const result = await deliverClips(
      h.client as never,
      "chat-1",
      [clip("big")],
      (c) => c.title,
      h.deps as never
    );

    expect(downloadToFileMock).not.toHaveBeenCalled();
    expect(h.client.sendVideoUpload).not.toHaveBeenCalled();
    expect(markUnsendableMock).toHaveBeenCalledWith("big", expect.stringContaining("too large"));
    expect(result.unsendable).toBe(1);
  });

  it("stops the whole batch when the chat itself is gone", async () => {
    const h = harness(async () => {
      throw new TelegramApiError("Forbidden: bot was blocked by the user", "sendVideo");
    });

    await expect(
      deliverClips(h.client as never, "chat-1", [clip("a"), clip("b")], (c) => c.title, h.deps as never)
    ).rejects.toBeInstanceOf(TelegramApiError);

    expect(h.sent).toEqual(["a"]);
  });

  it("does not retry a clip already marked unsendable", async () => {
    const h = harness(async (id) => `FID-${id}`);
    const dead = { ...clip("dead"), telegramSendError: "too large" };
    await deliverClips(h.client as never, "chat-1", [dead, clip("ok")], (c) => c.title, h.deps as never);
    expect(h.sent).toEqual(["ok"]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/clip-delivery-loop.test.ts'
```
Expected: FAIL - `deliverClips` is not exported.

- [ ] **Step 4: Create the download helper**

Create `apps/bot/src/clip-file.ts`:

```typescript
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { downloadFile } from "@clipclap/shared";

/** Pull a stored clip to a temp file and return the path.
 *
 *  A file rather than a buffer so `openAsBlob` can stream it into the upload:
 *  the point of the whole change is that a 36 MB clip never has to be resident. */
export async function downloadToFile(storageKey: string): Promise<string> {
  const path = join(tmpdir(), `clipclap-send-${randomUUID()}.mp4`);
  const body = await downloadFile(storageKey);
  await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
  return path;
}
```

- [ ] **Step 5: Implement the loop**

Append to `apps/bot/src/clip-delivery.ts`:

```typescript
import { unlink } from "fs/promises";
import { getObjectSize } from "@clipclap/shared";
import { downloadToFile } from "./clip-file";

const DEFAULT_UPLOAD_MAX_BYTES = 262_144_000;

function uploadMaxBytes(): number {
  const raw = Number(process.env.TELEGRAM_UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UPLOAD_MAX_BYTES;
}

export interface DeliverableClip {
  id: string;
  storageKey: string;
  telegramFileId: string | null;
  telegramSendError: string | null;
}

export interface ClipDeliveryDeps {
  markSent(clipId: string, fileId: string | undefined): Promise<void>;
  markUnsendable(clipId: string, reason: string): Promise<void>;
}

export interface ClipDeliveryResult {
  /** Clips that reached the chat during THIS pass. */
  delivered: number;
  /** Still owed: no file id, no permanent verdict. The row stays re-pickable. */
  pending: number;
  /** Refused for good. Counted in the summary, never retried. */
  unsendable: number;
}

/** Send every clip that is not already in the chat, one at a time.
 *
 *  ONE CLIP'S FAILURE COSTS ONLY ITSELF. That is the defect this exists to fix:
 *  the previous loop had no per-clip catch, so the first refusal threw and every
 *  later clip - all deliverable - was never attempted.
 *
 *  SEQUENTIAL ON PURPOSE. Do not map this into Promise.all. Uploads are
 *  file-backed rather than buffered, but concurrency here would also multiply
 *  temp files and Telegram rate pressure, and the poller already serialises
 *  rows. */
export async function deliverClips<C extends DeliverableClip>(
  client: { sendVideoUpload(chatId: string | number, filePath: string, caption?: string): Promise<string | undefined> },
  chatId: string,
  clips: readonly C[],
  captionFor: (clip: C) => string,
  deps: ClipDeliveryDeps
): Promise<ClipDeliveryResult> {
  const result: ClipDeliveryResult = { delivered: 0, pending: 0, unsendable: 0 };
  const maxBytes = uploadMaxBytes();

  for (const clip of clips) {
    if (clip.telegramFileId) continue;
    if (clip.telegramSendError) {
      result.unsendable += 1;
      continue;
    }

    // Before a byte is read: an absurd file must not be downloaded at all.
    //
    // getObjectSize THROWS for a key that is gone (NotFound) and returns null
    // only for "answered but reported no length" - two different things, and
    // conflating them would treat a vanished clip as merely unmeasured and try
    // to download it anyway. A gone object is permanent: nothing brings it back,
    // so it must not burn the attempt budget either.
    let size: number | null;
    try {
      size = await getObjectSize(clip.storageKey);
    } catch (error) {
      const reason = `clip is no longer in storage: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`[delivery] ${clip.id}: ${reason}`);
      await deps.markUnsendable(clip.id, reason);
      result.unsendable += 1;
      continue;
    }

    if (size !== null && size > maxBytes) {
      const reason = `clip is too large to send: ${size} bytes exceeds ${maxBytes}`;
      console.error(`[delivery] ${clip.id}: ${reason}`);
      await deps.markUnsendable(clip.id, reason);
      result.unsendable += 1;
      continue;
    }

    let path: string | undefined;
    try {
      path = await downloadToFile(clip.storageKey);
      const fileId = await client.sendVideoUpload(chatId, path, captionFor(clip));
      await deps.markSent(clip.id, fileId);
      result.delivered += 1;
    } catch (error) {
      const kind = classifySendFailure(error);
      if (kind === "chat-permanent") throw error;

      if (kind === "ambiguous") {
        // Logged distinctly because retrying this one can duplicate: the send
        // may have landed and we never heard. The rate needs to be observable
        // rather than assumed - see the spec's section 6.
        console.warn(
          `[delivery] ${clip.id}: no response from Telegram, retrying may duplicate:`,
          error instanceof Error ? error.message : error
        );
      } else {
        console.warn(
          `[delivery] ${clip.id}: transient send failure:`,
          error instanceof Error ? error.message : error
        );
      }
      result.pending += 1;
    } finally {
      if (path) await unlink(path).catch(() => undefined);
    }
  }

  return result;
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/clip-delivery-loop.test.ts'
```
Expected: 5 passed.

- [ ] **Step 7: Mutation-test the defect assertion**

Temporarily remove the `try`/`catch` around the send (let the error propagate) and re-run. Expected: "keeps sending after one clip fails" FAILS. Restore and re-run; expected: pass.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/clip-delivery.ts apps/bot/src/clip-file.ts apps/bot/src/__tests__/clip-delivery-loop.test.ts .env.example
git commit -m "feat(bot): send clips one at a time, so one failure costs only itself"
```

---

## Task 7: Wire the loop into the poller

**Files:**
- Modify: `apps/bot/src/handlers.ts:1319-1381`

- [ ] **Step 1: Replace the sign-then-send block**

In `deliverReadyTelegramJobs`, delete the `const videos = []` loop and the `for (const video of videos)` loop (handlers.ts:1319-1335) and put in their place:

```typescript
      const outcome = await deliverClips(
        client,
        delivery.chatId,
        delivery.job.clips,
        (clip) =>
          buildClipCaption({
            title: clip.title,
            description: clip.description,
            lowQuality: clip.lowQuality,
            lowQualityNote: dict.lowQualityNote,
          }),
        {
          markSent: async (clipId, fileId) => {
            await prisma.clip.update({
              where: { id: clipId },
              data: { telegramFileId: fileId ?? "sent" },
            });
          },
          markUnsendable: async (clipId, reason) => {
            await prisma.clip.update({
              where: { id: clipId },
              data: { telegramSendError: reason },
            });
          },
        }
      );
      clipsInChat += outcome.delivered;

      // Still owed, so the row is NOT settled: the next poll re-picks it and
      // sends only what is missing. Returning here rather than falling through
      // is what keeps the summary from being repeated on every pass.
      if (outcome.pending > 0) {
        const { terminal } = await markTelegramDeliveryAttemptFailed(
          delivery.id,
          `${outcome.pending} clip(s) not delivered yet`,
          delivery.attempts
        );
        if (!terminal) continue;
      }
```

`fileId ?? "sent"` is deliberate: Telegram has confirmed the clip is in the chat even in the unlikely case it returned no id, and the column's job is "do not send this again". A null there would resend a clip the user already has.

- [ ] **Step 2: Import the new unit**

Add to the imports at the top of `apps/bot/src/handlers.ts`:

```typescript
import { deliverClips } from "./clip-delivery";
```

- [ ] **Step 3: Delete the branch that made a partial delivery terminal**

In the `catch` block, remove the whole `if (clipsInChat > 0) { ... continue; }` section (handlers.ts:1355-1381). Its comment explains it exists because a re-pickup would repeat clips - `telegramFileId` now prevents that for every recorded attempt, and the branch is what stopped ten deliverable clips from ever being retried.

- [ ] **Step 4: Run the full bot suite**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot'
```
Expected: all pass. Fix any test that asserted the old partial-is-terminal behaviour by asserting the new one - the row stays re-pickable while clips are owed.

- [ ] **Step 5: Typecheck**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app/apps/bot && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```
Expected: `tsc=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/handlers.ts
git commit -m "fix(delivery): retry only the clips still owed, instead of abandoning the row"
```

---

## Task 8: Copy that names no dashboard

**Files:**
- Modify: `apps/bot/src/i18n/types.ts`, `en.ts`, `ru.ts`, `uk.ts`, `es.ts`, `pt.ts`, `id.ts`

- [ ] **Step 1: Add the button label to the dictionary type**

In `apps/bot/src/i18n/types.ts`, beside `donePartial`:

```typescript
  /** Label of the inline button attached to a partial delivery summary. */
  resendRemainingBtn: string;
```

- [ ] **Step 2: Rewrite both leaking strings in all six locales**

The two strings currently point bot users at a web dashboard the owner deliberately hides from them. Replace `donePartial` and the `clips === 0` branch of `deliveryGivenUp`, and add `resendRemainingBtn`:

`en.ts`:
```typescript
  donePartial: (sent, total) =>
    `Sent ${sent} of ${total} clips - the rest did not go through. Tap below and I will try again.`,
  resendRemainingBtn: "Send the rest",
```
`ru.ts`:
```typescript
  donePartial: (sent, total) =>
    `Отправил ${sent} из ${total} ${pluralizeRu(total, "клипа", "клипов", "клипов")} - остальные не прошли. Нажми ниже, и я попробую ещё раз.`,
  resendRemainingBtn: "Прислать оставшиеся",
```
`uk.ts`:
```typescript
  donePartial: (sent, total) =>
    `Надіслав ${sent} з ${total} - решта не пройшла. Натисни нижче, і я спробую ще раз.`,
  resendRemainingBtn: "Надіслати решту",
```
`es.ts`:
```typescript
  donePartial: (sent, total) =>
    `Envié ${sent} de ${total} clips - el resto no salió. Pulsa abajo y lo intento otra vez.`,
  resendRemainingBtn: "Enviar el resto",
```
`pt.ts`:
```typescript
  donePartial: (sent, total) =>
    `Enviei ${sent} de ${total} clipes - o resto não passou. Toque abaixo e eu tento de novo.`,
  resendRemainingBtn: "Enviar o resto",
```
`id.ts`:
```typescript
  donePartial: (sent, total) =>
    `Terkirim ${sent} dari ${total} klip - sisanya gagal. Tekan di bawah dan aku coba lagi.`,
  resendRemainingBtn: "Kirim sisanya",
```

In `deliveryGivenUp`, delete the `Open ${url}/dashboard` sentence (and its translation) from the `clips === 0` branch in every locale. **Keep the warning that follows it** - "do not send this video again, a second run bills your minutes twice" - which is the one thing in that string the user cannot afford to lose.

- [ ] **Step 3: Verify no locale still names the dashboard**

Run:
```bash
grep -rn "dashboard\|кабинет\|кабінет\|panel\|painel" apps/bot/src/i18n/*.ts
```
Expected: no matches.

- [ ] **Step 4: Run the i18n completeness test**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot'
```
Expected: all pass - the suite already checks every locale implements the full dictionary, so a missing `resendRemainingBtn` fails here.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/i18n
git commit -m "fix(bot): stop telling bot users about a dashboard they are not shown"
```

---

## Task 9: The resend button

**Files:**
- Modify: `apps/bot/src/handlers.ts` (partial summary send + `handleCallbackQuery`)
- Test: `apps/bot/src/__tests__/resend-callback.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/resend-callback.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

const findFirstMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());

vi.mock("@clipclap/shared", () => ({
  prisma: { telegramDelivery: { findFirst: findFirstMock, update: updateMock } },
}));

import { rearmDeliveryForResend } from "../clip-delivery";

beforeEach(() => vi.clearAllMocks());

describe("rearmDeliveryForResend", () => {
  it("re-arms a delivery that belongs to this user", async () => {
    findFirstMock.mockResolvedValue({ id: "d1" });
    await expect(rearmDeliveryForResend("job-1", "user-1")).resolves.toBe(true);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { status: "PENDING", attempts: 0, error: null },
    });
  });

  // Callback data is attacker-controlled: another user's job id must not
  // re-arm a delivery into someone else's chat.
  it("refuses a job that belongs to someone else", async () => {
    findFirstMock.mockResolvedValue(null);
    await expect(rearmDeliveryForResend("job-1", "intruder")).resolves.toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/resend-callback.test.ts'
```
Expected: FAIL - `rearmDeliveryForResend` is not exported.

- [ ] **Step 3: Implement the re-arm**

Append to `apps/bot/src/clip-delivery.ts`:

```typescript
import { prisma } from "@clipclap/shared";

/** Put a settled delivery back in the poller's queue.
 *
 *  The button adds no second delivery path: everything after this is the
 *  ordinary loop, which skips clips that already carry a telegramFileId. The
 *  ownership check is not decoration - callback data comes from the user. */
export async function rearmDeliveryForResend(
  jobId: string,
  userId: string
): Promise<boolean> {
  const row = await prisma.telegramDelivery.findFirst({
    where: { jobId, userId },
    select: { id: true },
  });
  if (!row) return false;

  await prisma.telegramDelivery.update({
    where: { id: row.id },
    data: { status: "PENDING", attempts: 0, error: null },
  });
  return true;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/resend-callback.test.ts'
```
Expected: 2 passed.

- [ ] **Step 5: Repair the Task 6 mock, which this task just broke**

Adding `prisma` to `clip-delivery.ts` breaks `clip-delivery-loop.test.ts`: its factory mock of `@clipclap/shared` lists only the exports that existed when it was written, and vitest fails a module that reaches for one the mock does not return. This exact failure - `No "X" export is defined on the mock` - already cost a debugging round in this repo when `download.ts` gained new shared imports.

In `apps/bot/src/__tests__/clip-delivery-loop.test.ts`, extend the mock:

```typescript
vi.mock("@clipclap/shared", () => ({
  getObjectSize: getObjectSizeMock,
  isPermanentTelegramError: (m: string) => m.includes("blocked"),
  // Imported by rearmDeliveryForResend in the same module. The loop under test
  // never touches it, but the factory must still return it or the import fails.
  prisma: { telegramDelivery: { findFirst: vi.fn(), update: vi.fn() } },
}));
```

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot/src/__tests__/clip-delivery-loop.test.ts'
```
Expected: 5 passed.

- [ ] **Step 6: Attach the button to the partial summary**

In the `catch` block of `deliverReadyTelegramJobs` where `dict!.donePartial(...)` is sent, and in the terminal-partial path, pass the keyboard:

```typescript
          await client.sendMessage(
            delivery.chatId,
            clipsInChat < total ? dict!.donePartial(clipsInChat, total) : dict!.done(total),
            clipsInChat < total
              ? {
                  replyMarkup: {
                    inline_keyboard: [
                      [{ text: dict!.resendRemainingBtn, callback_data: `resend:${delivery.jobId}` }],
                    ],
                  },
                }
              : undefined
          );
```

- [ ] **Step 7: Dispatch the callback**

In `handleCallbackQuery`, beside the existing `sub:` branch (handlers.ts:1614):

```typescript
  if (query.data.startsWith("resend:")) {
    const jobId = query.data.slice("resend:".length);
    const user = await resolveTelegramUser(query.from);
    const rearmed = await rearmDeliveryForResend(jobId, user.id);
    if (!rearmed) {
      console.warn(`[delivery] resend refused for job ${jobId}: not this user's`);
    }
    return;
  }
```

Add `rearmDeliveryForResend` to the `./clip-delivery` import.

- [ ] **Step 8: Run the full suite and typecheck**

Run:
```bash
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/vitest run apps/bot'
docker compose exec -T bot sh -lc 'cd /app/apps/bot && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit; echo "tsc=$?"'
```
Expected: all pass, `tsc=0`.

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/clip-delivery.ts apps/bot/src/__tests__/resend-callback.test.ts
git commit -m "feat(bot): a button that re-arms the delivery instead of a dead end"
```

---

## Task 10: Deploy and prove it on the clip that broke

**Files:** none - this is the acceptance step.

- [ ] **Step 1: Confirm nothing is mid-flight**

Run:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -tAc "SELECT count(*) FROM jobs WHERE status NOT IN ('DONE','FAILED');"
```
Expected: `0`. Editing bind-mounted source restarts the worker via tsx and kills a running job.

- [ ] **Step 2: Deploy**

Run:
```bash
docker compose up -d bot
docker compose exec -T bot sh -lc 'cd /app && /app/node_modules/.bin/prisma generate >/dev/null && npm run build -w @clipclap/shared'
docker compose restart bot
```
`up -d`, not `restart`, because `restart` does not re-read `env_file` and `TELEGRAM_UPLOAD_MAX_BYTES` is new.

- [ ] **Step 3: Re-run the job that produced the defect**

Run:
```bash
docker compose exec -T worker-download sh -lc 'cat > /tmp/verify.ts <<"EOF"
import { jobService, prisma } from "@clipclap/shared";
(async () => {
  const user = await prisma.user.findFirstOrThrow({ where: { telegramId: "575308044" } });
  const r = await jobService.createJob({
    userId: user.id,
    sourceUrl: "https://www.youtube.com/watch?v=L4DvjdbjY4Q",
    originalFilename: "[verify:delivery] Zurich",
    subtitles: true,
    sourceDurationSec: 1584,
  });
  console.log(r.status, (r as any).job?.id ?? "");
  process.exit(0);
})();
EOF
/app/node_modules/.bin/tsx /tmp/verify.ts; rm -f /tmp/verify.ts'
```

This is the source whose clip 5 is 36.1 MB and clip 11 is 31.2 MB - both impossible to deliver before this change.

- [ ] **Step 4: Watch it settle**

Run:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c "
SELECT d.status, d.attempts, count(c.\"telegramFileId\") AS delivered, count(*) AS clips
FROM telegram_deliveries d
JOIN clips c ON c.\"jobId\" = d.\"jobId\"
WHERE d.\"jobId\" = (SELECT id FROM jobs WHERE \"originalFilename\" LIKE '[verify:delivery]%' ORDER BY \"createdAt\" DESC LIMIT 1)
GROUP BY 1,2;"
```
Expected: `DELIVERED`, and `delivered` equal to `clips`. **This is the acceptance criterion - passing unit tests are not.** Every clip carrying a `telegramFileId`, including the 36 MB one, is the proof.

- [ ] **Step 5: Clean up the verification artifact**

Run:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c "
DELETE FROM clips WHERE \"jobId\" IN (SELECT id FROM jobs WHERE \"originalFilename\" LIKE '[verify:delivery]%');
DELETE FROM job_steps WHERE \"jobId\" IN (SELECT id FROM jobs WHERE \"originalFilename\" LIKE '[verify:delivery]%');
DELETE FROM telegram_deliveries WHERE \"jobId\" IN (SELECT id FROM jobs WHERE \"originalFilename\" LIKE '[verify:delivery]%');
DELETE FROM free_usage WHERE \"jobId\" IN (SELECT id FROM jobs WHERE \"originalFilename\" LIKE '[verify:delivery]%');
DELETE FROM jobs WHERE \"originalFilename\" LIKE '[verify:delivery]%';"
```

- [ ] **Step 6: Leave the two legacy rows alone**

`cmshc1olm000le3zk8f2etco2` and `cmrv9t0x5000y9pvweq9c8j78` are `FAILED`, and `getPendingTelegramDeliveries` selects only `PENDING` and `FAILURE_NOTIFIED` - so they cannot resurrect. They carry no button, because the button only attaches to summaries the new code sends. Resending either by hand duplicates whatever already reached the chat (one clip for the first); that is a judgement call, not something to automate.

---

## Self-Review

**Spec coverage.** §1 defect - Task 10 reproduces it. §3 multipart - Task 4. §4 transport and the size ceiling - Tasks 4 and 6. §5 per-clip state and the withdrawn exactly-once claim - Tasks 1, 6, 7. §6 four-way classification - Tasks 5 and 6. §7 inline button - Task 9. §8 copy - Task 8. §8a rollout - Task 10 step 6. §9 testing - every task carries its tests, with mutation checks on the two assertions that matter most.

**One spec item deliberately not implemented as written.** §4 accepts buffering one clip in memory. `fs.openAsBlob` exists in the container's Node 20.20.2 (verified), so the implementation streams from disk instead and never buffers. That is strictly better than the spec requires, and `TELEGRAM_UPLOAD_MAX_BYTES` remains as the guard. The spec's "do not make the loop concurrent" rule still applies and is stated in the code comment.

**Type consistency.** `deliverClips`, `classifySendFailure`, `rearmDeliveryForResend`, `downloadToFile`, `getObjectSize`, `sendVideoUpload`, `TelegramApiError` are each defined once and used with the same signature everywhere. `ClipDeliveryResult` fields (`delivered`/`pending`/`unsendable`) are consistent between Task 6's implementation and Task 7's consumer.
