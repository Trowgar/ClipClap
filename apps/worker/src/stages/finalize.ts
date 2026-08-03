import {
  jobStepService,
  loadModelPrices,
  prisma,
  readRate,
} from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { buildJobCostTelemetry, type ModelTokenUsage } from "../cost-telemetry";
import { criticModel, transcriptionModel } from "../model-selection";
import { settleFreeLedger } from "./free-settlement";
import type { FinalizeStagePayload } from "./types";

/**
 * Compile-time guard on the seam that nearly took production down.
 *
 * The telemetry object is spread into prisma.job.update, and Prisma REJECTS
 * unknown arguments rather than ignoring them - the throw is caught by
 * runFinalizeStage, which marks the job FAILED and refunds it. Spreading a
 * non-literal skips TypeScript's excess-property check and the tests mock
 * Prisma, so neither guard saw it the first time.
 *
 * This checks BOTH halves of "fits the row", because each misses what the other
 * catches. The outer arm rejects a field that is not a Job column at all. The
 * inner arm rejects a field whose VALUE the column cannot accept - the columns
 * this guard was written for are String?, so criticModel() one day returning a
 * non-string is the plausible slip, and a key-only check waves it through.
 * Prisma's FieldUpdateOperationsInput wrappers do not get in the way: they are
 * supertypes, so a plain `string` is assignable to
 * `string | StringFieldUpdateOperationsInput | null`.
 *
 * Nested rather than intersected on purpose - it keeps the two diagnostics
 * distinct, so the failure says which kind of mistake was made.
 */
type Telemetry = ReturnType<typeof buildJobCostTelemetry>;
type TelemetryFitsJobRow =
  keyof Telemetry extends keyof Prisma.JobUncheckedUpdateInput
    ? Telemetry extends Pick<
        Prisma.JobUncheckedUpdateInput,
        keyof Telemetry & keyof Prisma.JobUncheckedUpdateInput
      >
      ? true
      : {
          error: "buildJobCostTelemetry returns a field whose type the Job column cannot accept";
        }
    : { error: "buildJobCostTelemetry returns a field that is not a Job column" };
// Do not delete: this const IS the check.
const _telemetryFitsJobRow: TelemetryFitsJobRow = true;

/** Parsed once at module load: the price table does not change under a running
 *  worker, and re-parsing per job would multiply the warning noise by traffic.
 *
 * price-check.ts reports missing prices once at boot; a second identical line
 * here would land after the [cost] summary and read as a new problem. */
const MODEL_PRICES = loadModelPrices(process.env, () => {});

/** Optional. Unset means compute is not reported - see cost-telemetry.ts. */
const COMPUTE_COST_PER_MINUTE_USD = readRate(
  process.env.COMPUTE_COST_PER_MINUTE_USD,
  "COMPUTE_COST_PER_MINUTE_USD"
);

type Aggregate = { inputTokens: number | null; outputTokens: number | null };

const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The refusals, in one place, applied to whichever record supplied the map.
 *
 * There are two records of the same breakdown (the Job column and the ANALYZE
 * step's copy) and they must be judged by identical rules - a source that is
 * validated more loosely than the other is a source that can smuggle a wrong
 * number past the strict one. Hence one parser, two thin readers below.
 *
 * REFUSES rather than repairs, in all three directions:
 *   - a payload of the wrong shape (legacy engine, pre-breakdown row, anything
 *     unreadable) yields null, and pricing falls back to the next source;
 *   - a malformed ENTRY nulls the whole map, because dropping it would silently
 *     under-count that model's tokens - the exact class of quiet wrong number
 *     this file exists to stop;
 *   - a breakdown whose totals disagree with the job row's totals is a
 *     breakdown from a DIFFERENT run (a step row can outlive the attempt that
 *     wrote it, and a crash between two writes leaves the previous attempt's
 *     copy behind). The two records are then about different work, and pricing
 *     the older one would be a confident wrong number about this job.
 */
type ByModelRead =
  | { ok: true; map: Record<string, ModelTokenUsage> }
  /** Nothing to read: not an object, or an object with no models in it. The
   *  ordinary state of a legacy row and of a job that never called an LLM. */
  | { ok: false; reason: "no-breakdown" }
  /** Something is there and it is wrong - a defect, not an absence. */
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "mismatch" };

function parseByModel(
  candidate: unknown,
  aggregate: Aggregate,
  warn: (message: string) => void
): ByModelRead {
  const byModel = obj(candidate);
  if (!byModel) return { ok: false, reason: "no-breakdown" };

  const out: Record<string, ModelTokenUsage> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const [model, raw] of Object.entries(byModel)) {
    const entry = obj(raw);
    const i = entry?.inputTokens;
    const o = entry?.outputTokens;
    const usable = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!usable(i) || !usable(o)) return { ok: false, reason: "malformed" };
    out[model] = { inputTokens: i, outputTokens: o };
    inputTokens += i;
    outputTokens += o;
  }
  if (Object.keys(out).length === 0) return { ok: false, reason: "no-breakdown" };

  if (
    inputTokens !== (aggregate.inputTokens ?? 0) ||
    outputTokens !== (aggregate.outputTokens ?? 0)
  ) {
    warn(
      `[cost] per-model analysis usage (${inputTokens} in / ${outputTokens} out) does not ` +
        `match the job row (${aggregate.inputTokens ?? 0} in / ${aggregate.outputTokens ?? 0} ` +
        `out) - the two records are from different runs, so the breakdown is ignored and ` +
        `this job is priced at the configured critic's rate.`
    );
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, map: out };
}

/**
 * The AUTHORITATIVE source: Job.analysisUsageByModel, written by stages/analyze.ts
 * in the same update as the totals it decomposes. Preferred over the step copy
 * because it cannot be orphaned by a step rewrite and is queryable for margin
 * analysis without a join.
 *
 * A NULL column is the ordinary state of every job analyzed before 2026-08-03
 * and of every legacy-engine job, and an EMPTY one is the state of a job that
 * never reached an LLM. Both are silent, and the step reader below gets its
 * turn. A column that holds something UNREADABLE is a different animal: only
 * this worker writes it, so a shape it cannot parse is a defect in the
 * analyze-side write rather than history. That warns - and then still falls
 * through. See the note on the precedence chain in runFinalizeStage for why
 * falling through, not refusing, is the right answer to a bad column.
 */
export function readAnalysisUsageColumn(
  column: unknown,
  aggregate: Aggregate,
  warn: (message: string) => void = console.warn
): Record<string, ModelTokenUsage> | null {
  if (column === null || column === undefined) return null;
  const read = parseByModel(column, aggregate, warn);
  if (read.ok) return read.map;
  // "mismatch" has already said its piece, and in far more detail.
  if (read.reason === "malformed" || (read.reason === "no-breakdown" && !obj(column))) {
    warn(
      `[cost] Job.analysisUsageByModel is present but unreadable (${read.reason}) - ` +
        `ignoring it and falling back to the ANALYZE step's copy.`
    );
  }
  return null;
}

/**
 * The FALLBACK source: the engine's whole LlmUsage as published into the ANALYZE
 * JobStep's outputJson, which is where the breakdown lived before the column
 * existed. Kept because jobs analyzed before this deploy - and any in flight at
 * the moment it lands - have the step copy and nothing else, and dropping this
 * path would price exactly those jobs at the configured critic's rate again.
 */
export function readAnalysisUsageByModel(
  outputJson: unknown,
  aggregate: Aggregate,
  warn: (message: string) => void = console.warn
): Record<string, ModelTokenUsage> | null {
  const read = parseByModel(
    obj(obj(outputJson)?.usage)?.byModel,
    aggregate,
    warn
  );
  return read.ok ? read.map : null;
}

export async function runFinalizeStage(
  payload: FinalizeStagePayload
): Promise<void> {
  try {
    await jobStepService.startJobStep(payload.jobId, "FINALIZE", payload);

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: payload.jobId },
    });
    const processingEndedAt = new Date();
    const processingStartedAt = job.processingStartedAt ?? processingEndedAt;

    const aggregate = {
      inputTokens: job.analysisInputTokens,
      outputTokens: job.analysisOutputTokens,
    };

    // Precedence: the job's own column, then the ANALYZE step's copy, then the
    // aggregate columns priced at the CONFIGURED critic (inside cost-telemetry).
    //
    // The two breakdown sources are two writes of one in-memory object, so a
    // source that refuses is evidence about that RECORD, never about the other
    // one - which is why an unreadable column falls through to the step rather
    // than nulling the cost. Both are held to the identical refusals above,
    // including reconciliation against this row's totals, so falling through
    // cannot promote a wrong number: it can only reach a record that passes
    // every check we have. Refusing outright would instead throw away a good
    // record and report null cost - and null cost is what settleFreeLedger
    // trues the free-tier ledger up against.
    let analysisUsageByModel = readAnalysisUsageColumn(
      job.analysisUsageByModel,
      aggregate
    );
    if (analysisUsageByModel === null) {
      const analyzeStep = await prisma.jobStep.findUnique({
        where: { jobId_step: { jobId: payload.jobId, step: "ANALYZE" } },
        select: { outputJson: true },
      });
      analysisUsageByModel = readAnalysisUsageByModel(
        analyzeStep?.outputJson,
        aggregate
      );
    }

    const telemetry = buildJobCostTelemetry({
      sourceDurationSec: job.sourceDurationSec,
      processingStartedAt,
      processingEndedAt,
      transcribeMs: job.transcribeMs ?? 0,
      analyzeMs: job.analyzeMs ?? 0,
      renderMs: job.renderMs ?? 0,
      clipsGenerated: job.clipsGenerated,
      transcriptionModel: transcriptionModel(),
      analysisInputTokens: job.analysisInputTokens,
      analysisOutputTokens: job.analysisOutputTokens,
      analysisUsageByModel,
      // The CONFIGURED critic, still stamped on the row - it is what the
      // deployment asked for, and a row that records only the models that
      // answered cannot show that they were not the ones chosen. The COST no
      // longer comes from it whenever the breakdown above is available.
      criticModel: criticModel(),
      prices: MODEL_PRICES,
      computeCostPerMinuteUsd: COMPUTE_COST_PER_MINUTE_USD,
    });

    // Annotated rather than inlined so that deleting the guard above changes
    // real code rather than a lone unused const. This does NOT replace it: a
    // spread of a non-literal skips excess-property checking here too, which is
    // exactly how the unknown-argument throw reached production.
    const data: Prisma.JobUncheckedUpdateInput = {
      status: "DONE",
      error: null,
      ...telemetry,
    };

    await prisma.job.update({ where: { id: payload.jobId }, data });

    // Settle the free ledger against the outcome that was just written: true up
    // the reservation's cost from the telemetry above, and give the allowance
    // back if the run produced nothing. It runs AFTER the status write, not
    // before, because the refunds are only safe on a state the job has actually
    // reached - a refund written against an outcome that then fails to persist
    // would be released for a job BullMQ retries and may still finish.
    await settleFreeLedger(payload.jobId, "DONE");

    await jobStepService.completeJobStep(payload.jobId, "FINALIZE", {
      status: "DONE",
    });
  } catch (error) {
    await jobStepService.failJobStep(payload.jobId, "FINALIZE", error);
    await prisma.job.update({
      where: { id: payload.jobId },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    // Same rule on this side: the FAILED write comes first, and only a job that
    // is recorded as failed gets its allowance back. settleFreeLedger swallows
    // its own errors so the original failure is what propagates.
    await settleFreeLedger(payload.jobId, "FAILED");
    throw error;
  }
}
