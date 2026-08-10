/**
 * Label reader and time-overlap matching shared by eval-arc-audit.ts (task 1)
 * and eval-arc-stability.ts (spec 2026-08-10, task 2 item 7).
 *
 * Kept in its own module, with no CLI/`main()` of its own, for exactly the
 * reason arc-audit-onset.ts already documents for classifyOnset: importing a
 * script that runs itself at module scope would execute THAT script's own
 * `main()` - parsing this process's argv under a different usage string and
 * very possibly calling `process.exit(1)` before the importing script ever
 * gets control. eval-arc-audit.ts now imports this module too, so its own
 * behaviour is unchanged - this is the same logic, moved, not copied.
 */
import { existsSync, readFileSync } from "fs";
import type { V2Highlight } from "../analyze-v2/types";

// ---------------------------------------------------------------------------
// --labels: optional, tolerant. See eval-arc-audit.ts's module doc comment for
// why the shape is treated as loose rather than asserted.
// ---------------------------------------------------------------------------

export interface LabelEntry {
  ownerVerdict?: string | null;
  entryDefect?: string | null;
  exitDefect?: string | null;
  provenance?: string;
  productionTitle?: string;
  // Task 0's shipped shape (fixtures/eval/podcast-nuclear/labels.json,
  // 2026-08-10): a top-level [start, end] pair plus an optional, separately
  // sourced scout-consensus range. Both are tolerated; neither is assumed.
  range?: [number, number];
  scoutConsensus?: { start: number | null; end: number | null; agreement?: string } | null;
  // Flatter alternate shapes, in case a future labels.json uses them instead.
  scoutConsensusStart?: number;
  scoutConsensusEnd?: number;
  start?: number;
  end?: number;
}

export function loadLabels(path: string): LabelEntry[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    console.warn(
      `[arc-audit-labels] --labels: ${path} did not parse as JSON (${(error as Error).message}) - ignoring`
    );
    return [];
  }
  if (Array.isArray(parsed)) return parsed as LabelEntry[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["clips", "moments", "labels"]) {
      if (Array.isArray(obj[key])) return obj[key] as LabelEntry[];
    }
  }
  console.warn(
    `[arc-audit-labels] --labels: ${path} is not an array (or {clips|moments|labels: [...]}) - ignoring`
  );
  return [];
}

/** The label's own primary range, matched against the SHIPPED clip range for
 *  IoU - i.e. "does this clip correspond to a labeled moment", not "does it
 *  match the scout-consensus arc" (that comparison is a separate, harder
 *  question left to task 2/3's acceptance runs, M3/M4). scoutConsensus is
 *  printed alongside when present, because M1 makes it the entry/exit ground
 *  truth, but it never substitutes here: it can be a wider or disjoint arc by
 *  design (see the "Что увидела мать" entry, whose scout consensus opens
 *  61.5s before the labeled range). */
export function labelRange(entry: LabelEntry): [number, number] | null {
  if (
    Array.isArray(entry.range) &&
    entry.range.length === 2 &&
    typeof entry.range[0] === "number" &&
    typeof entry.range[1] === "number" &&
    entry.range[1] > entry.range[0]
  ) {
    return [entry.range[0], entry.range[1]];
  }
  const start = entry.scoutConsensusStart ?? entry.start;
  const end = entry.scoutConsensusEnd ?? entry.end;
  return typeof start === "number" && typeof end === "number" && end > start
    ? [start, end]
    : null;
}

export function iou(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const interStart = Math.max(aStart, bStart);
  const interEnd = Math.min(aEnd, bEnd);
  const inter = Math.max(0, interEnd - interStart);
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  return union > 0 ? inter / union : 0;
}

export function bestLabelMatch(
  h: { start: number; end: number },
  labels: LabelEntry[]
): { entry: LabelEntry; iou: number } | null {
  let best: { entry: LabelEntry; iou: number } | null = null;
  for (const entry of labels) {
    const range = labelRange(entry);
    if (!range) continue;
    const score = iou(h.start, h.end, range[0], range[1]);
    if (!best || score > best.iou) best = { entry, iou: score };
  }
  return best;
}

// Re-exported so a caller that only knows V2Highlight (eval-arc-audit.ts's own
// use) does not need a second import; bestLabelMatch itself only reads
// start/end; so a bare {start, end} (eval-arc-stability.ts's SnappedClip
// seconds) works too, structurally.
export type { V2Highlight };
