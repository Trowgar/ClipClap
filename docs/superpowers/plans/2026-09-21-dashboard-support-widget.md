# Dashboard Support Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dashboard Support navigation with a persistent floating chat widget while preserving the production support thread and delivery pipeline.

**Architecture:** Add one client-side `SupportWidget` to the authenticated Dashboard layout and reuse `SupportChat`. Keep the chat mounted after first open so its draft survives closing, but pass an `active` flag so closed widgets neither poll nor mark new replies read. Redirect the old page to a query URL and update support email links for compatibility.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS, Phosphor icons, Vitest server rendering, existing support APIs.

---

## File map

- Create `apps/web/components/support-widget.tsx`: floating trigger, responsive panel, open/close state, unread badge and query-driven opening.
- Modify `apps/web/components/support-chat.tsx`: optional `active` and `className` props for an embedded, pauseable conversation.
- Modify `apps/web/app/(dashboard)/layout.tsx`: mount the widget once on all authenticated Dashboard routes.
- Modify `apps/web/components/sidebar.tsx`: remove Support navigation and obsolete routing logic.
- Modify `apps/web/app/(dashboard)/dashboard/support/page.tsx`: redirect legacy visits to the widget URL.
- Modify `packages/shared/src/services/email.service.ts`: point notification CTA at the widget URL.
- Modify focused support tests to specify the new behavior.

### Task 1: Specify widget and compatibility behavior

**Files:**
- Create: `apps/web/src/__tests__/support-widget.test.ts`
- Modify: `apps/web/src/__tests__/support-sidebar.test.ts`
- Modify: `apps/web/src/__tests__/support-page.test.ts`
- Modify: `packages/shared/src/services/__tests__/email.service.test.ts`

- [ ] **Step 1: Write failing widget tests**

Render the client component with mocked navigation and assert the trigger, capped
badge, dialog label and query-open state:

```ts
expect(closedHtml).toContain('aria-label="Open support chat"');
expect(closedHtml).toContain("99+");
expect(closedHtml).not.toContain('aria-label="Support chat"');
expect(openHtml).toContain('aria-label="Support chat"');
expect(openHtml).toContain('aria-label="Close support chat"');
```

Change the sidebar test to assert `Support` and `/dashboard/support` are absent.
Mock `redirect` in the page test and assert `/dashboard?support=open`. Change the
email assertion to the same URL.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
docker exec clipclap-support-check-20260921 sh -lc 'cd /app && npx vitest run apps/web/src/__tests__/support-widget.test.ts apps/web/src/__tests__/support-sidebar.test.ts apps/web/src/__tests__/support-page.test.ts packages/shared/src/services/__tests__/email.service.test.ts'
```

Expected: FAIL because `SupportWidget` is missing and the old navigation/page URL
still exists.

- [ ] **Step 3: Commit the red tests**

```bash
git add apps/web/src/__tests__/support-widget.test.ts apps/web/src/__tests__/support-sidebar.test.ts apps/web/src/__tests__/support-page.test.ts packages/shared/src/services/__tests__/email.service.test.ts
git commit -m "test(web): specify floating support widget"
```

### Task 2: Implement the floating widget

**Files:**
- Create: `apps/web/components/support-widget.tsx`
- Modify: `apps/web/components/support-chat.tsx`
- Modify: `apps/web/app/(dashboard)/layout.tsx`
- Modify: `apps/web/components/sidebar.tsx`
- Modify: `apps/web/app/(dashboard)/dashboard/support/page.tsx`
- Modify: `packages/shared/src/services/email.service.ts`

- [ ] **Step 1: Add pauseable embedded chat behavior**

Extend the component signature and polling guard without changing the standalone
defaults:

```ts
export function SupportChat({
  contextPath,
  active = true,
  className,
}: { contextPath?: string; active?: boolean; className?: string })
```

The refresh effect returns immediately while inactive, includes `active` in its
dependencies, and uses `cn()` to merge the existing section styles with the
widget's full-height styles.

- [ ] **Step 2: Add the responsive widget**

Implement `SupportWidget({ unread })` with `usePathname`, `useSearchParams`, one
`open` state initialized from `support=open`, and one `hasOpened` state. The
closed trigger is fixed at bottom-right with an accessible unread badge. Once
opened, keep the conversation mounted and toggle its visibility; pass
`active={open}` and `contextPath={pathname}`. Use a 400 px anchored panel on
`sm` screens and a safe-area-aware bottom sheet below `sm`. Add a backdrop only
on mobile, an explicit close button, Escape handling, and click-outside handling
for desktop.

- [ ] **Step 3: Replace old entry points**

Remove `ChatCircleDots`, `useRouter`, the Support nav row and Support-specific
link/badge conditions from `sidebar.tsx`. Mount:

```tsx
<SupportWidget unread={supportUnread} />
```

after the Dashboard `<main>`. Replace the old page body with:

```ts
redirect("/dashboard?support=open");
```

and change the email URL to:

```ts
const href = `${APP_URL}/dashboard?support=open`;
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: all focused tests PASS.

- [ ] **Step 5: Commit implementation**

```bash
git add apps/web/components/support-widget.tsx apps/web/components/support-chat.tsx 'apps/web/app/(dashboard)/layout.tsx' apps/web/components/sidebar.tsx 'apps/web/app/(dashboard)/dashboard/support/page.tsx' packages/shared/src/services/email.service.ts
git commit -m "feat(web): open support as Dashboard widget"
```

### Task 3: Regression, browser QA and production release

**Files:**
- Modify: `docs/2026-09-21-web-support-production-release.md`

- [ ] **Step 1: Run support regressions, typechecks and production build**

```bash
docker exec clipclap-support-check-20260921 sh -lc 'cd /app && SUBMISSION_QUEUE=off DATABASE_URL="postgresql://test:test@127.0.0.1:1/test?connect_timeout=1" npx vitest run apps/web/src/__tests__/support-widget.test.ts apps/web/src/__tests__/support-page.test.ts apps/web/src/__tests__/support-route.test.ts apps/web/src/__tests__/support-sidebar.test.ts packages/shared/src/services/__tests__/web-support.service.test.ts packages/shared/src/services/__tests__/email.service.test.ts apps/bot/src/__tests__/support.test.ts && npx tsc -p apps/web/tsconfig.json --noEmit && npm run build -w @clipclap/web'
```

Expected: tests, typecheck and Next production build PASS; only previously
documented warnings are acceptable.

- [ ] **Step 2: Review the implementation**

Check the diff against all seven design acceptance criteria and run a focused
code review before deployment. Fix any correctness, accessibility or responsive
layout blocker through another red/green test cycle.

- [ ] **Step 3: Deploy only the verified web/shared delta**

Preserve the dirty production workspace and its prior releases. Back up the
current `.next`, copy the reviewed files from this worktree into
`/srv/dev/clipclap.io`, rebuild in the production web container using the host's
documented bind-mounted development deployment process, and restart only `web`.

- [ ] **Step 4: Run production browser QA**

At desktop and 390x844 mobile widths verify: no Support nav item, trigger does
not cover primary controls, unread badge, open/close/reopen, preserved draft,
direct legacy redirect, query-driven open, successful support send, and no
browser console/page errors. Confirm container health and clean post-release
logs.

- [ ] **Step 5: Record and commit release evidence**

Update the release note with build ID, commands/results, screenshots or browser
evidence, backup path and rollback instructions, then commit:

```bash
git add docs/2026-09-21-web-support-production-release.md
git commit -m "docs: record support widget production release"
```
