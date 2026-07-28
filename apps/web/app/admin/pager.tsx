import type { Page } from "@clipclap/shared";

/**
 * Pagination as plain links in the same URL.
 *
 * No client JS: it survives a reload, it is shareable, and it works in a
 * webview that failed to load anything external.
 */
export function Pager({
  page,
  surface,
  label,
}: {
  page: Page;
  /** Preserved across page changes so the filter does not reset. */
  surface: string;
  label: string;
}) {
  if (page.total === 0) return null;

  const href = (n: number): string => {
    const params = new URLSearchParams();
    if (surface) params.set("surface", surface);
    if (n > 1) params.set("page", String(n));
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  };

  const link = "rounded-md border border-white/10 px-3 py-1 text-sm";
  const dead = "rounded-md border border-white/5 px-3 py-1 text-sm opacity-30";

  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-xs opacity-60">
        {page.from}-{page.to} of {page.total} {label}
      </span>
      <div className="flex gap-2">
        {page.page > 1 ? (
          <a className={link} href={href(page.page - 1)}>
            Prev
          </a>
        ) : (
          <span className={dead}>Prev</span>
        )}
        {page.page < page.totalPages ? (
          <a className={link} href={href(page.page + 1)}>
            Next
          </a>
        ) : (
          <span className={dead}>Next</span>
        )}
      </div>
    </div>
  );
}
