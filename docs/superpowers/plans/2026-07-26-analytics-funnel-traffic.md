# Analytics (Funnel + Guest Traffic + Admin Page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "where do our ~100 organic users drop off, and how much guest traffic does the site get" from one admin page, split by Telegram / Web / Combined.

**Architecture:** Three subsystems. (A) The existing `bot_funnel_events` table is generalized to `funnel_events` (`surface` + `subjectId`) and instrumented on both bot and web, reusing the shared `canSubmitJob` refusal codes so both surfaces report the same reasons. (B) Anonymous visits are recorded by the Edge middleware handing request data to a Node API route that does GeoIP and the DB write. (C) A server-rendered admin page aggregates both, gated by an env allow-list.

**Tech Stack:** TypeScript, Prisma 5.20 (PostgreSQL), Next.js 15 (App Router, Edge middleware + Node route handlers), grammY bot, Vitest 3, Docker Compose, MaxMind GeoLite2.

**Design reference:** `docs/superpowers/specs/2026-07-26-analytics-funnel-traffic-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `prisma/schema.prisma` | `FunnelEvent` (renamed/generalized) + `SiteVisit` | Modify |
| `prisma/migrations/20260726120000_funnel_events_generalize/migration.sql` | Rename + `surface` backfill | Create |
| `prisma/migrations/20260726120100_site_visits/migration.sql` | Guest-visit table | Create |
| `packages/shared/src/services/bot-funnel.service.ts` | Renamed to funnel.service.ts: surface-aware recorder + step vocabulary | Rewrite |
| `packages/shared/src/services/site-visit.service.ts` | Visitor hash, bot detection, referrer host, GeoIP, upsert | Create |
| `packages/shared/src/services/analytics.service.ts` | Read-side aggregation for the admin page | Create |
| `apps/bot/src/handlers.ts` | `app_opened`, `video_submitted`, `upload_rejected_*` | Modify |
| `apps/web/app/api/jobs/route.ts` | `video_submitted` + every refusal branch | Modify |
| `apps/web/app/(dashboard)/dashboard/page.tsx` | `app_opened` (web) | Modify |
| `apps/web/app/api/_track/route.ts` | Node runtime, secret check, visit write | Create |
| `apps/web/middleware.ts` | `waitUntil(fetch)` to the track route, wider matcher | Modify |
| `apps/web/app/admin/page.tsx` | Admin page; `ADMIN_EMAILS` session or Mini App cookie | Create |
| `apps/web/app/admin/mini-app-gate.tsx` | Client bootstrap that hands Telegram `initData` over | Create |
| `packages/shared/src/services/mini-app.service.ts` | `initData` HMAC validation + signed admin cookie | Create |
| `apps/web/app/api/admin/enter/route.ts` | Validates `initData`, sets the admin cookie | Create |
| `apps/worker/Dockerfile`, `apps/web/Dockerfile` | GeoLite2 download | Modify |
| `.env.example` | `TRACK_SECRET`, `ADMIN_EMAILS`, `MAXMIND_LICENSE_KEY` | Modify |

**Conventions (verified for this repo)**
- Shared tests: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/<file>`
  (from `/app/apps/web`, `--root ../..` resolves to `/app` where `vitest.config.ts` lives; using `-w /app` makes it resolve to `/` and OOMs).
- **Bot tests MUST run in the `bot` container** - the `web` container carries a stale copy of `apps/bot` and passes silently:
  `docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src/__tests__/<file>`
- Prisma runs in-container: `docker compose exec -w /app web npx prisma <cmd>`. Migrations, never `db push`.
- Commit identity `Trowgar <trowgar@yahoo.com>`, **no AI attribution trailer**:
  `git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "..."`
- Comments use plain hyphens `-`, never em-dashes.

**Build-ordering note:** Task 2 renames the exported `BOT_FUNNEL_EVENTS` / `recordBotFunnelEvent`. Between Task 2 and Task 4 the bot and web will not typecheck, because their call sites still use the old names. That is expected; the per-task gate is the test named in that task. The full typecheck gate is Task 11.

---

# Phase A - Funnel events

## Task 1: Generalize the funnel table

**Files:**
- Modify: `prisma/schema.prisma` (the `BotFunnelEvent` model, ~line 266)
- Create: `prisma/migrations/20260726120000_funnel_events_generalize/migration.sql`

- [ ] **Step 1: Replace the model**

Replace the whole `model BotFunnelEvent { ... }` block (and keep the `///` doc comment above it, updating its wording) with:

```prisma
/// Funnel steps for both surfaces, which were previously invisible.
///
/// A User row only exists once someone presses "New account" or "Link
/// account", so everyone who opened the bot, read the first screen and left
/// was recorded nowhere. One row per person per step, not one per press - the
/// question is "how many people", so count(*) is the answer directly and the
/// table stays the size of the audience rather than of the traffic. Repeat
/// presses increment `occurrences`.
///
/// Deliberately NOT related to User: the whole point is the people who never
/// became one. Join on `subjectId` when you want the ones who did - it holds a
/// telegramId for surface='bot' and a users.id for surface='web'.
model FunnelEvent {
  /// "bot" | "web". Plain String for the same reason `event` is: adding a
  /// surface must not be a migration on a table nobody's request path needs.
  surface     String
  /// bot: telegramId (may predate the account). web: users.id (post-signup
  /// only - an anonymous visitor cannot be identified without cookies, which
  /// this product deliberately does not set).
  subjectId   String
  id          String   @id @default(cuid())
  /// Funnel step. Values come from FUNNEL_EVENTS in
  /// packages/shared/src/services/funnel.service.ts - a String, not an enum.
  event       String
  /// Locale as detected at the time. Copy exists in EN and RU only, so knowing
  /// what the drop-offs actually read is the one dimension worth a column.
  locale      String?
  occurrences Int      @default(1)
  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())

  @@unique([surface, subjectId, event])
  @@index([event, firstSeenAt])
  @@map("funnel_events")
}
```

- [ ] **Step 2: Hand-author the migration**

Create `prisma/migrations/20260726120000_funnel_events_generalize/migration.sql`:

```sql
-- Rename the table and the subject column
ALTER TABLE "bot_funnel_events" RENAME TO "funnel_events";
ALTER TABLE "funnel_events" RENAME COLUMN "telegramId" TO "subjectId";

-- Add the surface, backfilling every existing row as bot traffic
ALTER TABLE "funnel_events" ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE "funnel_events" ALTER COLUMN "surface" DROP DEFAULT;

-- The unique key gains the surface, so it must be recreated rather than renamed
DROP INDEX "bot_funnel_events_telegramId_event_key";
CREATE UNIQUE INDEX "funnel_events_surface_subjectId_event_key"
  ON "funnel_events"("surface", "subjectId", "event");

ALTER INDEX "bot_funnel_events_event_firstSeenAt_idx"
  RENAME TO "funnel_events_event_firstSeenAt_idx";
```

The `DEFAULT 'bot'` exists only to backfill the 4 existing rows, then is dropped so future writes must state the surface explicitly.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `docker compose exec -w /app web npx prisma generate`
Expected: "Generated Prisma Client". `prisma.funnelEvent` now exists; `prisma.botFunnelEvent` no longer does.

Do **not** run `migrate deploy` yet - that happens in Task 11 with the rest of the deploy.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260726120000_funnel_events_generalize
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): generalize bot_funnel_events to surface-aware funnel_events"
```

---

## Task 2: Surface-aware funnel service

**Files:**
- Create: `packages/shared/src/services/funnel.service.ts`
- Delete: `packages/shared/src/services/bot-funnel.service.ts`
- Rewrite: `packages/shared/src/services/__tests__/bot-funnel.service.test.ts` -> `funnel.service.test.ts`
- Modify: `packages/shared/src/services/index.ts:32`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/funnel.service.test.ts` (delete the old `bot-funnel.service.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two properties matter and are both tested here:
 *  - it counts PEOPLE, not presses (one row per surface+subject+event), so
 *    count(*) is the answer and the table stays the size of the audience;
 *  - it never throws. Telemetry that can break a stranger's first interaction
 *    with the product is worse than no telemetry.
 */

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { funnelEvent: { upsert: mocks.upsert } },
}));

import {
  FUNNEL_EVENTS,
  recordFunnelEvent,
  uploadRejectedEvent,
} from "../funnel.service";

describe("recordFunnelEvent", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({});
    vi.restoreAllMocks();
  });

  it("keys the row on surface + subject + event", async () => {
    await recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN, "ru");

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      surface_subjectId_event: {
        surface: "bot",
        subjectId: "42",
        event: "start_first_screen",
      },
    });
    expect(arg.create).toMatchObject({
      surface: "bot",
      subjectId: "42",
      event: "start_first_screen",
      locale: "ru",
    });
  });

  it("separates the same id on different surfaces", async () => {
    await recordFunnelEvent("web", "42", FUNNEL_EVENTS.APP_OPENED);
    expect(mocks.upsert.mock.calls[0][0].create.surface).toBe("web");
  });

  it("counts a repeat on the existing row instead of adding another", async () => {
    await recordFunnelEvent("bot", "42", FUNNEL_EVENTS.VIDEO_SUBMITTED);
    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.update.occurrences).toEqual({ increment: 1 });
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("accepts a missing locale", async () => {
    await recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN);
    expect(mocks.upsert.mock.calls[0][0].create.locale).toBeNull();
  });

  it("keeps the existing step names stable and adds the shared ones", () => {
    expect(FUNNEL_EVENTS.FIRST_SCREEN).toBe("start_first_screen");
    expect(FUNNEL_EVENTS.NEW_ACCOUNT).toBe("first_screen_new_account");
    expect(FUNNEL_EVENTS.LINK_ACCOUNT).toBe("first_screen_link_account");
    expect(FUNNEL_EVENTS.APP_OPENED).toBe("app_opened");
    expect(FUNNEL_EVENTS.VIDEO_SUBMITTED).toBe("video_submitted");
  });

  it("maps every canSubmitJob code to a rejection event", () => {
    expect(uploadRejectedEvent("FREE_TRIAL_USED")).toBe("upload_rejected_trial_used");
    expect(uploadRejectedEvent("FREE_TRIAL_ATTEMPTS")).toBe("upload_rejected_trial_attempts");
    expect(uploadRejectedEvent("FREE_SOURCE_TOO_LONG")).toBe("upload_rejected_too_long");
    expect(uploadRejectedEvent("QUOTA")).toBe("upload_rejected_quota");
    expect(uploadRejectedEvent("LIFECYCLE")).toBe("upload_rejected_lifecycle");
    // Route-level refusals that never reach canSubmitJob
    expect(uploadRejectedEvent("TOO_LONG")).toBe("upload_rejected_too_long");
    expect(uploadRejectedEvent("DAILY_LIMIT")).toBe("upload_rejected_daily_limit");
    expect(uploadRejectedEvent("CONCURRENT")).toBe("upload_rejected_concurrent");
  });

  it("resolves instead of throwing when the write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockRejectedValue(new Error("db is down"));

    await expect(
      recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN, "ru")
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("resolves when the client has no such model at all", async () => {
    // Guards the deploy window: the Prisma client is regenerated per container,
    // so funnelEvent may be undefined on an instance not regenerated yet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });
    await expect(
      recordFunnelEvent("bot", "42", FUNNEL_EVENTS.FIRST_SCREEN)
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/funnel.service.test.ts`
Expected: FAIL - cannot resolve `../funnel.service`.

- [ ] **Step 3: Write the service**

Create `packages/shared/src/services/funnel.service.ts` and delete `bot-funnel.service.ts`:

```ts
import { prisma } from "../lib/prisma";

/**
 * Funnel steps for the Telegram bot and the web app.
 *
 * Only the steps that are otherwise invisible live here. Job creation, clip
 * delivery, zero-clip outcomes and repeat use are NOT events: they are already
 * rows in `jobs`, `telegram_deliveries` and `clips`, and a second counter would
 * drift from them. Repeat attempts come from `occurrences` on VIDEO_SUBMITTED.
 *
 * The values are wire format. They are written to a String column and read by
 * hand in SQL, so they must not be renamed casually.
 */
export const FUNNEL_EVENTS = {
  /** Bot only: the two-button screen was shown to somebody with no account. */
  FIRST_SCREEN: "start_first_screen",
  /** Bot only: pressed "New account". */
  NEW_ACCOUNT: "first_screen_new_account",
  /** Bot only: pressed "Link account". */
  LINK_ACCOUNT: "first_screen_link_account",
  /** Both: bot main menu rendered / web dashboard loaded. */
  APP_OPENED: "app_opened",
  /** Both: an attempt to create a job, recorded before the limit checks. */
  VIDEO_SUBMITTED: "video_submitted",
} as const;

export type FunnelEvent = string;
export type FunnelSurface = "bot" | "web";

/** Refusal codes: the shared canSubmitJob ones plus the route-level checks. */
export type UploadRejectionCode =
  | "FREE_TRIAL_USED"
  | "FREE_TRIAL_ATTEMPTS"
  | "FREE_SOURCE_TOO_LONG"
  | "QUOTA"
  | "LIFECYCLE"
  | "TOO_LONG"
  | "DAILY_LIMIT"
  | "CONCURRENT";

const REJECTION_SUFFIX: Record<UploadRejectionCode, string> = {
  FREE_TRIAL_USED: "trial_used",
  FREE_TRIAL_ATTEMPTS: "trial_attempts",
  FREE_SOURCE_TOO_LONG: "too_long",
  QUOTA: "quota",
  LIFECYCLE: "lifecycle",
  TOO_LONG: "too_long",
  DAILY_LIMIT: "daily_limit",
  CONCURRENT: "concurrent",
};

/** The event name for a refusal, e.g. "upload_rejected_quota". */
export function uploadRejectedEvent(code: UploadRejectionCode): string {
  return `upload_rejected_${REJECTION_SUFFIX[code]}`;
}

/**
 * Records that `subjectId` reached `event` on `surface`. Counts people, not
 * presses: the row is unique per (surface, subjectId, event) and a repeat
 * bumps `occurrences`.
 *
 * NEVER THROWS, and never rejects. This is called on a stranger's first
 * interaction with the product, and a telemetry write that can turn that
 * interaction into silence is worse than having no telemetry at all. The
 * swallow lives here rather than at each call site so no caller can forget it -
 * but it logs, so a suspiciously flat funnel can be traced to failing writes
 * instead of to a dead product.
 *
 * Callers must still await it AFTER the user has been answered, not before.
 */
export async function recordFunnelEvent(
  surface: FunnelSurface,
  subjectId: string | number,
  event: FunnelEvent,
  locale?: string | null
): Promise<void> {
  try {
    const id = String(subjectId);
    await prisma.funnelEvent.upsert({
      where: { surface_subjectId_event: { surface, subjectId: id, event } },
      create: { surface, subjectId: id, event, locale: locale ?? null },
      update: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        ...(locale ? { locale } : {}),
      },
    });
  } catch (error) {
    // Includes the case where the Prisma client in this container predates the
    // migration and `funnelEvent` is undefined - a synchronous TypeError,
    // caught here as well because the throw happens inside the try.
    console.error(
      `Funnel telemetry: could not record ${event} for ${surface}:${subjectId}:`,
      error instanceof Error ? error.message : error
    );
  }
}
```

Update the barrel `packages/shared/src/services/index.ts` line 32:
```ts
export * from "./funnel.service";
```

- [ ] **Step 4: Run it to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/funnel.service.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/funnel.service.ts packages/shared/src/services/index.ts packages/shared/src/services/__tests__/
git rm packages/shared/src/services/bot-funnel.service.ts packages/shared/src/services/__tests__/bot-funnel.service.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): surface-aware funnel recorder with rejection vocabulary"
```

---

## Task 3: Instrument the bot

**Files:**
- Modify: `apps/bot/src/handlers.ts` (import at line 6; call sites at ~1052, ~1123, ~1141; menu render; video intake; refusal switch ~1616)
- Modify: `apps/bot/src/__tests__/funnel.test.ts`

- [ ] **Step 1: Update the existing bot test to the new API**

In `apps/bot/src/__tests__/funnel.test.ts`, change the prisma mock model name and the import:

```ts
    telegramLinkToken: { create: mocks.linkTokenCreate },
    funnelEvent: { upsert: mocks.funnelUpsert },
```
```ts
import { FUNNEL_EVENTS } from "@clipclap/shared";
```

Then replace every assertion that reads `BOT_FUNNEL_EVENTS` with `FUNNEL_EVENTS`, and every expected `where` shape with the surface-aware key, e.g.:

```ts
expect(mocks.funnelUpsert.mock.calls[0][0].where).toEqual({
  surface_subjectId_event: {
    surface: "bot",
    subjectId: "42",
    event: FUNNEL_EVENTS.FIRST_SCREEN,
  },
});
```

- [ ] **Step 2: Add a test for the new bot steps**

Append to `apps/bot/src/__tests__/funnel.test.ts`:

```ts
describe("upload funnel steps", () => {
  it("names the refusal events the same way the web route does", async () => {
    const { uploadRejectedEvent } = await import("@clipclap/shared");
    expect(uploadRejectedEvent("QUOTA")).toBe("upload_rejected_quota");
    expect(uploadRejectedEvent("FREE_TRIAL_USED")).toBe("upload_rejected_trial_used");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src/__tests__/funnel.test.ts`
Expected: FAIL - `FUNNEL_EVENTS` is not exported yet from the bot's built copy of shared, or the where-shape assertion mismatches.

If the failure is "not exported", rebuild shared first (the bot runs the built `dist`):
`docker compose exec -w /app web npm run build -w @clipclap/shared`

- [ ] **Step 4: Update the three existing call sites**

In `apps/bot/src/handlers.ts`, change the import on line 6 from `BOT_FUNNEL_EVENTS` to `FUNNEL_EVENTS` (and add `uploadRejectedEvent`, `recordFunnelEvent`), then update the three existing calls to pass the surface first:

```ts
await recordFunnelEvent(
  "bot",
  message.from!.id,
  FUNNEL_EVENTS.FIRST_SCREEN,
  message.from!.language_code
);
```
```ts
await recordFunnelEvent(
  "bot",
  query.from.id,
  FUNNEL_EVENTS.NEW_ACCOUNT,
  query.from.language_code
);
```
```ts
await recordFunnelEvent(
  "bot",
  query.from.id,
  FUNNEL_EVENTS.LINK_ACCOUNT,
  query.from.language_code
);
```

- [ ] **Step 5: Add `app_opened` where the main menu is sent**

`buildMainMenu(dict)` (line 348) only builds the keyboard, so record at the place that *sends* it. In `handleMenuAction` (line 562, signature
`(client, message, action, dict, config, existing)`) add to `case "menu":` **after** its `sendMessage`:

```ts
      await recordFunnelEvent(
        "bot",
        message.from!.id,
        FUNNEL_EVENTS.APP_OPENED,
        message.from!.language_code
      );
```

Also add it after the menu that follows account creation, in the
`CALLBACK_NEW_ACCOUNT` branch (~line 1119) next to the existing
`FUNNEL_EVENTS.NEW_ACCOUNT` call, using `query.from.id` /
`query.from.language_code`.

- [ ] **Step 6: Add `video_submitted` at both intake points**

Both intake functions already carry `from: TelegramUser`:
`handleVideo(client, message, from, source, dict, config)` at line 1449 and
`handleVideoUrl(client, message, from, url, dict, config)` at line 1521.

In `handleVideo`, immediately before `const blockedReason = await getSubmissionBlocker(...)` (line 1458):

```ts
  await recordFunnelEvent(
    "bot",
    from.id,
    FUNNEL_EVENTS.VIDEO_SUBMITTED,
    from.language_code
  );
```

In `handleVideoUrl`, the same call immediately before its
`getSubmissionBlocker` (line 1538). Recording before the checks is what makes
"tried and was refused" distinguishable from "never tried".

- [ ] **Step 7: Record the refusal reason inside `getSubmissionBlocker`**

The refusal `switch` lives in `getSubmissionBlocker(userId, dict, durationSec)`
(line 1589), which has no Telegram identity in scope. Thread it in rather than
reaching for a global - change the signature to:

```ts
export async function getSubmissionBlocker(
  userId: string,
  dict: Dict,
  durationSec?: number,
  subject?: { telegramId: string | number; locale?: string }
) {
```

Add one line for the plan-level duration refusal (the branch returning
`dict.planSourceTooLong(...)`, ~line 1610), before its `return`:

```ts
    if (subject) {
      await recordFunnelEvent(
        "bot",
        subject.telegramId,
        uploadRejectedEvent("TOO_LONG"),
        subject.locale
      );
    }
```

And one line above the `switch (submission.code)` (line 1616), which covers all
five shared codes at once instead of touching every branch:

```ts
  const submission = await canSubmitJob(userId, durationMinutes);
  if (!submission.allowed) {
    if (subject) {
      await recordFunnelEvent(
        "bot",
        subject.telegramId,
        uploadRejectedEvent(submission.code),
        subject.locale
      );
    }
    switch (submission.code) {
```

Update both call sites to pass the subject:

```ts
  const blockedReason = await getSubmissionBlocker(user.id, dict, source.duration, {
    telegramId: from.id,
    locale: from.language_code,
  });
```
(line 1458, and the same shape at line 1538 with `probe.durationSec`).

`subject` is optional so any other caller of this exported function keeps
compiling and simply records nothing.

- [ ] **Step 8: Run the bot tests**

Run: `docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src/__tests__/funnel.test.ts`
Expected: PASS.

Then the whole bot suite: `docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/handlers.ts apps/bot/src/__tests__/funnel.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): bot records app_opened, video_submitted and refusal reasons"
```

---

## Task 4: Instrument the web app

**Files:**
- Modify: `apps/web/app/api/jobs/route.ts`
- Modify: `apps/web/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Record the attempt and every refusal in the jobs route**

In `apps/web/app/api/jobs/route.ts`, extend the import:

```ts
import {
  jobService,
  prisma,
  getPlanLimits,
  canSubmitJob,
  recordFunnelEvent,
  uploadRejectedEvent,
  FUNNEL_EVENTS,
} from "@clipclap/shared";
```

Record the attempt right after the "no source" guard, before the limit reads:

```ts
  await recordFunnelEvent("web", userId, FUNNEL_EVENTS.VIDEO_SUBMITTED);
```

Then add one line to each refusal branch, before its `return`:

```ts
  if (durationMinutes > limits.maxSourceDurationMinutes) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("TOO_LONG"));
    return NextResponse.json(
      {
        error: `Source exceeds max duration (${limits.maxSourceDurationMinutes} min). Trim before uploading.`,
      },
      { status: 400 }
    );
  }

  if (!submission.allowed) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent(submission.code));
    return NextResponse.json({ error: submission.reason }, { status: 402 });
  }

  if (jobsToday >= limits.maxJobsPerDay) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("DAILY_LIMIT"));
    return NextResponse.json(
      {
        error: `Daily job limit reached (${limits.maxJobsPerDay}). Try again tomorrow or upgrade.`,
      },
      { status: 429 }
    );
  }
  if (inFlight >= limits.concurrentJobsLimit) {
    await recordFunnelEvent("web", userId, uploadRejectedEvent("CONCURRENT"));
    return NextResponse.json(
      {
        error: `You have ${inFlight} active jobs (limit: ${limits.concurrentJobsLimit}). Wait for one to finish.`,
      },
      { status: 429 }
    );
  }
```

- [ ] **Step 2: Record `app_opened` on the dashboard**

In `apps/web/app/(dashboard)/dashboard/page.tsx`, add `recordFunnelEvent, FUNNEL_EVENTS` to the `@clipclap/shared` import, then after the `Promise.all` that loads the data:

```ts
  // After the page's own data is resolved, never before: this is telemetry and
  // must not sit in front of what the user came for. recordFunnelEvent never
  // throws, so a failing write cannot break the dashboard.
  await recordFunnelEvent("web", session.user.id, FUNNEL_EVENTS.APP_OPENED);
```

- [ ] **Step 3: Typecheck the web app**

Run: `docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/jobs/route.ts "apps/web/app/(dashboard)/dashboard/page.tsx"
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): web records app_opened, video_submitted and refusal reasons"
```

---

# Phase B - Guest traffic

## Task 5: SiteVisit table

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260726120100_site_visits/migration.sql`

- [ ] **Step 1: Add the model**

Append to `prisma/schema.prisma`:

```prisma
/// Anonymous guest traffic. One row per visitor per path per day; a reload
/// increments `hits` rather than adding a row, so the table stays the size of
/// the audience.
///
/// No raw IP is ever stored: `visitorHash` is sha256(ip + ua + a salt derived
/// from the day), so the same person cannot be followed across days.
model SiteVisit {
  id           String   @id @default(cuid())
  day          DateTime @db.Date
  visitorHash  String
  /// ISO-2 from MaxMind GeoLite2. Null when the database file is absent - a
  /// missing GeoIP file degrades the country column, never the page load.
  country      String?
  path         String
  referrerHost String?
  /// Crawlers are flagged, not dropped, so the noise ratio stays visible and
  /// the filter itself can be audited. The page counts isBot = false.
  isBot        Boolean  @default(false)
  hits         Int      @default(1)
  firstSeenAt  DateTime @default(now())
  lastSeenAt   DateTime @default(now())

  @@unique([day, visitorHash, path])
  @@index([day, country])
  @@index([day, isBot])
  @@map("site_visits")
}
```

- [ ] **Step 2: Create the migration**

Create `prisma/migrations/20260726120100_site_visits/migration.sql`:

```sql
CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "country" TEXT,
    "path" TEXT NOT NULL,
    "referrerHost" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "site_visits_day_visitorHash_path_key"
  ON "site_visits"("day", "visitorHash", "path");
CREATE INDEX "site_visits_day_country_idx" ON "site_visits"("day", "country");
CREATE INDEX "site_visits_day_isBot_idx" ON "site_visits"("day", "isBot");
```

- [ ] **Step 3: Regenerate the client**

Run: `docker compose exec -w /app web npx prisma generate`
Expected: "Generated Prisma Client"; `prisma.siteVisit` exists.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260726120100_site_visits
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): site_visits table for anonymous guest traffic"
```

---

## Task 6: Visit-recording service

Pure helpers plus the write live in `shared` so they are covered by the existing vitest setup and the GeoIP reader has Node `fs`.

**Files:**
- Create: `packages/shared/src/services/site-visit.service.ts`
- Create: `packages/shared/src/services/__tests__/site-visit.service.test.ts`
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/site-visit.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("../../lib/prisma", () => ({
  prisma: { siteVisit: { upsert: mocks.upsert } },
}));

import {
  isBotUserAgent,
  referrerHost,
  visitorHash,
  recordSiteVisit,
} from "../site-visit.service";

describe("isBotUserAgent", () => {
  it("flags the crawlers that actually hit this host", () => {
    // These are real user-agents seen in the server's nginx log.
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isBotUserAgent("r00ts3c-owned-you")).toBe(true);
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("python-requests/2.31.0")).toBe(true);
    expect(isBotUserAgent("HeadlessChrome/135.0.0.0")).toBe(true);
  });

  it("does not flag a normal browser", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"
      )
    ).toBe(false);
  });

  it("treats a missing user-agent as a bot", () => {
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
  });
});

describe("referrerHost", () => {
  it("keeps only the host", () => {
    expect(referrerHost("https://www.google.com/search?q=clipclap")).toBe("www.google.com");
  });
  it("returns null for our own pages, empty and malformed values", () => {
    expect(referrerHost("https://clipclap.io/login", "clipclap.io")).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
    expect(referrerHost("not a url")).toBeNull();
  });
});

describe("visitorHash", () => {
  it("is stable for the same visitor on the same day", () => {
    const a = visitorHash("1.2.3.4", "UA", "secret", "2026-07-26");
    const b = visitorHash("1.2.3.4", "UA", "secret", "2026-07-26");
    expect(a).toBe(b);
  });

  it("differs the next day, so a visitor cannot be followed across days", () => {
    const a = visitorHash("1.2.3.4", "UA", "secret", "2026-07-26");
    const b = visitorHash("1.2.3.4", "UA", "secret", "2026-07-27");
    expect(a).not.toBe(b);
  });

  it("never contains the raw ip", () => {
    expect(visitorHash("1.2.3.4", "UA", "secret", "2026-07-26")).not.toContain("1.2.3.4");
  });
});

describe("recordSiteVisit", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.upsert.mockResolvedValue({});
    vi.restoreAllMocks();
  });

  it("upserts one row per visitor per path per day and increments on repeat", async () => {
    await recordSiteVisit({
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0 (iPhone) Safari/604.1",
      path: "/",
      referrer: "https://www.google.com/",
      secret: "secret",
      now: new Date("2026-07-26T10:00:00Z"),
    });

    const arg = mocks.upsert.mock.calls[0][0];
    expect(arg.where.day_visitorHash_path.path).toBe("/");
    expect(arg.create.isBot).toBe(false);
    expect(arg.create.referrerHost).toBe("www.google.com");
    expect(arg.update.hits).toEqual({ increment: 1 });
  });

  it("flags a crawler instead of dropping it", async () => {
    await recordSiteVisit({
      ip: "1.2.3.4",
      userAgent: "curl/8.4.0",
      path: "/",
      secret: "secret",
      now: new Date("2026-07-26T10:00:00Z"),
    });
    expect(mocks.upsert.mock.calls[0][0].create.isBot).toBe(true);
  });

  it("never throws when the write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockRejectedValue(new Error("db down"));
    await expect(
      recordSiteVisit({ ip: "1.2.3.4", userAgent: "Safari", path: "/", secret: "s" })
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/site-visit.service.test.ts`
Expected: FAIL - cannot resolve `../site-visit.service`.

- [ ] **Step 3: Write the service**

Create `packages/shared/src/services/site-visit.service.ts`:

```ts
import { createHash } from "crypto";
import { prisma } from "../lib/prisma";

/**
 * Anonymous guest traffic.
 *
 * The site sits behind the host nginx, which forwards X-Real-IP and
 * X-Forwarded-For, so the visitor's address is available - but it is never
 * stored. The row is keyed by a hash of (ip + user-agent + a salt derived from
 * the day), which makes repeat visits on one day collapse into one row and
 * makes the same person unlinkable across days.
 */

const BOT_UA =
  /(bot|crawler|spider|slurp|curl|wget|python-requests|httpclient|headless|phantomjs|scrapy|facebookexternalhit|preview|monitor|scanner|owned-you)/i;

/** A missing user-agent is treated as a bot: real browsers always send one. */
export function isBotUserAgent(ua?: string | null): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_UA.test(ua);
}

/** Host of an external referrer, or null for our own pages and junk values. */
export function referrerHost(
  referrer?: string | null,
  selfHost?: string
): string | null {
  if (!referrer?.trim()) return null;
  try {
    const host = new URL(referrer).host;
    if (!host) return null;
    if (selfHost && host.endsWith(selfHost)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * sha256(ip + ua + sha256(secret + day)). The day-derived salt is what keeps
 * a visitor unlinkable across days, and it needs nothing stored or rotated by
 * hand.
 */
export function visitorHash(
  ip: string,
  ua: string,
  secret: string,
  day: string
): string {
  const salt = createHash("sha256").update(`${secret}|${day}`).digest("hex");
  return createHash("sha256").update(`${ip}|${ua}|${salt}`).digest("hex");
}

/** YYYY-MM-DD in UTC - the bucket key for both the salt and the `day` column. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface RecordSiteVisitInput {
  ip: string;
  userAgent?: string | null;
  path: string;
  referrer?: string | null;
  secret: string;
  selfHost?: string;
  now?: Date;
}

/**
 * NEVER THROWS. This runs on the request path of every page view; a telemetry
 * failure must not surface to a visitor.
 */
export async function recordSiteVisit(
  input: RecordSiteVisitInput
): Promise<void> {
  try {
    const now = input.now ?? new Date();
    const day = utcDay(now);
    const ua = input.userAgent ?? "";
    const hash = visitorHash(input.ip, ua, input.secret, day);
    const country = await lookupCountry(input.ip);

    await prisma.siteVisit.upsert({
      where: {
        day_visitorHash_path: {
          day: new Date(`${day}T00:00:00.000Z`),
          visitorHash: hash,
          path: input.path,
        },
      },
      create: {
        day: new Date(`${day}T00:00:00.000Z`),
        visitorHash: hash,
        path: input.path,
        country,
        referrerHost: referrerHost(input.referrer, input.selfHost),
        isBot: isBotUserAgent(ua),
      },
      update: { hits: { increment: 1 }, lastSeenAt: now },
    });
  } catch (error) {
    console.error(
      "Site visit telemetry: could not record visit:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * ISO-2 country from the local GeoLite2 database, or null.
 *
 * The reader is created once and cached. A missing or unreadable database is
 * not an error: the country column degrades to null and every other metric
 * keeps working.
 */
let readerPromise: Promise<{ country: (ip: string) => { country?: { isoCode?: string } } } | null> | null = null;

async function lookupCountry(ip: string): Promise<string | null> {
  try {
    if (!readerPromise) {
      readerPromise = (async () => {
        const path = process.env.GEOLITE2_COUNTRY_DB;
        if (!path) return null;
        const { Reader } = await import("@maxmind/geoip2-node");
        return (await Reader.open(path)) as never;
      })().catch(() => null);
    }
    const reader = await readerPromise;
    if (!reader) return null;
    return reader.country(ip).country?.isoCode ?? null;
  } catch {
    return null;
  }
}
```

Add to `packages/shared/src/services/index.ts`:
```ts
export * from "./site-visit.service";
```

- [ ] **Step 4: Install the GeoIP reader**

Run: `docker compose exec -w /app web npm install @maxmind/geoip2-node -w @clipclap/shared`
Expected: added to `packages/shared/package.json` dependencies.

- [ ] **Step 5: Run to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/site-visit.service.test.ts`
Expected: PASS (11 tests). Country is null throughout because `GEOLITE2_COUNTRY_DB` is unset in tests - that is the intended degradation.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/services/site-visit.service.ts packages/shared/src/services/__tests__/site-visit.service.test.ts packages/shared/src/services/index.ts packages/shared/package.json package-lock.json
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): site visit recorder with bot flagging and optional GeoIP"
```

---

## Task 7: The `/api/_track` route

**Files:**
- Create: `apps/web/app/api/_track/route.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the route**

Create `apps/web/app/api/_track/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { recordSiteVisit } from "@clipclap/shared";

// Prisma and the GeoIP reader both need Node APIs, which the Edge runtime does
// not have - this is exactly why the middleware hands off to this route rather
// than writing the visit itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.TRACK_SECRET;
  // Without the shared secret this is a public endpoint that writes rows:
  // anyone could inflate the numbers. Answer 204 either way so the endpoint
  // does not confirm whether a guess was right.
  if (!secret || req.headers.get("x-track-secret") !== secret) {
    return new NextResponse(null, { status: 204 });
  }

  let body: {
    ip?: string;
    userAgent?: string;
    path?: string;
    referrer?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  if (!body.ip || !body.path) return new NextResponse(null, { status: 204 });

  await recordSiteVisit({
    ip: body.ip,
    userAgent: body.userAgent,
    path: body.path,
    referrer: body.referrer,
    secret,
    selfHost: process.env.NEXT_PUBLIC_APP_HOST ?? "clipclap.io",
  });

  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 2: Document the new env vars**

Append to `.env.example`:

```
# Shared secret between the Edge middleware and /api/_track. Without it the
# tracking endpoint would be a public row-writer. Any random string.
TRACK_SECRET=
# Comma-separated emails allowed to open /admin.
ADMIN_EMAILS=
# MaxMind licence key, used at image build time to fetch GeoLite2-Country.
# Absent = visits are still recorded, country is null.
MAXMIND_LICENSE_KEY=
GEOLITE2_COUNTRY_DB=/app/geoip/GeoLite2-Country.mmdb
```

- [ ] **Step 3: Typecheck**

Run: `docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/_track/route.ts .env.example
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): node-runtime track endpoint behind a shared secret"
```

---

## Task 8: Wire the middleware

**Files:**
- Modify: `apps/web/middleware.ts`

- [ ] **Step 1: Add the tracking hand-off**

Rewrite `apps/web/middleware.ts`, keeping the existing auth guard and `?ref` cookie behaviour exactly as they are:

```ts
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

// Inlined from @clipclap/shared config/referral.ts.
// We cannot import from the @clipclap/shared barrel here because it re-exports
// ./lib (which includes prisma.ts) and the Edge runtime is not compatible with
// Prisma's Node.js bindings. REFERRAL_COOKIE_NAME and REFERRAL_CONFIG are plain
// constants so we inline them to keep middleware Edge-safe.
const REFERRAL_COOKIE_NAME = "cc_ref";
const ATTRIBUTION_WINDOW_DAYS = 30; // REFERRAL_CONFIG.attributionWindowDays

/**
 * Hands the visit to /api/_track, which runs on Node and can reach Prisma.
 *
 * Wrapped in event.waitUntil because a bare un-awaited fetch may be killed
 * along with the response, silently losing visits.
 */
function trackVisit(req: NextRequest, event: NextFetchEvent): void {
  const secret = process.env.TRACK_SECRET;
  if (!secret) return;

  // The owner's own analytics visits must not pollute the numbers he reads.
  if (req.nextUrl.pathname.startsWith("/admin")) return;

  const ip =
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return;

  event.waitUntil(
    fetch(new URL("/api/_track", req.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-track-secret": secret },
      body: JSON.stringify({
        ip,
        userAgent: req.headers.get("user-agent") ?? "",
        path: req.nextUrl.pathname,
        referrer: req.headers.get("referer") ?? "",
      }),
    }).catch(() => undefined)
  );
}

export function middleware(req: NextRequest, event: NextFetchEvent) {
  trackVisit(req, event);

  const ref = req.nextUrl.searchParams.get("ref");

  // Auth guard only for /dashboard.
  if (req.nextUrl.pathname.startsWith("/dashboard")) {
    const sessionCookie =
      req.cookies.get("authjs.session-token") ||
      req.cookies.get("__Secure-authjs.session-token") ||
      req.cookies.get("next-auth.session-token") ||
      req.cookies.get("__Secure-next-auth.session-token");
    if (!sessionCookie) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.next();
  }

  // Last-touch attribution: set/overwrite the ref cookie on any page hit with ?ref=.
  const res = NextResponse.next();
  if (ref) {
    res.cookies.set(REFERRAL_COOKIE_NAME, ref, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60,
      path: "/",
    });
  }
  return res;
}

// Every page, but never /api (the track route would record itself in a loop),
// _next internals, or files with an extension.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/middleware.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): middleware forwards visits to the track route via waitUntil"
```

---

## Task 9: GeoLite2 in the image

**Files:**
- Modify: `apps/web/Dockerfile`

- [ ] **Step 1: Fetch the database at build time**

In `apps/web/Dockerfile`, in the `deps` stage after `RUN npm install`, add:

```dockerfile
# GeoLite2-Country for visitor countries. Optional by design: without a licence
# key the build still succeeds and country lookups return null at runtime.
ARG MAXMIND_LICENSE_KEY=""
RUN mkdir -p /app/geoip && \
    if [ -n "$MAXMIND_LICENSE_KEY" ]; then \
      apk add --no-cache curl tar && \
      curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
        -o /tmp/geo.tgz && \
      tar -xzf /tmp/geo.tgz -C /tmp && \
      find /tmp -name 'GeoLite2-Country.mmdb' -exec cp {} /app/geoip/ \; && \
      rm -rf /tmp/geo.tgz; \
    else \
      echo "MAXMIND_LICENSE_KEY not set - country lookups will return null"; \
    fi
```

Pass the key through in `docker-compose.yml` under the web service's `build:`:

```yaml
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: ${TARGET:-development}
      args:
        MAXMIND_LICENSE_KEY: ${MAXMIND_LICENSE_KEY:-}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/Dockerfile docker-compose.yml
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "build(analytics): optional GeoLite2-Country in the web image"
```

---

# Phase C - Admin page

## Task 10: Aggregation service + admin page

**Files:**
- Create: `packages/shared/src/services/analytics.service.ts`
- Create: `packages/shared/src/services/__tests__/analytics.service.test.ts`
- Create: `apps/web/app/admin/page.tsx`
- Modify: `packages/shared/src/services/index.ts`

> **Not under `/dashboard`:** the middleware redirects unauthenticated
> `/dashboard/*` to `/login`, so a Telegram Mini App (which has no session
> cookie) would never reach the page. `/admin` sits outside that guard and does
> its own gating.

- [ ] **Step 1: Write the failing test for the admin gate helper**

Create `packages/shared/src/services/__tests__/analytics.service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAdminEmail } from "../analytics.service";

describe("isAdminEmail", () => {
  it("accepts an email on the list, case- and space-insensitively", () => {
    expect(isAdminEmail("me@example.com", " Me@Example.com , other@x.io")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isAdminEmail("stranger@x.io", "me@example.com")).toBe(false);
  });
  it("rejects everyone when the list is empty or missing", () => {
    // A misconfigured deploy must close the page, not open it to all.
    expect(isAdminEmail("me@example.com", "")).toBe(false);
    expect(isAdminEmail("me@example.com", undefined)).toBe(false);
  });
  it("rejects a missing email", () => {
    expect(isAdminEmail(undefined, "me@example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/analytics.service.test.ts`
Expected: FAIL - cannot resolve `../analytics.service`.

- [ ] **Step 3: Write the service**

Create `packages/shared/src/services/analytics.service.ts`:

```ts
import { prisma } from "../lib/prisma";
import type { FunnelSurface } from "./funnel.service";

/** Closed by default: an unset or empty ADMIN_EMAILS admits nobody. */
export function isAdminEmail(
  email: string | null | undefined,
  adminEmails: string | undefined
): boolean {
  if (!email || !adminEmails) return false;
  const allowed = adminEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export interface FunnelRow {
  event: string;
  people: number;
  repeats: number;
}

/** People per funnel step for one surface, or both when surface is undefined. */
export async function getFunnel(surface?: FunnelSurface): Promise<FunnelRow[]> {
  const grouped = await prisma.funnelEvent.groupBy({
    by: ["event"],
    where: surface ? { surface } : undefined,
    _count: { _all: true },
    _sum: { occurrences: true },
  });
  return grouped
    .map((g) => ({
      event: g.event,
      people: g._count._all,
      repeats: (g._sum.occurrences ?? 0) - g._count._all,
    }))
    .sort((a, b) => b.people - a.people);
}

export interface TrafficSummary {
  guests: number;
  pageviews: number;
  byCountry: { country: string | null; guests: number }[];
  topPaths: { path: string; hits: number }[];
  topReferrers: { referrerHost: string; guests: number }[];
}

/** Guest traffic for the last `days` days, crawlers excluded. */
export async function getTraffic(days = 30): Promise<TrafficSummary> {
  const since = new Date(Date.now() - days * 86_400_000);
  const where = { isBot: false, day: { gte: since } };

  const [rows, byCountry, topPaths, topReferrers] = await Promise.all([
    prisma.siteVisit.findMany({ where, select: { visitorHash: true, hits: true } }),
    prisma.siteVisit.groupBy({ by: ["country"], where, _count: { _all: true } }),
    prisma.siteVisit.groupBy({ by: ["path"], where, _sum: { hits: true } }),
    prisma.siteVisit.groupBy({
      by: ["referrerHost"],
      where: { ...where, referrerHost: { not: null } },
      _count: { _all: true },
    }),
  ]);

  return {
    guests: new Set(rows.map((r) => r.visitorHash)).size,
    pageviews: rows.reduce((sum, r) => sum + r.hits, 0),
    byCountry: byCountry
      .map((c) => ({ country: c.country, guests: c._count._all }))
      .sort((a, b) => b.guests - a.guests),
    topPaths: topPaths
      .map((p) => ({ path: p.path, hits: p._sum.hits ?? 0 }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10),
    topReferrers: topReferrers
      .map((r) => ({ referrerHost: r.referrerHost as string, guests: r._count._all }))
      .sort((a, b) => b.guests - a.guests)
      .slice(0, 10),
  };
}

export interface Totals {
  users: number;
  paying: number;
  jobs: number;
  clips: number;
}

/** Surface-scoped totals: bot = users with a telegramId, web = with an email. */
export async function getTotals(surface?: FunnelSurface): Promise<Totals> {
  const userWhere =
    surface === "bot"
      ? { telegramId: { not: null } }
      : surface === "web"
        ? { email: { not: null } }
        : {};

  const [users, paying, jobs, clips] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.user.count({ where: { ...userWhere, plan: { not: "NONE" } } }),
    prisma.job.count({ where: { user: userWhere } }),
    prisma.clip.count({ where: { user: userWhere } }),
  ]);
  return { users, paying, jobs, clips };
}
```

Add to `packages/shared/src/services/index.ts`:
```ts
export * from "./analytics.service";
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/analytics.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the admin page**

Create `apps/web/app/admin/page.tsx`:

```tsx
import { auth } from "@/lib/auth";
import { cookies } from "next/headers";
import {
  getFunnel,
  getTotals,
  getTraffic,
  isAdminEmail,
  verifyAdminCookie,
  type FunnelSurface,
} from "@clipclap/shared";
import { MiniAppGate } from "./mini-app-gate";

export const dynamic = "force-dynamic";

const SURFACES = [
  { key: "", label: "Combined" },
  { key: "bot", label: "Telegram" },
  { key: "web", label: "Web" },
] as const;

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string }>;
}) {
  // Two independent ways in: a normal admin session (desktop), or the signed
  // cookie that /api/admin/enter sets after validating Telegram initData.
  const session = await auth();
  const cookieOk = verifyAdminCookie(
    (await cookies()).get("cc_admin")?.value,
    process.env.NEXTAUTH_SECRET
  );
  if (!isAdminEmail(session?.user?.email, process.env.ADMIN_EMAILS) && !cookieOk) {
    // Render only the Mini App gate: inside Telegram it posts initData and
    // reloads; in a plain browser it renders nothing and the page stays empty,
    // which is the 404-equivalent we want (no hint that this route matters).
    return <MiniAppGate />;
  }

  const { surface: raw } = await searchParams;
  const surface: FunnelSurface | undefined =
    raw === "bot" || raw === "web" ? raw : undefined;

  const [funnel, totals, traffic] = await Promise.all([
    getFunnel(surface),
    getTotals(surface),
    surface === "bot" ? Promise.resolve(null) : getTraffic(30),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <div className="mt-3 flex gap-2">
          {SURFACES.map((s) => (
            <a
              key={s.key}
              href={s.key ? `?surface=${s.key}` : "?"}
              className={`rounded-md border px-3 py-1 text-sm ${
                (raw ?? "") === s.key ? "bg-white text-black" : "opacity-70"
              }`}
            >
              {s.label}
            </a>
          ))}
        </div>
      </div>

      <section>
        <h2 className="mb-2 font-semibold">Totals</h2>
        <p className="text-sm opacity-80">
          users {totals.users} · paying {totals.paying} · jobs {totals.jobs} ·
          clips {totals.clips}
        </p>
      </section>

      {traffic && (
        <section>
          <h2 className="mb-2 font-semibold">Guest traffic (30d)</h2>
          <p className="text-sm opacity-80">
            guests {traffic.guests} · pageviews {traffic.pageviews}
          </p>
          <p className="mt-2 text-sm opacity-80">
            {traffic.byCountry
              .slice(0, 10)
              .map((c) => `${c.country ?? "??"} ${c.guests}`)
              .join(" · ")}
          </p>
          <p className="mt-2 text-sm opacity-80">
            {traffic.topReferrers.map((r) => `${r.referrerHost} ${r.guests}`).join(" · ")}
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-semibold">Funnel</h2>
        <table className="w-full text-sm">
          <tbody>
            {funnel.map((row) => (
              <tr key={row.event} className="border-b border-white/10">
                <td className="py-1">{row.event}</td>
                <td className="py-1 text-right">{row.people}</td>
                <td className="py-1 text-right opacity-60">+{row.repeats} repeats</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-xs opacity-50">
        Web funnel starts at signup - an anonymous visitor cannot be identified
        before login without cookies, which this product does not set. In
        Combined, a person with both a bot and a web account is counted twice.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/services/analytics.service.ts packages/shared/src/services/__tests__/analytics.service.test.ts packages/shared/src/services/index.ts apps/web/app/admin/page.tsx
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): aggregation service and admin page behind ADMIN_EMAILS"
```

---

## Task 11: Telegram Mini App entry

**Files:**
- Create: `packages/shared/src/services/__tests__/mini-app.service.test.ts`
- Create: `packages/shared/src/services/mini-app.service.ts`
- Create: `apps/web/app/api/admin/enter/route.ts`
- Create: `apps/web/app/admin/mini-app-gate.tsx`
- Modify: `apps/bot/src/handlers.ts` (admin button)
- Modify: `packages/shared/src/services/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/services/__tests__/mini-app.service.test.ts`:

```ts
import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  verifyTelegramInitData,
  signAdminCookie,
  verifyAdminCookie,
} from "../mini-app.service";

const BOT_TOKEN = "123456:test-bot-token";

/** Builds a correctly signed initData string the way Telegram does. */
function makeInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN
): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  // Mini App algorithm: the secret is HMAC("WebAppData", token), NOT sha256(token).
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const nowSec = Math.floor(Date.now() / 1000);
const userJson = JSON.stringify({ id: 575308044, first_name: "Oleg" });

describe("verifyTelegramInitData", () => {
  it("accepts data Telegram actually signed and returns the telegram id", () => {
    const initData = makeInitData({ auth_date: String(nowSec), user: userJson });
    expect(verifyTelegramInitData(initData, BOT_TOKEN)).toEqual({
      ok: true,
      telegramId: "575308044",
    });
  });

  it("rejects a tampered payload", () => {
    const initData = makeInitData({ auth_date: String(nowSec), user: userJson });
    const tampered = initData.replace("575308044", "999999999");
    expect(verifyTelegramInitData(tampered, BOT_TOKEN).ok).toBe(false);
  });

  it("rejects data signed with a different bot token", () => {
    const initData = makeInitData(
      { auth_date: String(nowSec), user: userJson },
      "999999:someone-elses-token"
    );
    expect(verifyTelegramInitData(initData, BOT_TOKEN).ok).toBe(false);
  });

  it("rejects a stale auth_date", () => {
    const old = String(nowSec - 60 * 60 * 25);
    const initData = makeInitData({ auth_date: old, user: userJson });
    expect(verifyTelegramInitData(initData, BOT_TOKEN).ok).toBe(false);
  });

  it("rejects empty input and a missing hash", () => {
    expect(verifyTelegramInitData("", BOT_TOKEN).ok).toBe(false);
    expect(verifyTelegramInitData("auth_date=1&user=%7B%7D", BOT_TOKEN).ok).toBe(false);
  });
});

describe("admin cookie", () => {
  it("round-trips a signed value", () => {
    const value = signAdminCookie("575308044", "secret", 3600_000);
    expect(verifyAdminCookie(value, "secret")).toBe(true);
  });

  it("rejects a forged or edited value", () => {
    const value = signAdminCookie("575308044", "secret", 3600_000);
    expect(verifyAdminCookie(value.replace("575308044", "1"), "secret")).toBe(false);
    expect(verifyAdminCookie("1.9999999999999.deadbeef", "secret")).toBe(false);
  });

  it("rejects an expired value and a missing one", () => {
    const expired = signAdminCookie("575308044", "secret", -1000);
    expect(verifyAdminCookie(expired, "secret")).toBe(false);
    expect(verifyAdminCookie(undefined, "secret")).toBe(false);
  });

  it("rejects everything when the signing secret is missing", () => {
    const value = signAdminCookie("575308044", "secret", 3600_000);
    expect(verifyAdminCookie(value, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/mini-app.service.test.ts`
Expected: FAIL - cannot resolve `../mini-app.service`.

- [ ] **Step 3: Write the service**

Create `packages/shared/src/services/mini-app.service.ts`:

```ts
import { createHmac, timingSafeEqual } from "crypto";

const MAX_AUTH_AGE_SEC = 60 * 60 * 24;

export type InitDataResult =
  | { ok: true; telegramId: string }
  | { ok: false };

/**
 * Validates the `initData` Telegram injects into a Mini App.
 *
 * NOTE the secret derivation: for Mini Apps it is HMAC_SHA256("WebAppData",
 * botToken). The Login Widget uses SHA256(botToken) instead, and mixing the two
 * up is the classic reason "the signature never matches".
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string | undefined
): InitDataResult {
  try {
    if (!initData || !botToken) return { ok: false };
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false };

    params.delete("hash");
    const checkString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");

    const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
    const expected = createHmac("sha256", secret).update(checkString).digest("hex");

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };

    const authDate = Number(params.get("auth_date"));
    if (!Number.isFinite(authDate)) return { ok: false };
    if (Math.floor(Date.now() / 1000) - authDate > MAX_AUTH_AGE_SEC) {
      return { ok: false };
    }

    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number };
    if (!user.id) return { ok: false };
    return { ok: true, telegramId: String(user.id) };
  } catch {
    return { ok: false };
  }
}

/** `<telegramId>.<expiresAtMs>.<hmac>` - unforgeable without the secret. */
export function signAdminCookie(
  telegramId: string,
  secret: string,
  ttlMs: number
): string {
  const expiresAt = Date.now() + ttlMs;
  const body = `${telegramId}.${expiresAt}`;
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function verifyAdminCookie(
  value: string | undefined,
  secret: string | undefined
): boolean {
  try {
    if (!value || !secret) return false;
    const [telegramId, expiresAt, mac] = value.split(".");
    if (!telegramId || !expiresAt || !mac) return false;
    if (Number(expiresAt) < Date.now()) return false;

    const expected = createHmac("sha256", secret)
      .update(`${telegramId}.${expiresAt}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(mac, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Whether a telegram id is listed in REFERRAL_ADMIN_TELEGRAM_IDS. */
export function isAdminTelegramId(
  telegramId: string,
  adminIds: string | undefined
): boolean {
  if (!adminIds) return false;
  return adminIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(telegramId);
}
```

Add to `packages/shared/src/services/index.ts`:
```ts
export * from "./mini-app.service";
```

- [ ] **Step 4: Run to verify it passes**

Run: `docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src/services/__tests__/mini-app.service.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the entry route**

Create `apps/web/app/api/admin/enter/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  isAdminTelegramId,
  signAdminCookie,
  verifyTelegramInitData,
} from "@clipclap/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const { initData } = (await req.json().catch(() => ({}))) as {
    initData?: string;
  };

  const result = verifyTelegramInitData(
    initData ?? "",
    process.env.TELEGRAM_BOT_TOKEN
  );
  // One shape of failure for every reason - a bad signature, a stale
  // auth_date and a valid signature from a non-admin all look identical.
  if (
    !result.ok ||
    !isAdminTelegramId(result.telegramId, process.env.REFERRAL_ADMIN_TELEGRAM_IDS)
  ) {
    return new NextResponse(null, { status: 204 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return new NextResponse(null, { status: 204 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set("cc_admin", signAdminCookie(result.telegramId, secret, TTL_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/admin",
    maxAge: TTL_MS / 1000,
  });
  return res;
}
```

- [ ] **Step 6: Write the Mini App gate component**

Create `apps/web/app/admin/mini-app-gate.tsx`:

```tsx
"use client";

import { useEffect } from "react";

/**
 * Rendered when the request carries neither an admin session nor the cookie.
 *
 * Inside Telegram it hands initData to /api/admin/enter and reloads into the
 * real page. In a plain browser window.Telegram is undefined, so it renders
 * nothing and the page stays blank.
 */
export function MiniAppGate() {
  useEffect(() => {
    const initData = (
      window as unknown as {
        Telegram?: { WebApp?: { initData?: string; ready?: () => void } };
      }
    ).Telegram?.WebApp?.initData;
    if (!initData) return;

    fetch("/api/admin/enter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData }),
    })
      .then((r) => {
        // Reload only on success, so a rejected signature does not spin.
        if (r.ok) window.location.reload();
      })
      .catch(() => undefined);
  }, []);

  return (
    <script
      src="https://telegram.org/js/telegram-web-app.js"
      async
      // The script must be present before initData can be read; on the first
      // paint it is not, which is why the effect runs after it loads and the
      // page reloads once the cookie is set.
      onLoad={() => window.location.reload()}
    />
  );
}
```

- [ ] **Step 7: Add the admin button to the bot**

In `apps/bot/src/handlers.ts`, in the menu that is sent to a user, append an
inline `web_app` button only for admins. Add near `buildMainMenu` usage in
`handleMenuAction`'s `case "menu":`, after the existing `sendMessage`:

```ts
      if (isReferralAdmin(String(message.from!.id), process.env.REFERRAL_ADMIN_TELEGRAM_IDS)) {
        await client
          .sendMessage(message.chat.id, "Analytics", {
            replyMarkup: {
              inline_keyboard: [
                [{ text: "Open analytics", web_app: { url: `${config.appUrl}/admin` } }],
              ],
            },
          })
          .catch(() => undefined);
      }
```

If `TelegramClient`'s inline-keyboard type does not yet allow `web_app`, extend
the button type in `apps/bot/src/types.ts` to include
`{ text: string; web_app: { url: string } }`.

- [ ] **Step 8: Typecheck and run the suites**

```bash
docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit
docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/services/mini-app.service.ts packages/shared/src/services/__tests__/mini-app.service.test.ts packages/shared/src/services/index.ts apps/web/app/api/admin/enter/route.ts apps/web/app/admin/mini-app-gate.tsx apps/bot/src/handlers.ts apps/bot/src/types.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(analytics): telegram mini app entry for the admin page"
```

---

## Task 12: Deploy and verify

No code changes. Run each step and confirm before moving on.

- [ ] **Step 1: Full test suites**

```bash
docker compose exec -w /app/apps/web web npx vitest run --root ../.. packages/shared/src
docker compose exec -w /app/apps/bot bot npx vitest run --root ../.. apps/bot/src
```
Expected: PASS. (A pre-existing failure in `billing.service.test.ts` about `STRIPE_STARTER_MONTHLY_PRICE_ID` is unrelated to this work - that test asserts a throw that cannot happen while the env var is set in the container.)

- [ ] **Step 2: Typecheck everything**

```bash
docker compose exec -w /app web npx tsc -p packages/shared/tsconfig.json --noEmit
docker compose exec -w /app web npx tsc -p apps/web/tsconfig.json --noEmit
docker compose exec -w /app web npx tsc -p apps/bot/tsconfig.json --noEmit
```
Expected: all PASS.

- [ ] **Step 3: Add the new env vars to production `.env`**

Add `TRACK_SECRET` (any long random string), `ADMIN_EMAILS=ikscerato@gmail.com`, and optionally `MAXMIND_LICENSE_KEY` plus `GEOLITE2_COUNTRY_DB=/app/geoip/GeoLite2-Country.mmdb`.

- [ ] **Step 4: Apply the migrations**

Run: `docker compose exec -w /app web npx prisma migrate deploy`
Expected: 2 migrations applied.

Verify the rename preserved the existing rows:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT surface, event, \"subjectId\", occurrences FROM funnel_events ORDER BY \"firstSeenAt\";"
```
Expected: the 4 pre-existing rows, all `surface = 'bot'`, history intact.

- [ ] **Step 5: Rebuild and recreate**

```bash
docker compose up -d --build web bot
```
Then the regeneration ritual, which a recreate always requires on this host:
```bash
docker compose exec -w /app web npx prisma generate
docker compose exec -w /app bot npx prisma generate
docker compose exec -w /app web npm run build -w @clipclap/shared
docker compose restart bot
```
Expected: containers `running`. Without the shared rebuild the bot runs the old `dist` and writes no events.

- [ ] **Step 6: Verify guest tracking**

Visit `https://clipclap.io/` in a browser, then:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT day, country, path, \"referrerHost\", \"isBot\", hits FROM site_visits ORDER BY \"firstSeenAt\" DESC LIMIT 5;"
```
Expected: one row for `/` with `isBot = false`. Reload the page and confirm `hits` becomes 2 **without** a second row appearing.

- [ ] **Step 7: Verify the secret actually guards the endpoint**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://clipclap.io/api/_track \
  -H 'content-type: application/json' -d '{"ip":"9.9.9.9","path":"/fake"}'
```
Expected: `204`, and **no** new row for `/fake`:
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT count(*) FROM site_visits WHERE path='/fake';"
```
Expected: 0.

- [ ] **Step 8: Verify the bot funnel**

Send `/start` to the bot from an account with no user row, press "New account", then send a video that will be refused (e.g. one over the free duration cap):
```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT surface, event, occurrences FROM funnel_events WHERE surface='bot' ORDER BY \"lastSeenAt\" DESC LIMIT 10;"
```
Expected: `start_first_screen`, `first_screen_new_account`, `app_opened`, `video_submitted`, and one `upload_rejected_*` row.

- [ ] **Step 9: Verify the web funnel and the page**

Load `/dashboard` while signed in, then open `/admin`.
Expected: an `app_opened` row with `surface='web'`; the admin page renders with the three filters. Open `/admin` in a logged-out browser and confirm it renders no data.

- [ ] **Step 10: Verify the Mini App path**

In the bot, open the menu as the admin Telegram account and tap "Open analytics".
Expected: the page opens inside Telegram and shows the stats without any login.

Then confirm the endpoint cannot be talked into issuing a cookie:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://clipclap.io/api/admin/enter \
  -H 'content-type: application/json' -d '{"initData":"auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef"}'
```
Expected: `204` and no `set-cookie` header (add `-D -` to inspect headers).

Also confirm the button is absent for a non-admin Telegram account.

- [ ] **Step 11: Confirm /admin is not tracked**

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c \
  "SELECT count(*) FROM site_visits WHERE path LIKE '/admin%';"
```
Expected: 0 - the owner's own visits must not pollute the traffic numbers.

- [ ] **Step 12: Final commit if anything changed**

If verification required a fix, commit it. Otherwise the work is complete on this branch.

---

## Self-Review Notes (author)

- **Mini App coverage:** `initData` HMAC with the Mini-App-specific secret derivation, stale `auth_date`, non-admin id, signed one-hour cookie, bot `web_app` button gated by `isReferralAdmin`, `/admin` excluded from traffic (T11, verified in T12 steps 10-11). The page moved out of `/dashboard` because the middleware would redirect the Mini App to `/login` before it could run.
- **Spec coverage:** generalized table + migration (T1) · surface-aware recorder and step vocabulary incl. rejection names (T2) · bot call sites (T3) · web call sites (T4) · `site_visits` (T5) · visitor hash / daily salt / bot flagging / GeoIP degradation (T6) · `TRACK_SECRET`-guarded Node route (T7) · `waitUntil` + widened matcher excluding `/api` (T8) · GeoLite2 build (T9) · aggregation + `ADMIN_EMAILS` 404 gate + three-surface page + disclosure footnote (T10) · deploy ritual and the 7 spec verification points (T11). The spec's "not new events" rule is honoured: no task adds counters for jobs, clips or returns.
- **Type consistency:** `recordFunnelEvent(surface, subjectId, event, locale?)`, `uploadRejectedEvent(code)`, `FUNNEL_EVENTS`, `FunnelSurface`, `recordSiteVisit({ip, userAgent, path, referrer, secret, selfHost, now})`, `isAdminEmail(email, adminEmails)`, `getFunnel/getTraffic/getTotals` are used with identical names and shapes across tasks and in the page.
- **Known intermediate breakage:** the bot and web do not typecheck between T2 and T4 (renamed exports). Stated in the header; the full typecheck gate is T11 Step 2.
