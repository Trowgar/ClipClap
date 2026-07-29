/**
 * Shared class strings for the dashboard's full-width state panels.
 *
 * Their own module, with no imports, because they are read from both a server
 * component (free-state.tsx) and a client one (verify-email-panel.tsx). Kept
 * next to the icons in free-state.tsx they would drag its server-only icon
 * entry point into the client bundle for the sake of three strings.
 *
 * The ring-offset-black on every focus style is load-bearing on this surface:
 * the panels sit on a near-black page, and a ring with no offset is invisible
 * against a white button.
 */
export const dashboardPanelClass =
  "rounded-xl border border-white/[0.08] bg-white/[0.02] p-6";

export const dashboardPrimaryActionClass =
  "inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-40";

export const dashboardSecondaryActionClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black";
