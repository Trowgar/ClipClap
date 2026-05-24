# Telegram Bot Usage Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the bot's `/account` view to show real-time minute usage and storage-clip occupancy alongside the existing plan + total-clips info.

**Architecture:** Service-layer first (`getUsageForUser` returns the four new fields), then i18n template refactor (new `accountText` signature with EN+RU templates), then handler swap (`renderAccountText` reads from service instead of doing its own DB count).

**Tech Stack:** TypeScript, Prisma, Vitest.

**Spec:** [docs/superpowers/specs/2026-05-24-telegram-usage-display-design.md](../specs/2026-05-24-telegram-usage-display-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/services/usage.service.ts` | modify | Extend `UsageSummary` with `clipsStored`, `retentionDays`, `currentPeriodEnd`, `clipsTotal`. Add two `prisma.clip.count` calls run in parallel with the existing minute-aggregate. |
| `packages/shared/src/services/__tests__/usage.service.test.ts` | modify | Extend the mock to include `prisma.clip.count`. New cases for the four new fields and NONE-plan defaults. |
| `apps/bot/src/i18n.ts` | modify | Update `accountText` signature in `Dict`; rewrite EN+RU templates to render plan/period, minutes, storage, total blocks; branch on `plan === "NONE"`. |
| `apps/bot/src/__tests__/i18n.test.ts` | modify | New cases for `accountText` (NONE, active, top-up, Russian pluralization). |
| `apps/bot/src/handlers.ts` | modify | `renderAccountText` calls `getUsageForUser`, computes `daysUntilPeriodEnd`, formats and passes to `dict.accountText`. Removes the local `prisma.clip.count`. |

---

## Task 1: Extend `UsageSummary` in usage.service.ts

**Files:**
- Modify: `packages/shared/src/services/usage.service.ts`
- Test: `packages/shared/src/services/__tests__/usage.service.test.ts`

- [ ] **Step 1: Extend the test mock to include `prisma.clip.count`**

At the top of `packages/shared/src/services/__tests__/usage.service.test.ts`, replace the `vi.mock` block (currently lines 3–8):

```ts
vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: { findUniqueOrThrow: vi.fn() },
    job: { aggregate: vi.fn() },
    clip: { count: vi.fn() },
  },
}));
```

- [ ] **Step 2: Write the failing tests**

In `packages/shared/src/services/__tests__/usage.service.test.ts`, after the existing `getUsageForUser` test (after line ~47), append:

```ts
  it("getUsageForUser includes clipsStored, retentionDays, currentPeriodEnd, clipsTotal", async () => {
    const periodEnd = new Date("2026-06-24T00:00:00Z");
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 100,
      currentPeriodEnd: periodEnd,
    });
    (prisma.job.aggregate as any).mockResolvedValue({
      _sum: { sourceDurationSec: 2700 },
    });
    (prisma.clip.count as any)
      .mockResolvedValueOnce(8)   // clipsStored (deletedAt: null)
      .mockResolvedValueOnce(42); // clipsTotal (no filter)

    const usage = await getUsageForUser("u1");

    expect(usage.clipsStored).toBe(8);
    expect(usage.clipsTotal).toBe(42);
    expect(usage.retentionDays).toBe(7);
    expect(usage.currentPeriodEnd).toEqual(periodEnd);
    expect(usage.topUpMinutesRemaining).toBe(100);
  });

  it("getUsageForUser queries clipsStored with deletedAt: null filter", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "STARTER",
      billingCycle: "MONTHLY",
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.job.aggregate as any).mockResolvedValue({ _sum: { sourceDurationSec: 0 } });
    (prisma.clip.count as any).mockResolvedValue(0);

    await getUsageForUser("u1");

    const calls = (prisma.clip.count as any).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toEqual({ where: { userId: "u1", deletedAt: null } });
    expect(calls[1][0]).toEqual({ where: { userId: "u1" } });
  });

  it("getUsageForUser returns zero/null defaults for NONE plan", async () => {
    (prisma.user.findUniqueOrThrow as any).mockResolvedValue({
      id: "u1",
      plan: "NONE",
      billingCycle: null,
      topUpMinutesRemaining: 0,
      currentPeriodEnd: null,
    });
    (prisma.clip.count as any).mockResolvedValueOnce(0).mockResolvedValueOnce(3);

    const usage = await getUsageForUser("u1");

    expect(usage.plan).toBe("NONE");
    expect(usage.minutesUsed).toBe(0);
    expect(usage.minutesLimit).toBe(0);
    expect(usage.storageClipsLimit).toBe(0);
    expect(usage.retentionDays).toBe(0);
    expect(usage.currentPeriodEnd).toBeNull();
    expect(usage.clipsStored).toBe(0);
    expect(usage.clipsTotal).toBe(3);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run from repo root `/srv/saas/clipclap.io`:
```
npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts
```
Expected: the three new tests fail with errors about missing `clipsStored` / `clipsTotal` / `retentionDays` / `currentPeriodEnd` fields.

- [ ] **Step 4: Extend `UsageSummary` interface**

In `packages/shared/src/services/usage.service.ts`, replace the existing `UsageSummary` interface (currently lines 46–53) with:

```ts
export interface UsageSummary {
  plan: Plan;
  billingCycle: BillingCycle | null;
  minutesUsed: number;
  minutesLimit: number;
  topUpMinutesRemaining: number;
  storageClipsLimit: number;
  clipsStored: number;
  retentionDays: number;
  currentPeriodEnd: Date | null;
  clipsTotal: number;
}
```

- [ ] **Step 5: Rewrite `getUsageForUser` to populate new fields**

In the same file, replace the entire `getUsageForUser` function body (currently lines 55–82) with:

```ts
export async function getUsageForUser(userId: string): Promise<UsageSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const [clipsStored, clipsTotal] = await Promise.all([
    prisma.clip.count({ where: { userId, deletedAt: null } }),
    prisma.clip.count({ where: { userId } }),
  ]);

  if (user.plan === "NONE") {
    return {
      plan: "NONE",
      billingCycle: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutesRemaining: 0,
      storageClipsLimit: 0,
      clipsStored,
      retentionDays: 0,
      currentPeriodEnd: null,
      clipsTotal,
    };
  }

  const limits = getPlanLimits(user.plan, user.billingCycle ?? "MONTHLY");
  const periodStart = getPeriodStart(user.billingCycle, user.currentPeriodEnd);
  const minutesUsed = await getMinutesUsedInPeriod(
    userId,
    periodStart,
    new Date()
  );

  return {
    plan: user.plan,
    billingCycle: user.billingCycle,
    minutesUsed,
    minutesLimit: limits.minutesPerPeriod,
    topUpMinutesRemaining: user.topUpMinutesRemaining,
    storageClipsLimit: limits.storageClips,
    clipsStored,
    retentionDays: limits.retentionDays,
    currentPeriodEnd: user.currentPeriodEnd,
    clipsTotal,
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/shared/src/services/__tests__/usage.service.test.ts`
Expected: all tests pass (including existing ones - verify no regression).

- [ ] **Step 7: Run full suite + typecheck**

Run from repo root:
```
npx vitest run && npm run build -w @clipfast/shared
```
Expected: all green. (`shared` builds because `apps/bot` imports from its `dist/`.)

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/services/usage.service.ts packages/shared/src/services/__tests__/usage.service.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(shared): extend UsageSummary with clipsStored, retention, total"
```

---

## Task 2: Update `accountText` i18n template

**Files:**
- Modify: `apps/bot/src/i18n.ts`
- Test: `apps/bot/src/__tests__/i18n.test.ts`

- [ ] **Step 1: Write failing tests**

In `apps/bot/src/__tests__/i18n.test.ts`, append before the closing `});` of the `describe("bot i18n", ...)` block:

```ts
it("renders accountText NONE variant in both locales", () => {
  const en = t("en").accountText({
    plan: "NONE",
    billingCycle: null,
    periodEnd: null,
    daysUntilPeriodEnd: null,
    minutesUsed: 0,
    minutesLimit: 0,
    topUpMinutes: 0,
    clipsStored: 0,
    storageClipsLimit: 0,
    retentionDays: 0,
    clipsTotal: 0,
  });
  expect(en).toContain("Plan: no active plan");
  expect(en).toContain("Pick a plan");
  expect(en).toContain("Total clips created: 0");
  expect(en).not.toContain("Minutes:");
  expect(en).not.toContain("Storage:");

  const ru = t("ru").accountText({
    plan: "NONE",
    billingCycle: null,
    periodEnd: null,
    daysUntilPeriodEnd: null,
    minutesUsed: 0,
    minutesLimit: 0,
    topUpMinutes: 0,
    clipsStored: 0,
    storageClipsLimit: 0,
    retentionDays: 0,
    clipsTotal: 0,
  });
  expect(ru).toContain("Тариф: нет активного");
  expect(ru).toContain("Выбери тариф");
  expect(ru).toContain("Всего создано: 0");
  expect(ru).not.toContain("Минуты:");
  expect(ru).not.toContain("Хранилище:");
});

it("renders accountText active plan with top-up in EN", () => {
  const text = t("en").accountText({
    plan: "STARTER",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    daysUntilPeriodEnd: 31,
    minutesUsed: 45,
    minutesLimit: 270,
    topUpMinutes: 100,
    clipsStored: 8,
    storageClipsLimit: 20,
    retentionDays: 7,
    clipsTotal: 42,
  });
  expect(text).toContain("Plan: STARTER (monthly)");
  expect(text).toContain("Renews: 2026-06-24 (in 31 days)");
  expect(text).toContain("Minutes: 45 / 270 this period (225 left)");
  expect(text).toContain("Top-up: 100 minutes");
  expect(text).toContain("Storage: 8 / 20 clips (kept for 7 days)");
  expect(text).toContain("Total clips created: 42");
});

it("renders accountText active plan with top-up in RU with correct plurals", () => {
  const text = t("ru").accountText({
    plan: "STARTER",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    daysUntilPeriodEnd: 31,
    minutesUsed: 45,
    minutesLimit: 270,
    topUpMinutes: 100,
    clipsStored: 8,
    storageClipsLimit: 20,
    retentionDays: 7,
    clipsTotal: 42,
  });
  expect(text).toContain("Тариф: STARTER (месячный)");
  expect(text).toContain("Продление: 2026-06-24 (через 31 день)");
  expect(text).toContain("Минуты: 45 / 270 в этом периоде (осталось 225)");
  expect(text).toContain("Дополнительно: 100 минут");
  expect(text).toContain("Хранилище: 8 / 20 клипов (хранятся 7 дней)");
  expect(text).toContain("Всего создано: 42 клипа");
});

it("omits top-up line when topUpMinutes is 0", () => {
  const en = t("en").accountText({
    plan: "STARTER",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    daysUntilPeriodEnd: 31,
    minutesUsed: 45,
    minutesLimit: 270,
    topUpMinutes: 0,
    clipsStored: 8,
    storageClipsLimit: 20,
    retentionDays: 7,
    clipsTotal: 42,
  });
  expect(en).not.toContain("Top-up");

  const ru = t("ru").accountText({
    plan: "STARTER",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    daysUntilPeriodEnd: 31,
    minutesUsed: 45,
    minutesLimit: 270,
    topUpMinutes: 0,
    clipsStored: 8,
    storageClipsLimit: 20,
    retentionDays: 7,
    clipsTotal: 42,
  });
  expect(ru).not.toContain("Дополнительно");
});

it("renders correct Russian noun plurals for clips and days", () => {
  const base = {
    plan: "STARTER",
    billingCycle: "monthly",
    periodEnd: "2026-06-24",
    minutesUsed: 0,
    minutesLimit: 270,
    topUpMinutes: 0,
    storageClipsLimit: 20,
    retentionDays: 7,
  };
  expect(
    t("ru").accountText({
      ...base,
      daysUntilPeriodEnd: 1,
      clipsStored: 1,
      clipsTotal: 1,
    })
  ).toContain("через 1 день");

  expect(
    t("ru").accountText({
      ...base,
      daysUntilPeriodEnd: 3,
      clipsStored: 3,
      clipsTotal: 3,
    })
  ).toContain("через 3 дня");

  expect(
    t("ru").accountText({
      ...base,
      daysUntilPeriodEnd: 11,
      clipsStored: 5,
      clipsTotal: 5,
    })
  ).toContain("через 11 дней");

  expect(
    t("ru").accountText({
      ...base,
      daysUntilPeriodEnd: 21,
      clipsStored: 21,
      clipsTotal: 21,
    })
  ).toContain("через 21 день");

  const t5 = t("ru").accountText({
    ...base,
    daysUntilPeriodEnd: null,
    clipsStored: 5,
    clipsTotal: 5,
  });
  expect(t5).toContain("Хранилище: 5 / 20 клипов");
  expect(t5).toContain("Всего создано: 5 клипов");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: All five new tests fail - `accountText` signature mismatch or text doesn't match.

- [ ] **Step 3: Update the `Dict` interface signature**

In `apps/bot/src/i18n.ts`, find the existing `accountText` field in the `Dict` interface (currently around lines 60–66):

```ts
  accountText: (params: {
    plan: string;
    billingCycle: string | null;
    periodEnd: string | null;
    clipsTotal: number;
  }) => string;
```

Replace with:

```ts
  accountText: (params: {
    plan: string;
    billingCycle: string | null;
    periodEnd: string | null;
    daysUntilPeriodEnd: number | null;
    minutesUsed: number;
    minutesLimit: number;
    topUpMinutes: number;
    clipsStored: number;
    storageClipsLimit: number;
    retentionDays: number;
    clipsTotal: number;
  }) => string;
```

- [ ] **Step 4: Rewrite the EN `accountText` implementation**

In `apps/bot/src/i18n.ts`, find the EN `accountText` implementation (currently around lines 129–133 in the `en: Dict = { ... }` block):

```ts
  accountText: ({ plan, billingCycle, periodEnd, clipsTotal }) => {
    const planLine = plan === "NONE" ? "Plan: no active plan" : `Plan: ${plan}${billingCycle ? ` (${billingCycle.toLowerCase()})` : ""}`;
    const periodLine = periodEnd ? `\nRenews/expires: ${periodEnd}` : "";
    return `${planLine}${periodLine}\nClips created: ${clipsTotal}`;
  },
```

Replace with:

```ts
  accountText: ({
    plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
    minutesUsed,
    minutesLimit,
    topUpMinutes,
    clipsStored,
    storageClipsLimit,
    retentionDays,
    clipsTotal,
  }) => {
    if (plan === "NONE") {
      return `Plan: no active plan\n\nPick a plan to start clipping.\nTotal clips created: ${clipsTotal}`;
    }
    const planLine = `Plan: ${plan}${billingCycle ? ` (${billingCycle})` : ""}`;
    const renewSuffix =
      daysUntilPeriodEnd === null
        ? ""
        : daysUntilPeriodEnd === 0
          ? " (today)"
          : ` (in ${daysUntilPeriodEnd} day${daysUntilPeriodEnd === 1 ? "" : "s"})`;
    const renewLine = periodEnd ? `Renews: ${periodEnd}${renewSuffix}` : "";
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Minutes: ${minutesUsed} / ${minutesLimit} this period (${minutesLeft} left)`;
    const topUpLine = topUpMinutes > 0 ? `+ Top-up: ${topUpMinutes} minutes\n` : "";
    const storageLine = `Storage: ${clipsStored} / ${storageClipsLimit} clips (kept for ${retentionDays} days)`;
    const totalLine = `Total clips created: ${clipsTotal}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(/\n\n\n+/g, "\n\n");
  },
```

- [ ] **Step 5: Rewrite the RU `accountText` implementation**

In `apps/bot/src/i18n.ts`, find the RU `accountText` implementation (currently around lines 208–212 in the `ru: Dict = { ... }` block):

```ts
  accountText: ({ plan, billingCycle, periodEnd, clipsTotal }) => {
    const planLine = plan === "NONE" ? "Тариф: нет активного" : `Тариф: ${plan}${billingCycle ? ` (${billingCycle === "WEEKLY" ? "недельный" : "месячный"})` : ""}`;
    const periodLine = periodEnd ? `\nДо: ${periodEnd}` : "";
    return `${planLine}${periodLine}\nКлипов сделано: ${clipsTotal}`;
  },
```

Replace with:

```ts
  accountText: ({
    plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
    minutesUsed,
    minutesLimit,
    topUpMinutes,
    clipsStored,
    storageClipsLimit,
    retentionDays,
    clipsTotal,
  }) => {
    if (plan === "NONE") {
      return `Тариф: нет активного\n\nВыбери тариф, чтобы начать.\nВсего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    }
    const cycleLabel =
      billingCycle === null
        ? ""
        : billingCycle === "weekly" || billingCycle === "WEEKLY"
          ? " (недельный)"
          : " (месячный)";
    const planLine = `Тариф: ${plan}${cycleLabel}`;
    const renewSuffix =
      daysUntilPeriodEnd === null
        ? ""
        : daysUntilPeriodEnd === 0
          ? " (сегодня)"
          : ` (через ${daysUntilPeriodEnd} ${pluralizeRu(daysUntilPeriodEnd, "день", "дня", "дней")})`;
    const renewLine = periodEnd ? `Продление: ${periodEnd}${renewSuffix}` : "";
    const minutesLeft = Math.max(0, minutesLimit - minutesUsed);
    const minutesLine = `Минуты: ${minutesUsed} / ${minutesLimit} в этом периоде (осталось ${minutesLeft})`;
    const topUpLine =
      topUpMinutes > 0 ? `+ Дополнительно: ${topUpMinutes} минут\n` : "";
    const storageLine = `Хранилище: ${clipsStored} / ${storageClipsLimit} ${pluralizeRu(clipsStored, "клип", "клипа", "клипов")} (хранятся ${retentionDays} ${pluralizeRu(retentionDays, "день", "дня", "дней")})`;
    const totalLine = `Всего создано: ${clipsTotal} ${pluralizeRu(clipsTotal, "клип", "клипа", "клипов")}`;
    return `${planLine}\n${renewLine}\n\n${minutesLine}\n${topUpLine}\n${storageLine}\n${totalLine}`.replace(/\n\n\n+/g, "\n\n");
  },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/bot/src/__tests__/i18n.test.ts`
Expected: All tests pass (17 existing + 5 new = 22). If a test fails on whitespace, check the `\n\n\n+` collapse regex and the `topUpLine` newline.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w @clipfast/bot`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/i18n.ts apps/bot/src/__tests__/i18n.test.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): expand accountText with minutes and storage limits"
```

---

## Task 3: Wire `renderAccountText` to `getUsageForUser`

**Files:**
- Modify: `apps/bot/src/handlers.ts`

This swaps the in-handler `prisma.clip.count` for the service call and passes all the new fields into `dict.accountText`. The header line "📊 Account" (or RU equivalent) is currently NOT in the dict - it's just the plain text from the dict. We add no new header for now; the existing flow sends `dict.accountText` as the message body directly.

- [ ] **Step 1: Add `getUsageForUser` to the shared import block**

In `apps/bot/src/handlers.ts`, find the existing import from `@clipfast/shared` (currently lines 4–18, includes `canSubmitJob`, `findOrCreateTelegramUser`, etc.). Add `getUsageForUser` to that import alongside the others. The block becomes:

```ts
import {
  canSubmitJob,
  createBotInitiatedLink,
  createTelegramDelivery,
  findOrCreateTelegramUser,
  getPlanLimits,
  getPresignedDownloadUrl,
  getUsageForUser,
  jobService,
  markTelegramDeliveryFailed,
  markTelegramDeliverySent,
  prisma,
  redeemLinkFromBot,
  telegramDeliveryService,
  uploadFile,
} from "@clipfast/shared";
```

(Insertion is just adding `getUsageForUser,` alphabetically. Leave everything else untouched.)

- [ ] **Step 2: Rewrite `renderAccountText`**

In `apps/bot/src/handlers.ts`, find the existing `renderAccountText` function (currently around lines 198–222):

```ts
async function renderAccountText(
  dict: Dict,
  userId: string | undefined
): Promise<string> {
  if (!userId) {
    return dict.accountText({
      plan: "NONE",
      billingCycle: null,
      periodEnd: null,
      clipsTotal: 0,
    });
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, billingCycle: true, currentPeriodEnd: true },
  });
  const clipsTotal = await prisma.clip.count({ where: { userId } });
  const periodEndIso = user?.currentPeriodEnd;
  return dict.accountText({
    plan: user?.plan ?? "NONE",
    billingCycle: user?.billingCycle ?? null,
    periodEnd: periodEndIso
      ? periodEndIso.toISOString().slice(0, 10)
      : null,
    clipsTotal,
  });
}
```

Replace with:

```ts
async function renderAccountText(
  dict: Dict,
  userId: string | undefined
): Promise<string> {
  if (!userId) {
    return dict.accountText({
      plan: "NONE",
      billingCycle: null,
      periodEnd: null,
      daysUntilPeriodEnd: null,
      minutesUsed: 0,
      minutesLimit: 0,
      topUpMinutes: 0,
      clipsStored: 0,
      storageClipsLimit: 0,
      retentionDays: 0,
      clipsTotal: 0,
    });
  }

  const usage = await getUsageForUser(userId);

  const periodEnd = usage.currentPeriodEnd
    ? usage.currentPeriodEnd.toISOString().slice(0, 10)
    : null;
  const daysUntilPeriodEnd = usage.currentPeriodEnd
    ? Math.max(
        0,
        Math.ceil(
          (usage.currentPeriodEnd.getTime() - Date.now()) / 86_400_000
        )
      )
    : null;
  const billingCycle = usage.billingCycle ? usage.billingCycle.toLowerCase() : null;

  return dict.accountText({
    plan: usage.plan,
    billingCycle,
    periodEnd,
    daysUntilPeriodEnd,
    minutesUsed: usage.minutesUsed,
    minutesLimit: usage.minutesLimit,
    topUpMinutes: usage.topUpMinutesRemaining,
    clipsStored: usage.clipsStored,
    storageClipsLimit: usage.storageClipsLimit,
    retentionDays: usage.retentionDays,
    clipsTotal: usage.clipsTotal,
  });
}
```

- [ ] **Step 3: Typecheck + full test run**

Run from repo root:
```
npm run typecheck -w @clipfast/bot && npx vitest run
```
Expected: All green.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/handlers.ts
git -c user.email='trowgar@yahoo.com' -c user.name='Trowgar' commit -m "feat(bot): show minutes and storage usage in /account"
```

---

## Task 4: Manual verification

**No new code.** Smoke-test the new view in Telegram.

- [ ] **Step 1: Rebuild the bot container**

Run: `docker compose up -d --build bot`
Expected: Container comes up, logs show `Bot profile sync complete (en, ru) - check warnings above for any locale failures` (no warnings).

- [ ] **Step 2: Verify active-plan view**

In Telegram, tap 📊 Account (or 📊 Аккаунт) for a user with an active plan:
- Confirm the new layout - plan line, renews line, blank, minutes line, optional top-up, blank, storage line, total line.
- For RU users, confirm the noun plurals look correct (e.g., `1 день` / `3 дня` / `5 дней`; `1 клип` / `3 клипа` / `5 клипов`).
- Confirm the `(225 left)` / `(осталось 225)` math matches `minutesLimit - minutesUsed`.

- [ ] **Step 3: Verify NONE-plan view**

For a freshly created user with no plan (or temporarily set a test user's plan to `NONE`):
- The view should show `Plan: no active plan` (`Тариф: нет активного`) + the "Pick a plan" / "Выбери тариф" prompt + `Total clips created: 0`.
- Minutes and Storage blocks should be ABSENT.

- [ ] **Step 4: Verify top-up rendering**

For a user with `topUpMinutesRemaining > 0`:
- `+ Top-up: N minutes` (`+ Дополнительно: N минут`) line should appear between minutes and storage blocks.

For a user with `topUpMinutesRemaining = 0`:
- The top-up line should be ABSENT (no empty `+ Top-up: ` artifact).

- [ ] **Step 5: Confirm regressions**

- 💎 Plans / ❓ Help / 🌐 Language behavior unchanged.
- Video submission flow unchanged (uploading → queued → delivery).

---

## Self-review notes

**Spec coverage:**
- Section "Output shape" (active, NONE, no-top-up) → Tasks 2 + 3 + manual verification covers all three variants.
- Section "Data layer" (new fields, parallel queries, `deletedAt: null` filter) → Task 1.
- Section "i18n" (signature change, EN+RU templates, NONE branch, Russian plurals) → Task 2.
- Section "Handler" (use `getUsageForUser`, compute `daysUntilPeriodEnd`, drop direct `prisma.clip.count`) → Task 3.
- Section "Error handling" - `getUsageForUser` throws on missing user; the existing top-level error handling in `handleUpdate` catches and logs. No new error code needed.
- Section "Testing" - service + i18n tests both included.

**Risks / things to watch:**
- The `replace(/\n\n\n+/g, "\n\n")` regex collapses extra blank lines when `topUpLine` is empty. Verify in tests by asserting no triple newlines in the output of the no-top-up case.
- `billingCycle` is lower-cased in the handler (Prisma stores it as `"MONTHLY"`/`"WEEKLY"`). The RU template checks both upper and lower case to be defensive - that's intentional.
- `daysUntilPeriodEnd = 0` renders "today" / "сегодня". If you'd prefer "tomorrow" semantics or a different threshold, change the comparison in both templates.
- The service now runs three queries (job aggregate + 2 clip counts). All three are indexed on `userId` (per schema). Account view should remain sub-100ms.
