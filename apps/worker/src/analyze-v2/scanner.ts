import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { SCANNER_PROMPT, scannerUserPrompt } from "./prompts";
import { SCANNER_SCHEMA } from "./schemas";
import { buildScanWindows, renderWindowText } from "./windows";
import type { LlmUsage, ScanCandidate, SentenceNode } from "./types";

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

export async function runScanner(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  options: ScannerOptions = {}
): Promise<ScannerResult> {
  const windows = buildScanWindows(nodes, cfg);
  const maxNode = nodes.length - 1;
  const candidatesPerWindow: number[] = new Array(windows.length).fill(0);
  let windowsFailed = 0;

  const perWindow = await mapWithConcurrency(windows, cfg.maxConcurrency, async (window) => {
    const windowCandidates: ScanCandidate[] = [];
    const result = await callJsonSchema<{ candidates: ScanRow[] }>(client, usage, {
      model: cfg.scanModel,
      system: SCANNER_PROMPT,
      user: scannerUserPrompt(renderWindowText(nodes, window)),
      schema: SCANNER_SCHEMA,
      temperature: 0.4,
      retryDelayMs: options.retryDelayMs,
    });
    if (!result.ok) {
      // callJsonSchema already retried once; a dead window costs recall, never the job
      windowsFailed += 1;
      console.warn(
        `[analyze-v2] scanner window ${window.index} failed: ${"error" in result ? result.error : result.kind}`
      );
      return windowCandidates;
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
      windowCandidates.push({
        startNode: row.start_node,
        endNode: row.end_node,
        payoffNode: payoff,
        interest: Math.min(1, Math.max(0, Number(row.interest) || 0)),
        type: row.type || "other",
        thread: row.thread ?? undefined,
        windowIndex: window.index,
      });
      candidatesPerWindow[window.index] += 1;
    }
    return windowCandidates;
  });

  // Deterministic order: window index, not API completion order. Candidate ids
  // are assigned by position downstream and mergeCandidates sorts stably, so a
  // latency-dependent order changed merges, critic batches and which clips shipped.
  const all = perWindow.flat();

  return {
    candidates: all,
    telemetry: {
      windowsTotal: windows.length,
      windowsFailed,
      candidatesPerWindow,
    },
  };
}
