/**
 * Turns the raw `clip_feedback` rows into a report an agent can open and
 * immediately understand: which clip a complaint is about, what the user
 * said, and what the engine did to produce it - without anyone running SQL
 * by hand.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/feedback-digest.ts"
 *
 * WHY THIS EXISTS. `clip_feedback` (prisma/schema.prisma) deliberately has
 * no relations to Clip/Job/User - deleting a project hard-deletes the job
 * and cascades the clips, and a relation would erase exactly the strongest
 * signal in the table. So `recordClipFeedback` (clip-feedback.service.ts)
 * freezes everything an agent would need into a `snapshot` JSON column at
 * tap time, and takes a permanent R2 copy of the clip keyed by
 * `evidenceKey`. This script is the reader for both: it never joins against
 * Clip or Job, only against the frozen snapshot, and it signs a fresh
 * download link for the evidence copy on every run rather than storing one
 * - a link written into a report is dead within 7 days, the R2 copy never
 * expires, so regenerating always works. A failed signature falls back to
 * noting the raw key rather than aborting the whole report.
 *
 * Read-only: no clip, job or feedback row is touched, only counted and read.
 *
 * OUTPUT, both under apps/worker/.corpus/feedback/ (gitignored):
 *   <date>.md      - the report, one per run, named by the day it ran
 *   feedback.jsonl - every row as one JSON object per line, raw and
 *                    unformatted, overwritten each run - for grepping or
 *                    feeding into another tool, not for reading by hand
 *
 * Each `reason` routes to one subsystem to look at - see REASON_SUBSYSTEM
 * below and docs/engine-notes.md §11 for the same mapping.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import {
  prisma,
  getPresignedDownloadUrl,
  FEEDBACK_VERDICTS,
  type FeedbackReason,
} from "@clipclap/shared";

/** Resolved from __dirname, not cwd - same convention as corpus-fetch.ts,
 *  so the output lands in the same place regardless of where the command is
 *  invoked from. */
const OUT_DIR = join(__dirname, "..", "..", ".corpus", "feedback");

/** A link written into a report is dead within 7 days; the evidence copy in
 *  R2 never expires. Regenerating always works, so nothing is ever stored. */
const LINK_TTL_SEC = 7 * 24 * 3600;

/** Where each reason routes an agent fixing the engine. Printed once, in the
 *  report header - see docs/engine-notes.md §11 for the same table. */
const REASON_SUBSYSTEM: Record<FeedbackReason, string> = {
  BORING: "moment selection (ANALYZE)",
  CUTOFF: "clip boundaries (ANALYZE snapNodes)",
  FRAMING: "reframing (RENDER crop/reframe stage)",
  SUBS: "subtitles (RENDER subtitle burn-in)",
  QUALITY: "rendering (RENDER, general render quality)",
};

/** Frozen at tap time by recordClipFeedback - see clip-feedback.service.ts
 *  for exactly how each field is computed. Every field is optional here on
 *  purpose: this script reads a JSON blob written by a different subsystem
 *  and must not crash on a shape it does not fully recognise. */
interface FeedbackSnapshot {
  title?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  duration?: number | null;
  score?: number | null;
  clipKind?: string | null;
  lowQuality?: boolean | null;
  hookStart?: number | null;
  hookEnd?: number | null;
  payoffAt?: number | null;
  analyzeEngine?: string | null;
  highlightsVersion?: number | null;
  language?: string | null;
  sourceDurationSec?: number | null;
  cropPlan?: {
    keyframes?: number;
    layout?: string | null;
    static?: boolean;
  } | null;
  transcript?: string | null;
}

interface Row {
  id: string;
  clipId: string;
  jobId: string;
  userId: string;
  surface: string;
  verdict: string;
  reason: string | null;
  note: string | null;
  snapshot: FeedbackSnapshot | null;
  evidenceKey: string | null;
  locale: string | null;
  createdAt: Date;
}

function num(v: number | null | undefined, digits = 1): string {
  return typeof v === "number" ? v.toFixed(digits) : "-";
}

function str(v: string | null | undefined): string {
  return v && v.length > 0 ? v : "-";
}

/** "" is a real value - written when someone leaves a note or picks a reason
 *  before ever tapping a verdict - and must read as "no verdict", never as a
 *  blank or as one of the three real verdicts. Same convention as
 *  apps/web/app/admin/feedback-table.tsx's verdictLabel. */
function verdictLabel(verdict: string): string {
  return verdict === "" ? "no verdict" : verdict;
}

/** count/total as a whole-number percent, or "-" when total is 0 - every
 *  percentage in this report must survive a zero denominator instead of
 *  producing NaN or Infinity. Same convention as feedback-table.tsx's pct. */
function pct(count: number, total: number): string {
  return total > 0 ? `${Math.round((count / total) * 100)}%` : "-";
}

async function signOrFallback(evidenceKey: string | null): Promise<string> {
  if (!evidenceKey) {
    return "(no evidence copy - the R2 copy failed, or the clip predates evidence capture)";
  }
  try {
    return await getPresignedDownloadUrl(evidenceKey, LINK_TTL_SEC);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A dead link is not a reason to lose the rest of the report.
    return `(signing failed, raw key: ${evidenceKey} - ${message})`;
  }
}

function renderClip(row: Row, videoLink: string): string {
  const s: FeedbackSnapshot = row.snapshot ?? {};
  const crop = s.cropPlan;
  return [
    `### ${str(s.title)} - ${row.clipId}`,
    "",
    `- Verdict: ${verdictLabel(row.verdict)}`,
    `- Surface: ${str(row.surface)}   Locale: ${str(row.locale)}`,
    `- When: ${row.createdAt.toISOString()}`,
    `- Clip id: ${row.clipId}   Job id: ${row.jobId}   Feedback id: ${row.id}`,
    `- Window: ${num(s.startTime)}s -> ${num(s.endTime)}s  (duration ${s.duration ?? "-"}s)`,
    `- Score: ${num(s.score, 2)}   Kind: ${str(s.clipKind)}   Low quality: ${s.lowQuality ? "yes" : "no"}`,
    `- Hook: ${num(s.hookStart)}s -> ${num(s.hookEnd)}s   Payoff: ${num(s.payoffAt)}s`,
    `- Engine: ${str(s.analyzeEngine)}   Highlights version: ${s.highlightsVersion ?? "-"}   Language: ${str(s.language)}`,
    `- Source duration: ${s.sourceDurationSec ?? "-"}s`,
    crop
      ? `- Crop plan: ${crop.keyframes ?? "-"} keyframes, layout=${crop.layout ?? "-"}, static=${crop.static ? "yes" : "no"}`
      : "- Crop plan: -",
    `- Video: ${videoLink}`,
    `- Note: ${row.note ? row.note : "-"}`,
    "",
    "Transcript slice:",
    "```",
    s.transcript && s.transcript.length > 0 ? s.transcript : "(no transcript captured)",
    "```",
  ].join("\n");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // One query is the single source of truth for the header stats, the
  // grouped body and the raw jsonl dump - so the three can never disagree
  // with each other about how many rows there are.
  const raw = await prisma.clipFeedback.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      clipId: true,
      jobId: true,
      userId: true,
      surface: true,
      verdict: true,
      reason: true,
      note: true,
      snapshot: true,
      evidenceKey: true,
      locale: true,
      createdAt: true,
    },
  });
  const rows: Row[] = raw.map((r) => ({
    ...r,
    snapshot: (r.snapshot as FeedbackSnapshot | null) ?? null,
  }));

  // Same denominator apps/admin shows as "clips delivered" - getFeedbackSummary
  // in analytics.service.ts uses the identical unfiltered prisma.clip.count().
  const clipsDelivered = await prisma.clip.count();

  const verdictCounts = new Map<string, number>();
  for (const r of rows) {
    verdictCounts.set(r.verdict, (verdictCounts.get(r.verdict) ?? 0) + 1);
  }
  const ratedWithVerdict = FEEDBACK_VERDICTS.reduce(
    (n, v) => n + (verdictCounts.get(v) ?? 0),
    0
  );
  const asIs = verdictCounts.get("AS_IS") ?? 0;
  const noVerdict = verdictCounts.get("") ?? 0;

  const date = new Date().toISOString().slice(0, 10);
  const header: string[] = [
    `# Clip feedback digest - ${date}`,
    "",
    "Generated by `apps/worker/src/scripts/feedback-digest.ts`. Video links are",
    "signed fresh on every run and expire in 7 days - the R2 evidence copies",
    "never expire, so a stale link is never a dead end, just re-run this script.",
    "",
    "## Summary",
    "",
    `- Total feedback rows: ${rows.length}`,
    `- Clips delivered (all time): ${clipsDelivered}`,
    `- Response rate: ${pct(rows.length, clipsDelivered)} (${rows.length} of ${clipsDelivered} delivered clips have any feedback)`,
    "- Verdict split:",
    ...FEEDBACK_VERDICTS.map((v) => `  - ${v}: ${verdictCounts.get(v) ?? 0}`),
    `  - No verdict (note or reason left before any verdict tap - "" in the column, reported separately, never folded into a real verdict): ${noVerdict}`,
    `- Postable rate: ${pct(asIs, ratedWithVerdict)} (AS_IS ${asIs} of ${ratedWithVerdict} rows carrying a real verdict; the ${noVerdict} "no verdict" row(s) are excluded from this denominator)`,
    "",
    "## Reason routes to subsystem",
    "",
    "| reason | subsystem |",
    "|---|---|",
    ...Object.entries(REASON_SUBSYSTEM).map(([r, s]) => `| ${r} | ${s} |`),
    "",
  ];

  const bodySections: string[] = [];
  if (rows.length === 0) {
    bodySections.push("No feedback recorded yet - clip_feedback is empty.");
  } else {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.reason ?? "";
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
    const noReasonRows = groups.get("") ?? [];
    groups.delete("");
    // Commonest reason first, ties broken alphabetically for a stable order
    // across runs; rows with no reason at all form their own final group
    // regardless of size - they are not competing for "commonest".
    const reasoned = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
    );
    const orderedGroups: [string, Row[]][] = [...reasoned];
    if (noReasonRows.length > 0) orderedGroups.push(["", noReasonRows]);

    for (const [reasonKey, list] of orderedGroups) {
      const subsystem =
        reasonKey === ""
          ? null
          : (REASON_SUBSYSTEM[reasonKey as FeedbackReason] ?? "unmapped reason");
      const title =
        reasonKey === ""
          ? `## No reason given (${list.length})`
          : `## ${reasonKey} - ${subsystem} (${list.length})`;
      const clipBlocks: string[] = [];
      for (const row of list) {
        const link = await signOrFallback(row.evidenceKey);
        clipBlocks.push(renderClip(row, link));
      }
      bodySections.push([title, "", clipBlocks.join("\n\n---\n\n")].join("\n"));
    }
  }

  const markdown = header.join("\n") + "\n" + bodySections.join("\n\n") + "\n";
  const jsonl =
    rows
      .map((r) =>
        JSON.stringify({ ...r, createdAt: r.createdAt.toISOString() })
      )
      .join("\n") + (rows.length > 0 ? "\n" : "");

  const mdPath = join(OUT_DIR, `${date}.md`);
  const jsonlPath = join(OUT_DIR, "feedback.jsonl");
  await writeFile(mdPath, markdown, "utf-8");
  await writeFile(jsonlPath, jsonl, "utf-8");

  console.log(`[feedback-digest] ${rows.length} rows, ${clipsDelivered} clips delivered`);
  console.log(`[feedback-digest] wrote ${mdPath}`);
  console.log(`[feedback-digest] wrote ${jsonlPath}`);
}

main()
  .catch((error) => {
    console.error("[feedback-digest] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
