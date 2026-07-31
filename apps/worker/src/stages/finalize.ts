import {
  jobStepService,
  loadModelPrices,
  prisma,
  readRate,
} from "@clipclap/shared";
import type { Prisma } from "@prisma/client";
import { buildJobCostTelemetry } from "../cost-telemetry";
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
