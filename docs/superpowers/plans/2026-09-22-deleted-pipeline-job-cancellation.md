# Deleted Pipeline Job Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancel queued work for deleted projects and make every worker stage discard a concurrently deleted project without retrying or raising a false incident.

**Architecture:** A shared BullMQ helper removes matching jobs from all removable stage-queue states after the project row is deleted. A single guard around worker stage dispatch checks whether a failed stage's pipeline row still exists; if it does not, the guard completes the queue item as cancelled and releases the user's next waiting project. Genuine failures keep the existing retry, refund, and incident behavior.

**Tech Stack:** TypeScript, BullMQ 5, Prisma 5, Vitest 3, npm workspaces, Docker/Node 20.

---

## File map

- `packages/shared/src/lib/queues.ts`: own the cross-queue pending-job removal helper beside the stage queue registry.
- `packages/shared/src/lib/index.ts`: expose the new helper through `@clipclap/shared`.
- `packages/shared/src/lib/__tests__/queues.test.ts`: pin queue states, payload filtering, race-safe removal, and best-effort scan behavior.
- `packages/shared/src/services/project.service.ts`: invoke queue cleanup after the hard database delete.
- `packages/shared/src/services/__tests__/project.service.test.ts`: pin deletion ordering and Redis-failure behavior.
- `apps/worker/src/worker-app.ts`: classify a failed stage as cancelled when its pipeline row has disappeared, release the user's slot, and mark the completion result so finalize does not release twice.
- `apps/worker/src/__tests__/worker-role.test.ts`: pin cancellation, genuine failure, failed existence check, no incident/refund, and single slot release.
- `docs/2026-09-22-deleted-pipeline-job-cancellation.md`: record implementation and production verification evidence.

## Test environment

Host Node 18 cannot load this repository's Vitest/Vite ESM combination. Build one isolated Node 20 development image from this worktree, then bind-mount the worktree sources into it for every red/green command:

```bash
cd /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation
docker build --target development -f apps/worker/Dockerfile -t clipclap-cancellation-test .
```

Expected: image `clipclap-cancellation-test:latest` builds successfully. The subsequent commands do not connect to production Postgres or Redis; the focused suites mock both.

### Task 1: Remove pending work from every stage queue

**Files:**
- Modify: `packages/shared/src/lib/__tests__/queues.test.ts`
- Modify: `packages/shared/src/lib/queues.ts`
- Modify: `packages/shared/src/lib/index.ts`

- [ ] **Step 1: Add BullMQ and Redis mocks to the queue-helper test**

Add these declarations before the imports from `../queues`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Queue: vi.fn(),
  getJobs: vi.fn(),
}));

vi.mock("bullmq", () => ({ Queue: mocks.Queue }));
vi.mock("../redis", () => ({ getRedis: () => ({ host: "redis" }) }));
```

Remove the old `vitest` import and extend the queue import with `removeQueuedPipelineJobs`. Add this setup inside `describe("stage queue helpers", ...)`:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  mocks.Queue.mockImplementation((name: string) => ({
    getJobs: (states: string[]) => mocks.getJobs(name, states),
  }));
});
```

- [ ] **Step 2: Write failing tests for matching removal and best-effort failures**

Append these tests to the same `describe` block:

```ts
it("removes only this pipeline job from every removable queue state", async () => {
  const removeMatching = vi.fn(async () => undefined);
  const removeOther = vi.fn(async () => undefined);
  mocks.getJobs.mockImplementation(async (queueName: string, states: string[]) => {
    expect(states).toEqual(["waiting", "delayed", "prioritized", "paused"]);
    return queueName === "video-transcribe"
      ? [
          { id: "373", data: { jobId: "deleted-job" }, remove: removeMatching },
          { id: "374", data: { jobId: "other-job" }, remove: removeOther },
        ]
      : [];
  });

  await expect(removeQueuedPipelineJobs("deleted-job")).resolves.toBe(1);
  expect(removeMatching).toHaveBeenCalledOnce();
  expect(removeOther).not.toHaveBeenCalled();
  expect(mocks.getJobs).toHaveBeenCalledTimes(5);
});

it("continues cleaning other queues when a scan or remove races with a worker", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const removed = vi.fn(async () => undefined);
  mocks.getJobs.mockImplementation(async (queueName: string) => {
    if (queueName === "video-download") throw new Error("redis unavailable");
    if (queueName === "video-transcribe") {
      return [{
        id: "locked",
        data: { jobId: "deleted-job" },
        remove: vi.fn(async () => { throw new Error("locked by worker"); }),
      }];
    }
    if (queueName === "video-analyze") {
      return [{ id: "free", data: { jobId: "deleted-job" }, remove: removed }];
    }
    return [];
  });

  await expect(removeQueuedPipelineJobs("deleted-job")).resolves.toBe(1);
  expect(removed).toHaveBeenCalledOnce();
  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});
```

- [ ] **Step 3: Run the focused queue test and verify red**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/vitest.config.ts:/app/vitest.config.ts:ro \
  -w /app clipclap-cancellation-test \
  npx vitest run --root /app packages/shared/src/lib/__tests__/queues.test.ts
```

Expected: FAIL because `removeQueuedPipelineJobs` is not exported.

- [ ] **Step 4: Implement minimal cross-queue cleanup**

Add to `packages/shared/src/lib/queues.ts` after `getStageQueue`:

```ts
const REMOVABLE_PIPELINE_JOB_STATES = [
  "waiting",
  "delayed",
  "prioritized",
  "paused",
] as const;

export async function removeQueuedPipelineJobs(
  pipelineJobId: string
): Promise<number> {
  const results = await Promise.allSettled(
    STAGES.map(async (stage) => {
      const jobs = await getStageQueue(stage).getJobs([
        ...REMOVABLE_PIPELINE_JOB_STATES,
      ]);
      let removed = 0;

      for (const job of jobs) {
        const data = job.data as { jobId?: unknown } | null;
        if (data?.jobId !== pipelineJobId) continue;
        try {
          await job.remove();
          removed += 1;
        } catch (error) {
          console.error(
            `[queue] could not remove ${stage} item ${job.id} for deleted job ${pipelineJobId}:`,
            error
          );
        }
      }
      return removed;
    })
  );

  return results.reduce((count, result, index) => {
    if (result.status === "fulfilled") return count + result.value;
    console.error(
      `[queue] could not scan ${STAGES[index]} for deleted job ${pipelineJobId}:`,
      result.reason
    );
    return count;
  }, 0);
}
```

Add `removeQueuedPipelineJobs` to the named queue exports in `packages/shared/src/lib/index.ts`.

- [ ] **Step 5: Run the focused queue test and verify green**

Run the Step 3 command again.

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit the queue helper**

```bash
git add packages/shared/src/lib/queues.ts packages/shared/src/lib/index.ts packages/shared/src/lib/__tests__/queues.test.ts
git commit -m "fix(queue): remove work for deleted projects"
```

### Task 2: Attach queue cleanup to project deletion

**Files:**
- Modify: `packages/shared/src/services/__tests__/project.service.test.ts`
- Modify: `packages/shared/src/services/project.service.ts`

- [ ] **Step 1: Mock the cleanup dependency in project-service tests**

Add `removeQueuedPipelineJobs: vi.fn()` to the hoisted `mocks` object and add:

```ts
vi.mock("../../lib/queues", () => ({
  removeQueuedPipelineJobs: mocks.removeQueuedPipelineJobs,
}));
```

In each delete-focused `beforeEach`, default it to:

```ts
mocks.removeQueuedPipelineJobs.mockResolvedValue(0);
```

- [ ] **Step 2: Write failing ordering and fail-open tests**

Add these tests under `describe("deleteProject - R2 keys", ...)` using the same complete job shape as the existing normalized-artifact test:

```ts
it("cleans BullMQ only after the project row is deleted", async () => {
  mocks.jobFindFirst.mockResolvedValue({
    id: "job1", status: "TRANSCRIBING", clipsGenerated: 0,
    sourceKey: null, sourceArtifactKey: null,
    normalizedArtifactKey: null, thumbnailKey: null, clips: [],
  });
  mocks.jobDelete.mockImplementation(async () => {
    mocks.order.push("delete");
    return {};
  });
  mocks.removeQueuedPipelineJobs.mockImplementation(async () => {
    mocks.order.push("queue");
    return 2;
  });

  await deleteProject("job1", "u1");

  expect(mocks.order.slice(-2)).toEqual(["delete", "queue"]);
  expect(mocks.removeQueuedPipelineJobs).toHaveBeenCalledWith("job1");
});

it("finishes deletion when queue cleanup is unavailable", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.jobFindFirst.mockResolvedValue({
    id: "job1", status: "TRANSCRIBING", clipsGenerated: 0,
    sourceKey: null, sourceArtifactKey: null,
    normalizedArtifactKey: null, thumbnailKey: null, clips: [],
  });
  mocks.removeQueuedPipelineJobs.mockRejectedValue(new Error("redis unavailable"));

  await expect(deleteProject("job1", "u1")).resolves.toEqual({
    status: "deleted",
    deletedClips: 0,
  });
  expect(mocks.jobDelete).toHaveBeenCalled();
  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});
```

- [ ] **Step 3: Run the project-service tests and verify red**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/vitest.config.ts:/app/vitest.config.ts:ro \
  -w /app clipclap-cancellation-test \
  npx vitest run --root /app packages/shared/src/services/__tests__/project.service.test.ts
```

Expected: FAIL because `deleteProject` does not call the queue helper.

- [ ] **Step 4: Implement ordered, best-effort cleanup**

Import the helper in `project.service.ts`:

```ts
import { removeQueuedPipelineJobs } from "../lib/queues";
```

Immediately after `prisma.job.delete`, add:

```ts
await removeQueuedPipelineJobs(job.id).catch((error) => {
  console.error(
    `[deleteProject] failed to remove queued work for ${job.id}:`,
    error
  );
});
```

Keep ledger settlement before the delete and R2 cleanup after the queue cleanup.

- [ ] **Step 5: Run project and queue tests and verify green**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/vitest.config.ts:/app/vitest.config.ts:ro \
  -w /app clipclap-cancellation-test \
  npx vitest run --root /app \
  packages/shared/src/lib/__tests__/queues.test.ts \
  packages/shared/src/services/__tests__/project.service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit deletion integration**

```bash
git add packages/shared/src/services/project.service.ts packages/shared/src/services/__tests__/project.service.test.ts
git commit -m "fix(projects): cancel queued stages on delete"
```

### Task 3: Discard active work whose project disappeared

**Files:**
- Modify: `apps/worker/src/__tests__/worker-role.test.ts`
- Modify: `apps/worker/src/worker-app.ts`

- [ ] **Step 1: Extend worker mocks with the Prisma existence lookup**

Add `jobFindUnique: vi.fn()` to the hoisted `mocks` object. Add this to the mocked `@clipclap/shared` module:

```ts
prisma: {
  job: { findUnique: mocks.jobFindUnique },
},
```

Import `DELETED_PIPELINE_JOB_RESULT` and `dispatchStageJob` alongside the existing worker-app imports.

- [ ] **Step 2: Write failing cancellation-boundary tests**

Append:

```ts
it("completes failed work as cancelled when its project was deleted", async () => {
  const stageError = new Error("Record to update not found");
  mocks.transcribe.mockRejectedValueOnce(stageError);
  mocks.jobFindUnique.mockResolvedValueOnce(null);

  await expect(dispatchStageJob("transcribe", {
    jobId: "pipeline-1",
    userId: "user-1",
  })).resolves.toBe(DELETED_PIPELINE_JOB_RESULT);

  expect(mocks.releaseNextQueued).toHaveBeenCalledWith("user-1");
  expect(mocks.refundFailedJob).not.toHaveBeenCalled();
  expect(mocks.notifyPipelineIncident).not.toHaveBeenCalled();
});

it("rethrows the original stage error while the project still exists", async () => {
  const stageError = new Error("transcription provider unavailable");
  mocks.transcribe.mockRejectedValueOnce(stageError);
  mocks.jobFindUnique.mockResolvedValueOnce({ id: "pipeline-1" });

  await expect(dispatchStageJob("transcribe", {
    jobId: "pipeline-1",
    userId: "user-1",
  })).rejects.toBe(stageError);
  expect(mocks.releaseNextQueued).not.toHaveBeenCalled();
});

it("preserves the stage error when deletion cannot be checked", async () => {
  const stageError = new Error("stage failed");
  mocks.render.mockRejectedValueOnce(stageError);
  mocks.jobFindUnique.mockRejectedValueOnce(new Error("database unavailable"));

  await expect(dispatchStageJob("render", {
    jobId: "pipeline-1",
    userId: "user-1",
  })).rejects.toBe(stageError);
});

it("does not release finalize twice after deletion cancellation", async () => {
  mocks.finalize.mockRejectedValueOnce(new Error("missing row"));
  mocks.jobFindUnique.mockResolvedValueOnce(null);
  const worker = createStageWorker("finalize");
  const calls = (worker as unknown as { on: ReturnType<typeof vi.fn> }).on.mock.calls;
  const processor = (Worker as unknown as { mock: { calls: unknown[][] } })
    .mock.calls[0][1] as (job: { data: unknown }) => Promise<unknown>;
  const completed = calls.find((call: unknown[]) => call[0] === "completed")?.[1]
    as (job: unknown, result: unknown) => void;
  const job = { data: { jobId: "pipeline-1", userId: "user-1" } };

  const result = await processor(job);
  completed(job, result);

  expect(result).toBe(DELETED_PIPELINE_JOB_RESULT);
  expect(mocks.releaseNextQueued).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run worker-role tests and verify red**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/vitest.config.ts:/app/vitest.config.ts:ro \
  -w /app clipclap-cancellation-test \
  npx vitest run --root /app apps/worker/src/__tests__/worker-role.test.ts
```

Expected: FAIL because the dispatch result and deletion guard do not exist.

- [ ] **Step 4: Implement one centralized deletion guard**

Add `prisma` to the imports from `@clipclap/shared` and export this marker near the concurrency constants:

```ts
export const DELETED_PIPELINE_JOB_RESULT = "deleted-pipeline-job" as const;
```

Add these helpers before `dispatchStageJob`:

```ts
function pipelinePayload(
  data: unknown
): { jobId: string; userId: string } | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as { jobId?: unknown; userId?: unknown };
  return typeof value.jobId === "string" && typeof value.userId === "string"
    ? { jobId: value.jobId, userId: value.userId }
    : null;
}

async function pipelineJobWasDeleted(jobId: string): Promise<boolean> {
  try {
    return await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true },
    }) === null;
  } catch (error) {
    console.error(`[queue] could not verify failed pipeline job ${jobId}:`, error);
    return false;
  }
}
```

Replace `dispatchStageJob` with an awaited dispatch inside a `try/catch` so asynchronous rejections are caught:

```ts
export async function dispatchStageJob(
  role: StageName,
  data: unknown,
  job?: Job,
  token?: string
): Promise<void | typeof DELETED_PIPELINE_JOB_RESULT> {
  try {
    if (role === "download") await runDownloadStage(data as never, job, token);
    else if (role === "transcribe") await runTranscribeStage(data as never);
    else if (role === "analyze") await runAnalyzeStage(data as never);
    else if (role === "render") await runRenderStage(data as never);
    else await runFinalizeStage(data as never);
  } catch (error) {
    const payload = pipelinePayload(data);
    if (!payload || !(await pipelineJobWasDeleted(payload.jobId))) throw error;

    console.log(`[${role}] discarded deleted pipeline job ${payload.jobId}`);
    try {
      await releaseNextQueued(payload.userId);
    } catch (releaseError) {
      console.error(
        `[queue] could not release after deleting ${payload.jobId}:`,
        releaseError
      );
    }
    return DELETED_PIPELINE_JOB_RESULT;
  }
}
```

Update the completed handler to accept its result and stop before the normal finalize release:

```ts
worker.on("completed", (job, result) => {
  if (result === DELETED_PIPELINE_JOB_RESULT) return;
  console.log(`[${role}] completed ${job.id}`);
  if (!isQualityCanary(job.data)) void maybeReleaseAfterStageEvent(role, "completed", job);
});
```

- [ ] **Step 5: Run worker-role tests and verify green**

Run the Step 3 command again.

Expected: PASS, 17 tests.

- [ ] **Step 6: Commit the worker guard**

```bash
git add apps/worker/src/worker-app.ts apps/worker/src/__tests__/worker-role.test.ts
git commit -m "fix(worker): discard deleted pipeline jobs"
```

### Task 4: Verify the complete change and record evidence

**Files:**
- Modify: `docs/2026-09-22-deleted-pipeline-job-cancellation.md`

- [ ] **Step 1: Run all focused regression tests together**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/vitest.config.ts:/app/vitest.config.ts:ro \
  -w /app clipclap-cancellation-test \
  npx vitest run --root /app \
  packages/shared/src/lib/__tests__/queues.test.ts \
  packages/shared/src/services/__tests__/project.service.test.ts \
  apps/worker/src/__tests__/worker-role.test.ts
```

Expected: all files and tests PASS.

- [ ] **Step 2: Run shared and worker type/build checks**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/tsconfig.base.json:/app/tsconfig.base.json:ro \
  -w /app clipclap-cancellation-test \
  sh -lc 'npm run typecheck -w @clipclap/worker && npm run build -w @clipclap/shared && npm run build -w @clipclap/worker'
```

Expected: all commands exit 0 with no TypeScript errors. Run the container as UID/GID `1000:1000` so generated `packages/shared/dist` files remain writable by the repository owner.

- [ ] **Step 3: Run the full shared and worker suites**

Run:

```bash
docker run --rm --user 1000:1000 \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/apps:/app/apps \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/packages:/app/packages \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/prisma:/app/prisma \
  -v /home/trowgar/.config/superpowers/worktrees/clipclap.io/deleted-pipeline-cancellation/vitest.config.ts:/app/vitest.config.ts:ro \
  -w /app clipclap-cancellation-test \
  sh -lc 'npm run test -w @clipclap/shared && npm run test -w @clipclap/worker'
```

Expected: both suites PASS. If an unrelated pre-existing failure appears, capture the exact test and compare it on `main` before treating it as a regression.

- [ ] **Step 4: Record verification results in the design document**

Append a `## Implementation evidence` section containing the final commit IDs, exact focused/full test counts, type/build results, and the statement that no schema or environment change was required.

- [ ] **Step 5: Commit the verification record**

```bash
git add docs/2026-09-22-deleted-pipeline-job-cancellation.md
git commit -m "docs: verify deleted pipeline cancellation"
```

### Task 5: Integrate and deploy on the production host

**Files:**
- No source changes expected.

- [ ] **Step 1: Review the branch delta**

```bash
git status --short
git log --oneline main..HEAD
git diff --check main...HEAD
git diff --stat main...HEAD
```

Expected: clean worktree, this plan commit plus four implementation/evidence commits after the design commit, no whitespace errors, and only the files listed in this plan.

- [ ] **Step 2: Push the feature branch**

```bash
git push -u origin fix/deleted-pipeline-cancellation
```

Expected: remote branch created successfully.

- [ ] **Step 3: Fast-forward main and push it**

From `/srv/dev/clipclap.io`, after verifying it is clean and still points at the plan's base commit:

```bash
git merge --ff-only fix/deleted-pipeline-cancellation
git push origin main
```

Expected: `main`, `origin/main`, and the feature branch point at the same verified commit.

- [ ] **Step 4: Rebuild the shared package and restart consumers**

```bash
docker compose exec -T -w /app worker-transcribe npm run build -w @clipclap/shared
docker compose restart web worker-download worker-transcribe worker-analyze worker-render worker-finalize
```

Expected: shared build exits 0 and all six services restart successfully. No Prisma migration, generated-client refresh, image rebuild, or environment reload is needed.

- [ ] **Step 5: Verify the deployed revision and health**

```bash
git rev-parse HEAD
git rev-parse origin/main
docker compose ps web worker-download worker-transcribe worker-analyze worker-render worker-finalize
docker compose logs --since 3m web worker-download worker-transcribe worker-analyze worker-render worker-finalize
curl -fsS -o /dev/null -w '%{http_code}\n' https://clipclap.io/login
docker compose exec -T worker-transcribe sh -lc "grep -q 'deleted-pipeline-job' /app/apps/worker/src/worker-app.ts"
docker compose exec -T web sh -lc "grep -q 'removeQueuedPipelineJobs' /app/packages/shared/dist/lib/queues.js"
```

Expected: the Git hashes match, services are running, logs contain no startup loop or new Prisma failure, HTTPS returns `200`, and both source/build probes exit 0.

- [ ] **Step 6: Observe the next deletion boundary**

Watch worker logs for the next user-initiated deletion race:

```bash
docker compose logs --since 30m worker-download worker-transcribe worker-analyze worker-render worker-finalize | rg "discarded deleted pipeline job|Pipeline job exhausted retries|Record to update not found"
```

Expected: a raced deletion may log one `discarded deleted pipeline job` line; it must not produce a new exhausted-retries alert or repeated Prisma missing-record attempts.
