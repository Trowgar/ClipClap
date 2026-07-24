# Bot Support Media Relay + Operator Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In an open support session, relay the user's screenshots/media to the operator; show a clear notice when they send a video (do NOT make a clip); and show an operator note when the operator taps Support in their own chat.

**Architecture:** Extends the shipped support relay. Adds `copyMessage` to the Telegram client, a `caption` field to the message type, `relaySupportMedia`, and reworks the `handleUpdate` support tail. No schema/worker/web changes.

**Tech Stack:** TypeScript, custom long-polling Telegram client, vitest (run in the `bot` container).

**Spec:** `docs/superpowers/specs/2026-07-24-bot-support-media-relay-design.md`

**Repo facts:**
- Bot tests: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/<file>`
- Typecheck: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`
- Host Node 18 cannot run vitest - always the container.
- Plain hyphens only; commit identity `Trowgar <trowgar@yahoo.com>`, no trailer.
- Branch: `feat/bot-support-media`.
- Pre-existing uncommitted `apps/web/lib/auth.ts` + `apps/web/lib/telegram-provider.ts` - never touch/stage.

---

### Task 1: Client `copyMessage` + `caption` type + i18n

**Files:**
- Modify: `apps/bot/src/telegram-client.ts`
- Modify: `apps/bot/src/types.ts`
- Modify: `apps/bot/src/i18n.ts`
- Modify: `apps/bot/src/__tests__/support-i18n.test.ts`

- [ ] **Step 1: Update the i18n test (remove supportTextOnly, add the two new keys)**

In `apps/bot/src/__tests__/support-i18n.test.ts`, in the "support session strings" loop, replace the line `expect(d.supportTextOnly.length).toBeGreaterThan(0);` with:
```ts
      expect(d.supportVideoInSession.length).toBeGreaterThan(0);
      expect(d.supportMediaUnsupported.length).toBeGreaterThan(0);
```

- [ ] **Step 2: Run it, verify FAIL**

`docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support-i18n.test.ts`
Expected: FAIL (new keys undefined).

- [ ] **Step 3: Add `copyMessage` to the client**

In `apps/bot/src/telegram-client.ts`, next to `sendVideo`, add:
```ts
  async copyMessage(
    chatId: string | number,
    fromChatId: string | number,
    messageId: number,
    options?: { caption?: string }
  ) {
    return this.request("copyMessage", {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      caption: options?.caption,
    });
  }
```

- [ ] **Step 4: Add `caption` to `TelegramMessage`**

In `apps/bot/src/types.ts`, in `interface TelegramMessage`, add after `text?: string;`:
```ts
  caption?: string;
```

- [ ] **Step 5: Swap the i18n keys in the `Dict` interface**

In `apps/bot/src/i18n.ts`, replace the interface line `supportTextOnly: string;` with:
```ts
  supportVideoInSession: string;
  supportMediaUnsupported: string;
```

- [ ] **Step 6: Swap the EN values**

In the `en: Dict` object, replace the `supportTextOnly: "..."` entry with:
```ts
  supportVideoInSession:
    '⚠️ You\'re in the support chat right now.\n\n• To make a clip - tap "⬅️ Close chat" below and send the video again.\n• To describe your issue - send text or a screenshot.',
  supportMediaUnsupported:
    "Couldn't send that. Send a screenshot or describe it in text.",
```

- [ ] **Step 7: Swap the RU values**

In the `ru: Dict` object, replace the `supportTextOnly: "..."` entry with:
```ts
  supportVideoInSession:
    "⚠️ Ты сейчас в чате поддержки.\n\n• Чтобы сделать клип - нажми «⬅️ Закрыть диалог» внизу и пришли видео снова.\n• Чтобы описать проблему - напиши текстом или пришли скриншот.",
  supportMediaUnsupported:
    "Не удалось переслать это. Пришли скриншот или опиши текстом.",
```

> NOTE: the `⬅️ Close chat` / `⬅️ Закрыть диалог` text inside `supportVideoInSession`
> must match `supportCloseBtn` exactly. It does in the values above.

- [ ] **Step 8: Run the i18n test, verify PASS**

`docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support-i18n.test.ts`
Expected: PASS. (Task 2 will remove the last `supportTextOnly` usage in handlers; tsc for the whole app is checked at the end of Task 2.)

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/telegram-client.ts apps/bot/src/types.ts apps/bot/src/i18n.ts apps/bot/src/__tests__/support-i18n.test.ts
git commit -m "feat(bot): copyMessage client method, message caption, support media i18n"
```

---

### Task 2: Handlers - media relay, video-in-session notice, operator note

**Files:**
- Modify: `apps/bot/src/handlers.ts`
- Modify: `apps/bot/src/__tests__/support.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/bot/src/__tests__/support.test.ts` (the file already mocks `@clipclap/shared` with `prisma`/`findOrCreateTelegramUser` and imports from `../handlers`). Add these imports to the existing import from `../handlers`: `parseSupportReply` is already imported; add `relaySupportMedia`. Then append:

```ts
describe("parseSupportReply from caption", () => {
  it("reads #uid from a media reply's caption when text is absent", async () => {
    const { parseSupportReply } = await import("../handlers");
    const msg = {
      message_id: 3,
      chat: { id: 5, type: "private" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 5, type: "private" },
        from: { id: 9, is_bot: true },
        caption: "🆕 #uid575308044 Ivan\n\nscreenshot",
      },
    };
    expect(parseSupportReply(msg as never)).toEqual({ uid: "575308044" });
  });
});

describe("relaySupportMedia", () => {
  it("copies the media to the support chat with a #uid caption", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { copyMessage: vi.fn().mockResolvedValue(undefined) } as never;
    const msg = { message_id: 8, chat: { id: 42, type: "private" }, caption: "look" };
    const ok = await relaySupportMedia(client, { id: 42, first_name: "Ann" } as never, msg as never);
    expect(ok).toBe(true);
    const call = (client as unknown as { copyMessage: ReturnType<typeof vi.fn> }).copyMessage.mock.calls[0];
    expect(call[0]).toBe("777"); // to support chat
    expect(call[1]).toBe(42); // from user chat
    expect(call[2]).toBe(8); // message id
    expect(call[3].caption).toContain("🆕 #uid42");
    expect(call[3].caption).toContain("look"); // original caption appended
  });

  it("returns false when copyMessage throws", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { copyMessage: vi.fn().mockRejectedValue(new Error("sticker")) } as never;
    const ok = await relaySupportMedia(client, { id: 1 } as never, { message_id: 2, chat: { id: 1 } } as never);
    expect(ok).toBe(false);
  });

  it("no-ops (returns true) when no support chat is configured", async () => {
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    const client = { copyMessage: vi.fn() } as never;
    const ok = await relaySupportMedia(client, { id: 1 } as never, { message_id: 2, chat: { id: 1 } } as never);
    expect(ok).toBe(true);
    expect((client as unknown as { copyMessage: ReturnType<typeof vi.fn> }).copyMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify FAIL**

`docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support.test.ts`
Expected: FAIL (`relaySupportMedia` not exported; caption-reply not parsed).

- [ ] **Step 3: `parseSupportReply` reads caption**

In `apps/bot/src/handlers.ts`, change the `parseSupportReply` body line:
```ts
  const m = SUPPORT_UID_RE.exec(r.text ?? "");
```
to:
```ts
  const m = SUPPORT_UID_RE.exec(r.text ?? r.caption ?? "");
```

- [ ] **Step 4: Add `relaySupportMedia`**

Next to `relaySupportMessage`, add:
```ts
export async function relaySupportMedia(
  client: TelegramClient,
  from: TelegramUser,
  message: TelegramMessage
): Promise<boolean> {
  const chat = getSupportChatId();
  if (!chat) {
    console.warn(
      "Support media received but SUPPORT_CHAT_ID is not configured"
    );
    return true;
  }
  const rawName = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const name = rawName.replace(/#uid\d+/g, "").trim() || String(from.id);
  const username = from.username ? ` (@${from.username})` : "";
  const caption =
    `${SUPPORT_MARKER}${from.id} ${name}${username}` +
    (message.caption ? `\n\n${message.caption}` : "");
  try {
    await client.copyMessage(chat, message.chat.id, message.message_id, {
      caption,
    });
    return true;
  } catch (e) {
    console.error(`Failed to relay support media to ${chat}:`, e);
    return false;
  }
}
```

- [ ] **Step 5: Rework the `handleUpdate` support tail**

Find the current tail (starts at the comment "Video/document files always process..."):
```ts
  // Video/document files always process (unambiguous product intent), even in a
  // support session. Plain text (including pasted URLs) is treated as part of the
  // support conversation and relayed while a session is open.
  const source = getVideoSource(message);
  if (source) {
    await handleVideo(client, message, from, source, dict, config);
    return;
  }

  if (supportOpen && String(message.chat.id) !== getSupportChatId()) {
    if (text) {
      await relaySupportMessage(client, from, text);
    } else {
      await client
        .sendMessage(message.chat.id, dict.supportTextOnly)
        .catch(() => undefined);
    }
    return;
  }

  const url = extractVideoUrl(text);
  if (url) {
    await handleVideoUrl(client, message, from, url, dict, config);
    return;
  }

  await client.sendMessage(message.chat.id, dict.sendVideoHint);
```
Replace that entire block with:
```ts
  const source = getVideoSource(message);

  // While a support session is open, capture the conversation. A video is NOT
  // turned into a clip here - tell the user to close the chat first. Screenshots
  // and other media are relayed to the operator.
  if (supportOpen && String(message.chat.id) !== getSupportChatId()) {
    if (source) {
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

  // Session closed: normal product path.
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
```

- [ ] **Step 6: Operator note in the Help `support` dispatch**

Find the `matchHelpAction` dispatch block in `handleUpdate`:
```ts
  const helpAction = matchHelpAction(text);
  if (helpAction) {
    if (helpAction === "how") {
      await client.sendMessage(message.chat.id, dict.helpText(config.appUrl));
    } else {
      await openSupport(client, message, from, dict);
    }
    return;
  }
```
Replace the `else` branch so the operator gets a note instead of a session:
```ts
  const helpAction = matchHelpAction(text);
  if (helpAction) {
    if (helpAction === "how") {
      await client.sendMessage(message.chat.id, dict.helpText(config.appUrl));
    } else if (String(message.chat.id) === getSupportChatId()) {
      await client
        .sendMessage(
          message.chat.id,
          "Ты оператор - тикеты от пользователей приходят сюда. Отвечай reply'ем на сообщение тикета."
        )
        .catch(() => undefined);
    } else {
      await openSupport(client, message, from, dict);
    }
    return;
  }
```

- [ ] **Step 7: Run support tests + full bot suite**

```bash
docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support.test.ts apps/bot/src/__tests__/support-i18n.test.ts
docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/
```
Expected: all pass.

- [ ] **Step 8: Typecheck**

`docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`
Expected: PASS (no more `supportTextOnly` references anywhere).

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/support.test.ts
git commit -m "feat(bot): relay support media, video-in-session notice, operator note"
```

---

### Task 3: Verification (coordinator-run)

- [ ] Full suite: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/` -> all green.
- [ ] Typecheck: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit` -> pass.
- [ ] `docker compose logs --tail=12 bot` -> clean reload.
- [ ] Final review of the branch diff, then merge to main + push (per established workflow).
