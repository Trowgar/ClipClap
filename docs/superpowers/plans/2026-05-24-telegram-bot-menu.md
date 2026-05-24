# Telegram Bot Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish all Telegram-side discovery surfaces of the ClipClap bot — pre-Start (description, about, commands list), welcome flow copy, and replace the Language menu text prompt with tappable inline buttons.

**Architecture:** Strings live in `apps/bot/src/i18n.ts` per-locale. `TelegramClient` gains three thin profile-config methods. A new `setup.ts` module syncs the bot profile (description/about/commands) for `en` and `ru` once at startup. `handlers.ts` gains callback cases for `lang_en|lang_ru|lang_auto` that share a small `applyLangChoice` helper with the existing `/lang` command.

**Tech Stack:** TypeScript, Telegram Bot API (HTTPS), Prisma (DB), Vitest.

**Spec:** [docs/superpowers/specs/2026-05-24-telegram-bot-menu-design.md](../specs/2026-05-24-telegram-bot-menu-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `apps/bot/src/i18n.ts` | modify | Add `botDescription`, `botShortDescription`, `commands[]`, `langBtnEn/Ru/Auto` fields. Rewrite `welcomeFirstChoice`, shorten `languageMenuPrompt`. |
| `apps/bot/src/telegram-client.ts` | modify | Add `setMyDescription`, `setMyShortDescription`, `setMyCommands` methods. |
| `apps/bot/src/setup.ts` | create | `configureBotProfile(client)` — syncs description/about/commands for both locales at startup. |
| `apps/bot/src/handlers.ts` | modify | Export `parseLangCallback` + `applyLangChoice`. Replace `language` menu action with inline-button prompt. Add `lang_en/ru/auto` callback cases. Define `CALLBACK_LANG_*` constants. |
| `apps/bot/src/index.ts` | modify | Call `configureBotProfile(client)` once at startup before entering polling loop. |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | Length-bound checks for description/about, commands shape check, welcome markers. |
| `apps/bot/src/__tests__/configure-bot-profile.test.ts` | create | Mocked `TelegramClient`, verifies per-locale calls + non-fatal error handling. |
| `apps/bot/src/__tests__/lang-callback.test.ts` | create | Pure `parseLangCallback(data)` mapping test. |

---

## Task 1: i18n strings (description, about, commands, lang buttons, copy rewrites)

**Files:**
- Modify: `apps/bot/src/i18n.ts`
- Test: `apps/bot/src/__tests__/i18n.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/src/__tests__/i18n.test.ts` (inside the existing `describe("bot i18n", ...)` block, just before the closing `});`):

```ts
it("keeps bot description within Telegram's 512-char limit per locale", () => {
  expect(t("en").botDescription.length).toBeGreaterThan(0);
  expect(t("en").botDescription.length).toBeLessThanOrEqual(512);
  expect(t("ru").botDescription.length).toBeGreaterThan(0);
  expect(t("ru").botDescription.length).toBeLessThanOrEqual(512);
});

it("keeps bot short description within Telegram's 120-char limit per locale", () => {
  expect(t("en").botShortDescription.length).toBeGreaterThan(0);
  expect(t("en").botShortDescription.length).toBeLessThanOrEqual(120);
  expect(t("ru").botShortDescription.length).toBeGreaterThan(0);
  expect(t("ru").botShortDescription.length).toBeLessThanOrEqual(120);
});

it("exposes a well-formed commands list per locale", () => {
  for (const loc of ["en", "ru"] as const) {
    const cmds = t(loc).commands;
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c.command).toMatch(/^[a-z]+$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  }
});

it("includes the canonical command set in both locales", () => {
  for (const loc of ["en", "ru"] as const) {
    const names = t(loc).commands.map((c) => c.command);
    expect(names).toEqual(["start", "plans", "account", "help", "lang", "link"]);
  }
});

it("renders a value-pitch welcome with numbered steps for new users", () => {
  expect(t("en").welcomeFirstChoice).toContain("vertical clips");
  expect(t("en").welcomeFirstChoice).toContain("1.");
  expect(t("en").welcomeFirstChoice).toContain("2.");
  expect(t("en").welcomeFirstChoice).toContain("3.");
  expect(t("en").welcomeFirstChoice).toContain("New account");
  expect(t("ru").welcomeFirstChoice).toContain("вертикальные клипы");
  expect(t("ru").welcomeFirstChoice).toContain("1.");
  expect(t("ru").welcomeFirstChoice).toContain("2.");
  expect(t("ru").welcomeFirstChoice).toContain("3.");
  expect(t("ru").welcomeFirstChoice).toContain("Новый аккаунт");
});

it("exposes localized language-button labels", () => {
  expect(t("en").langBtnEn).toContain("English");
  expect(t("en").langBtnRu).toContain("Русский");
  expect(t("en").langBtnAuto.toLowerCase()).toContain("auto");
  expect(t("ru").langBtnEn).toContain("English");
  expect(t("ru").langBtnRu).toContain("Русский");
  expect(t("ru").langBtnAuto.toLowerCase()).toContain("авто");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: Six new tests fail with errors like `Cannot read properties of undefined (reading 'length')` and "expected undefined to contain ..." because the new `Dict` fields don't exist yet.

- [ ] **Step 3: Extend the `Dict` interface and add fields**

In `apps/bot/src/i18n.ts`, modify the `Dict` interface — add these fields anywhere inside the interface body:

```ts
export interface Dict {
  // ... existing fields ...
  botDescription: string;
  botShortDescription: string;
  commands: Array<{ command: string; description: string }>;
  langBtnEn: string;
  langBtnRu: string;
  langBtnAuto: string;
}
```

(Keep all existing fields exactly as they are — only add the six new ones.)

- [ ] **Step 4: Fill in EN dictionary values**

In `apps/bot/src/i18n.ts`, inside `const en: Dict = { ... }`, add these entries (keep the existing entries; add these near the bottom, before the closing `}`):

```ts
  botDescription:
    "ClipClap turns long videos into short vertical clips with subtitles — ready for TikTok, Reels and Shorts.\n\nSend a video (up to 3 hours) — I'll find the highlights, cut them and burn in subtitles automatically.\n\nHow it works:\n1. Pick a plan\n2. Send a video\n3. Receive your clips\n\nTap START to begin.",
  botShortDescription:
    "Long video → vertical clips with subtitles. Send a video to start.",
  commands: [
    { command: "start", description: "Show main menu" },
    { command: "plans", description: "Choose a subscription" },
    { command: "account", description: "Your plan and stats" },
    { command: "help", description: "Limits and how it works" },
    { command: "lang", description: "Switch language" },
    { command: "link", description: "Connect your clipclap.io account" },
  ],
  langBtnEn: "🇬🇧 English",
  langBtnRu: "🇷🇺 Русский",
  langBtnAuto: "🤖 Auto-detect",
```

Then replace the existing `welcomeFirstChoice` value in the `en` dict with:

```ts
  welcomeFirstChoice:
    "Hi! I turn long videos into vertical clips with subtitles — ready for TikTok, Reels and Shorts.\n\nHow it works:\n1. Pick a plan\n2. Send a video (up to 3 hours)\n3. Get 5–15 short clips back\n\nFirst — how do you want to set up?\n\n• New account — use this Telegram as your ClipClap account.\n• I already have an account — link this Telegram to your existing clipclap.io account.",
```

And replace the existing `languageMenuPrompt` value in the `en` dict with:

```ts
  languageMenuPrompt: "Pick a language:",
```

- [ ] **Step 5: Fill in RU dictionary values**

In `apps/bot/src/i18n.ts`, inside `const ru: Dict = { ... }`, add these entries near the bottom:

```ts
  botDescription:
    "ClipClap нарезает длинные видео на короткие вертикальные клипы с субтитрами — для TikTok, Reels и Shorts.\n\nПришли видео (до 3 часов) — найду самые цепляющие моменты, нарежу и наложу субтитры автоматически.\n\nКак это работает:\n1. Выбери тариф\n2. Пришли видео\n3. Получи клипы\n\nЖми START.",
  botShortDescription:
    "Длинное видео → вертикальные клипы с субтитрами. Пришли видео — нарежу.",
  commands: [
    { command: "start", description: "Главное меню" },
    { command: "plans", description: "Выбрать тариф" },
    { command: "account", description: "Тариф и статистика" },
    { command: "help", description: "Лимиты и как работает" },
    { command: "lang", description: "Сменить язык" },
    { command: "link", description: "Привязать аккаунт clipclap.io" },
  ],
  langBtnEn: "🇬🇧 English",
  langBtnRu: "🇷🇺 Русский",
  langBtnAuto: "🤖 Авто-определение",
```

Replace the existing `welcomeFirstChoice` value in the `ru` dict with:

```ts
  welcomeFirstChoice:
    "Привет! Нарезаю длинные видео на вертикальные клипы с субтитрами — для TikTok, Reels и Shorts.\n\nКак это работает:\n1. Выбери тариф\n2. Пришли видео (до 3 часов)\n3. Получи 5–15 коротких клипов\n\nСначала — как тебе удобнее начать?\n\n• Новый аккаунт — Telegram станет твоим аккаунтом ClipClap.\n• Уже есть аккаунт — привяжем этот Telegram к существующему аккаунту на clipclap.io.",
```

Replace the existing `languageMenuPrompt` value in the `ru` dict with:

```ts
  languageMenuPrompt: "Выбери язык:",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: All tests pass (including the six new ones).

- [ ] **Step 7: Run full suite + typecheck**

Run: `npx vitest run && npm run typecheck -w @clipfast/bot`
Expected: All green.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/__tests__/i18n.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): add description, about, commands list i18n + rewrite first-time welcome"
```

---

## Task 2: TelegramClient profile methods

**Files:**
- Modify: `apps/bot/src/telegram-client.ts`

These methods are thin wrappers over `setMyDescription` / `setMyShortDescription` / `setMyCommands`. No new tests — the existing `request()` helper is already exercised by other methods, and Task 3's `configure-bot-profile.test.ts` will cover the call shapes via a mocked client.

- [ ] **Step 1: Add the three methods**

In `apps/bot/src/telegram-client.ts`, add these three methods inside the `TelegramClient` class (after `answerCallbackQuery`, before `sendVideo`):

```ts
  async setMyDescription(description: string, languageCode?: string) {
    return this.request("setMyDescription", {
      description,
      language_code: languageCode,
    });
  }

  async setMyShortDescription(shortDescription: string, languageCode?: string) {
    return this.request("setMyShortDescription", {
      short_description: shortDescription,
      language_code: languageCode,
    });
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    languageCode?: string
  ) {
    return this.request("setMyCommands", {
      commands,
      language_code: languageCode,
    });
  }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @clipfast/bot`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/bot/src/telegram-client.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): add setMyDescription/ShortDescription/Commands client methods"
```

---

## Task 3: `configureBotProfile` module + startup wiring

**Files:**
- Create: `apps/bot/src/setup.ts`
- Modify: `apps/bot/src/index.ts`
- Test: `apps/bot/src/__tests__/configure-bot-profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/configure-bot-profile.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { configureBotProfile } from "../setup";
import { t } from "../i18n";

function makeStubClient() {
  return {
    setMyDescription: vi.fn().mockResolvedValue(true),
    setMyShortDescription: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
  };
}

describe("configureBotProfile", () => {
  it("syncs description, short description and commands for en and ru", async () => {
    const client = makeStubClient();
    await configureBotProfile(client as never);

    expect(client.setMyDescription).toHaveBeenCalledTimes(2);
    expect(client.setMyDescription).toHaveBeenCalledWith(
      t("en").botDescription,
      "en"
    );
    expect(client.setMyDescription).toHaveBeenCalledWith(
      t("ru").botDescription,
      "ru"
    );

    expect(client.setMyShortDescription).toHaveBeenCalledTimes(2);
    expect(client.setMyShortDescription).toHaveBeenCalledWith(
      t("en").botShortDescription,
      "en"
    );
    expect(client.setMyShortDescription).toHaveBeenCalledWith(
      t("ru").botShortDescription,
      "ru"
    );

    expect(client.setMyCommands).toHaveBeenCalledTimes(2);
    expect(client.setMyCommands).toHaveBeenCalledWith(t("en").commands, "en");
    expect(client.setMyCommands).toHaveBeenCalledWith(t("ru").commands, "ru");
  });

  it("does not throw when the client fails — logs a warning instead", async () => {
    const client = {
      setMyDescription: vi
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(true),
      setMyShortDescription: vi.fn().mockResolvedValue(true),
      setMyCommands: vi.fn().mockResolvedValue(true),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(configureBotProfile(client as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/bot/src/__tests__/configure-bot-profile.test.ts`
Expected: FAIL — module `../setup` not found.

- [ ] **Step 3: Create the `setup.ts` module**

Create `apps/bot/src/setup.ts`:

```ts
import type { TelegramClient } from "./telegram-client";
import { t, type Locale } from "./i18n";

const LOCALES: Locale[] = ["en", "ru"];

export async function configureBotProfile(client: TelegramClient): Promise<void> {
  for (const locale of LOCALES) {
    const dict = t(locale);
    try {
      await client.setMyDescription(dict.botDescription, locale);
      await client.setMyShortDescription(dict.botShortDescription, locale);
      await client.setMyCommands(dict.commands, locale);
    } catch (error) {
      console.warn(
        `Bot profile sync failed for locale=${locale}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/bot/src/__tests__/configure-bot-profile.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Wire into bot startup**

Edit `apps/bot/src/index.ts`. Replace the existing imports + initial logging block with:

```ts
import { TelegramClient } from "./telegram-client";
import { deliverReadyTelegramJobs, handleUpdate } from "./handlers";
import { configureBotProfile } from "./setup";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL;
const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || "https://clipclap.io";
const tributeUrls = {
  starterWeekly: process.env.TRIBUTE_PRODUCT_STARTER_WEEKLY_URL,
  starter: process.env.TRIBUTE_PRODUCT_STARTER_MONTHLY_URL,
  plus: process.env.TRIBUTE_PRODUCT_PLUS_MONTHLY_URL,
  max: process.env.TRIBUTE_PRODUCT_MAX_MONTHLY_URL,
};
const client = new TelegramClient(token, apiBaseUrl);
console.log(`Telegram API base: ${apiBaseUrl || "cloud (api.telegram.org)"}`);
let offset: number | undefined;
let running = true;

console.log("ClipClap Telegram bot starting");

void (async () => {
  await configureBotProfile(client);
  console.log("Bot profile synced (en, ru)");
})();

void pollUpdates();
void pollDeliveries();
```

(Everything below — `process.on(...)`, `pollUpdates`, `pollDeliveries`, `shutdown`, `sleep` — stays unchanged.)

- [ ] **Step 6: Typecheck + full test run**

Run: `npm run typecheck -w @clipfast/bot && npx vitest run`
Expected: All green.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/setup.ts apps/bot/src/index.ts apps/bot/src/__tests__/configure-bot-profile.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): sync description/about/commands per locale at startup"
```

---

## Task 4: Language inline buttons + callback handlers

**Files:**
- Modify: `apps/bot/src/handlers.ts`
- Test: `apps/bot/src/__tests__/lang-callback.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/src/__tests__/lang-callback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CALLBACK_LANG_AUTO,
  CALLBACK_LANG_EN,
  CALLBACK_LANG_RU,
  parseLangCallback,
} from "../handlers";

describe("parseLangCallback", () => {
  it("maps known callback data to a language choice", () => {
    expect(parseLangCallback(CALLBACK_LANG_EN)).toBe("en");
    expect(parseLangCallback(CALLBACK_LANG_RU)).toBe("ru");
    expect(parseLangCallback(CALLBACK_LANG_AUTO)).toBe("auto");
  });

  it("returns null for unknown or empty data", () => {
    expect(parseLangCallback("")).toBeNull();
    expect(parseLangCallback("new_acc")).toBeNull();
    expect(parseLangCallback("lang_de")).toBeNull();
    expect(parseLangCallback(undefined)).toBeNull();
  });

  it("exposes stable callback-data constants", () => {
    expect(CALLBACK_LANG_EN).toBe("lang_en");
    expect(CALLBACK_LANG_RU).toBe("lang_ru");
    expect(CALLBACK_LANG_AUTO).toBe("lang_auto");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/bot/src/__tests__/lang-callback.test.ts`
Expected: FAIL — `CALLBACK_LANG_EN` etc. not exported, `parseLangCallback` not defined.

- [ ] **Step 3: Add constants and parser to handlers.ts**

In `apps/bot/src/handlers.ts`, add these exports right after the existing `CALLBACK_LINK_ACCOUNT` constant:

```ts
export const CALLBACK_LANG_EN = "lang_en";
export const CALLBACK_LANG_RU = "lang_ru";
export const CALLBACK_LANG_AUTO = "lang_auto";

export function parseLangCallback(
  data: string | undefined
): "en" | "ru" | "auto" | null {
  if (!data) return null;
  if (data === CALLBACK_LANG_EN) return "en";
  if (data === CALLBACK_LANG_RU) return "ru";
  if (data === CALLBACK_LANG_AUTO) return "auto";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/bot/src/__tests__/lang-callback.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `handleLang` — extract `applyLangChoice` helper**

This deduplicates the persistence + locale-resolution logic so the callback handler can reuse it.

In `apps/bot/src/handlers.ts`, replace the existing `handleLang` function with:

```ts
async function applyLangChoice(
  from: TelegramUser,
  choice: "en" | "ru" | "auto"
): Promise<{ dict: Dict; ack: string }> {
  const user = await resolveTelegramUser(from);
  const stored: string | null = choice === "auto" ? null : choice;
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramLocale: stored },
  });

  const effectiveLocale: Locale =
    choice === "en"
      ? "en"
      : choice === "ru"
        ? "ru"
        : detectLocale(from.language_code);
  const dict = t(effectiveLocale);

  const ack =
    choice === "en"
      ? dict.langSetEn
      : choice === "ru"
        ? dict.langSetRu
        : dict.langSetAuto;

  return { dict, ack };
}

async function handleLang(
  client: TelegramClient,
  message: TelegramMessage,
  from: TelegramUser,
  choice: ReturnType<typeof parseLangCommand>,
  currentDict: Dict
) {
  if (choice === "usage" || choice === null) {
    await client.sendMessage(message.chat.id, currentDict.langUsage);
    return;
  }

  const { ack } = await applyLangChoice(from, choice);
  await client.sendMessage(message.chat.id, ack);
}
```

- [ ] **Step 6: Replace the `language` case in `handleMenuAction`**

Find the `case "language":` block inside `handleMenuAction` and replace it with:

```ts
    case "language": {
      await client.sendMessage(message.chat.id, dict.languageMenuPrompt, {
        replyMarkup: languageKeyboard(dict),
      });
      return;
    }
```

Then add this helper function near `firstChoiceKeyboard` (around line 358):

```ts
function languageKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.langBtnEn, callback_data: CALLBACK_LANG_EN }],
      [{ text: dict.langBtnRu, callback_data: CALLBACK_LANG_RU }],
      [{ text: dict.langBtnAuto, callback_data: CALLBACK_LANG_AUTO }],
    ],
  };
}
```

- [ ] **Step 7: Add callback cases for lang_en/lang_ru/lang_auto**

In `handleCallbackQuery`, find the `switch (query.data)` block. Add three new cases between `CALLBACK_LINK_ACCOUNT` and `default`:

```ts
    case CALLBACK_LANG_EN:
    case CALLBACK_LANG_RU:
    case CALLBACK_LANG_AUTO: {
      const choice = parseLangCallback(query.data)!;
      const { ack } = await applyLangChoice(query.from, choice);
      await client
        .editMessageText(
          query.message.chat.id,
          query.message.message_id,
          ack
        )
        .catch(() => undefined);
      return;
    }
```

- [ ] **Step 8: Typecheck + full test run**

Run: `npm run typecheck -w @clipfast/bot && npx vitest run`
Expected: All green. (132 → ~138 tests passing.)

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/lang-callback.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): tappable language switcher with inline buttons"
```

---

## Task 5: Manual verification

**No new code.** Sanity check on a fresh Telegram client.

- [ ] **Step 1: Rebuild the bot container**

Run: `docker compose up -d --build bot`
Expected: Container comes up healthy, logs show `Bot profile synced (en, ru)`.

- [ ] **Step 2: Verify pre-Start surfaces**

In a Telegram account that has never used the bot (or after running `/stop` in BotFather then re-adding it):
- Open the bot's profile — the short description should match `t("en").botShortDescription` (or RU if Telegram client language is Russian).
- On the empty chat screen above the START button, the big description should match `t("en").botDescription` / `t("ru").botDescription`.
- Type `/` in the chat — the autocomplete dropdown should show `start, plans, account, help, lang, link` with the new localized descriptions.

- [ ] **Step 3: Verify first-time welcome**

In a fresh Telegram account:
- Tap START.
- The welcome should contain "vertical clips" (EN) or "вертикальные клипы" (RU), include the three numbered steps, and offer the two account-choice buttons.

- [ ] **Step 4: Verify language switcher**

- Tap the 🌐 Language button on the persistent keyboard.
- Confirm a short prompt ("Pick a language:" / "Выбери язык:") appears with three inline buttons (English / Русский / Auto-detect).
- Tap Русский — message should edit to "Язык установлен: русский." and subsequent bot messages should appear in Russian.
- Tap 🌐 Язык again → tap English → message edits to "Language set to English." Subsequent messages return to English.
- Tap Auto-detect — message edits to the auto-set confirmation; behavior reverts to Telegram client language.

- [ ] **Step 5: Verify nothing else broke**

- Send `/start` as an existing user with an active plan → reply keyboard appears, no regression.
- Tap 💎 Plans → tariff inline buttons appear (unchanged behavior).
- Tap 📊 Account → plan/clip stats render.
- Tap ❓ Help → help text renders.
- Drop a small video → "Uploading..." → "Queued..." flow as before.

---

## Self-review notes

**Spec coverage:**
- Section 1 (pre-Start) → Tasks 1 (strings) + 2 (client methods) + 3 (startup sync).
- Section 2 (welcome flow) → Task 1 (welcomeFirstChoice rewrite). Returning-user paths unchanged per spec.
- Section 3 (reply keyboard) → no task; spec explicitly says no change.
- Section 4 (Language menu) → Task 4.
- Section 5 (implementation) → Tasks 1–4 mirror the file map.
- Manual deployment & verification → Task 5.

**Risks / things to watch:**
- `setMyCommands` writes apply globally to the bot for the given language code; existing users will see the new descriptions in `/` immediately on bot restart.
- `setMyDescription` is shown only on **empty** chats — existing users with chat history won't see the new big description (Telegram intentionally hides it once a conversation starts). This is a Telegram constraint, not a bug.
- Sync runs on every bot startup. Telegram has light rate limits on these endpoints but they're sufficient for restart-time use. Idempotent on the Telegram side — re-sending the same content is a no-op.
