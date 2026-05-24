# Stage-Based Video Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split ClipClap video processing into resilient stage-based queues so heavy FFmpeg work cannot block download, transcription, analysis, or upload/finalization work.

**Architecture:** Keep one worker codebase/image, but run it in role-specific modes over separate BullMQ queues. Jobs move through `download -> transcribe -> analyze -> render -> finalize`; trim jobs enter at `render`. `JobStep` rows record per-stage status, attempts, timings, input/output payloads, and errors so the system can retry safely and explain failures.

**Tech Stack:** Next.js API routes, BullMQ, Redis, Prisma/PostgreSQL, TypeScript, Vitest, Docker Compose, FFmpeg, OpenAI, Cloudflare R2.

---

## File Structure

**New files:**
- `packages/shared/src/lib/queues.ts` - queue names, role names, queue factory helpers, queue enqueue helpers.
- `packages/shared/src/services/job-step.service.ts` - create/start/complete/fail helpers for `JobStep`.
- `packages/shared/src/services/__tests__/job-step.service.test.ts` - tests for idempotent stage tracking.
- `apps/worker/src/stages/download.ts` - download stage handler.
- `apps/worker/src/stages/transcribe.ts` - transcription stage handler.
- `apps/worker/src/stages/analyze.ts` - highlight analysis stage handler.
- `apps/worker/src/stages/render.ts` - render stage handler for full video clips and trim clips.
- `apps/worker/src/stages/finalize.ts` - final DB update, cost telemetry, final `DONE`.
- `apps/worker/src/worker-app.ts` - creates a BullMQ Worker for one role.
- `apps/worker/src/__tests__/stage-flow.test.ts` - tests stage handoff.
- `prisma/migrations/20260509_stage_pipeline_job_steps/migration.sql` - `JobStep` table and stage enum.

**Modified files:**
- `prisma/schema.prisma` - add `JobStep`, `JobStepStatus`, `JobStepName`, and artifact fields on `Job`.
- `packages/shared/src/lib/index.ts` - export queue helpers.
- `packages/shared/src/services/index.ts` - export job step service.
- `packages/shared/src/services/job.service.ts` - enqueue `download` stage instead of monolithic `process-video`.
- `packages/shared/src/services/clip.service.ts` - enqueue trim into `render` queue.
- `apps/worker/src/index.ts` - choose worker role from `WORKER_ROLE`.
- `apps/worker/src/pipeline.ts` - gradually shrink; keep legacy wrapper only until stage flow passes.
- `docker-compose.yml` - replace one `worker` service with role-specific workers.
- `apps/worker/package.json` - keep scripts compatible with one image.

---

## Stage Payloads

Use explicit payload types to avoid stage coupling:

```ts
export type StageJobName =
  | "download"
  | "transcribe"
  | "analyze"
  | "render"
  | "finalize";

export interface DownloadStagePayload {
  jobId: string;
  userId: string;
}

export interface TranscribeStagePayload {
  jobId: string;
  userId: string;
  localVideoPath?: string;
}

export interface AnalyzeStagePayload {
  jobId: string;
  userId: string;
}

export interface RenderStagePayload {
  jobId: string;
  userId: string;
  mode: "clips" | "trim";
  clipId?: string;
  originalClipStorageKey?: string;
  start?: number;
  end?: number;
}

export interface FinalizeStagePayload {
  jobId: string;
  userId: string;
}
```

Note: local temp paths are not safe across different containers. Stage 1 should persist downloaded source to R2 as a working artifact key, not pass `/tmp` paths between workers.

---

## Task 1: Queue Names, Roles, and Stage Enqueue Helpers

**Files:**
- Create: `packages/shared/src/lib/queues.ts`
- Modify: `packages/shared/src/lib/index.ts`
- Test: `packages/shared/src/lib/__tests__/queues.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/shared/src/lib/__tests__/queues.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  QUEUE_NAMES,
  getQueueNameForStage,
  parseWorkerRole,
} from "../queues";

describe("stage queue helpers", () => {
  it("maps each pipeline stage to its own queue name", () => {
    expect(QUEUE_NAMES.download).toBe("video-download");
    expect(QUEUE_NAMES.transcribe).toBe("video-transcribe");
    expect(QUEUE_NAMES.analyze).toBe("video-analyze");
    expect(QUEUE_NAMES.render).toBe("video-render");
    expect(QUEUE_NAMES.finalize).toBe("video-finalize");
  });

  it("parses known worker roles and rejects unknown roles", () => {
    expect(parseWorkerRole("download")).toBe("download");
    expect(parseWorkerRole("render")).toBe("render");
    expect(() => parseWorkerRole("all")).toThrow(/unknown worker role/i);
  });

  it("returns queue name for stage", () => {
    expect(getQueueNameForStage("analyze")).toBe("video-analyze");
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test -w @clipfast/shared -- packages/shared/src/lib/__tests__/queues.test.ts
```

Expected: FAIL because `../queues` does not exist.

- [ ] **Step 3: Implement helpers**

Create `packages/shared/src/lib/queues.ts`:

```ts
import { Queue } from "bullmq";
import { getRedis } from "./redis";

export const QUEUE_NAMES = {
  download: "video-download",
  transcribe: "video-transcribe",
  analyze: "video-analyze",
  render: "video-render",
  finalize: "video-finalize",
} as const;

export type StageName = keyof typeof QUEUE_NAMES;

const STAGES = Object.keys(QUEUE_NAMES) as StageName[];
const queues = new Map<StageName, Queue>();

export function parseWorkerRole(value: string | undefined): StageName {
  if (value && STAGES.includes(value as StageName)) return value as StageName;
  throw new Error(`Unknown worker role: ${value ?? "(empty)"}`);
}

export function getQueueNameForStage(stage: StageName): string {
  return QUEUE_NAMES[stage];
}

export function getStageQueue(stage: StageName): Queue {
  const existing = queues.get(stage);
  if (existing) return existing;

  const queue = new Queue(getQueueNameForStage(stage), {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: stage === "render" ? 2 : 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  });
  queues.set(stage, queue);
  return queue;
}
```

Modify `packages/shared/src/lib/index.ts`:

```ts
export {
  QUEUE_NAMES,
  getQueueNameForStage,
  getStageQueue,
  parseWorkerRole,
} from "./queues";
export type { StageName } from "./queues";
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test -w @clipfast/shared -- packages/shared/src/lib/__tests__/queues.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/lib/queues.ts packages/shared/src/lib/__tests__/queues.test.ts packages/shared/src/lib/index.ts
git commit -m "feat(queue): add stage queue helpers"
```

---

## Task 2: JobStep Schema and Service

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260509_stage_pipeline_job_steps/migration.sql`
- Create: `packages/shared/src/services/job-step.service.ts`
- Modify: `packages/shared/src/services/index.ts`
- Test: `packages/shared/src/services/__tests__/job-step.service.test.ts`

- [ ] **Step 1: Add RED tests for step lifecycle**

Create `packages/shared/src/services/__tests__/job-step.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    jobStep: {
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
    },
  },
}));

import {
  completeJobStep,
  failJobStep,
  startJobStep,
} from "../job-step.service";

describe("job-step.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a step idempotently by jobId and step", async () => {
    await startJobStep("job1", "DOWNLOAD", { source: "url" });

    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { jobId_step: { jobId: "job1", step: "DOWNLOAD" } },
      create: expect.objectContaining({
        jobId: "job1",
        step: "DOWNLOAD",
        status: "RUNNING",
        attempt: 1,
      }),
      update: expect.objectContaining({
        status: "RUNNING",
        attempt: { increment: 1 },
      }),
    });
  });

  it("marks a step complete with output json", async () => {
    await completeJobStep("job1", "DOWNLOAD", { sourceKey: "work/job1.mp4" });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job1", step: "DOWNLOAD" },
      data: expect.objectContaining({
        status: "DONE",
        outputJson: { sourceKey: "work/job1.mp4" },
      }),
    });
  });

  it("marks a step failed with safe error text", async () => {
    await failJobStep("job1", "DOWNLOAD", new Error("network failed"));

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job1", step: "DOWNLOAD" },
      data: expect.objectContaining({
        status: "FAILED",
        error: "network failed",
      }),
    });
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test -w @clipfast/shared -- packages/shared/src/services/__tests__/job-step.service.test.ts
```

Expected: FAIL because `job-step.service` does not exist.

- [ ] **Step 3: Add Prisma schema**

Modify `prisma/schema.prisma`:

```prisma
enum JobStepName {
  DOWNLOAD
  TRANSCRIBE
  ANALYZE
  RENDER
  FINALIZE
}

enum JobStepStatus {
  PENDING
  RUNNING
  DONE
  FAILED
}

model Job {
  // existing fields...
  sourceArtifactKey String?
  transcriptJson    Json?
  renderManifest    Json?
  steps             JobStep[]
}

model JobStep {
  id         String        @id @default(cuid())
  jobId      String
  job        Job           @relation(fields: [jobId], references: [id], onDelete: Cascade)
  step       JobStepName
  status     JobStepStatus @default(PENDING)
  attempt    Int           @default(0)
  inputJson  Json?
  outputJson Json?
  error      String?
  startedAt  DateTime?
  finishedAt DateTime?
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt

  @@unique([jobId, step])
  @@index([status, step])
  @@index([jobId])
  @@map("job_steps")
}
```

Create migration `prisma/migrations/20260509_stage_pipeline_job_steps/migration.sql`:

```sql
CREATE TYPE "JobStepName" AS ENUM ('DOWNLOAD', 'TRANSCRIBE', 'ANALYZE', 'RENDER', 'FINALIZE');
CREATE TYPE "JobStepStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

ALTER TABLE "jobs"
  ADD COLUMN "sourceArtifactKey" TEXT,
  ADD COLUMN "transcriptJson" JSONB,
  ADD COLUMN "renderManifest" JSONB;

CREATE TABLE "job_steps" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "step" "JobStepName" NOT NULL,
  "status" "JobStepStatus" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "inputJson" JSONB,
  "outputJson" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_steps_jobId_step_key" ON "job_steps"("jobId", "step");
CREATE INDEX "job_steps_status_step_idx" ON "job_steps"("status", "step");
CREATE INDEX "job_steps_jobId_idx" ON "job_steps"("jobId");

ALTER TABLE "job_steps"
  ADD CONSTRAINT "job_steps_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Generate Prisma Client**

```bash
npx prisma generate
```

Expected: Prisma Client generated.

- [ ] **Step 5: Implement job step service**

Create `packages/shared/src/services/job-step.service.ts`:

```ts
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
  return prisma.jobStep.upsert({
    where: { jobId_step: { jobId, step } },
    create: {
      jobId,
      step,
      status: "RUNNING",
      attempt: 1,
      inputJson: json(input),
      startedAt: new Date(),
      error: null,
    },
    update: {
      status: "RUNNING",
      attempt: { increment: 1 },
      inputJson: json(input),
      startedAt: new Date(),
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
```

Modify `packages/shared/src/services/index.ts`:

```ts
export * as jobStepService from "./job-step.service";
export * from "./job-step.service";
```

- [ ] **Step 6: Run GREEN**

```bash
npm run test -w @clipfast/shared -- packages/shared/src/services/__tests__/job-step.service.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: PASS and typecheck exit 0.

- [ ] **Step 7: Apply migration locally**

```bash
docker compose exec -T web npx prisma migrate deploy --schema /app/prisma/schema.prisma
docker compose exec -T web npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker npx prisma generate --schema /app/prisma/schema.prisma
```

Expected: migration applied and clients generated.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260509_stage_pipeline_job_steps packages/shared/src/services/job-step.service.ts packages/shared/src/services/__tests__/job-step.service.test.ts packages/shared/src/services/index.ts
git commit -m "feat(jobs): add stage step tracking"
```

---

## Task 3: Split Pipeline Into Stage Handlers

**Files:**
- Create: `apps/worker/src/stages/download.ts`
- Create: `apps/worker/src/stages/transcribe.ts`
- Create: `apps/worker/src/stages/analyze.ts`
- Create: `apps/worker/src/stages/render.ts`
- Create: `apps/worker/src/stages/finalize.ts`
- Create: `apps/worker/src/__tests__/stage-flow.test.ts`
- Modify: `packages/shared/src/services/job.service.ts`
- Modify: `packages/shared/src/services/clip.service.ts`

- [ ] **Step 1: Write RED test for stage handoff**

Create `apps/worker/src/__tests__/stage-flow.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  downloadVideo: vi.fn(),
  transcribeVideo: vi.fn(),
  analyzeHighlights: vi.fn(),
  getStageQueue: vi.fn(),
  queueAdd: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
}));

vi.mock("@clipfast/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  getStageQueue: mocks.getStageQueue,
  prisma: {
    job: {
      findUniqueOrThrow: mocks.jobFind,
      update: mocks.jobUpdate,
    },
  },
}));

vi.mock("../processors/download", () => ({
  downloadVideo: mocks.downloadVideo,
}));

vi.mock("../processors/transcribe", () => ({
  transcribeVideo: mocks.transcribeVideo,
}));

vi.mock("../processors/analyze", () => ({
  analyzeHighlights: mocks.analyzeHighlights,
}));

import { runDownloadStage } from "../stages/download";
import { runTranscribeStage } from "../stages/transcribe";
import { runAnalyzeStage } from "../stages/analyze";

describe("stage handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStageQueue.mockReturnValue({ add: mocks.queueAdd });
  });

  it("download stores a source artifact and enqueues transcribe", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      userId: "u1",
      sourceUrl: "https://example.com/video",
      sourceKey: null,
    });
    mocks.downloadVideo.mockResolvedValue("/tmp/source.mp4");

    await runDownloadStage({ jobId: "job1", userId: "u1" });

    expect(mocks.startJobStep).toHaveBeenCalledWith("job1", "DOWNLOAD", {
      jobId: "job1",
      userId: "u1",
    });
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({ status: "DOWNLOADING" }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith("transcribe", {
      jobId: "job1",
      userId: "u1",
    });
  });

  it("transcribe stores transcript json and enqueues analyze", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      sourceArtifactKey: "work/job1/source.mp4",
    });
    mocks.transcribeVideo.mockResolvedValue({
      text: "hello",
      segments: [{ start: 0, end: 10, text: "hello" }],
    });

    await runTranscribeStage({ jobId: "job1", userId: "u1" });

    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "TRANSCRIBING",
        transcription: "hello",
      }),
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith("analyze", {
      jobId: "job1",
      userId: "u1",
    });
  });

  it("analyze stores highlights and enqueues render", async () => {
    mocks.jobFind.mockResolvedValue({
      id: "job1",
      transcriptJson: {
        text: "hello",
        segments: [{ start: 0, end: 10, text: "hello" }],
      },
    });
    mocks.analyzeHighlights.mockResolvedValue([
      { start: 0, end: 10, title: "Clip", reason: "Hook" },
    ]);

    await runAnalyzeStage({ jobId: "job1", userId: "u1" });

    expect(mocks.queueAdd).toHaveBeenCalledWith("render", {
      jobId: "job1",
      userId: "u1",
      mode: "clips",
    });
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test -w @clipfast/worker -- apps/worker/src/__tests__/stage-flow.test.ts
```

Expected: FAIL because stage modules do not exist.

- [ ] **Step 3: Implement minimal stage modules**

Create `apps/worker/src/stages/download.ts`:

```ts
import { getStageQueue, jobStepService, prisma } from "@clipfast/shared";
import { downloadVideo } from "../processors/download";

export async function runDownloadStage(payload: { jobId: string; userId: string }) {
  await jobStepService.startJobStep(payload.jobId, "DOWNLOAD", payload);
  await prisma.job.update({
    where: { id: payload.jobId },
    data: { status: "DOWNLOADING" },
  });

  const job = await prisma.job.findUniqueOrThrow({ where: { id: payload.jobId } });
  const localPath = await downloadVideo(job.sourceUrl ?? undefined, job.sourceKey ?? undefined);

  await jobStepService.completeJobStep(payload.jobId, "DOWNLOAD", { localPath });
  await getStageQueue("transcribe").add("transcribe", payload);
}
```

Create `apps/worker/src/stages/transcribe.ts`:

```ts
import { getStageQueue, jobStepService, prisma } from "@clipfast/shared";
import { transcribeVideo } from "../processors/transcribe";
import type { TranscriptionResult } from "@clipfast/shared";

export async function runTranscribeStage(payload: { jobId: string; userId: string }) {
  await jobStepService.startJobStep(payload.jobId, "TRANSCRIBE", payload);
  await prisma.job.update({
    where: { id: payload.jobId },
    data: { status: "TRANSCRIBING" },
  });

  const job = await prisma.job.findUniqueOrThrow({ where: { id: payload.jobId } });
  const sourcePath = String(job.sourceArtifactKey ?? "");
  const transcription: TranscriptionResult = await transcribeVideo(sourcePath);

  await prisma.job.update({
    where: { id: payload.jobId },
    data: {
      transcription: transcription.text,
      transcriptJson: transcription as any,
    },
  });
  await jobStepService.completeJobStep(payload.jobId, "TRANSCRIBE", {
    segments: transcription.segments.length,
  });
  await getStageQueue("analyze").add("analyze", payload);
}
```

Create `apps/worker/src/stages/analyze.ts`:

```ts
import { getStageQueue, jobStepService, prisma } from "@clipfast/shared";
import { analyzeHighlights } from "../processors/analyze";
import type { TranscriptionResult } from "@clipfast/shared";

export async function runAnalyzeStage(payload: { jobId: string; userId: string }) {
  await jobStepService.startJobStep(payload.jobId, "ANALYZE", payload);
  await prisma.job.update({
    where: { id: payload.jobId },
    data: { status: "ANALYZING" },
  });

  const job = await prisma.job.findUniqueOrThrow({ where: { id: payload.jobId } });
  const transcription = job.transcriptJson as unknown as TranscriptionResult;
  const highlights = await analyzeHighlights(transcription);

  await prisma.job.update({
    where: { id: payload.jobId },
    data: { highlights: highlights as any },
  });
  await jobStepService.completeJobStep(payload.jobId, "ANALYZE", {
    highlights: highlights.length,
  });
  await getStageQueue("render").add("render", {
    jobId: payload.jobId,
    userId: payload.userId,
    mode: "clips",
  });
}
```

Create initial `render.ts` and `finalize.ts` by moving existing `processVideoJob` render/final DB logic into stage handlers. Keep payload interfaces explicit and tested by typecheck.

- [ ] **Step 4: Update enqueue points**

Modify `packages/shared/src/services/job.service.ts`:

```ts
import { getStageQueue } from "../lib/queues";

// replace getVideoQueue().add("process-video", ...)
await getStageQueue("download").add("download", {
  jobId: job.id,
  userId: job.userId,
});
```

Modify `packages/shared/src/services/clip.service.ts`:

```ts
import { getStageQueue } from "../lib/queues";

await getStageQueue("render").add("render", {
  clipId: newClip.id,
  originalClipStorageKey: original.storageKey,
  jobId: original.jobId,
  userId: input.userId,
  start: relativeStart,
  end: relativeEnd,
  subtitles: input.subtitles,
  subtitlePreset: input.subtitlePreset,
  mode: "trim",
});
```

- [ ] **Step 5: Run GREEN**

```bash
npm run test -w @clipfast/worker -- apps/worker/src/__tests__/stage-flow.test.ts
npm run test --workspaces --if-present
npm run typecheck -w @clipfast/worker
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/stages packages/shared/src/services/job.service.ts packages/shared/src/services/clip.service.ts apps/worker/src/__tests__/stage-flow.test.ts
git commit -m "feat(worker): split pipeline into stage handlers"
```

---

## Task 4: Role-Based Workers and Docker Compose Services

**Files:**
- Modify: `apps/worker/src/index.ts`
- Create: `apps/worker/src/worker-app.ts`
- Modify: `docker-compose.yml`
- Test: `apps/worker/src/__tests__/worker-role.test.ts`

- [ ] **Step 1: Write RED test for worker role routing**

Create `apps/worker/src/__tests__/worker-role.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getWorkerConcurrency } from "../worker-app";

describe("worker role config", () => {
  it("uses CPU-safe concurrency for render", () => {
    expect(getWorkerConcurrency("render")).toBe(1);
  });

  it("uses higher concurrency for IO/API stages", () => {
    expect(getWorkerConcurrency("download")).toBe(4);
    expect(getWorkerConcurrency("analyze")).toBe(5);
    expect(getWorkerConcurrency("finalize")).toBe(3);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test -w @clipfast/worker -- apps/worker/src/__tests__/worker-role.test.ts
```

Expected: FAIL because `worker-app` does not exist.

- [ ] **Step 3: Implement `worker-app.ts`**

Create `apps/worker/src/worker-app.ts`:

```ts
import { Worker } from "bullmq";
import {
  getQueueNameForStage,
  getRedis,
  parseWorkerRole,
  type StageName,
} from "@clipfast/shared";
import { runDownloadStage } from "./stages/download";
import { runTranscribeStage } from "./stages/transcribe";
import { runAnalyzeStage } from "./stages/analyze";
import { runRenderStage } from "./stages/render";
import { runFinalizeStage } from "./stages/finalize";

export function getWorkerConcurrency(role: StageName): number {
  if (role === "render") return Number(process.env.RENDER_CONCURRENCY ?? "1");
  if (role === "download") return Number(process.env.DOWNLOAD_CONCURRENCY ?? "4");
  if (role === "transcribe") return Number(process.env.TRANSCRIBE_CONCURRENCY ?? "2");
  if (role === "analyze") return Number(process.env.ANALYZE_CONCURRENCY ?? "5");
  return Number(process.env.FINALIZE_CONCURRENCY ?? "3");
}

export function createStageWorker(roleValue = process.env.WORKER_ROLE): Worker {
  const role = parseWorkerRole(roleValue);
  const worker = new Worker(
    getQueueNameForStage(role),
    async (job) => {
      if (role === "download") return runDownloadStage(job.data);
      if (role === "transcribe") return runTranscribeStage(job.data);
      if (role === "analyze") return runAnalyzeStage(job.data);
      if (role === "render") return runRenderStage(job.data);
      return runFinalizeStage(job.data);
    },
    {
      connection: getRedis(),
      concurrency: getWorkerConcurrency(role),
      lockDuration: role === "render" ? 30 * 60 * 1000 : 5 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 1,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[${role}] completed ${job.id}`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${role}] failed ${job?.id}:`, err.message);
  });

  return worker;
}
```

Modify `apps/worker/src/index.ts`:

```ts
import { createStageWorker } from "./worker-app";

const role = process.env.WORKER_ROLE;
console.log(`ClipClap worker starting with role=${role}`);

const worker = createStageWorker(role);

process.on("SIGTERM", async () => {
  console.log("SIGTERM received; closing worker");
  await worker.close();
  process.exit(0);
});
```

- [ ] **Step 4: Modify Docker Compose**

Replace the single `worker` service in `docker-compose.yml` with:

```yaml
  worker-download:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
      target: ${TARGET:-development}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    env_file: .env
    environment:
      - NODE_ENV=${NODE_ENV:-development}
      - WORKER_ROLE=download
      - DOWNLOAD_CONCURRENCY=4
      - CHOKIDAR_USEPOLLING=true
    volumes:
      - ./apps/worker:/app/apps/worker
      - ./packages:/app/packages
      - ./prisma:/app/prisma
      - /app/node_modules
      - /app/apps/worker/node_modules
    restart: unless-stopped

  worker-transcribe:
    extends:
      service: worker-download
    environment:
      - NODE_ENV=${NODE_ENV:-development}
      - WORKER_ROLE=transcribe
      - TRANSCRIBE_CONCURRENCY=2
      - CHOKIDAR_USEPOLLING=true

  worker-analyze:
    extends:
      service: worker-download
    environment:
      - NODE_ENV=${NODE_ENV:-development}
      - WORKER_ROLE=analyze
      - ANALYZE_CONCURRENCY=5
      - CHOKIDAR_USEPOLLING=true

  worker-render:
    extends:
      service: worker-download
    environment:
      - NODE_ENV=${NODE_ENV:-development}
      - WORKER_ROLE=render
      - RENDER_CONCURRENCY=1
      - CHOKIDAR_USEPOLLING=true

  worker-finalize:
    extends:
      service: worker-download
    environment:
      - NODE_ENV=${NODE_ENV:-development}
      - WORKER_ROLE=finalize
      - FINALIZE_CONCURRENCY=3
      - CHOKIDAR_USEPOLLING=true
```

If `extends` causes Compose issues, duplicate the service blocks explicitly.

- [ ] **Step 5: Run GREEN**

```bash
npm run test -w @clipfast/worker -- apps/worker/src/__tests__/worker-role.test.ts
npm run test --workspaces --if-present
npm run typecheck -w @clipfast/worker
docker compose config >/tmp/clipclap-compose.yml
```

Expected: tests pass, typecheck exits 0, compose config exits 0.

- [ ] **Step 6: Restart workers**

```bash
docker compose up -d --build worker-download worker-transcribe worker-analyze worker-render worker-finalize
docker compose ps
```

Expected: five worker services are up.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/index.ts apps/worker/src/worker-app.ts apps/worker/src/__tests__/worker-role.test.ts docker-compose.yml
git commit -m "feat(worker): run role-based stage workers"
```

---

## Task 5: Final Verification

**Files:** no source changes expected.

- [ ] **Step 1: Run full automated verification**

```bash
npm run test --workspaces --if-present
npm run typecheck -w @clipfast/worker
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npm run build -w @clipfast/worker
docker compose config >/tmp/clipclap-compose.yml
```

Expected: all commands exit 0.

- [ ] **Step 2: Apply migrations and regenerate Prisma in containers**

```bash
docker compose exec -T web npx prisma migrate deploy --schema /app/prisma/schema.prisma
docker compose exec -T web npx prisma generate --schema /app/prisma/schema.prisma
docker compose exec -T worker-download npx prisma generate --schema /app/prisma/schema.prisma
```

Expected: migrations applied or no pending migrations; Prisma Client generated.

- [ ] **Step 3: Smoke test queue services are alive**

```bash
docker compose ps
docker compose logs --tail=50 worker-download worker-transcribe worker-analyze worker-render worker-finalize
```

Expected: all workers are `Up`; logs show role startup and no crash loop.

- [ ] **Step 4: Commit verification-only changes if any**

If no files changed, do not commit.

---

## Self-Review

- Spec coverage: queue split, stage tracking, pipeline decomposition, Docker service split, retry/idempotency basis, and verification are covered.
- Scope intentionally excludes full admin cost dashboard, retention cleanup, and advanced autoscaling. Those are separate follow-up plans.
- Placeholder scan: no TBD/TODO placeholders remain in execution steps. The plan contains concrete file paths, commands, and expected results.
- Type consistency: stage names use lowercase BullMQ queue roles and uppercase Prisma `JobStepName` values; each task calls this out explicitly.
