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

/** Row plus the model tier that produced it - fallback rows ship lowQuality. */
interface TaggedRow {
  row: CriticRow;
  degraded: boolean;
}

export interface CriticRunResult {
  verdicts: CriticVerdict[];
  telemetry: {
    batchSplits: number;
    refusalDrops: number;
    truncatedDrops: number;
    omittedDrops: number;
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
    omittedDrops: 0,
    invariantDrops: 0,
    fallbackModelUsed: false,
  };

  const batches: MergedCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += cfg.criticBatchSize) {
    batches.push(candidates.slice(i, i + cfg.criticBatchSize));
  }

  const kindById = new Map(candidates.map((c) => [c.id, c.type]));
  /** ids whose loss is already attributed to refusal/truncation telemetry. */
  const accountedDropIds = new Set<string>();

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

  const processBatch = async (batch: MergedCandidate[]): Promise<TaggedRow[]> => {
    const ids = () => batch.map((c) => c.id).join(",");

    const split = async (): Promise<TaggedRow[]> => {
      // split in half and recurse - each half gets its own budget and
      // starts over on the primary model
      telemetry.batchSplits += 1;
      const mid = Math.ceil(batch.length / 2);
      const first = await processBatch(batch.slice(0, mid));
      const second = await processBatch(batch.slice(mid));
      return [...first, ...second];
    };
    const dropTruncated = (): TaggedRow[] => {
      // content-shaped anomaly of the candidate(s), not infrastructure - drop
      telemetry.truncatedDrops += batch.length;
      for (const c of batch) accountedDropIds.add(c.id);
      console.warn(`[analyze-v2] critic dropped still-truncated candidate ${ids()}`);
      return [];
    };
    const dropRefused = (): TaggedRow[] => {
      telemetry.refusalDrops += batch.length;
      for (const c of batch) accountedDropIds.add(c.id);
      return [];
    };

    let degraded = false;
    let result = await callBatch(batch, cfg.criticModel, 1);

    if (!result.ok && result.kind === "truncated") {
      if (batch.length > 1) return split();
      // single candidate: double the output cap once
      result = await callBatch(batch, cfg.criticModel, 2);
      if (!result.ok && result.kind === "truncated") return dropTruncated();
    }

    if (!result.ok && result.kind === "refusal") {
      result = await callBatch(batch, cfg.criticModel, 1);
      if (!result.ok && result.kind === "refusal") return dropRefused();
    }

    if (!result.ok && result.kind === "error") {
      // llm.ts already retried once with backoff; try the fallback model
      telemetry.fallbackModelUsed = true;
      degraded = true;
      result = await callBatch(batch, cfg.criticModelFallback, 1);
    }

    if (!result.ok) {
      // post-fallback (or residual second-chance) outcome: only a hard API
      // error is terminal - content-shaped anomalies degrade gracefully
      if (result.kind === "error") {
        throw new AnalyzeTechnicalError(`critic failed for batch [${ids()}]: error`);
      }
      if (result.kind === "truncated") {
        return batch.length > 1 ? split() : dropTruncated();
      }
      return dropRefused();
    }

    // per-batch id guard: a row may only claim an id from THIS batch, so a
    // hallucinating batch can never steal another batch's candidate
    const batchIds = new Set(batch.map((c) => c.id));
    const own: TaggedRow[] = [];
    for (const row of result.data.results ?? []) {
      if (!row || typeof row !== "object" || !batchIds.has(row.id)) {
        telemetry.invariantDrops += 1;
        continue;
      }
      own.push({ row, degraded });
    }
    return own;
  };

  const tagged = (await mapWithConcurrency(batches, CRITIC_CONCURRENCY, processBatch)).flat();

  // business invariants: every id at most once, sane fields, node indices in range
  const verdicts: CriticVerdict[] = [];
  const seen = new Set<string>();
  const maxNode = nodes.length - 1;
  for (const { row, degraded } of tagged) {
    if (seen.has(row.id)) {
      telemetry.invariantDrops += 1;
      continue;
    }
    const nodeRefs = [
      row.start_node,
      row.payoff_node,
      row.end_node,
      row.hook_start_node,
      row.hook_end_node,
    ];
    if (
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > 1 ||
      typeof row.title !== "string" ||
      row.title.trim().length === 0 ||
      typeof row.description !== "string" ||
      row.description.trim().length === 0 ||
      nodeRefs.some((n) => !Number.isInteger(n) || n < 0 || n > maxNode)
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
      lowQuality: degraded ? true : undefined,
      kind: kindById.get(row.id),
    });
  }

  // silent omissions: input ids that ended with no verdict and no attributed drop
  const verdictIds = new Set(verdicts.map((v) => v.id));
  const omitted = candidates
    .filter((c) => !verdictIds.has(c.id) && !accountedDropIds.has(c.id))
    .map((c) => c.id);
  if (omitted.length > 0) {
    telemetry.omittedDrops += omitted.length;
    console.warn(`[analyze-v2] critic returned no verdict for candidate ${omitted.join(",")}`);
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
  // schema-valid but blank copy must not overwrite the original
  if (!result.data.title?.trim() || !result.data.description?.trim()) return null;
  return {
    title: truncateTitle(result.data.title),
    description: result.data.description.trim(),
  };
}

/** Code-point-safe 70-char cap - never splits a surrogate pair. */
function truncateTitle(title: string): string {
  const trimmed = title.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= 70) return trimmed;
  return chars.slice(0, 69).join("").trimEnd() + "…";
}
