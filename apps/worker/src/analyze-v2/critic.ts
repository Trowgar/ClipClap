import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema, mapWithConcurrency } from "./llm";
import { criticSystemPrompt, criticUserPrompt } from "./prompts";
import { CRITIC_SCHEMA, REPAIR_SCHEMA } from "./schemas";
import { isoToLanguageName } from "./language";
import type { CriticVerdict, LlmUsage, MergedCandidate, SentenceNode } from "./types";

// Output budget for one critic batch.
//
// gpt-5.1 is a reasoning model: max_completion_tokens pays for the reasoning
// tokens FIRST and only then for the visible JSON. The old constant (400 per
// candidate, a non-reasoning-model number) sat below the reasoning floor at
// every batch size, so calls died mid-reasoning with content == null and zero
// verdicts - and the split-in-half recovery inherited the same starvation,
// which is how a budget bug turned into dropped candidates.
//
// Measured on the podcast-ecology critic prompts, live gpt-5.1,
// reasoning_effort "low" (batch / cap -> completion / reasoning / verdicts):
//     6 /  2400 -> 2400 / 2400 / 0   (truncated: killed mid-reasoning)
//     6 /  5000 -> 2857 / 1979 / 6
//     6 / 14000 -> 3506 / 2677 / 6   (worst seen at size 6)
//     3 /  1200 -> 1200 / 1200 / 0   (truncated)
//     3 /  3000 -> 1338 /  918 / 3
//     3 /  6000 -> 1931 / 1478 / 3   (worst seen at size 3)
//     1 /   400 ->  400 /  400 / 0   (truncated)
//     1 /  1200 ->  762 /  603 / 1   (worst seen at size 1)
//     1 /  3000 ->  501 /  354 / 1
//
// So reasoning is ~330-450 tokens PER CANDIDATE with only a small fixed part,
// while the visible JSON is a stable ~150 tokens per verdict. The allowance has
// to scale with batch size because the dominant term does.
//
// Headroom is cheap but NOT free, and the two costs differ:
//   - Billing: max_completion_tokens is a cap, not a reservation. A request that
//     stops at 2857 costs 2857 whether the cap was 5000 or 14000. Note this
//     makes the fix cost-POSITIVE: a truncated completion is billed in full, so
//     the old 6@2400 -> 2x3@1200 -> singles cascade billed more tokens for zero
//     verdicts than one 6@6000 call that actually returns 6.
//   - Rate limiting: OpenAI has historically estimated a request's TPM draw as
//     prompt_tokens + max_completion_tokens, so against TPM the cap IS a
//     reservation. At CRITIC_CONCURRENCY 4 and batch 6 that is ~4x(9.3k+6k) =
//     ~61k in flight, up from ~47k. Do NOT read "unused tokens are never billed"
//     as licence to set this to 14000; a 429 degrades to the fallback model and
//     then to AnalyzeTechnicalError.
// The model also expands its reasoning into room it is given (size 6: 1979
// tokens at cap 5000 -> 2159 at 9000 -> 2677 at 14000). So each cap is the
// smallest round number that clears a cap already OBSERVED TO COMPLETE at that
// size, which is the load-bearing property:
//   1 candidate  -> 2000 (> 1200, which completed)
//   3 candidates -> 3600 (> 3000, which completed)
//   6 candidates -> 6000 (> 5000, which completed)
//
// CAVEAT: every number above is one sample per cell on one fixture, and per-call
// variance is the same order as the headroom (a later live run measured 2184
// completion at 6/6000, BELOW the 2857 seen at 6/5000). Treat "worst seen" as
// "only seen once".
//
// CONDITIONAL ON reasoning_effort = "low", which is env-tunable via
// SELECTION_REASONING_EFFORT (config.ts) and passed straight through below.
// Raising it multiplies reasoning tokens, which is the dominant term here, and
// re-creates the starvation this constant exists to prevent: truncation ->
// split cascade -> dropTruncated() -> thin or (at zero verdicts) failed jobs.
// Re-measure this table before shipping a higher effort.
const CRITIC_BASE_TOKENS = 1200; // shared rubric/JSON-scaffold pass + flat headroom
const CRITIC_TOKENS_PER_CANDIDATE = 800; // ~450 reasoning + ~150 JSON + ~200 headroom
const CRITIC_CONCURRENCY = 4;

/** Output cap for a batch. capMultiplier is the single-candidate retry hatch. */
export function criticMaxOutputTokens(batchSize: number, capMultiplier = 1): number {
  return (CRITIC_BASE_TOKENS + batchSize * CRITIC_TOKENS_PER_CANDIDATE) * capMultiplier;
}

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
      maxOutputTokens: criticMaxOutputTokens(batch.length, capMultiplier),
      reasoningEffort: cfg.reasoningEffort,
      retryDelayMs: options.retryDelayMs,
    });

  const processBatch = async (batch: MergedCandidate[]): Promise<TaggedRow[]> => {
    const ids = () => batch.map((c) => c.id).join(",");

    const split = async (): Promise<TaggedRow[]> => {
      // split in half and recurse - each half gets its own budget and
      // starts over on the primary model. With the budget sized above this is
      // a genuine last resort: truncation at 1200 + 800n is a content anomaly,
      // not the systematic starvation the old flat 400/candidate produced.
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
    // Copy is only load-bearing for a clip we would actually ship: the
    // orchestrator skips a keep:false verdict before it ever reads title or
    // description. The live model writes neither for a clip it is killing -
    // there is no title for a moment you are rejecting - and every rejection in
    // the podcast-answer-arc eval fixture came back title:"" description:"".
    // Demanding copy here dropped those rows, which filed the critic's
    // considered "no" under "the critic never answered about this candidate"
    // and made a weak video look like a protocol failure.
    const copyOk =
      row.keep !== true ||
      (typeof row.title === "string" &&
        row.title.trim().length > 0 &&
        typeof row.description === "string" &&
        row.description.trim().length > 0);
    if (
      typeof row.keep !== "boolean" ||
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > 1 ||
      !copyOk ||
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
      title: typeof row.title === "string" ? truncateTitle(row.title) : "",
      description: typeof row.description === "string" ? row.description.trim() : "",
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
