import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { criticSystemPrompt, criticUserPrompt } from "./prompts";
import { CRITIC_SCHEMA, REPAIR_SCHEMA } from "./schemas";
import { isoToLanguageName } from "./language";
import type { CriticVerdict, LlmUsage, MergedCandidate, SentenceNode } from "./types";

const OUTPUT_TOKENS_PER_CANDIDATE = 400;
const CRITIC_CONCURRENCY = 4;

/** Terminal infrastructure failure - the job must fail retryable, never ship unjudged. */
export class AnalyzeTechnicalError extends Error {}

interface CriticRow {
  id: string;
  keep: boolean;
  score: number;
  grounded: boolean;
  self_contained: boolean;
  start_node: number;
  payoff_node: number;
  end_node: number;
  hook_start_node: number;
  hook_end_node: number;
  title: string;
  description: string;
  title_evidence_nodes: number[];
  description_evidence_nodes: number[];
  language: string;
}

export interface CriticRunResult {
  verdicts: CriticVerdict[];
  telemetry: {
    batchSplits: number;
    refusalDrops: number;
    truncatedDrops: number;
    invariantDrops: number;
    fallbackModelUsed: boolean;
  };
}

export interface CriticOptions {
  /** Test hook - forwarded to callJsonSchema. */
  retryDelayMs?: number;
}

export async function runCritic(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  candidates: MergedCandidate[],
  languageIso: string,
  cfg: AnalyzeConfig,
  options: CriticOptions = {}
): Promise<CriticRunResult> {
  const system = criticSystemPrompt(languageIso, isoToLanguageName(languageIso));
  const telemetry = {
    batchSplits: 0,
    refusalDrops: 0,
    truncatedDrops: 0,
    invariantDrops: 0,
    fallbackModelUsed: false,
  };

  const batches: MergedCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += cfg.criticBatchSize) {
    batches.push(candidates.slice(i, i + cfg.criticBatchSize));
  }

  const kindById = new Map(candidates.map((c) => [c.id, c.type]));
  const verdicts: CriticVerdict[] = [];

  const callBatch = async (
    batch: MergedCandidate[],
    model: string,
    capMultiplier: number
  ) =>
    callJsonSchema<{ results: CriticRow[] }>(client, usage, {
      model,
      system,
      user: criticUserPrompt(batch, nodes),
      schema: CRITIC_SCHEMA,
      maxOutputTokens: batch.length * OUTPUT_TOKENS_PER_CANDIDATE * capMultiplier,
      reasoningEffort: cfg.reasoningEffort,
      retryDelayMs: options.retryDelayMs,
    });

  const processBatch = async (batch: MergedCandidate[]): Promise<CriticRow[]> => {
    let result = await callBatch(batch, cfg.criticModel, 1);

    if (!result.ok && result.kind === "truncated") {
      if (batch.length > 1) {
        // split in half and recurse - each half gets its own budget
        telemetry.batchSplits += 1;
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = [batch.slice(0, mid), batch.slice(mid)];
        return [...(await processBatch(a)), ...(await processBatch(b))];
      }
      // single candidate: double the output cap once
      result = await callBatch(batch, cfg.criticModel, 2);
      if (!result.ok && result.kind === "truncated") {
        // content-shaped anomaly of one candidate, not infrastructure - drop it
        telemetry.truncatedDrops += batch.length;
        console.warn(
          `[analyze-v2] critic dropped still-truncated candidate ${batch.map((c) => c.id).join(",")}`
        );
        return [];
      }
    }

    if (!result.ok && result.kind === "refusal") {
      result = await callBatch(batch, cfg.criticModel, 1);
      if (!result.ok && result.kind === "refusal") {
        telemetry.refusalDrops += batch.length;
        return [];
      }
    }

    if (!result.ok && result.kind === "error") {
      // llm.ts already retried once with backoff; try the fallback model
      telemetry.fallbackModelUsed = true;
      result = await callBatch(batch, cfg.criticModelFallback, 1);
    }

    if (!result.ok) {
      throw new AnalyzeTechnicalError(
        `critic failed for batch [${batch.map((c) => c.id).join(",")}]: ${result.kind}`
      );
    }
    return result.data.results ?? [];
  };

  const rowsPerBatch = await mapWithConcurrency(batches, CRITIC_CONCURRENCY, processBatch);

  // business invariants: every input id at most once, no unknown ids, sane fields
  const seen = new Set<string>();
  const inputIds = new Set(candidates.map((c) => c.id));
  for (const row of rowsPerBatch.flat()) {
    if (!row || typeof row !== "object" || !inputIds.has(row.id) || seen.has(row.id)) {
      telemetry.invariantDrops += 1;
      continue;
    }
    if (
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > 1 ||
      typeof row.title !== "string" ||
      row.title.trim().length === 0 ||
      typeof row.description !== "string" ||
      row.description.trim().length === 0
    ) {
      telemetry.invariantDrops += 1;
      continue;
    }
    seen.add(row.id);
    verdicts.push({
      id: row.id,
      keep: row.keep,
      score: row.score,
      grounded: row.grounded,
      selfContained: row.self_contained,
      startNode: row.start_node,
      payoffNode: row.payoff_node,
      endNode: row.end_node,
      hookStartNode: row.hook_start_node,
      hookEndNode: row.hook_end_node,
      title: truncateTitle(row.title),
      description: row.description.trim(),
      titleEvidenceNodes: row.title_evidence_nodes ?? [],
      descriptionEvidenceNodes: row.description_evidence_nodes ?? [],
      language: row.language,
      kind: kindById.get(row.id),
    });
  }

  return { verdicts, telemetry };
}

/** One copy-repair retry through the same stage-2 model (spec §8). */
export async function repairCopy(
  client: OpenAI,
  usage: LlmUsage,
  nodes: SentenceNode[],
  verdict: CriticVerdict,
  languageIso: string,
  cfg: AnalyzeConfig,
  options: CriticOptions = {}
): Promise<{ title: string; description: string } | null> {
  const clipText = nodes
    .slice(verdict.startNode, verdict.endNode + 1)
    .filter((n) => n.hasWords)
    .map((n) => n.text)
    .join(" ");
  const result = await callJsonSchema<{ title: string; description: string }>(client, usage, {
    model: cfg.criticModel,
    system: `Rewrite the clip title and one-sentence description STRICTLY in ${isoToLanguageName(languageIso)} (${languageIso}). Grounded in the clip text only, no hype, title max 70 characters. Output ONLY the JSON object described by the schema.`,
    user: `Clip transcript:\n${clipText}\n\nCurrent (wrong-language) title: ${verdict.title}\nCurrent description: ${verdict.description}`,
    schema: REPAIR_SCHEMA,
    reasoningEffort: cfg.reasoningEffort,
    retryDelayMs: options.retryDelayMs,
  });
  if (!result.ok) return null;
  return {
    title: truncateTitle(result.data.title),
    description: result.data.description.trim(),
  };
}

function truncateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= 70) return trimmed;
  return trimmed.slice(0, 69).trimEnd() + "…";
}
