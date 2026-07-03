# Responsive Design for ClipClap Web - Design Spec

**Date:** 2026-07-03
**Status:** Approved
**Approach:** Targeted retrofit using existing house patterns (no new architecture)

## Problem

The marketing surface (landing page, login) is fully responsive, but the entire
authenticated product is desktop-only. An audit found:

1. **Dashboard shell** (`apps/web/app/(dashboard)/layout.tsx:17`) renders a
   permanent 224px sidebar (`components/sidebar.tsx:57`) with no mobile
   navigation. On a 375px phone it consumes ~60% of the width, making every
   authenticated page unusable. This is the root issue; inner page content is
   already constrained-width (`mx-auto max-w-*`) and stacks acceptably.
2. **Subtitle editor** (`components/editor/clip-editor.tsx:131`) is locked to
   `h-[calc(100vh-3rem)]`; below `lg` it stacks but both panes are starved.
   Row actions are hover-only (`subtitle-list.tsx:322`) and drag handles are
   12px (`trim-bar.tsx:85,93`, scrubber `video-preview.tsx:79`) - unusable by
   touch.
3. **Three tables clipped**: `invoice-table.tsx:67`, dashboard
   `referrals/page.tsx:150`, `payouts/page.tsx:90` wrap multi-column tables in
   `overflow-hidden` - columns truncate with no scroll on narrow screens.
4. **No explicit viewport export** in `app/layout.tsx` (relies on Next.js
   default).
5. **Hover-only affordances** invisible on touch: subtitle row toolbar,
   project-list delete button (`project-list.tsx:185`).

## Decisions (user-confirmed)

- **Editor scope:** full editing on mobile (touch-capable trimming, scrubbing,
  row editing) - not a degraded or desktop-only mode.
- **Mobile navigation:** hamburger + off-canvas drawer. No bottom tab bar, no
  icon rail.
- **Editor mobile layout:** sticky compact video preview at top, subtitle list
  scrolling beneath - not tabs, not a plain stack.
- **Minimum verified width:** 375px.
- **Strategy:** targeted retrofit (approach A). No shadcn Sidebar migration,
  no container-query infrastructure, no mobile-first rewrite.

## Design

### 1. Shell & mobile navigation

- **Viewport:** add `export const viewport` to `apps/web/app/layout.tsx` with
  `width: 'device-width'`, `initialScale: 1`, `themeColor: '#000000'`.
- **Breakpoint:** `md` (768px) is the sidebar/drawer switch point.
- **Desktop (>= md):** unchanged - current fixed sidebar and
  `h-screen overflow-hidden` shell.
- **Mobile (< md):**
  - Sidebar hidden (`hidden md:flex`).
  - New slim top bar: hamburger button (>= 44px touch target), ClipClap logo,
    user avatar menu.
  - Hamburger opens an off-canvas drawer from the left, built on a new shadcn
    `Sheet` component (`components/ui/sheet.tsx`, `@radix-ui/react-dialog` -
    same stack as existing primitives). Drawer contains the same sidebar
    content: nav items, usage bar, user section.
  - Drawer closes on route change, backdrop tap, and Escape.
  - Main area uses normal page scroll; where a viewport lock is needed use
    `dvh` units (not `vh`) to avoid mobile browser-chrome overflow.
- **Structure:** extract the sidebar's nav content into a shared component
  rendered by both the static desktop sidebar and the drawer. The dashboard
  layout stays a server component; drawer open/close state lives in a small
  client `MobileHeader` component.

### 2. Subtitle editor - full editing on touch

- **Desktop (>= lg):** unchanged (two-pane grid, viewport-locked height).
- **Below lg:** remove the fixed `h-[calc(100vh-3rem)]`. The video block
  (preview + scrubber + playback controls + trim bar) becomes sticky at the
  top of the scroll container (offset by the mobile top bar height below
  `md`), with the video capped at 40dvh; the subtitle list flows beneath in
  normal page scroll.
- Editor header (title, save/export) wraps (`flex-wrap`) instead of
  overflowing.
- **Touch targets:** trim-bar handles and scrubber handle keep slim visuals
  but gain ~44px invisible hit areas (pseudo-element expansion). Drag already
  uses pointer events, so touch drag works once targets are hittable.
- **Row actions:** replace hover-only visibility
  (`opacity-0 group-hover:opacity-100`) with Tailwind v4 `pointer-coarse:`
  variant so actions are always visible on touch devices; desktop hover
  behavior unchanged. Row action buttons get >= 40px touch targets.
- CSS-only branching; no `useIsMobile` hook unless implementation hits a case
  CSS variants cannot express.

### 3. Tables & small fixes

- Swap `overflow-hidden` for the proven horizontal-scroll pattern from
  `project-list.tsx:134` (`overflow-x-auto` wrapper + `min-w-[...]` table) in:
  - `components/invoice-table.tsx`
  - `app/(dashboard)/dashboard/referrals/page.tsx`
  - `app/(dashboard)/dashboard/payouts/page.tsx`
- Payouts balance cards: stack `grid-cols-3` below `sm`.
- Clip detail header (`dashboard/clips/[id]/page.tsx:58`): `flex-wrap` so long
  titles and buttons coexist.
- Project-list delete button: same `pointer-coarse:` visibility treatment.

## Patterns to follow (already in the codebase)

- Responsive grids: `grid-cols-1 min-[520px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4`
  (`project-detail.tsx:193`).
- Scroll-safe table: `overflow-x-auto` + `min-w-[600px]` (`project-list.tsx:134`).
- Two-pane stack: `lg:grid-cols-[minmax(0,1fr)_420px]` (`clip-editor.tsx:167`).
- Wrapping toolbars: `flex flex-wrap` (`upload-zone.tsx:297`).
- Progressive disclosure: `hidden xl:block` (`subtitle-list.tsx:473`).

## Out of scope

- Landing page and login (already responsive).
- Telegram bot.
- Custom Tailwind breakpoints (defaults suffice).
- Theming / light mode.
- shadcn Sidebar component migration.

## Rollout order

1. Viewport export + shell/drawer (unblocks all dashboard pages).
2. Tables + small fixes.
3. Editor touch redesign.

Each phase ships independently.

## Verification

After each phase, drive the real app (dev stack runs via docker compose with
hot reload) in a browser at 375px, 768px, and 1024px:

- Drawer opens, closes on backdrop/Escape, and closes on navigation.
- No horizontal body scroll on any dashboard page at 375px.
- Tables scroll horizontally inside their own container.
- Editor: video stays visible while scrolling the subtitle list; rows are
  editable; trim/scrub handles draggable under touch emulation; row actions
  visible without hover.
- Desktop (1024px+) layouts visually unchanged.

No CSS unit tests - verification is visual/behavioral.
