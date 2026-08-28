import { formatLocalDateTime, type GuestRow, type Page } from "@clipclap/shared";
import { Pager } from "./pager";

/** The visitor bucket's date, which is a UTC date by construction - see the
 *  note in the section header. Printed as it is stored, never converted. */
function bucketDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A real instant in the admin dashboard's fixed Europe/Riga timezone. Include
 *  its calendar date because one UTC bucket can span a Riga midnight. */
function timestamp(d: Date): string {
  return formatLocalDateTime(d);
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
        One row per visitor-day, crawlers excluded. The DATE is a UTC day and is
        marked as such: the visitor bucket and the salt behind its hash are both
        derived from the UTC date, so relabelling it as a local day would rename
        a bucket that is not one. The full timestamps inside are Europe/Riga,
        like everywhere else on this page; they are instants, not bucket keys.
        Time is the gap between the first and last request - the last
        page&apos;s reading time is not recorded, so treat it as a minimum.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm opacity-60">No guest visits recorded yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((g) => (
            <details
              key={`${bucketDay(g.day)}-${g.visitorHash}`}
              className="rounded-md border border-white/10 px-3 py-2"
            >
              <summary className="cursor-pointer list-none text-sm">
                <span className="tabular-nums opacity-70">
                  {bucketDay(g.day)}
                  <span className="ml-1 text-[10px] opacity-60">UTC</span>
                </span>
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
                      {timestamp(p.firstSeenAt)}-{timestamp(p.lastSeenAt)} · {p.hits}
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
