import type { Page, UserDetail, UserRow } from "@clipclap/shared";
import { Pager } from "./pager";

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function secs(n: number | null): string {
  if (n === null) return "?";
  return n < 60 ? `${n}s` : `${Math.round(n / 60)}m`;
}

/** Lifetime totals for one person, summed from their jobs. */
function Totals({ jobs }: { jobs: UserDetail["jobs"] }) {
  const sourceSec = jobs.reduce((n, j) => n + (j.sourceDurationSec ?? 0), 0);
  const clips = jobs.reduce((n, j) => n + j.clipsGenerated, 0);
  const cost = jobs.reduce((n, j) => n + (j.estimatedTotalCostUsd ?? 0), 0);
  return (
    <p className="text-xs opacity-50">
      total {Math.round(sourceSec / 60)}m processed · {clips} clips · $
      {cost.toFixed(2)} estimated
    </p>
  );
}

function JobBlock({ job }: { job: UserDetail["jobs"][number] }) {
  return (
    <div className="rounded border border-white/10 p-2">
      <div className="flex justify-between gap-2 text-xs">
        <span className="tabular-nums opacity-70">{stamp(job.createdAt)}</span>
        <span className={job.error ? "text-red-400" : "opacity-70"}>
          {job.status}
        </span>
      </div>
      <p className="mt-1 truncate text-xs opacity-80">{job.source}</p>
      <p className="mt-1 text-xs opacity-60">
        {secs(job.sourceDurationSec)} source · {job.clipsGenerated} clips
        {job.analyzeEngine ? ` · ${job.analyzeEngine}` : ""}
        {job.processingMs !== null
          ? ` · ${Math.round(job.processingMs / 1000)}s processing`
          : ""}
        {job.estimatedTotalCostUsd !== null
          ? ` · $${job.estimatedTotalCostUsd.toFixed(2)}`
          : ""}
      </p>
      {job.error && <p className="mt-1 text-xs text-red-400">{job.error}</p>}
      {job.steps.length > 0 && (
        <p className="mt-1 text-xs opacity-50">
          {job.steps
            .map(
              (s) =>
                `${s.step} ${s.status}${s.ms !== null ? ` ${Math.round(s.ms / 1000)}s` : ""}`
            )
            .join(" · ")}
        </p>
      )}
      {job.delivery && (
        <p className="mt-1 text-xs opacity-50">
          telegram: {job.delivery.status}
          {job.delivery.error ? ` (${job.delivery.error})` : ""}
        </p>
      )}
    </div>
  );
}

export function UsersTable({
  rows,
  details,
  page,
}: {
  rows: UserRow[];
  details: Record<string, UserDetail>;
  page: Page;
}) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">Users</h2>
      <p className="mb-3 text-xs opacity-60">
        Newest first. Bold means registered today. Funnel events only exist from
        2026-07-27 onward, so older accounts show jobs and clips and nothing
        before them.
      </p>

      {rows.length === 0 ? (
        <p className="text-sm opacity-60">No users yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.map((u) => {
            const detail = details[u.id] ?? { jobs: [], events: [] };
            return (
              <details
                key={u.id}
                className="rounded-md border border-white/10 px-3 py-2"
              >
                <summary className="cursor-pointer list-none text-sm">
                  <span
                    className={
                      u.isToday
                        ? "font-bold tabular-nums"
                        : "tabular-nums opacity-70"
                    }
                  >
                    {day(u.createdAt)}
                  </span>
                  <span className={u.isToday ? "ml-2 font-bold" : "ml-2"}>
                    {u.label}
                  </span>
                  {u.isOwn && (
                    <span className="ml-2 rounded bg-white/10 px-1 text-xs opacity-70">
                      own
                    </span>
                  )}
                  <span className="float-right tabular-nums opacity-70">
                    {u.jobs} · {u.clips}
                  </span>
                </summary>

                <div className="mt-2 space-y-2 border-t border-white/10 pt-2">
                  <p className="text-xs opacity-70">
                    {stamp(u.createdAt)} · {u.locale ?? "no locale"} · {u.plan} ·{" "}
                    {u.subscriptionStatus}
                    {u.currentPeriodEnd
                      ? ` until ${day(u.currentPeriodEnd)}`
                      : ""}
                    {u.telegramId ? ` · tg ${u.telegramId}` : ""}
                  </p>
                  <p className="text-xs opacity-50">
                    {u.referredBy
                      ? `referred by ${u.referredBy}`
                      : "no referrer"}
                    {u.referralCode ? ` · own code ${u.referralCode}` : ""}
                  </p>
                  {detail.jobs.length > 0 && <Totals jobs={detail.jobs} />}

                  {detail.events.length > 0 && (
                    <div className="space-y-1">
                      {detail.events.map((e) => (
                        <div
                          key={e.event}
                          className="flex justify-between gap-2 text-xs opacity-70"
                        >
                          <span>{e.event}</span>
                          <span className="shrink-0 tabular-nums">
                            {stamp(e.firstSeenAt)}
                            {e.occurrences > 1 ? ` x${e.occurrences}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {detail.jobs.length === 0 ? (
                    <p className="text-xs opacity-50">No jobs.</p>
                  ) : (
                    <div className="space-y-2">
                      {detail.jobs.map((j) => (
                        <JobBlock key={j.id} job={j} />
                      ))}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      <Pager page={page} surface="bot" label="users" />
    </section>
  );
}
