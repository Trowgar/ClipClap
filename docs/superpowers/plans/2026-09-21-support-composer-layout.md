# Support Composer Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped side-by-side Dashboard support composer with a fixed-height textarea and a full-width Send button below it.

**Architecture:** Keep all behavior in the existing `SupportChat` component and change only its presentational Tailwind classes and nesting. Add one server-rendered component assertion to lock the layout without introducing browser-test infrastructure.

**Tech Stack:** React 19, Next.js 15, Tailwind CSS 4, Vitest, React server rendering

---

### Task 1: Stack and stabilize the support composer

**Files:**
- Modify: `apps/web/src/__tests__/support-page.test.ts`
- Modify: `apps/web/components/support-chat.tsx:220-254`

- [ ] **Step 1: Write the failing layout test**

Append this test to `apps/web/src/__tests__/support-page.test.ts`:

```tsx
it("stacks a fixed textarea above a full-width send button", () => {
  const html = renderToStaticMarkup(
    React.createElement(SupportChat, { active: false })
  );
  expect(html).toContain('class="block h-20 w-full resize-none');
  expect(html).toContain('class="flex h-10 w-full items-center justify-center');
  expect(html).toContain("Ctrl/⌘ + Enter to send");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run apps/web/src/__tests__/support-page.test.ts
```

Expected: the new test fails because the current textarea contains `resize-y` and the button has no `w-full` or `justify-center` classes.

- [ ] **Step 3: Implement the minimal layout change**

In `apps/web/components/support-chat.tsx`, replace the side-by-side wrapper and nested width wrapper with a vertical stack. Keep the label, textarea, shortcut/count row, and button behavior unchanged:

```tsx
<div className="space-y-2">
  <label htmlFor="support-message" className="sr-only">Message to support</label>
  <textarea
    id="support-message"
    aria-label="Message to support"
    value={text}
    onChange={event => setText(event.target.value)}
    onKeyDown={event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void send(text);
      }
    }}
    maxLength={4000}
    rows={3}
    placeholder="Describe what happened…"
    className="block h-20 w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-white/30"
  />
  <div className="flex justify-between px-1 text-[10px] text-muted-foreground">
    <span>Ctrl/⌘ + Enter to send</span>
    {text.length >= 3500 && <span>{text.length}/4000</span>}
  </div>
  <button type="button" onClick={() => void send(text)}
    disabled={sending || !text.trim() || text.length > 4000}
    className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40">
    <PaperPlaneTilt size={16} weight="fill" />
    <span>Send</span>
  </button>
</div>
```

- [ ] **Step 4: Run focused and related support tests**

Run:

```bash
npx vitest run apps/web/src/__tests__/support-page.test.ts apps/web/src/__tests__/support-widget.test.ts apps/web/src/__tests__/support-chat-refresh.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Run the production web build**

Run:

```bash
npm run build --workspace @clipclap/web
```

Expected: Next.js production build exits with status 0.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/web/src/__tests__/support-page.test.ts apps/web/components/support-chat.tsx
git commit -m "fix(web): stack support composer controls"
```

### Task 2: Release and verify

**Files:**
- Modify: `docs/2026-09-21-web-support-production-release.md`

- [ ] **Step 1: Deploy the tested branch using the repository's existing production release procedure**

Back up the two replaced files and the currently running build, copy only the allowlisted composer files into the dirty production workspace, build there, and restart only web:

```bash
composer_backup_dir=$(mktemp -d /tmp/clipclap-support-composer-release-XXXXXX)
cp /srv/dev/clipclap.io/apps/web/components/support-chat.tsx "$composer_backup_dir/support-chat.tsx"
cp /srv/dev/clipclap.io/apps/web/src/__tests__/support-page.test.ts "$composer_backup_dir/support-page.test.ts"
cp -a /srv/dev/clipclap.io/apps/web/.next "$composer_backup_dir/previous-next"
cp /home/trowgar/.config/superpowers/worktrees/clipclap.io/web-support-chat-20260921/apps/web/components/support-chat.tsx /srv/dev/clipclap.io/apps/web/components/support-chat.tsx
cp /home/trowgar/.config/superpowers/worktrees/clipclap.io/web-support-chat-20260921/apps/web/src/__tests__/support-page.test.ts /srv/dev/clipclap.io/apps/web/src/__tests__/support-page.test.ts
cd /srv/dev/clipclap.io
docker compose exec -T -w /app web npx vitest run apps/web/src/__tests__/support-page.test.ts apps/web/src/__tests__/support-widget.test.ts apps/web/src/__tests__/support-chat-refresh.test.ts
docker compose exec -T web sh -lc 'cd /app && npx prisma generate && npm run build --workspace @clipclap/web'
docker compose restart web
docker compose ps web
curl -fsS https://clipclap.io/login >/dev/null
```

Expected: tests and build exit zero, `clipclapio-web-1` is running, and HTTPS login returns 200. Do not apply migrations or restart bot/workers because this is frontend-only.

- [ ] **Step 2: Check the production widget at desktop and narrow widths**

Open `https://clipclap.io/dashboard?support=open` in the authenticated test account at 1440×1000 and 390×844. Confirm that the textarea is fixed-height, the shortcut/count row remains visible, the Send button spans the composer width, and the controls do not overflow. Do not send a support message during this visual check.

- [ ] **Step 3: Record and commit release evidence**

Append the build identifier, health result, and visual checks to `docs/2026-09-21-web-support-production-release.md`, then run:

```bash
git add docs/2026-09-21-web-support-production-release.md
git commit -m "docs: verify support composer release"
```
