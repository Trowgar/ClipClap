# Web Support Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an authenticated Dashboard support thread whose messages reach the existing operator Telegram chat and whose Telegram replies return to the web user with one first-unread email notification.

**Architecture:** Extend the existing `SupportMessage` ledger and shared support service; do not add a ticket platform. Next.js routes authenticate web users, the existing Telegram helper relays inbound text, the bot parses an exact web marker for replies, and the Dashboard polls every five seconds. Telegram remains the only operator console.

**Tech Stack:** Next.js 15 App Router, React 19, Prisma/PostgreSQL, existing Telegram Bot API and Resend helpers, Vitest, Playwright browser QA.

---

## File map

- `prisma/schema.prisma`, `prisma/migrations/20260921153500_web_support_chat/migration.sql`: additive web-thread fields and indexes.
- `packages/shared/src/services/support-log.service.ts`: persistence, idempotency, rate limit, unread state and relay status.
- `packages/shared/src/services/telegram-notification.service.ts`: shared support-chat destination helper.
- `packages/shared/src/services/email.service.ts`: one transcript-free support-reply notification.
- `apps/web/app/api/support/route.ts`, `apps/web/app/api/support/read/route.ts`: authenticated thread/send/read boundary.
- `apps/bot/src/handlers.ts`: parse and store operator replies to web markers.
- `apps/web/app/(dashboard)/dashboard/support/page.tsx`, `apps/web/components/support-chat.tsx`: customer chat page.
- `apps/web/app/(dashboard)/layout.tsx`, `apps/web/components/sidebar.tsx`: Support navigation and unread badge.
- Focused tests beside the shared service, web route/UI and bot handlers.

### Task 1: Extend the existing support ledger

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260921153500_web_support_chat/migration.sql`
- Modify: `packages/shared/src/services/support-log.service.ts`
- Create: `packages/shared/src/services/__tests__/web-support.service.test.ts`

- [x] **Step 1: Write failing service tests**

Mock Prisma and cover these exact contracts:

```ts
await submitWebSupportMessage({
  userId: "u1", clientMessageId: "12345678-1234-1234-1234-123456789abc",
  text: "The upload stops", contextPath: "/dashboard/projects/p1",
});
expect(prisma.supportMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({
  surface: "web", userId: "u1", direction: "in", deliveryStatus: "pending",
  dedupeKey: "web:u1:12345678-1234-1234-1234-123456789abc",
}) });
```

Also assert: a sent duplicate is returned without a second Telegram call; a failed duplicate retries the same row; ten other new messages in one minute reject the eleventh; an operator reply is unique by Telegram message; only the first unread reply reports `shouldNotify: true`; read marking affects only outbound web rows for that user; unread count excludes Telegram and inbound rows.

- [x] **Step 2: Run the new test and verify failure**

Run:

```bash
docker exec clipclap-support-check-20260921 sh -lc 'cd /app && SUBMISSION_QUEUE=off DATABASE_URL="postgresql://test:test@127.0.0.1:1/test?connect_timeout=1" npx vitest run packages/shared/src/services/__tests__/web-support.service.test.ts'
```

Expected: FAIL because the web support functions do not exist.

- [x] **Step 3: Add the additive schema and SQL migration**

Change `SupportMessage.telegramId` to nullable and add:

```prisma
surface          String    @default("telegram")
deliveryStatus   String    @default("sent")
dedupeKey        String?   @unique
readAt           DateTime?
contextPath      String?
emailNotifiedAt  DateTime?

@@index([userId, surface, createdAt])
@@index([userId, surface, direction, readAt])
```

The SQL uses `ALTER COLUMN telegramId DROP NOT NULL`, adds columns with the
same defaults, creates a unique index on `dedupeKey`, and creates the two
compound indexes. Existing rows remain `surface='telegram'` and `sent`.

- [x] **Step 4: Implement the minimum shared service**

Keep `recordSupportMessage` and `supportThread` backward compatible. Add:

```ts
export class SupportRateLimitError extends Error {}
export async function submitWebSupportMessage(input: WebSupportInput): Promise<SupportMessage>
export async function listWebSupportMessages(userId: string, take = 100): Promise<SupportMessage[]>
export async function storeWebSupportReply(input: WebReplyInput): Promise<{ message: SupportMessage; created: boolean; shouldNotify: boolean }>
export async function markWebSupportRead(userId: string): Promise<number>
export async function countUnreadWebSupport(userId: string): Promise<number>
```

`submitWebSupportMessage` validates no presentation concerns; it uses the
authenticated `userId`, creates/reuses `web:${userId}:${clientMessageId}`,
checks ten new messages per minute, loads the user label, sends this plain text
through `sendTelegramMessage`, then updates the same row to `sent` or `failed`:

```text
🆕 #web<userId> <safe account label>
Context: /dashboard/...

<message text>
```

`storeWebSupportReply` deduplicates on
`web-reply:<supportChatId>:<telegramMessageId>` and checks for prior unread
outbound web rows before creating the reply.

- [x] **Step 5: Run Prisma generation and service tests**

Run `npx prisma generate` in the isolated container, then the Task 1 command.
Expected: all new service tests PASS; no production DB writes.

- [x] **Step 6: Commit**

```bash
git add prisma packages/shared/src/services/support-log.service.ts packages/shared/src/services/__tests__/web-support.service.test.ts
git commit -m "feat: add durable web support threads"
```

### Task 2: Add authenticated web APIs

**Files:**
- Create: `apps/web/app/api/support/route.ts`
- Create: `apps/web/app/api/support/read/route.ts`
- Create: `apps/web/src/__tests__/support-route.test.ts`

- [x] **Step 1: Write failing route tests**

Use `NextRequest` and mocked auth/shared service to assert:

```ts
expect((await GET()).status).toBe(401); // no session
expect((await POST(request({ text: " ", clientMessageId: validId }))).status).toBe(400);
expect((await POST(request({ text: "x".repeat(4001), clientMessageId: validId }))).status).toBe(400);
expect((await POST(request({ text: "help", clientMessageId: validId, contextPath: "https://evil.test" }))).status).toBe(400);
```

Then assert a valid POST passes only session `user.id`, trimmed text, UUID and
relative `/dashboard` path to the service; rate limit maps to 429; relay state
is returned; GET returns only that user's rows/unread; read POST passes only the
session ID and returns 204.

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
docker exec clipclap-support-check-20260921 sh -lc 'cd /app && SUBMISSION_QUEUE=off DATABASE_URL="postgresql://test:test@127.0.0.1:1/test?connect_timeout=1" npx vitest run apps/web/src/__tests__/support-route.test.ts'
```

Expected: FAIL because routes do not exist.

- [x] **Step 3: Implement route validation and handlers**

Use `auth()` in every handler. Accept JSON no larger than 8 KiB. Require an
RFC-4122-shaped UUID, trimmed text length 1–4000, and optional context matching
`^/dashboard(?:/|$)`. Do not accept a user ID, direction, delivery state or
email from the browser. Return `{ message }`, `{ messages, unread }`, 429 for
`SupportRateLimitError`, 400 for malformed input and 401 without auth.

- [x] **Step 4: Run route tests and commit**

Expected: route test PASS.

```bash
git add apps/web/app/api/support apps/web/src/__tests__/support-route.test.ts
git commit -m "feat(web): expose authenticated support API"
```

### Task 3: Route operator replies and first-unread email

**Files:**
- Modify: `packages/shared/src/services/telegram-notification.service.ts`
- Modify: `packages/shared/src/services/email.service.ts`
- Modify: `apps/bot/src/handlers.ts`
- Modify: `apps/bot/src/__tests__/support.test.ts`
- Modify: `packages/shared/src/services/__tests__/email.service.test.ts`

- [x] **Step 1: Write failing marker, dedupe and email tests**

Assert the exact anchored parser:

```ts
expect(parseWebSupportReply(replyTo("🆕 #webcm123 User"))).toEqual({ userId: "cm123" });
expect(parseWebSupportReply(replyTo("prefix #webcm123"))).toBeNull();
expect(parseWebSupportReply(replyTo("🆕 #web../../etc"))).toBeNull();
```

Mock `storeWebSupportReply` and assert bot replies pass support chat ID,
Telegram message ID, user ID and text. Missing user/storage failure sends an
operator warning. Duplicate updates do not create another row or email.
Assert `sendSupportReplyEmail()` uses subject `ClipClap support replied`, a
`/dashboard/support` CTA, and contains no transcript text.

- [x] **Step 2: Run focused tests and verify failure**

Run bot support and email tests. Expected: FAIL on missing parser/mailer.

- [x] **Step 3: Share the support destination helper**

Export `getSupportChatId()` from the existing shared Telegram notification
module using `SUPPORT_CHAT_ID`, then the first referral admin fallback. Keep a
thin exported wrapper in bot handlers so existing imports/tests remain valid.

- [x] **Step 4: Implement web-reply routing**

In the operator-chat branch, check `parseWebSupportReply` before the existing
numeric Telegram marker. Require text. Call `storeWebSupportReply` with
`web-reply:${chatId}:${message.message_id}`. If `created && shouldNotify`, load
the user; only when `email && emailVerified` call `sendSupportReplyEmail` and,
on accepted send, set this message's `emailNotifiedAt`. Never send email for a
duplicate or an already-unread thread. A failed email does not remove the row.

- [x] **Step 5: Run bot/email tests plus existing support regressions**

Run:

```bash
docker exec clipclap-support-check-20260921 sh -lc 'cd /app && SUBMISSION_QUEUE=off DATABASE_URL="postgresql://test:test@127.0.0.1:1/test?connect_timeout=1" npx vitest run apps/bot/src/__tests__/support.test.ts apps/bot/src/__tests__/support-i18n.test.ts apps/bot/src/__tests__/help-menu.test.ts packages/shared/src/services/__tests__/email.service.test.ts packages/shared/src/services/__tests__/web-support.service.test.ts'
```

Expected: all PASS.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src/services/telegram-notification.service.ts packages/shared/src/services/email.service.ts apps/bot/src/handlers.ts apps/bot/src/__tests__/support.test.ts packages/shared/src/services/__tests__/email.service.test.ts
git commit -m "feat(bot): deliver web support replies"
```

### Task 4: Build the Dashboard support experience

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/support/page.tsx`
- Create: `apps/web/components/support-chat.tsx`
- Modify: `apps/web/app/(dashboard)/layout.tsx`
- Modify: `apps/web/components/sidebar.tsx`
- Modify: `apps/web/components/mobile-header.tsx`
- Create: `apps/web/src/__tests__/support-page.test.ts`
- Create: `apps/web/src/__tests__/support-sidebar.test.ts`

- [x] **Step 1: Write failing page/navigation tests**

Render server components with mocked auth/service and assert the layout passes
the authenticated unread count. Render sidebar and assert Support exists on
desktop/mobile, links to `/dashboard/support?from=<current pathname>`, and badge
is absent at zero and visible above zero. Static-render the page shell and
assert the honest asynchronous-support copy, accessible `Support conversation`
region, textarea label and Send button.

- [x] **Step 2: Run tests and verify failure**

Run the two new web tests. Expected: FAIL on missing page/component/props.

- [x] **Step 3: Implement the page and client chat**

Use existing Tailwind/shadcn primitives only. `SupportChat`:

- fetches `/api/support` on mount, every five seconds while visible, and on
  `visibilitychange`;
- posts `/api/support/read` after rendering unread outbound messages;
- preserves one UUID per draft/send attempt, posts text/context, replaces the
  optimistic row with the server row, and retains that UUID for Retry;
- renders timestamps and `Sending…`, `Delivered`, `Not sent — Retry` states;
- keeps messages as text (`whitespace-pre-wrap`) and never uses HTML injection;
- supports Ctrl/Cmd+Enter to send while plain Enter inserts a newline;
- disables empty/over-limit sends and exposes errors with `role="alert"`.

The server page validates `from` with the same relative Dashboard pattern and
passes it to the client. It states: “We’ll reply here. This is not a live chat,
so replies may take time.”

- [x] **Step 4: Add navigation and unread badge**

The Dashboard layout calls `countUnreadWebSupport(session.user.id)` once and
passes `supportUnread` through existing sidebar/mobile props. Add a Chat icon,
accessible badge text and context-preserving href derived from `usePathname()`.
Do not add global polling.

- [x] **Step 5: Run UI tests, web typecheck and production build**

Run the two tests, all `apps/web/src/__tests__`, `npx tsc -p apps/web/tsconfig.json --noEmit`, shared build, bot typecheck, and isolated `next build`. Expected: PASS; the existing BullMQ dynamic-import warning is allowed.

- [ ] **Step 6: Commit**

```bash
git add 'apps/web/app/(dashboard)' apps/web/components/support-chat.tsx apps/web/components/sidebar.tsx apps/web/components/mobile-header.tsx apps/web/src/__tests__/support-page.test.ts apps/web/src/__tests__/support-sidebar.test.ts
git commit -m "feat(web): add Dashboard support conversation"
```

### Task 5: Verify and deploy

**Files:**
- Create: `docs/2026-09-21-web-support-production-release.md`

- [ ] **Step 1: Run complete focused verification**

Run all new tests, all bot tests, all web tests, shared build, web/bot typechecks,
`git diff --check`, and an independent code review. Fix concrete blockers and
rerun affected checks.

- [ ] **Step 2: Back up and apply the additive migration**

Confirm no active jobs. Save a PostgreSQL custom-format dump, current shared
dist, current Next `.next`, and current task source delta. Apply only the new
migration and verify columns/indexes read-only. Regenerate Prisma clients in
web, bot and all worker containers before new source starts.

- [ ] **Step 3: Deploy tested source and build artifacts**

Build outside the live `.next`, stop only web/bot/workers after active jobs are
zero, apply the reviewed task diff, copy tested shared dist and Next build,
then restart the existing containers in place. Do not recreate analyze or
transcribe containers because they have custom key-rotation configuration.

- [ ] **Step 4: Run production browser and transport smoke**

With the synthetic account, verify desktop and mobile Support navigation,
empty state, keyboard send, single Telegram operator notification, delivered
state, one operator reply, unread badge, poll/read clearing, no duplicate on
retry, and no page errors. Use a synthetic/test email destination only; do not
contact a real customer. Force a failed relay only in an isolated test path.

- [ ] **Step 5: Verify health and document evidence**

Check login/static assets, migration status, bot/web/worker logs and container
health. Confirm synthetic support rows are excluded from business analytics and
labelled as QA. Record build ID, test totals, smoke IDs, backup location,
rollback steps, and the deliberate no-attachments/no-live-presence ceiling.

- [ ] **Step 6: Commit release evidence**

```bash
git add docs/2026-09-21-web-support-production-release.md
git commit -m "docs: record web support production verification"
```
