import { formatLocalDateTime } from "@clipclap/shared";
import type { FeedbackRow, FeedbackSummary } from "@clipclap/shared";

/** The empty string is a real verdict value - written when someone leaves a
 *  note or picks a reason before ever tapping a verdict - so it gets its own
 *  label instead of rendering blank. */
function verdictLabel(verdict: string): string {
  return verdict === "" ? "No verdict" : verdict;
}

/** count/total as a whole-number percent, or null when total is 0 - the
 *  table renders "-" rather than NaN or a divide-by-zero. */
function pct(count: number, total: number): number | null {
  return total > 0 ? Math.round((count / total) * 100) : null;
}

export function FeedbackTable({
  summary,
  rows,
}: {
  summary: FeedbackSummary;
  rows: FeedbackRow[];
}) {
  // Postable rate = AS_IS over rows that carry a REAL verdict - the
  // empty-string bucket (note/reason with no verdict tap yet) is excluded
  // from the denominator, not folded into it.
  const realVerdicts = summary.verdicts.filter((v) => v.verdict !== "");
  const ratedWithVerdict = realVerdicts.reduce((n, v) => n + v.count, 0);
  const asIs = realVerdicts.find((v) => v.verdict === "AS_IS")?.count ?? 0;
  const postableRate = pct(asIs, ratedWithVerdict);
  const responseRate = pct(summary.clipsRated, summary.clipsDelivered);

  return (
    <section>
      <h2 className="mb-1 font-semibold">Feedback</h2>
      <p className="mb-3 text-xs opacity-60">
        Per-clip answers from the Telegram bot and the web. &quot;No
        verdict&quot; is a note or a reason left before anyone tapped a
        verdict button - it is its own bucket, not a fourth verdict.
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1 rounded-lg border border-white/10 p-4">
          <p className="text-xs uppercase tracking-wide opacity-60">
            Postable rate
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {postableRate === null ? "-" : `${postableRate}%`}
          </p>
          <p className="text-xs opacity-60">
            AS_IS of {ratedWithVerdict} rated with a verdict
          </p>
        </div>
        <div className="flex-1 rounded-lg border border-white/10 p-4">
          <p className="text-xs uppercase tracking-wide opacity-60">
            Response rate
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {responseRate === null ? "-" : `${responseRate}%`}
          </p>
          <p className="text-xs opacity-60">
            {summary.clipsRated} rated of {summary.clipsDelivered} clips
          </p>
        </div>
      </div>

      {summary.verdicts.length === 0 ? (
        <p className="mt-3 text-sm opacity-60">No feedback recorded yet.</p>
      ) : (
        <div className="mt-3 space-y-1">
          {summary.verdicts.map((v) => (
            <div
              key={v.verdict || "-"}
              className="flex items-baseline justify-between text-sm"
            >
              <span className="opacity-80">{verdictLabel(v.verdict)}</span>
              <span className="font-semibold tabular-nums">{v.count}</span>
            </div>
          ))}
        </div>
      )}

      {summary.reasons.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs uppercase tracking-wide opacity-60">
            Reasons
          </p>
          <div className="space-y-1">
            {summary.reasons.map((r) => (
              <div
                key={r.reason}
                className="flex items-baseline justify-between text-sm"
              >
                <span className="opacity-80">{r.reason}</span>
                <span className="font-semibold tabular-nums">{r.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="mb-1 text-xs uppercase tracking-wide opacity-60">
          Recent
        </p>
        {rows.length === 0 ? (
          <p className="text-sm opacity-60">No answers yet.</p>
        ) : (
          <div className="space-y-1">
            {rows.map((r) => (
              <div
                key={r.id}
                className="rounded-md border border-white/10 px-3 py-2 text-sm"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="tabular-nums opacity-70">
                    {formatLocalDateTime(r.createdAt)}
                  </span>
                  <span className="opacity-60">{r.surface}</span>
                  <span className="font-semibold">
                    {verdictLabel(r.verdict)}
                  </span>
                </div>
                <p className="mt-1 truncate opacity-80">
                  {r.title ?? r.clipId}
                </p>
                <div className="mt-1 flex items-baseline justify-between gap-2 text-xs opacity-60">
                  <span>{r.reason ?? "-"}</span>
                  {!r.evidenceKey && (
                    <span className="opacity-50">no video captured</span>
                  )}
                </div>
                {r.note && (
                  <p className="mt-1 text-xs opacity-70">{r.note}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
