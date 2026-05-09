import { prisma } from "../lib/prisma";
import type { JobStepName, Prisma } from "@prisma/client";

function json(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startJobStep(
  jobId: string,
  step: JobStepName,
  input?: unknown
) {
  const now = new Date();

  return prisma.jobStep.upsert({
    where: { jobId_step: { jobId, step } },
    create: {
      jobId,
      step,
      status: "RUNNING",
      attempt: 1,
      inputJson: json(input),
      startedAt: now,
      error: null,
    },
    update: {
      status: "RUNNING",
      attempt: { increment: 1 },
      inputJson: json(input),
      startedAt: now,
      finishedAt: null,
      error: null,
    },
  });
}

export async function completeJobStep(
  jobId: string,
  step: JobStepName,
  output?: unknown
) {
  return prisma.jobStep.updateMany({
    where: { jobId, step },
    data: {
      status: "DONE",
      outputJson: json(output),
      finishedAt: new Date(),
      error: null,
    },
  });
}

export async function failJobStep(
  jobId: string,
  step: JobStepName,
  error: unknown
) {
  return prisma.jobStep.updateMany({
    where: { jobId, step },
    data: {
      status: "FAILED",
      error: errorMessage(error),
      finishedAt: new Date(),
    },
  });
}
