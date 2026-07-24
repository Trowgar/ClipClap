# Bot Support Relay + Help Sub-menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the bot's "❓ Help" into `[How it works] [Support]` and add an in-bot support relay: user text -> operator DM -> operator replies -> delivered back to the user, session open until closed.

**Architecture:** One boolean `User.supportOpen` for inbound routing; outbound routing rides a leading `#uid<id>` marker in the forwarded message (parsed from the operator's Telegram reply) - no mapping table, restart-immune. All bot logic in `apps/bot/src/handlers.ts`; i18n in `i18n.ts`; `reply_to_message` added to `types.ts`.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, custom long-polling Telegram client, vitest. Bot runs in the `bot` Docker container (bind-mounted, hot-reload). Tests + typecheck run in-container.

**Spec:** `docs/superpowers/specs/2026-07-24-bot-support-relay-design.md`

**Repo facts:**
- Bot tests: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/<file>`
- Typecheck: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`
- Host Node 18 cannot run vitest - always use the container.
- Prisma migrate (not `db push`); `migrate deploy` + `generate` run per-container.
- Bilingual EN/RU; plain hyphens only (no em/en dashes).
- Commit identity `Trowgar <trowgar@yahoo.com>`, no attribution trailer.
- Branch: `feat/bot-support-relay`.

---

### Task 1: Schema - `User.supportOpen`

**Files:**
- Modify: `prisma/schema.prisma` (User model)
- Create: `prisma/migrations/20260724140000_user_support_open/migration.sql`

- [ ] **Step 1: Add the field to the schema**

Find the `User` model and add next to `subtitlesEnabled`:

```prisma
  supportOpen      Boolean   @default(false)
```

- [ ] **Step 2: Create the migration file**

Create `prisma/migrations/20260724140000_user_support_open/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "users" ADD COLUMN "supportOpen" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 3: Apply the migration and regenerate the client (per container)**

Run:
```bash
docker compose exec -T -w /app bot npx prisma migrate deploy
docker compose exec -T -w /app bot npx prisma generate
docker compose exec -T -w /app web npx prisma generate
docker compose exec -T -w /app worker npx prisma generate
docker compose exec -T -w /app bot npm run build -w @clipclap/shared
```
Expected: migration `20260724140000_user_support_open` applied; generate succeeds.

- [ ] **Step 4: Verify the column exists**

Run:
```bash
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: PASS (no errors; the field is not yet referenced, this just confirms the client regenerated cleanly).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260724140000_user_support_open
git commit -m "feat(bot): add User.supportOpen for support relay sessions"
```

---

### Task 2: Types + i18n strings

**Files:**
- Modify: `apps/bot/src/types.ts` (`TelegramMessage`)
- Modify: `apps/bot/src/i18n.ts` (`Dict` interface + `en` + `ru`)
- Test: `apps/bot/src/__tests__/support-i18n.test.ts`

- [ ] **Step 1: Write the failing i18n test**

Create `apps/bot/src/__tests__/support-i18n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { t } from "../i18n";

describe("support + help i18n", () => {
  it("has the help sub-menu labels in both locales", () => {
    expect(t("en").helpHowBtn).toContain("How it works");
    expect(t("ru").helpHowBtn).toContain("Как это работает");
    expect(t("en").helpSupportBtn).toContain("Support");
    expect(t("ru").helpSupportBtn).toContain("Поддержка");
  });

  it("has the support session strings in both locales", () => {
    for (const loc of ["en", "ru"] as const) {
      const d = t(loc);
      expect(d.supportPrompt.length).toBeGreaterThan(0);
      expect(d.supportCloseBtn.length).toBeGreaterThan(0);
      expect(d.supportClosed.length).toBeGreaterThan(0);
      expect(d.supportReplyPrefix.length).toBeGreaterThan(0);
      expect(d.supportUnavailable.length).toBeGreaterThan(0);
      expect(d.supportTextOnly.length).toBeGreaterThan(0);
      expect(d.helpMenuPrompt.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support-i18n.test.ts`
Expected: FAIL (properties do not exist / type errors).

- [ ] **Step 3: Add `reply_to_message` to `TelegramMessage`**

In `apps/bot/src/types.ts`, inside `interface TelegramMessage`, add after `document?: TelegramDocument;`:

```ts
  reply_to_message?: TelegramMessage;
```

- [ ] **Step 4: Add the fields to the `Dict` interface**

In `apps/bot/src/i18n.ts`, in the `Dict` interface, add after `helpText: (url: string) => string;`:

```ts
  helpMenuPrompt: string;
  helpHowBtn: string;
  helpSupportBtn: string;
  supportPrompt: string;
  supportCloseBtn: string;
  supportClosed: string;
  supportReplyPrefix: string;
  supportUnavailable: string;
  supportTextOnly: string;
```

- [ ] **Step 5: Add the EN values**

In the `en: Dict = { ... }` object, add after its `helpText` entry:

```ts
  helpMenuPrompt: "❓ Help - choose:",
  helpHowBtn: "❓ How it works",
  helpSupportBtn: "💬 Support",
  supportPrompt:
    "Write your message - we'll pass it to support and reply right here.",
  supportCloseBtn: "⬅️ Close chat",
  supportClosed: "Chat closed. Send a video anytime to make clips.",
  supportReplyPrefix: "💬 Support:",
  supportUnavailable: "Support is temporarily unavailable. Please try again later.",
  supportTextOnly:
    "Support takes text only for now - please describe your issue in a message.",
```

- [ ] **Step 6: Add the RU values**

In the `ru: Dict = { ... }` object, add after its `helpText` entry:

```ts
  helpMenuPrompt: "❓ Помощь - выбери:",
  helpHowBtn: "❓ Как это работает",
  helpSupportBtn: "💬 Поддержка",
  supportPrompt: "Напиши сообщение - передадим в поддержку, ответим здесь же.",
  supportCloseBtn: "⬅️ Закрыть диалог",
  supportClosed: "Диалог закрыт. Пришли видео - нарежу клипы.",
  supportReplyPrefix: "💬 Поддержка:",
  supportUnavailable: "Поддержка временно недоступна. Попробуй позже.",
  supportTextOnly:
    "Поддержка пока принимает только текст - опиши вопрос сообщением.",
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support-i18n.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/types.ts apps/bot/src/i18n.ts apps/bot/src/__tests__/support-i18n.test.ts
git commit -m "feat(bot): support + help sub-menu i18n strings and reply_to_message type"
```

---

### Task 3: Help sub-menu split

**Files:**
- Modify: `apps/bot/src/handlers.ts` (`matchHelpAction`, `helpKeyboard`, `handleMenuAction` help case, dispatch)
- Test: `apps/bot/src/__tests__/help-menu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/help-menu.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import { matchHelpAction } from "../handlers";

describe("matchHelpAction", () => {
  it("maps the how/support labels in both locales", () => {
    expect(matchHelpAction(t("en").helpHowBtn)).toBe("how");
    expect(matchHelpAction(t("ru").helpHowBtn)).toBe("how");
    expect(matchHelpAction(t("en").helpSupportBtn)).toBe("support");
    expect(matchHelpAction(t("ru").helpSupportBtn)).toBe("support");
  });

  it("does not match the back button or unrelated text", () => {
    expect(matchHelpAction(t("en").settingsBackBtn)).toBeNull();
    expect(matchHelpAction("random")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/help-menu.test.ts`
Expected: FAIL (`matchHelpAction` is not exported).

- [ ] **Step 3: Add `matchHelpAction` and `helpKeyboard`**

In `apps/bot/src/handlers.ts`, next to `matchReferralAction` / `referralKeyboard`, add:

```ts
export function matchHelpAction(text: string): "how" | "support" | null {
  for (const loc of ["en", "ru"] as const) {
    const d = t(loc);
    if (text === d.helpHowBtn) return "how";
    if (text === d.helpSupportBtn) return "support";
  }
  return null;
}

function helpKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.helpHowBtn }, { text: dict.helpSupportBtn }],
      [{ text: dict.settingsBackBtn }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}
```

- [ ] **Step 4: Change the `handleMenuAction` help case**

In `handleMenuAction`, replace the `case "help":` body with:

```ts
    case "help": {
      await client.sendMessage(message.chat.id, dict.helpMenuPrompt, {
        replyMarkup: helpKeyboard(dict),
      });
      return;
    }
```

- [ ] **Step 5: Dispatch `matchHelpAction` in `handleUpdate`**

In `handleUpdate`, after the `matchReferralAction` block (the withdraw stub) and before the `getVideoSource` block, add:

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

> NOTE: `openSupport` is added in Task 4. Until then this will not typecheck; that
> is expected - Task 3 and Task 4 both touch `handleUpdate` and are committed
> together at the end of Task 4. If executing Task 3 standalone, temporarily stub
> `else { await client.sendMessage(message.chat.id, dict.supportPrompt); }` and
> replace it in Task 4. Prefer executing Task 3 and Task 4 as one unit.

- [ ] **Step 6: Run the test to verify it passes**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/help-menu.test.ts`
Expected: PASS.

- [ ] **Step 7: (Committed together with Task 4.)**

Do not commit yet - Task 4 completes the `handleUpdate` wiring and both commit together.

---

### Task 4: Support relay core + `handleUpdate` wiring

**Files:**
- Modify: `apps/bot/src/handlers.ts`
- Modify: `.env.example` (document `SUPPORT_CHAT_ID`)
- Test: `apps/bot/src/__tests__/support.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/src/__tests__/support.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  findOrCreateTelegramUser: vi.fn(),
}));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findOrCreateTelegramUser: mocks.findOrCreateTelegramUser,
    prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
  };
});

import {
  matchSupportAction,
  getSupportChatId,
  parseSupportReply,
  relaySupportMessage,
  deliverSupportReply,
} from "../handlers";

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
  vi.clearAllMocks();
});

describe("matchSupportAction", () => {
  it("matches the close button in both locales", () => {
    expect(matchSupportAction(t("en").supportCloseBtn)).toBe("close");
    expect(matchSupportAction(t("ru").supportCloseBtn)).toBe("close");
    expect(matchSupportAction("nope")).toBeNull();
  });
});

describe("getSupportChatId", () => {
  it("prefers SUPPORT_CHAT_ID, falls back to first admin id, else null", () => {
    process.env.SUPPORT_CHAT_ID = "111";
    process.env.REFERRAL_ADMIN_TELEGRAM_IDS = "222,333";
    expect(getSupportChatId()).toBe("111");
    delete process.env.SUPPORT_CHAT_ID;
    expect(getSupportChatId()).toBe("222");
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    expect(getSupportChatId()).toBeNull();
  });
});

describe("parseSupportReply", () => {
  const botReply = (text: string) => ({
    message_id: 2,
    chat: { id: 5, type: "private" },
    reply_to_message: {
      message_id: 1,
      chat: { id: 5, type: "private" },
      from: { id: 9, is_bot: true },
      text,
    },
  });

  it("extracts the leading #uid marker", () => {
    expect(parseSupportReply(botReply("🆕 #uid575308044 Ivan (@ivan)\n\nhi") as never))
      .toEqual({ uid: "575308044" });
  });

  it("ignores a #uid injected in the quoted body (anchored to header)", () => {
    // header id must win over any later #uid
    expect(parseSupportReply(botReply("🆕 #uid999 Bob\n\n#uid575308044") as never))
      .toEqual({ uid: "999" });
  });

  it("returns null for non-bot replies, missing marker, or no reply", () => {
    const notBot = botReply("🆕 #uid1 x");
    notBot.reply_to_message.from.is_bot = false;
    expect(parseSupportReply(notBot as never)).toBeNull();
    expect(parseSupportReply(botReply("no marker here") as never)).toBeNull();
    expect(parseSupportReply({ message_id: 1, chat: { id: 5, type: "private" } } as never)).toBeNull();
  });
});

describe("relaySupportMessage", () => {
  it("sends to the support chat with a #uid header and verbatim text", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await relaySupportMessage(client, { id: 42, first_name: "Ann" } as never, "help me");
    const call = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(call[0]).toBe("777");
    expect(call[1]).toContain("🆕 #uid42");
    expect(call[1]).toContain("help me");
  });

  it("strips a spoofed #uid from the sender name", async () => {
    process.env.SUPPORT_CHAT_ID = "777";
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await relaySupportMessage(client, { id: 42, first_name: "#uid999" } as never, "x");
    const header = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0][1].split("\n")[0];
    // only the real leading marker remains
    expect(header.match(/#uid\d+/g)).toEqual(["#uid42"]);
  });

  it("no-ops when no support chat is configured", async () => {
    delete process.env.SUPPORT_CHAT_ID;
    delete process.env.REFERRAL_ADMIN_TELEGRAM_IDS;
    const client = { sendMessage: vi.fn() } as never;
    await relaySupportMessage(client, { id: 1 } as never, "x");
    expect((client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).not.toHaveBeenCalled();
  });
});

describe("deliverSupportReply", () => {
  it("delivers to a known user and re-opens the session", async () => {
    mocks.findUnique.mockResolvedValue({ telegramLocale: "ru" });
    mocks.update.mockResolvedValue({});
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await deliverSupportReply(client, "575308044", "готово", "777");
    const send = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(send[0]).toBe("575308044");
    expect(send[1]).toContain("готово");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telegramId: "575308044" }, data: { supportOpen: true } })
    );
  });

  it("notifies the operator and does not set the flag for an unknown user", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const client = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
    await deliverSupportReply(client, "404", "hi", "777");
    const send = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls[0];
    expect(send[0]).toBe("777"); // sent to operator, not the user
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Add the support helpers to `handlers.ts`**

Add near the other matchers/keyboards:

```ts
const SUPPORT_UID_RE = /^🆕 #uid(\d+)/;

export function matchSupportAction(text: string): "close" | null {
  for (const loc of ["en", "ru"] as const) {
    if (text === t(loc).supportCloseBtn) return "close";
  }
  return null;
}

export function getSupportChatId(): string | null {
  const explicit = process.env.SUPPORT_CHAT_ID?.trim();
  if (explicit) return explicit;
  const first = (process.env.REFERRAL_ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first ?? null;
}

function supportKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [[{ text: dict.supportCloseBtn }]],
    is_persistent: true,
    resize_keyboard: true,
  };
}

export function parseSupportReply(
  message: TelegramMessage
): { uid: string } | null {
  const r = message.reply_to_message;
  if (!r?.from?.is_bot) return null;
  const m = SUPPORT_UID_RE.exec(r.text ?? "");
  return m ? { uid: m[1] } : null;
}

async function openSupport(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  dict: Dict
) {
  if (!getSupportChatId()) {
    await client
      .sendMessage(message.chat.id, dict.supportUnavailable)
      .catch(() => undefined);
    return;
  }
  const user = await resolveTelegramUser(from);
  await prisma.user.update({
    where: { id: user.id },
    data: { supportOpen: true },
  });
  await client.sendMessage(message.chat.id, dict.supportPrompt, {
    replyMarkup: supportKeyboard(dict),
  });
}

async function closeSupport(
  client: TelegramClient,
  chatId: number,
  userId: string,
  dict: Dict
) {
  await prisma.user.update({
    where: { id: userId },
    data: { supportOpen: false },
  });
  await client.sendMessage(chatId, dict.supportClosed, {
    replyMarkup: buildMainMenu(dict),
  });
}

export async function relaySupportMessage(
  client: TelegramClient,
  from: TelegramUser,
  text: string
) {
  const chat = getSupportChatId();
  if (!chat) {
    console.warn(
      "Support message received but SUPPORT_CHAT_ID is not configured"
    );
    return;
  }
  const rawName = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const name = rawName.replace(/#uid\d+/g, "").trim() || String(from.id);
  const username = from.username ? ` (@${from.username})` : "";
  const header = `🆕 #uid${from.id} ${name}${username}`;
  await client
    .sendMessage(chat, `${header}\n\n${text}`)
    .catch(() => undefined);
}

export async function deliverSupportReply(
  client: TelegramClient,
  uid: string,
  text: string,
  supportChatId: string | number
) {
  const target = await prisma.user.findUnique({
    where: { telegramId: uid },
    select: { telegramLocale: true },
  });
  if (!target) {
    await client
      .sendMessage(
        supportChatId,
        `⚠️ #uid${uid}: пользователь не найден, ответ не доставлен.`
      )
      .catch(() => undefined);
    return;
  }
  const dict = t(detectLocale(target.telegramLocale ?? undefined));
  try {
    await client.sendMessage(uid, `${dict.supportReplyPrefix}\n${text}`, {
      replyMarkup: supportKeyboard(dict),
    });
  } catch {
    await client
      .sendMessage(
        supportChatId,
        `⚠️ #uid${uid}: не удалось доставить ответ (юзер мог заблокировать бота).`
      )
      .catch(() => undefined);
    return;
  }
  await prisma.user
    .update({ where: { telegramId: uid }, data: { supportOpen: true } })
    .catch(() => undefined);
}
```

- [ ] **Step 4: Extend the `existing` select in `handleUpdate`**

Change the `prisma.user.findUnique` select in `handleUpdate` to:

```ts
    select: { id: true, telegramLocale: true, supportOpen: true },
```

- [ ] **Step 5: Insert operator-reply + close + central-clear at the top of the message path**

In `handleUpdate`, immediately after `const dict = t(locale);` and BEFORE `if (text.startsWith("/start"))`, insert:

```ts
  // Operator answering a support ticket (a Telegram reply to the bot's #uid message).
  if (String(message.chat.id) === getSupportChatId()) {
    const parsed = parseSupportReply(message);
    if (parsed) {
      if (!text) {
        await client
          .sendMessage(
            message.chat.id,
            "⚠️ Ответ должен быть текстом. Ответь текстом на сообщение тикета."
          )
          .catch(() => undefined);
        return;
      }
      await deliverSupportReply(client, parsed.uid, text, message.chat.id);
      return;
    }
  }

  // Close the support session from its reply-keyboard button.
  if (matchSupportAction(text) === "close") {
    const user = await resolveTelegramUser(from);
    await closeSupport(client, message.chat.id, user.id, dict);
    return;
  }

  // Any recognized navigation exits an open support session (no stuck flag).
  if (existing?.supportOpen) {
    const navMatched =
      text.startsWith("/") ||
      (parseMenuCommand(text) ?? matchMenuAction(text)) !== null ||
      matchSettingsAction(text) !== null ||
      matchReferralAction(text) !== null ||
      matchHelpAction(text) !== null;
    if (navMatched) {
      await prisma.user
        .update({ where: { id: existing.id }, data: { supportOpen: false } })
        .catch(() => undefined);
    }
  }
```

- [ ] **Step 6: Insert the relay / media guard before URL extraction**

In `handleUpdate`, the tail currently reads:

```ts
  const source = getVideoSource(message);
  if (source) {
    await handleVideo(client, message, from, source, dict, config);
    return;
  }

  const url = extractVideoUrl(text);
```

Insert the support guard between the `source` block and the `url` line:

```ts
  const source = getVideoSource(message);
  if (source) {
    await handleVideo(client, message, from, source, dict, config);
    return;
  }

  if (existing?.supportOpen) {
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
```

- [ ] **Step 7: Replace the Task-3 support stub (if used)**

Ensure the `matchHelpAction` dispatch `support` branch calls `openSupport(client, message, from, dict)` (not the temporary stub).

- [ ] **Step 8: Document the env var**

In `.env.example`, add near the other Telegram/referral vars:

```
# Telegram chat id that receives in-bot support tickets (defaults to the first
# REFERRAL_ADMIN_TELEGRAM_IDS entry). Must be a PRIVATE chat.
SUPPORT_CHAT_ID=
```

- [ ] **Step 9: Run the support tests + help-menu test**

Run:
```bash
docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/support.test.ts apps/bot/src/__tests__/help-menu.test.ts apps/bot/src/__tests__/support-i18n.test.ts
```
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 11: Commit Task 3 + Task 4 together**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/help-menu.test.ts apps/bot/src/__tests__/support.test.ts .env.example
git commit -m "feat(bot): in-bot support relay + Help sub-menu (How it works / Support)"
```

---

### Task 5: Full verification (coordinator-run)

**Files:** none (verification only)

- [ ] **Step 1: Run the entire bot test suite**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/`
Expected: all pass (existing suites + the 3 new files).

- [ ] **Step 2: Typecheck bot**

Run: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Confirm the bot hot-reloaded cleanly**

Run: `docker compose logs --tail=20 bot`
Expected: `ClipClap Telegram bot starting` after the last restart, no stack traces.

- [ ] **Step 4: Manual smoke (operator = you)**

Ensure `SUPPORT_CHAT_ID` is set to your Telegram id in the prod `.env` (recreate
the bot container if you just added it: `docker compose up -d bot`, then re-run
`prisma generate` in the bot container). Then in Telegram:
1. ❓ Help -> `[❓ How it works] [💬 Support] / [⬅️ Menu]`.
2. "How it works" -> the instruction text.
3. 💬 Support -> prompt + `[⬅️ Close chat]`. Send a message -> it lands in your DM
   as `🆕 #uid<id> ...`.
4. Reply to that message -> the answer arrives back in the user chat with the
   Close keyboard.
5. Tap Close -> "Chat closed" + main menu. Send a video URL -> it processes
   (not relayed).

- [ ] **Step 5: Final code review + finish the branch**

Dispatch a final code review over the whole branch diff, then use
superpowers:finishing-a-development-branch (merge to main + push, per the
established workflow).
