import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { SCANNER_PROMPT, scannerUserPrompt } from "./prompts";
import { SCANNER_SCHEMA } from "./schemas";
import { buildScanWindows, renderWindowText } from "./windows";
import type { LlmUsage, ScanCandidate, ScanWindow, SentenceNode } from "./types";

interface ScanRow {
  start_node: number;
  end_node: number;
  payoff_node: number;
  interest: number;
  type: string;
  thread: string | null;
}

export interface ScannerResult {
  candidates: ScanCandidate[];
  telemetry: {
    windowsTotal: number;
    windowsFailed: number;
    candidatesPerWindow: number[];
  };
}

export interface ScannerOptions {
  /** Test hook - forwarded to callJsonSchema. */
  retryDelayMs?: number;
}

/** One (window, pass) unit of work - the flat task list `mapWithConcurrency`
 *  actually schedules. Built in nested window-then-pass order so the index
 *  every task lands at, and therefore the order `.flat()` below produces, is
 *  fixed before a single request goes out - the same discipline that fixed
 *  the completion-order nondeterminism (engine-notes §3, "Scanner order used
 *  to be non-deterministic") extended one level down to passes. */
interface ScanTask {
  window: ScanWindow;
  passIndex: number;
}

export async function runScanner(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  options: ScannerOptions = {}
): Promise<ScannerResult> {
  const windows = buildScanWindows(nodes, cfg);
  const maxNode = nodes.length - 1;
  const passes = cfg.scanPasses;
  const candidatesPerWindow: number[] = new Array(windows.length).fill(0);
  // Per-window count of passes that failed. A window counts as FAILED only
  // when every one of its passes failed - at passes=1 that is exactly
  // "this window's one call failed", byte-identical to before this knob
  // existed, and it keeps index.ts's `windowsFailed === windowsTotal` total-
  // outage check meaningful at passes>1 too (a window with one live pass out
  // of N still contributed real candidates, it did not fail).
  const windowFailureCount: number[] = new Array(windows.length).fill(0);

  // (window x pass) task list, in the exact nested order the flatten below
  // must preserve. Identical prompt every pass on purpose (spec 2026-08-11
  // "Scan recall remedy", Phase B "the 2x scan union") - diversity comes from
  // sampling at temperature 0.4, not from asking a different question, so
  // this loop must NOT vary anything about the request between passes.
  const tasks: ScanTask[] = [];
  for (const window of windows) {
    for (let passIndex = 0; passIndex < passes; passIndex++) {
      tasks.push({ window, passIndex });
    }
  }

  const perTask = await mapWithConcurrency(tasks, cfg.maxConcurrency, async ({ window, passIndex }) => {
    const taskCandidates: ScanCandidate[] = [];
    const result = await callJsonSchema<{ candidates: ScanRow[] }>(client, usage, {
      model: cfg.scanModel,
      system: SCANNER_PROMPT,
      user: scannerUserPrompt(renderWindowText(nodes, window)),
      schema: SCANNER_SCHEMA,
      temperature: 0.4,
      retryDelayMs: options.retryDelayMs,
    });
    if (!result.ok) {
      // callJsonSchema has already exhausted its retries (or classified the
      // failure as hopeless); a dead pass costs recall, never the job - the
      // window's other passes (if any) are independent tasks and proceed
      // regardless.
      windowFailureCount[window.index] += 1;
      console.warn(
        `[analyze-v2] scanner window ${window.index} pass ${passIndex + 1}/${passes} failed: ` +
          `${"error" in result ? result.error : result.kind}`
      );
      return taskCandidates;
    }
    for (const row of result.data.candidates ?? []) {
      if (
        !Number.isInteger(row.start_node) ||
        !Number.isInteger(row.end_node) ||
        row.start_node < 0 ||
        row.end_node > maxNode ||
        row.start_node > row.end_node
      ) {
        continue;
      }
      const payoff =
        Number.isInteger(row.payoff_node) &&
        row.payoff_node >= row.start_node &&
        row.payoff_node <= row.end_node
          ? row.payoff_node
          : row.start_node;
      taskCandidates.push({
        startNode: row.start_node,
        endNode: row.end_node,
        payoffNode: payoff,
        interest: Math.min(1, Math.max(0, Number(row.interest) || 0)),
        type: row.type || "other",
        thread: row.thread ?? undefined,
        windowIndex: window.index,
        passIndex,
      });
      candidatesPerWindow[window.index] += 1;
    }
    return taskCandidates;
  });

  // Deterministic order: (window index, pass index), not API completion
  // order. Candidate ids are assigned by position downstream and
  // mergeCandidates sorts stably, so a latency-dependent order changed
  // merges, critic batches and which clips shipped - mapWithConcurrency
  // writes each result to its task's own array slot regardless of which
  // finishes first, so `.flat()` on a nested-order task list reproduces that
  // nested order exactly.
  const all = perTask.flat();

  const windowsFailed = windowFailureCount.filter((failed) => failed === passes).length;

  return {
    candidates: all,
    telemetry: {
      windowsTotal: windows.length,
      windowsFailed,
      candidatesPerWindow,
    },
  };
}
