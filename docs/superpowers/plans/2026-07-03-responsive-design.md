# Responsive Design Retrofit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the authenticated ClipClap web app usable at 375px: hamburger + drawer navigation, touch-capable subtitle editor, scroll-safe tables, explicit viewport, and touch-visible affordances.

**Architecture:** Targeted retrofit per the approved spec (`docs/superpowers/specs/2026-07-03-responsive-design.md`). Desktop layouts stay pixel-identical; mobile behavior is added with Tailwind breakpoint variants (`md:`, `lg:`), the `pointer-coarse:` variant (Tailwind 4.2 is installed - it supports this), and one new Radix-based `Sheet` component for the nav drawer. CSS-only branching; no `useIsMobile` hook.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS v4 (CSS-first config, no tailwind.config), shadcn-style Radix primitives, Phosphor icons.

---

## Context for the implementer

- **Dev environment:** the app runs in Docker (`docker compose up -d`). Source is bind-mounted - code edits hot-reload, NO rebuild needed. Only npm dependency changes need `docker compose up -d --build web`.
- **Typecheck** runs inside the container:
  `docker compose exec web sh -c "cd /app/apps/web && /app/node_modules/.bin/tsc --noEmit"`
  Expected: exits 0, no output.
- **No unit-test infra exists in apps/web** (no test script, no runner). This work is CSS/layout-only, and the approved spec explicitly specifies visual/behavioral verification instead of unit tests. Each task therefore ends with a typecheck + a concrete visual verification step at specific viewport widths (use browser DevTools device toolbar, or any available browser automation, against http://localhost:3000).
- **Verification account:** the dashboard requires Google login. Use an already-logged-in browser session; if none exists, ask the user to log in once before verifying dashboard pages.
- **Commits:** author is `Trowgar <trowgar@yahoo.com>` (already configured). Do NOT add any Co-Authored-By/attribution trailers.
- **Punctuation in any prose you write:** plain hyphens only, never em/en dashes.
- **Important Tailwind v4 caveat:** `animate-in`/`fade-in` utility classes seen in `toast.tsx`/`dropdown-menu.tsx` are dead classes - the animation plugin is NOT installed. Do not copy that pattern. The Sheet uses custom keyframes defined in `globals.css` (Task 2).

### Phases (each ships independently)

1. Tasks 1-3: viewport + shell/drawer (unblocks every dashboard page)
2. Tasks 4-5: tables + small fixes
3. Tasks 6-8: editor touch redesign
4. Task 9: final verification sweep

---

## Task 1: Explicit viewport export

**Files:**
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1: Add the viewport export**

In `apps/web/app/layout.tsx`, change the first line and add an export after `metadata`:

```tsx
import type { Metadata, Viewport } from "next";
```

```tsx
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};
```

(Place the `viewport` export directly below the existing `metadata` export. Nothing else changes.)

- [ ] **Step 2: Verify**

Run: `curl -s http://localhost:3000 | grep -oE '<meta name="(viewport|theme-color)"[^>]*>'`
Expected output (order may vary):
```
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#000000">
```
Run the typecheck command from the Context section. Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/layout.tsx
git commit -m "feat(web): explicit viewport and theme-color exports"
```

---

## Task 2: Sheet UI primitive (drawer)

**Files:**
- Modify: `apps/web/package.json` (via npm install)
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/components/ui/sheet.tsx`

- [ ] **Step 1: Install @radix-ui/react-dialog**

```bash
npm install @radix-ui/react-dialog@^1.1.4 --workspace=apps/web
docker compose up -d --build web
```

Expected: install succeeds, web container rebuilds and comes up (`docker compose ps` shows web running; `docker compose logs --tail=20 web` shows Next.js ready, no module-not-found errors).

- [ ] **Step 2: Add sheet keyframes to globals.css**

Append to the end of `apps/web/app/globals.css` (after the existing `@keyframes marquee` block):

```css
@keyframes sheet-slide-in-left {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}
@keyframes sheet-slide-out-left {
  from { transform: translateX(0); }
  to { transform: translateX(-100%); }
}
@keyframes sheet-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes sheet-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
```

- [ ] **Step 3: Create the Sheet component**

Create `apps/web/components/ui/sheet.tsx`. Left-side only - YAGNI, the nav drawer is the only consumer:

```tsx
"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & {
    title?: string;
  }
>(({ className, children, title = "Navigation", ...props }, ref) => (
  <SheetPrimitive.Portal>
    <SheetPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/60",
        "data-[state=open]:animate-[sheet-fade-in_200ms_ease-out]",
        "data-[state=closed]:animate-[sheet-fade-out_150ms_ease-in]"
      )}
    />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background shadow-xl outline-none",
        "data-[state=open]:animate-[sheet-slide-in-left_200ms_ease-out]",
        "data-[state=closed]:animate-[sheet-slide-out-left_150ms_ease-in]",
        className
      )}
      {...props}
    >
      <SheetPrimitive.Title className="sr-only">{title}</SheetPrimitive.Title>
      {children}
      <SheetPrimitive.Close
        className="absolute right-3 top-3.5 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Close navigation"
      >
        <X size={18} />
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetContent };
```

- [ ] **Step 4: Verify**

Run the typecheck command. Expected: exit 0. (Visual verification happens in Task 3 when the Sheet gets a consumer.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/app/globals.css apps/web/components/ui/sheet.tsx
git commit -m "feat(web): add Sheet drawer primitive on radix dialog"
```

---

## Task 3: Responsive dashboard shell (hamburger + drawer)

**Files:**
- Modify: `apps/web/components/sidebar.tsx`
- Create: `apps/web/components/mobile-header.tsx`
- Modify: `apps/web/app/(dashboard)/layout.tsx`

- [ ] **Step 1: Split Sidebar into SidebarContent + desktop wrapper**

Rewrite `apps/web/components/sidebar.tsx`. The inner markup (logo header, nav, usage, separator, user) is UNCHANGED from the current file except: (a) it moves into `SidebarContent`, (b) every nav `Link` and the Upgrade `Link` gain `onClick={onNavigate}`, (c) the `aside` loses `h-screen` in favor of `h-full` and gains `hidden md:flex`. Export `SidebarProps` so `mobile-header.tsx` can reuse it.

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, FolderOpen, House, Receipt, Gear, Handshake, Wallet } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { UsageBar } from "./usage-bar";
import { UserNav } from "./user-nav";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/logo";

export interface SidebarProps {
  user: {
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  usage: {
    minutesUsed: number;
    minutesLimit: number;
    topUpRemaining: number;
    plan: string;
  };
}

const navSections: {
  heading?: string;
  items: { href: string; label: string; icon: typeof House }[];
}[] = [
  {
    items: [
      { href: "/dashboard", label: "Home", icon: House },
      { href: "/dashboard/projects", label: "Projects", icon: FolderOpen },
    ],
  },
  {
    heading: "Earn",
    items: [
      { href: "/dashboard/referrals", label: "Affiliate", icon: Handshake },
      { href: "/dashboard/payouts", label: "Payouts", icon: Wallet },
    ],
  },
  {
    heading: "Account",
    items: [
      { href: "/dashboard/plans", label: "Plans", icon: CreditCard },
      { href: "/dashboard/billing", label: "Billing", icon: Receipt },
      { href: "/dashboard/settings", label: "Settings", icon: Gear },
    ],
  },
];

export function SidebarContent({
  user,
  usage,
  onNavigate,
}: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center px-4 border-b border-border">
        <Link href="/dashboard" className="flex items-center" aria-label="ClipClap home" onClick={onNavigate}>
          <Logo className="h-6" />
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {navSections.map((section, i) => (
          <div key={section.heading ?? i} className="space-y-1">
            {section.heading && (
              <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                {section.heading}
              </div>
            )}
            {section.items.map((item) => {
              const isActive =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Usage */}
      <div className="p-3">
        <UsageBar
          used={usage.minutesUsed}
          limit={usage.minutesLimit}
          topup={usage.topUpRemaining}
          plan={usage.plan}
        />
        {usage.plan !== "MAX" && (
          <Link
            href="/dashboard/plans"
            onClick={onNavigate}
            className="mt-2 block w-full rounded-md border border-border py-1.5 text-center text-xs font-medium transition-colors hover:bg-accent"
          >
            Upgrade
          </Link>
        )}
      </div>

      <Separator />

      {/* User */}
      <div className="p-3">
        <UserNav
          name={user.name}
          email={user.email}
          avatarUrl={user.avatarUrl}
        />
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-border bg-background md:flex">
      <SidebarContent {...props} />
    </aside>
  );
}
```

Note the two intentional deltas from the original inner markup: `shrink-0` on the logo header and `overflow-y-auto` on `nav` - inside the fixed-height drawer/sidebar the nav must scroll if it ever outgrows short viewports (e.g. a landscape phone).

- [ ] **Step 2: Create MobileHeader**

Create `apps/web/components/mobile-header.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { List } from "@phosphor-icons/react";
import { Logo } from "@/components/logo";
import { UserNav } from "@/components/user-nav";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { SidebarContent, type SidebarProps } from "@/components/sidebar";

export function MobileHeader(props: SidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Safety net: close on any route change (covers back/forward navigation)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation"
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <List size={20} />
          </button>
        </SheetTrigger>
        <SheetContent>
          <SidebarContent {...props} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <Link href="/dashboard" className="flex items-center" aria-label="ClipClap home">
        <Logo className="h-6" />
      </Link>
      <div className="ml-auto pr-1">
        <UserNav
          name={props.user.name}
          email={props.user.email}
          avatarUrl={props.user.avatarUrl}
        />
      </div>
    </header>
  );
}
```

(`List` is Phosphor's hamburger icon.)

- [ ] **Step 3: Rework the dashboard layout**

Replace the returned JSX in `apps/web/app/(dashboard)/layout.tsx` (imports: add `MobileHeader`; data fetching is unchanged):

```tsx
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { userService } from "@clipclap/shared";
import { Sidebar } from "@/components/sidebar";
import { MobileHeader } from "@/components/mobile-header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  const user = {
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    avatarUrl: session.user.image ?? null,
  };
  const usageProps = {
    minutesUsed: usage.minutesUsed,
    minutesLimit: usage.minutesLimit,
    topUpRemaining: usage.topUpMinutesRemaining,
    plan: usage.plan,
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <MobileHeader user={user} usage={usageProps} />
      <Sidebar user={user} usage={usageProps} />
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}
```

Notes:
- `h-dvh` replaces `h-screen` (correct height under mobile browser chrome; identical on desktop).
- `flex-col md:flex-row`: on mobile the header stacks above `main`; from `md` the hidden header drops out and the row layout is exactly today's shell.
- `main` gets `p-4` on mobile, `sm:p-6` keeps today's desktop padding.

- [ ] **Step 4: Verify**

Run the typecheck command. Expected: exit 0.
Visual check at http://localhost:3000/dashboard (logged in):
- **375px:** no sidebar; top bar with hamburger, logo, avatar; page content uses full width; no horizontal body scroll. Hamburger opens a left drawer with nav + usage + user; drawer closes on backdrop tap, Escape, X button, and on tapping a nav item (navigates).
- **768px and 1024px:** top bar gone, sidebar present, layout pixel-identical to before this change.
- Repeat the 375px no-horizontal-scroll check on /dashboard/projects, /dashboard/plans, /dashboard/billing, /dashboard/settings.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/sidebar.tsx apps/web/components/mobile-header.tsx "apps/web/app/(dashboard)/layout.tsx"
git commit -m "feat(web): responsive dashboard shell with hamburger drawer nav"
```

---

## Task 4: Scroll-safe tables (invoices, referrals, payouts)

**Files:**
- Modify: `apps/web/components/invoice-table.tsx:67-68`
- Modify: `apps/web/app/(dashboard)/dashboard/referrals/page.tsx:150-151`
- Modify: `apps/web/app/(dashboard)/dashboard/payouts/page.tsx:90-91`

Pattern (copied from `project-list.tsx:134`): `overflow-hidden` wrapper becomes `overflow-x-auto`, and the `<table>` gets a `min-w` so columns keep breathing room and the wrapper scrolls.

- [ ] **Step 1: invoice-table.tsx**

```tsx
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
```

(5 columns incl. description + action buttons - needs the largest minimum.)

- [ ] **Step 2: referrals/page.tsx**

```tsx
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[480px] text-sm">
```

- [ ] **Step 3: payouts/page.tsx (History table)**

```tsx
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[480px] text-sm">
```

- [ ] **Step 4: Verify**

Typecheck: exit 0. Visual at 375px:
- /dashboard/billing: invoice table scrolls horizontally inside its border; page body itself does NOT scroll horizontally.
- /dashboard/referrals and /dashboard/payouts: same behavior for their tables (if the tables are empty on the test account, verify the empty-state renders and no horizontal body scroll appears).
- 1024px: tables look exactly as before (min-width is below their natural desktop width).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/invoice-table.tsx "apps/web/app/(dashboard)/dashboard/referrals/page.tsx" "apps/web/app/(dashboard)/dashboard/payouts/page.tsx"
git commit -m "fix(web): horizontal scroll for invoice, referral and payout tables"
```

---

## Task 5: Small responsive fixes (balance grid, clip header, delete button)

**Files:**
- Modify: `apps/web/app/(dashboard)/dashboard/payouts/page.tsx:44`
- Modify: `apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx:58`
- Modify: `apps/web/components/project-list.tsx:185`

- [ ] **Step 1: Payouts balance grid stacks below sm**

In `payouts/page.tsx` line 44:

```tsx
          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-3">
```

- [ ] **Step 2: Clip detail header wraps**

In `clips/[id]/page.tsx` line 58:

```tsx
      <div className="flex flex-wrap items-start justify-between gap-3">
```

(The `gap-3` keeps the title and button group separated when they wrap onto two lines.)

- [ ] **Step 3: Project delete button visible on touch**

In `project-list.tsx` line 185, add `pointer-coarse:opacity-100` to the button's className:

```tsx
                className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
```

- [ ] **Step 4: Verify**

Typecheck: exit 0. Visual:
- /dashboard/payouts at 375px: Clearing / In withdrawal / Paid out stack vertically; at 768px they are 3 columns as before.
- A clip page (/dashboard/clips/<id>) at 375px: title and Edit/Download buttons wrap without overflowing.
- /dashboard/projects with DevTools device emulation (coarse pointer): trash button visible without hover. With a normal mouse pointer: still hidden until hover (regression check).

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(dashboard)/dashboard/payouts/page.tsx" "apps/web/app/(dashboard)/dashboard/clips/[id]/page.tsx" apps/web/components/project-list.tsx
git commit -m "fix(web): mobile fixes for balance grid, clip header, delete affordance"
```

---

## Task 6: Editor layout - sticky video, page-flow subtitle list below lg

**Files:**
- Modify: `apps/web/components/editor/clip-editor.tsx:131,132,167,168,169`

Desktop (lg+) keeps the exact current behavior: viewport-locked two-pane grid. Below lg the editor becomes a normally scrolling page where the video block sticks to the top (main is the scroll container, so `sticky top-0` sticks below the mobile top bar automatically).

- [ ] **Step 1: Unlock the root height below lg**

Line 131:

```tsx
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-3rem)]">
```

- [ ] **Step 2: Let the editor header wrap**

Line 132:

```tsx
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
```

- [ ] **Step 3: Sticky video pane with capped height below lg**

Lines 167-169 - the grid stays, the left pane becomes sticky below lg, and the video wrapper gets a 40dvh cap that lg overrides:

```tsx
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="sticky top-0 z-20 flex flex-col gap-3 bg-background pb-1 lg:static lg:z-auto lg:min-h-0 lg:pb-0">
          <div className="h-[40dvh] lg:h-auto lg:min-h-0 lg:flex-1">
```

(The closing tags and everything inside - VideoPreview props, TrimBar block - are unchanged. `bg-background` stops subtitle rows from showing through the gaps around the rounded video card while they scroll behind it; `pb-1` gives the sticky block a small bottom inset so rows do not touch the trim bar.)

Why no `SubtitleList` change is needed: its root uses `h-full` + inner `flex-1 overflow-y-auto`. Inside the auto-height mobile flow those resolve to natural content height, so rows scroll with the page - exactly the spec behavior. On lg the grid cell is height-constrained again and the internal list scroll returns.

- [ ] **Step 4: Verify**

Typecheck: exit 0. Visual on /dashboard/editor?clip=<id> (pick any finished clip):
- **375px:** video (max ~40% of viewport height) + trim bar pinned at top while the subtitle list scrolls beneath; header wraps (Back + title on one line, Save on the next if needed); no horizontal body scroll.
- **768px (still below lg):** same stacked+sticky behavior, wider.
- **1024px+:** two-pane layout, editor fills viewport height, internal list scroll - pixel-identical to before.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/editor/clip-editor.tsx
git commit -m "feat(editor): sticky video and page-flow subtitle list on mobile"
```

---

## Task 7: Touch-capable trim handles and scrubber

**Files:**
- Modify: `apps/web/components/editor/trim-bar.tsx:81-96`
- Modify: `apps/web/components/editor/video-preview.tsx:54-93`

Two ingredients per drag surface: `touch-none` (CSS `touch-action: none`) so the browser does not hijack the drag for page scrolling, and an invisible pseudo-element hit area of ~44px. Visuals stay slim.

- [ ] **Step 1: Trim handles**

In `trim-bar.tsx`, both handle divs (lines 81-96) get the same className change - from
`"absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded-sm bg-white"` to:

```tsx
          className="absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize touch-none rounded-sm bg-white before:absolute before:-inset-x-4 before:inset-y-0 before:content-['']"
```

(12px visual + 16px each side = 44px hit zone. Applies to BOTH the "Trim start" and "Trim end" handles.)

- [ ] **Step 2: Scrubber**

In `video-preview.tsx`, the scrubber bar div (lines 67-70) className becomes:

```tsx
      className={cn(
        "group relative h-2.5 shrink-0 touch-none border-y border-white/[0.08] bg-white/[0.06] transition-[height] duration-150 hover:h-3.5 pointer-coarse:h-3.5 before:absolute before:inset-x-0 before:-inset-y-3 before:z-10 before:content-['']",
        duration > 0 ? "cursor-pointer" : "cursor-default"
      )}
```

Deltas: `touch-none` (drag seeks instead of scrolling), `pointer-coarse:h-3.5` (taller base bar on touch devices), and a `before:` pseudo extending the vertical hit area by 12px above and below (total ~38px on a 14px bar). `before:z-10` keeps the hit zone above the progress fill.

- [ ] **Step 3: Verify**

Typecheck: exit 0. Visual on the editor page with DevTools touch emulation at 375px:
- Trim handles: press-drag near (not exactly on) a handle works; dragging a handle does NOT scroll the page.
- Scrubber: tap-drag seeks continuously; page does not scroll during the drag; bar renders at the taller height under touch emulation.
- With a mouse at 1024px: hover still grows the bar to h-3.5; handle visuals unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/editor/trim-bar.tsx apps/web/components/editor/video-preview.tsx
git commit -m "feat(editor): 44px touch hit areas for trim handles and scrubber"
```

---

## Task 8: Subtitle rows - touch-visible actions and 40px targets

**Files:**
- Modify: `apps/web/components/editor/subtitle-list.tsx:322-357`

- [ ] **Step 1: Toolbar visible on touch (and keyboard focus)**

Line 322, the toolbar wrapper - from
`"mt-1.5 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100"` to:

```tsx
      <div className="mt-1.5 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
```

- [ ] **Step 2: 40px touch targets on the four action buttons**

All four buttons in the toolbar (Merge with next, Split at playhead, Play from here, Delete cue) get `flex items-center justify-center` plus coarse-pointer sizing appended to their existing className. The three neutral buttons - from
`"rounded p-1 text-neutral-400 hover:bg-white/[0.08] hover:text-white"` to:

```tsx
            className="flex items-center justify-center rounded p-1 text-neutral-400 hover:bg-white/[0.08] hover:text-white pointer-coarse:h-10 pointer-coarse:w-10 pointer-coarse:p-0"
```

The delete button - from
`"rounded p-1 text-red-400/70 hover:bg-red-400/10 hover:text-red-400"` to:

```tsx
          className="flex items-center justify-center rounded p-1 text-red-400/70 hover:bg-red-400/10 hover:text-red-400 pointer-coarse:h-10 pointer-coarse:w-10 pointer-coarse:p-0"
```

- [ ] **Step 3: Verify**

Typecheck: exit 0. Visual on the editor page:
- Touch emulation at 375px: every subtitle row shows its action buttons without hover; buttons render 40x40; merge/split/play/delete all work by tap; textarea editing, Enter-to-split and Backspace-to-merge still work with the on-screen keyboard workflow (type into a row, verify the text updates).
- Mouse at 1024px: toolbar still hidden until row hover; buttons at their compact size (regression check).

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/editor/subtitle-list.tsx
git commit -m "feat(editor): touch-visible subtitle row actions with 40px targets"
```

---

## Task 9: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Static checks**

```bash
docker compose exec web sh -c "cd /app/apps/web && /app/node_modules/.bin/tsc --noEmit"
docker compose logs --tail=50 web
```

Expected: typecheck exit 0; web logs free of runtime/compile errors.

- [ ] **Step 2: Behavioral sweep at 375 / 768 / 1024**

Walk every authenticated page at all three widths (spec acceptance criteria):

| Check | 375px | 768px | 1024px |
|---|---|---|---|
| No horizontal body scroll on any page | required | required | required |
| Nav: hamburger + drawer (opens, closes on backdrop/Escape/X/nav-tap) | drawer | sidebar | sidebar |
| Tables (billing, referrals, payouts) scroll inside their own container | required | required | n/a (fits) |
| Editor: video sticky + visible while list scrolls; header wraps | required | required | two-pane, unchanged |
| Editor touch: trim/scrub draggable, row actions visible, rows editable | required (touch emulation) | - | hover behavior unchanged |
| Payouts balance grid stacked / 3-col | stacked | 3-col | 3-col |
| Landing + login unchanged and responsive (regression) | required | - | required |

- [ ] **Step 3: Fix anything found, then re-verify that item**

Any failure: fix in the file that owns it, re-run the specific check, and amend into a fix commit:

```bash
git add -A
git commit -m "fix(web): responsive sweep fixes"
```

(Skip this commit if the sweep is clean.)

---

## Self-review notes (spec coverage)

- Spec 1 (shell/nav/viewport) → Tasks 1, 2, 3
- Spec 2 (editor full touch editing, sticky 40dvh video, wrap header, 44px handles, pointer-coarse row actions) → Tasks 6, 7, 8
- Spec 3 (tables, balance grid, clip header, delete affordance) → Tasks 4, 5
- Spec rollout order and per-phase verification → task ordering + Task 9
- Spec "sticky offset by mobile top bar height": resolved structurally instead - `main` remains the scroll container below the top bar, so `sticky top-0` inside `main` already sits below the header; no offset constant needed.
