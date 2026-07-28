import type { GuestRow, Page } from "@clipclap/shared";
import { Pager } from "./pager";

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function time(d: Date): string {
  return d.toISOString().slice(11, 16);
}

/** A floor, never a measurement - see GuestRow.durationSec. */
function duration(sec: number | null): string {
  if (sec === null) return "one page";
  if (sec < 60) return `>${sec}s`;
  return `>${Math.round(sec / 60)}m`;
}

export function GuestsTable({ rows, page }: { rows: GuestRow[]; page: Page }) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">Guests</h2>
      <p className="mb-3 text-xs opacity-60">
        One row per visitor-day, crawlers excluded. Days and times here are UTC,
        not local: the visitor bucket and the salt behind its hash are both
        derived from the UTC date, so a local day would relabel a bucket that is
        not one. Time is the gap between the first and last request - the last
        page&apos;s reading time is not recorded, so treat it as a minimum.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm opacity-60">No guest visits recorded yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((g) => (
            <details
              key={`${day(g.day)}-${g.visitorHash}`}
              className="rounded-md border border-white/10 px-3 py-2"
            >
              <summary className="cursor-pointer list-none text-sm">
                <span className="tabular-nums opacity-70">{day(g.day)}</span>
                <span className="ml-2">{g.country ?? "??"}</span>
                <span className="ml-2 opacity-60">
                  {g.referrerHost ?? "direct"}
                </span>
                <span className="float-right tabular-nums opacity-70">
                  {g.views} · {duration(g.durationSec)}
                </span>
              </summary>
              <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                {g.paths.map((p) => (
                  <div
                    key={p.path}
                    className="flex justify-between gap-2 text-xs opacity-70"
                  >
                    <span className="truncate">{p.path}</span>
                    <span className="shrink-0 tabular-nums">
                      {time(p.firstSeenAt)}-{time(p.lastSeenAt)} · {p.hits}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      <Pager page={page} surface="web" label="visitor-days" />
    </section>
  );
}
