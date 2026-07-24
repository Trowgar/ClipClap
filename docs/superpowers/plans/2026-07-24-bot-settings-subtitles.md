# Bot Settings Sub-menu + Subtitle Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the bot's Settings into a reply-keyboard sub-menu (Language / Video settings), make Language RU/EN only (remove Auto), and add a subtitles on/off toggle that a Telegram user's videos actually respect.

**Architecture:** Persist `User.subtitlesEnabled` (default true); the two bot video-submission sites snapshot it onto the existing `Job.subtitles`, which the worker already gates burn-in on (no worker changes). Settings navigation uses reply keyboards + text matching (like `matchMenuAction`); language and the subtitle toggle are inline keyboards edited in place.

**Tech Stack:** TypeScript, a plain polling Telegram bot (`apps/bot`), Prisma, Vitest (runs **inside the `bot` container**; host Node 18 cannot run it).

**Design spec:** `docs/superpowers/specs/2026-07-24-bot-settings-subtitles-design.md`

**Branch:** `feat/bot-settings-subtitles` (already checked out).

## Conventions

- Commit identity: `git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "..."`. No attribution trailer. Plain hyphens, never em-dashes.
- Bot tests: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/<file>`
- Bot typecheck: `docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit`

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | `User.subtitlesEnabled Boolean @default(true)` |
| `prisma/migrations/20260724120000_user_subtitles_enabled/migration.sql` | Create | Forward migration |
| `apps/bot/src/i18n.ts` | Modify | Remove Auto strings; add settings sub-menu + subtitle strings (EN+RU) |
| `apps/bot/src/handlers.ts` | Modify | Language-Auto removal; subtitle toggle; settings reply sub-menu + nav; read `subtitlesEnabled` at job creation |
| `apps/bot/src/__tests__/settings.test.ts` | Create | i18n + keyboards + matcher + toggle tests |

---

## Task 1: Schema - `User.subtitlesEnabled`

**Files:**
- Modify: `prisma/schema.prisma` (User model, ~103-146)
- Create: `prisma/migrations/20260724120000_user_subtitles_enabled/migration.sql`

- [ ] **Step 1: Add the field to the `User` model**

In `prisma/schema.prisma`, in the `User` model, add this line right after `telegramLocale String?` (line 109):

```prisma
  subtitlesEnabled      Boolean            @default(true)
```

- [ ] **Step 2: Hand-author the migration**

Create `prisma/migrations/20260724120000_user_subtitles_enabled/migration.sql`:

```sql
ALTER TABLE "users" ADD COLUMN "subtitlesEnabled" BOOLEAN NOT NULL DEFAULT true;
```

- [ ] **Step 3: Apply + regenerate the client in every service container**

```bash
docker compose exec -T web npx prisma migrate deploy --schema /app/prisma/schema.prisma
for c in web bot worker-analyze worker-download worker-render worker-transcribe worker-finalize; do
  docker compose exec -T "$c" npx prisma generate --schema /app/prisma/schema.prisma >/dev/null 2>&1 && echo "generated: $c" || echo "FAILED: $c"
done
```
Expected: "Applied migration ... 20260724120000_user_subtitles_enabled", then "generated: <c>" for each. `User.subtitlesEnabled` is now on the Prisma `User` type. (Worker code is unchanged, but its client type must include the field.)

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260724120000_user_subtitles_enabled/migration.sql
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): add User.subtitlesEnabled preference"
```

---

## Task 2: i18n - remove Auto, add settings + subtitle strings

**Files:**
- Modify: `apps/bot/src/i18n.ts` (Dict type ~52-90; EN dict ~150-239; RU dict ~305-401)
- Create: `apps/bot/src/__tests__/settings.test.ts`

- [ ] **Step 1: Write the failing i18n test**

Create `apps/bot/src/__tests__/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { t } from "../i18n";

describe("settings i18n", () => {
  it("has settings sub-menu labels in both locales", () => {
    expect(t("en").settingsLangBtn).toBe("🌐 Language");
    expect(t("ru").settingsLangBtn).toBe("🌐 Язык");
    expect(t("en").settingsVideoBtn).toBe("🎬 Video settings");
    expect(t("ru").settingsVideoBtn).toBe("🎬 Настройки видео");
    expect(t("en").settingsBackBtn).toBe("⬅️ Menu");
    expect(t("ru").settingsBackBtn).toBe("⬅️ Меню");
  });

  it("renders the subtitle toggle label and ack per state", () => {
    expect(t("en").subtitlesToggleBtn(true)).toContain("on");
    expect(t("en").subtitlesToggleBtn(false)).toContain("off");
    expect(t("ru").subtitlesToggleBtn(true)).toContain("вкл");
    expect(t("ru").subtitlesToggleBtn(false)).toContain("выкл");
    expect(t("ru").subtitlesAck(false)).toContain("выключены");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts`
Expected: FAIL - `settingsLangBtn` / `subtitlesToggleBtn` undefined.

- [ ] **Step 3: Update the `Dict` type**

In `apps/bot/src/i18n.ts`:
- Delete line 54 `langSetAuto: string;` and line 90 `langBtnAuto: string;`.
- After `settingsMenuPrompt: string;` (line 83) add:
```ts
  settingsLangBtn: string;
  settingsVideoBtn: string;
  settingsBackBtn: string;
  langMenuPrompt: string;
  videoSettingsPrompt: string;
  subtitlesToggleBtn: (enabled: boolean) => string;
  subtitlesAck: (enabled: boolean) => string;
```

- [ ] **Step 4: Update the EN dict**

- Change `settingsMenuPrompt: "Settings:",` (line 222) to `settingsMenuPrompt: "⚙️ Settings",`.
- Delete EN `langSetAuto: "Auto language detection enabled.",` (line 152) and `langBtnAuto: "🤖 Auto-detect",` (line 239).
- After EN `settingsMenuPrompt` add:
```ts
  settingsLangBtn: "🌐 Language",
  settingsVideoBtn: "🎬 Video settings",
  settingsBackBtn: "⬅️ Menu",
  langMenuPrompt: "Choose your language:",
  videoSettingsPrompt: "🎬 Video settings",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Subtitles: on ✅" : "Subtitles: off ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Subtitles turned on."
      : "Subtitles turned off. New videos won't have burned-in subtitles.",
```

- [ ] **Step 5: Update the RU dict**

- Change `settingsMenuPrompt: "Настройки:",` (line 384) to `settingsMenuPrompt: "⚙️ Настройки",`.
- Delete RU `langSetAuto: "Авто-определение языка включено.",` (line 307) and `langBtnAuto: "🤖 Авто-определение",` (line 401).
- After RU `settingsMenuPrompt` add:
```ts
  settingsLangBtn: "🌐 Язык",
  settingsVideoBtn: "🎬 Настройки видео",
  settingsBackBtn: "⬅️ Меню",
  langMenuPrompt: "Выбери язык:",
  videoSettingsPrompt: "🎬 Настройки видео",
  subtitlesToggleBtn: (enabled) =>
    enabled ? "Субтитры: вкл ✅" : "Субтитры: выкл ⬜",
  subtitlesAck: (enabled) =>
    enabled
      ? "Субтитры включены."
      : "Субтитры выключены. На новых видео субтитров не будет.",
```

- [ ] **Step 6: Run the test**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts`
Expected: the i18n tests PASS. (`handlers.ts` may not typecheck yet because it still references `langBtnAuto`/`langSetAuto`/`CALLBACK_LANG_AUTO` - fixed in Task 3. Do not commit until Task 3.)

> Tasks 2-3 share a commit (Task 3 finishes the Auto removal that `handlers.ts` needs to compile). Commit at Task 3 Step 6.

---

## Task 3: Language - remove Auto

**Files:**
- Modify: `apps/bot/src/handlers.ts` (`CALLBACK_LANG_AUTO` line 59; `parseLangCallback` 73-81; `languageKeyboard` 573-581; `applyLangChoice` 708-735; the `CALLBACK_LANG_*` dispatch 545-558)

- [ ] **Step 1: Add the failing test**

Append to `apps/bot/src/__tests__/settings.test.ts`:

```ts
import { languageKeyboard, parseLangCallback } from "../handlers";

describe("language without Auto", () => {
  it("parseLangCallback no longer accepts auto", () => {
    expect(parseLangCallback("lang_en")).toBe("en");
    expect(parseLangCallback("lang_ru")).toBe("ru");
    expect(parseLangCallback("lang_auto")).toBeNull();
  });

  it("languageKeyboard has only Russian and English", () => {
    const kb = JSON.stringify(languageKeyboard(t("en")));
    expect(kb).toContain("lang_en");
    expect(kb).toContain("lang_ru");
    expect(kb).not.toContain("lang_auto");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts`
Expected: FAIL - `languageKeyboard` not exported; `parseLangCallback("lang_auto")` still returns `"auto"`.

- [ ] **Step 3: Remove the Auto callback constant**

In `apps/bot/src/handlers.ts` delete line 59:
```ts
export const CALLBACK_LANG_AUTO = "lang_auto";
```

- [ ] **Step 4: Simplify `parseLangCallback`**

Replace `parseLangCallback` (lines 73-81) with:
```ts
export function parseLangCallback(data: string | undefined): "en" | "ru" | null {
  if (!data) return null;
  if (data === CALLBACK_LANG_EN) return "en";
  if (data === CALLBACK_LANG_RU) return "ru";
  return null;
}
```

- [ ] **Step 5: Export + trim `languageKeyboard`; simplify `applyLangChoice`; fix dispatch**

Replace `languageKeyboard` (lines 573-581) with:
```ts
export function languageKeyboard(dict: Dict): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.langBtnEn, callback_data: CALLBACK_LANG_EN }],
      [{ text: dict.langBtnRu, callback_data: CALLBACK_LANG_RU }],
    ],
  };
}
```

Replace `applyLangChoice` (lines 708-735) with:
```ts
async function applyLangChoice(
  from: TelegramUser,
  choice: "en" | "ru"
): Promise<string> {
  const user = await resolveTelegramUser(from);
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramLocale: choice },
  });
  const dict = t(choice);
  return choice === "en" ? dict.langSetEn : dict.langSetRu;
}
```

In `handleCallbackQuery`, replace the language dispatch (lines 545-558) with:
```ts
    case CALLBACK_LANG_EN:
    case CALLBACK_LANG_RU: {
      const choice = parseLangCallback(query.data)!;
      const ack = await applyLangChoice(query.from, choice);
      await client
        .editMessageText(query.message.chat.id, query.message.message_id, ack)
        .catch(() => undefined);
      return;
    }
```

- [ ] **Step 6: Run tests + typecheck, then commit Tasks 2-3**

Run:
```bash
docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: settings tests pass; tsc clean (no more `langBtnAuto`/`langSetAuto`/`CALLBACK_LANG_AUTO` references).

```bash
git add apps/bot/src/i18n.ts apps/bot/src/handlers.ts apps/bot/src/__tests__/settings.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): language settings RU/EN only (remove Auto)"
```

---

## Task 4: Subtitle toggle + job wiring

**Files:**
- Modify: `apps/bot/src/handlers.ts` (add callback const + `subtitlesKeyboard` + `handleSubtitlesToggle` + dispatch; the two `createJob` sites at ~890 and ~936)
- Modify: `apps/bot/src/__tests__/settings.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `apps/bot/src/__tests__/settings.test.ts`:

```ts
import { vi } from "vitest";
import { subtitlesKeyboard } from "../handlers";

describe("subtitlesKeyboard", () => {
  it("renders the toggle with the current state + toggle callback", () => {
    const on = JSON.stringify(subtitlesKeyboard(t("en"), true));
    expect(on).toContain("subs_toggle");
    expect(on).toContain("on");
    const off = JSON.stringify(subtitlesKeyboard(t("ru"), false));
    expect(off).toContain("subs_toggle");
    expect(off).toContain("выкл");
  });
});

const toggleMocks = vi.hoisted(() => ({
  findOrCreateTelegramUser: vi.fn(),
  userUpdate: vi.fn(),
}));
vi.mock("@clipclap/shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    findOrCreateTelegramUser: toggleMocks.findOrCreateTelegramUser,
    prisma: { user: { update: toggleMocks.userUpdate } },
  };
});

import { handleSubtitlesToggle } from "../handlers";

describe("handleSubtitlesToggle", () => {
  it("flips subtitlesEnabled and edits the message to the new state", async () => {
    toggleMocks.findOrCreateTelegramUser.mockResolvedValue({ id: "u1", subtitlesEnabled: true });
    toggleMocks.userUpdate.mockResolvedValue({});
    const client = { editMessageText: vi.fn().mockResolvedValue(undefined) } as never;
    const query = { id: "q", from: { id: 42 }, message: { chat: { id: 7 }, message_id: 3 } };

    await handleSubtitlesToggle(client, query as never, t("en"));

    expect(toggleMocks.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: { subtitlesEnabled: false } })
    );
    const edit = (client as unknown as { editMessageText: ReturnType<typeof vi.fn> }).editMessageText.mock.calls[0];
    expect(JSON.stringify(edit)).toContain("off"); // toggled to off
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts`
Expected: FAIL - `subtitlesKeyboard` / `handleSubtitlesToggle` not exported.

- [ ] **Step 3: Add the callback constant**

In `apps/bot/src/handlers.ts`, next to the other `CALLBACK_*` constants (after `CALLBACK_LANG_RU`, ~line 58) add:
```ts
export const CALLBACK_SUBTITLES_TOGGLE = "subs_toggle";
```

- [ ] **Step 4: Add `subtitlesKeyboard` + `handleSubtitlesToggle`**

Add near `languageKeyboard` in `apps/bot/src/handlers.ts`:
```ts
export function subtitlesKeyboard(dict: Dict, enabled: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: dict.subtitlesToggleBtn(enabled), callback_data: CALLBACK_SUBTITLES_TOGGLE }],
    ],
  };
}

export async function handleSubtitlesToggle(
  client: TelegramClient,
  query: TelegramCallbackQuery,
  dict: Dict
): Promise<void> {
  if (!query.message || !query.from) return;
  const user = await resolveTelegramUser(query.from);
  const enabled = !user.subtitlesEnabled;
  await prisma.user.update({
    where: { id: user.id },
    data: { subtitlesEnabled: enabled },
  });
  await client
    .editMessageText(query.message.chat.id, query.message.message_id, dict.subtitlesAck(enabled), {
      replyMarkup: subtitlesKeyboard(dict, enabled),
    })
    .catch(() => undefined);
}
```

- [ ] **Step 5: Dispatch the toggle callback**

In `handleCallbackQuery`, right after the `sub:` startsWith check and before the `switch (query.data)` (the same spot the `CALLBACK_NEW_ACCOUNT` etc. cases live), add a `case` inside the switch:
```ts
    case CALLBACK_SUBTITLES_TOGGLE: {
      await handleSubtitlesToggle(client, query, dict);
      return;
    }
```

- [ ] **Step 6: Read `subtitlesEnabled` at job creation (both sites)**

In `handleVideo` (the `jobService.createJob({...})` near line 890) change `subtitles: true,` to `subtitles: user.subtitlesEnabled,`.
In `handleVideoUrl` (the `jobService.createJob({...})` near line 936) change `subtitles: true,` to `subtitles: user.subtitlesEnabled,`.
(Both paths already have `const user = await resolveTelegramUser(from);` returning the full `User`, so `user.subtitlesEnabled` is available.)

- [ ] **Step 7: Run tests + typecheck, then commit**

Run:
```bash
docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: all settings tests pass; tsc clean.

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/settings.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): subtitle on/off toggle; jobs respect the user preference"
```

---

## Task 5: Settings reply sub-menu + navigation

**Files:**
- Modify: `apps/bot/src/handlers.ts` (add `settingsKeyboard` + `matchSettingsAction` + `handleSettingsAction`; change the `settings` menu action; dispatch in `handleUpdate`)
- Modify: `apps/bot/src/__tests__/settings.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `apps/bot/src/__tests__/settings.test.ts`:

```ts
import { matchSettingsAction } from "../handlers";

describe("matchSettingsAction", () => {
  it("matches the three sub-menu buttons in both locales", () => {
    expect(matchSettingsAction("🌐 Language")).toBe("lang");
    expect(matchSettingsAction("🌐 Язык")).toBe("lang");
    expect(matchSettingsAction("🎬 Video settings")).toBe("video");
    expect(matchSettingsAction("🎬 Настройки видео")).toBe("video");
    expect(matchSettingsAction("⬅️ Menu")).toBe("menu");
    expect(matchSettingsAction("⬅️ Меню")).toBe("menu");
    expect(matchSettingsAction("something else")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -T -w /app bot npx vitest run apps/bot/src/__tests__/settings.test.ts`
Expected: FAIL - `matchSettingsAction` not exported.

- [ ] **Step 3: Add `settingsKeyboard` + `matchSettingsAction`**

In `apps/bot/src/handlers.ts` (near `buildMainMenu` / `matchMenuAction`) add:
```ts
export type SettingsAction = "lang" | "video" | "menu";

export function matchSettingsAction(text: string): SettingsAction | null {
  for (const loc of ["en", "ru"] as const) {
    const d = t(loc);
    if (text === d.settingsLangBtn) return "lang";
    if (text === d.settingsVideoBtn) return "video";
    if (text === d.settingsBackBtn) return "menu";
  }
  return null;
}

function settingsKeyboard(dict: Dict): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: dict.settingsLangBtn }, { text: dict.settingsVideoBtn }],
      [{ text: dict.settingsBackBtn }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}
```

- [ ] **Step 4: Settings action shows the reply sub-menu**

Replace the `case "settings":` block in `handleMenuAction` (lines 230-235) with:
```ts
    case "settings": {
      await client.sendMessage(message.chat.id, dict.settingsMenuPrompt, {
        replyMarkup: settingsKeyboard(dict),
      });
      return;
    }
```

- [ ] **Step 5: Add `handleSettingsAction` + dispatch in `handleUpdate`**

Add this function (near `handleMenuAction`):
```ts
async function handleSettingsAction(
  client: TelegramClient,
  message: TelegramMessage,
  action: SettingsAction,
  dict: Dict
) {
  switch (action) {
    case "lang": {
      await client.sendMessage(message.chat.id, dict.langMenuPrompt, {
        replyMarkup: languageKeyboard(dict),
      });
      return;
    }
    case "video": {
      const user = await resolveTelegramUser(message.from!);
      await client.sendMessage(message.chat.id, dict.videoSettingsPrompt, {
        replyMarkup: subtitlesKeyboard(dict, user.subtitlesEnabled),
      });
      return;
    }
    case "menu": {
      await client.sendMessage(message.chat.id, dict.welcomeBack, {
        replyMarkup: buildMainMenu(dict),
      });
      return;
    }
  }
}
```

In `handleUpdate`, right after the `matchMenuAction` dispatch block (lines 184-188) add:
```ts
  const settingsAction = matchSettingsAction(text);
  if (settingsAction) {
    await handleSettingsAction(client, message, settingsAction, dict);
    return;
  }
```

- [ ] **Step 6: Run the full bot suite + typecheck**

Run:
```bash
docker compose exec -T -w /app bot npx vitest run apps/bot
docker compose exec -T -w /app/apps/bot bot npx tsc --noEmit
```
Expected: all bot tests pass (existing + new settings.test.ts); tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/settings.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): Settings reply sub-menu (Language / Video settings)"
```

---

## Task 6: Live verification

- [ ] **Step 1: Restart the bot**

```bash
docker compose restart bot
docker compose logs --tail=5 bot
```
Expected: "ClipClap Telegram bot starting".

- [ ] **Step 2: Manual smoke (in @clipclapio_bot)**

- ⚙️ Settings -> reply keyboard `[🌐 Language | 🎬 Video settings]`, `[⬅️ Menu]`.
- 🌐 Language -> inline `[🇬🇧 English] [🇷🇺 Русский]` (no Auto); pick one -> ack.
- 🎬 Video settings -> `[Subtitles: on ✅]`; tap -> flips to `Subtitles: off ⬜` + ack.
- ⬅️ Menu -> main menu restored.
- With subtitles OFF, send a short video -> resulting clips have no burned-in subtitles.

---

## Self-Review (completed by plan author)

**Spec coverage:** `User.subtitlesEnabled` + migration -> Task 1. Settings reply sub-menu (Language / Video / Menu) -> Task 5. Language RU/EN only, Auto removed -> Task 2 (i18n) + Task 3 (keyboard/parse/apply/dispatch). Subtitle toggle (inline, persisted, edit-in-place) -> Task 2 (strings) + Task 4. Jobs respect the preference -> Task 4 Step 6 (both `createJob` sites). No worker changes -> none in the file list. Auto-detect stays default -> `applyLangChoice` only writes `en`/`ru`; `telegramLocale=null` untouched for un-chosen users. Bilingual -> Task 2. Testing -> Tasks 2-5.

**Placeholder scan:** none - every step has concrete code and exact commands.

**Type consistency:** `subtitlesEnabled` (schema Task 1) is read in Task 4 (`user.subtitlesEnabled`, `handleSubtitlesToggle`) and Task 5 (`handleSettingsAction` video branch) - the field must exist first (Task 1 before 4/5, ordered). `CALLBACK_SUBTITLES_TOGGLE`, `subtitlesKeyboard`, `handleSubtitlesToggle`, `matchSettingsAction`/`SettingsAction`, `languageKeyboard` are each defined once and used consistently. `settingsKeyboard` returns `ReplyKeyboardMarkup` (matches `buildMainMenu`'s type). `applyLangChoice(from, "en"|"ru")` matches its two dispatch call sites.

**Interim compile note:** Tasks 2-3 share a single commit (`handlers.ts` won't compile between the i18n Auto-removal and the handler Auto-removal); called out at Task 2 Step 6 and Task 3 Step 6.
