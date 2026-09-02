import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId } from "../feedback-quality/store";
import { deployWithQualityGate, type DeployDependencies, type DeployRequest, type GateDeployDecision, type WorkerService } from "../feedback-quality/deploy";
import { effectiveConfigDigest } from "../feedback-quality/config";

const redisHarness = vi.hoisted(() => ({
  clients: [] as Array<{ get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn>; hexists: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
  create: undefined as undefined | (() => { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; eval: ReturnType<typeof vi.fn>; hexists: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }),
}));
const queueHarness = vi.hoisted(() => ({
  queues: [] as Array<Record<string, unknown>>,
  create: undefined as undefined | ((name: string) => Record<string, unknown>),
}));

vi.mock("@clipclap/shared/lib/redis", () => ({
  createQualityRedis: () => {
    if (!redisHarness.create) throw new Error("unexpected quality Redis client");
    const client = redisHarness.create();
    redisHarness.clients.push(client);
    return client;
  },
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(name: string) {
      if (!queueHarness.create) throw new Error(`unexpected quality queue: ${name}`);
      const queue = queueHarness.create(name);
      queueHarness.queues.push(queue);
      return queue;
    }
  },
}));

const hash = (seed: string) => sha256(seed);
const commit = "a".repeat(40);

function decision(overrides: Partial<GateDeployDecision> = {}): GateDeployDecision {
  const body = {
    schemaVersion: 1 as const,
    claim: "non_regression_only" as const,
    policyVersion: "quality-gate-v2",
    candidateCommitSha: commit,
    configSha256: hash("config"),
    corpusSha256: hash("corpus"),
    runnerVersion: 2,
    baselineEvalObservationId: `observation:${hash("be")}`,
    candidateEvalObservationId: `observation:${hash("ce")}`,
    baselineHoldoutObservationId: `observation:${hash("bh")}`,
    candidateHoldoutObservationId: `observation:${hash("ch")}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
    eval: { positiveCount: 4, negativeCount: 6, attemptCount: 1, varianceCaseCount: 0, baseline: { positiveRetention: 1, negativeDefects: 0, zeroClipFalseNegatives: 0, boundaryErrors: 0, focalFailures: 0, subtitleFailures: 0 }, candidate: { positiveRetention: 1, negativeDefects: 0, zeroClipFalseNegatives: 0, boundaryErrors: 0, focalFailures: 0, subtitleFailures: 0 } },
    holdout: { positiveCount: 1, negativeCount: 2, attemptCount: 1, varianceCaseCount: 0, baseline: { positiveRetention: 1, negativeDefects: 0, zeroClipFalseNegatives: 0, boundaryErrors: 0, focalFailures: 0, subtitleFailures: 0 }, candidate: { positiveRetention: 1, negativeDefects: 0, zeroClipFalseNegatives: 0, boundaryErrors: 0, focalFailures: 0, subtitleFailures: 0 } },
    verdict: "pass" as const,
    reasons: [],
    ...overrides,
  } as GateDeployDecision;
  return { ...body, decisionId: contentId("decision", body) };
}

function request(overrides: Partial<DeployRequest> = {}): DeployRequest {
  return { decisionId: decision().decisionId, services: ["worker-analyze", "worker-render"], ...overrides };
}

function rollbackArtifact(services: readonly WorkerService[] = ["worker-analyze", "worker-render"]) {
  const composeFiles = ["rollback.compose.yml"];
  const body = { createdAt: "2026-09-01T12:00:00.000Z", command: ["docker", "compose", "-f", ...composeFiles, "up", "-d", "--force-recreate", "--no-build", ...services], previousCommitSha: "b".repeat(40), previousImageRef: `clipclap-worker@${hash("image")}`, previousImageDigest: hash("image"), composeFiles, composeFilesSha256: hash("compose"), services };
  return { schemaVersion: 1 as const, artifactId: `rollback:${sha256(canonicalJson(body))}`, ...body };
}

function deps(overrides: Partial<DeployDependencies> = {}): DeployDependencies {
  const item = decision();
  return {
    root: "/private/corpus",
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    readDecision: vi.fn(async () => item),
    gitState: vi.fn(async () => ({ head: commit, dirtyTracked: false })),
    configSha256: vi.fn(async () => item.configSha256),
    corpusSha256: vi.fn(async () => item.corpusSha256),
    runnerVersion: vi.fn(async () => item.runnerVersion),
    queueCounts: vi.fn(async () => ({ active: 0, waiting: 0, delayed: 0 })),
    spawn: vi.fn(async () => ({ exitCode: 0 })),
    waitForHealthy: vi.fn(async () => undefined),
    runCanary: vi.fn(async () => undefined),
    prepareRollback: vi.fn(async (services) => rollbackArtifact(services)),
    appendEvent: vi.fn(async () => ({ status: "committed" as const })),
    ...overrides,
  };
}

function never<T>(): Promise<T> { return new Promise<T>(() => undefined); }

async function boundedResult<T>(operation: Promise<T>, milliseconds = 150): Promise<T | "timed_out"> {
  return Promise.race([operation, new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), milliseconds))]);
}

function installQualityRedisHarness(options: { loseOwnership?: boolean; countsHang?: boolean; pauseHangs?: boolean; latePause?: boolean; resumeHangsAfterNewOwner?: boolean; canaryAddHangs?: boolean; canaryAddRejects?: boolean; canaryAppearsAfterFirstRead?: boolean; canaryWaitingAfterAdd?: boolean; queueIsPausedRejectsAfterDisconnect?: boolean; recoveryReplyLostAfterResume?: boolean; resumeAlreadyApplied?: boolean } = {}) {
  let paused = false;
  let fenceToken: string | undefined;
  let pauseOwner: string | undefined;
  let sourceDisconnected = false;
  let resumeScriptCalls = 0;
  let canaryReads = 0;
  const canaryJob = { getState: vi.fn(async () => "waiting"), remove: vi.fn(async () => undefined) };
  const resume = vi.fn(async () => { paused = false; });
  redisHarness.clients = [];
  queueHarness.queues = [];
  redisHarness.create = () => ({
    get: vi.fn(async () => options.loseOwnership ? "other-rollout" : fenceToken ?? null),
    set: vi.fn(async (_key: string, value: string) => { fenceToken = value; return "OK"; }),
    eval: vi.fn((script: string, _keys: number, ...values: string[]) => {
      if (script.includes("quality-fenced-pause")) {
        const token = values.at(-2);
        const apply = () => { if (fenceToken === token) { paused = true; pauseOwner = token; if (options.loseOwnership) fenceToken = "other-rollout"; } };
        if (options.latePause) { setTimeout(apply, 30); return never<number>(); }
        apply();
        return options.pauseHangs ? never<number>() : Promise.resolve(1);
      }
      if (script.includes("quality-fenced-resume")) {
        const token = values.at(-1);
        const apply = () => {
          if (fenceToken !== token) return 0;
          if (pauseOwner !== token) { fenceToken = undefined; return paused ? -1 : 2; }
          paused = false; pauseOwner = undefined; fenceToken = undefined; return 1;
        };
        resumeScriptCalls += 1;
        if (options.recoveryReplyLostAfterResume && resumeScriptCalls === 1) {
          paused = false; pauseOwner = undefined; fenceToken = undefined;
          return Promise.resolve(0);
        }
        if (options.resumeAlreadyApplied && resumeScriptCalls === 1) {
          paused = false; pauseOwner = undefined; fenceToken = undefined;
          return never<number>();
        }
        if (options.resumeHangsAfterNewOwner && resumeScriptCalls === 1) {
          fenceToken = "other-rollout";
          setTimeout(apply, 30);
          return never<number>();
        }
        return Promise.resolve(apply());
      }
      return Promise.resolve(1);
    }),
    hexists: vi.fn(async () => paused ? 1 : 0),
    disconnect: vi.fn(() => { sourceDisconnected = true; }),
  });
  queueHarness.create = (name) => ({
    getJobCounts: vi.fn(() => options.countsHang ? never() : Promise.resolve({ active: 0, waiting: 0, delayed: 0, paused: 0, prioritized: 0, "waiting-children": 0 })),
    isPaused: vi.fn(async () => {
      if (options.queueIsPausedRejectsAfterDisconnect && sourceDisconnected) throw new Error("shared Redis already disconnected");
      return paused;
    }),
    pause: vi.fn(async () => {
      if (options.latePause) { setTimeout(() => { paused = true; }, 30); return never<void>(); }
      paused = true; if (options.pauseHangs) return never<void>();
    }),
    resume: vi.fn(async () => {
      if (options.resumeHangsAfterNewOwner) { setTimeout(() => { paused = false; }, 30); return never<void>(); }
      return resume();
    }),
    add: vi.fn(() => {
      if (name.endsWith("-quality-canary") && options.canaryAddRejects) return Promise.reject(new Error("connection reset"));
      return options.canaryAddHangs && name.endsWith("-quality-canary") ? never() : Promise.resolve({ id: "added" });
    }),
    getJob: vi.fn(() => {
      if (name.endsWith("-quality-canary") && (options.canaryAddHangs || options.canaryAddRejects || options.canaryWaitingAfterAdd)) {
        canaryReads += 1;
        return Promise.resolve(options.canaryAppearsAfterFirstRead && canaryReads === 1 ? undefined : canaryJob);
      }
      return Promise.resolve(undefined);
    }),
    close: vi.fn(async () => undefined),
    name,
    keys: { wait: `bull:${name}:wait`, paused: `bull:${name}:paused`, meta: `bull:${name}:meta`, prioritized: `bull:${name}:prioritized`, events: `bull:${name}:events`, delayed: `bull:${name}:delayed`, marker: `bull:${name}:marker` },
  });
  return { resume, isPaused: () => paused, canaryJob };
}

describe("feedback quality deployment", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("bounds a never-resolving quality lease read and never spawns", async () => {
    installQualityRedisHarness({ countsHang: true });
    const spawn = vi.fn(async () => ({ exitCode: 0 }));
    const d = deps({
      redisOperationTimeoutMs: 10,
      spawn,
      queueCounts: undefined,
      runCanary: undefined,
    });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).not.toBe("timed_out");
    expect(outcome).toMatchObject({ status: "failed", reasons: ["queue_read_failed"] });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("recovers a server-applied pause when the pause reply times out, audits it, and closes quality clients", async () => {
    const harness = installQualityRedisHarness({ pauseHangs: true });
    const spawn = vi.fn(async () => ({ exitCode: 0 }));
    const d = deps({ redisOperationTimeoutMs: 10, spawn, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["queue_read_failed"] });
    expect(harness.isPaused()).toBe(false);
    expect(harness.resume).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(d.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "quality_rollout_failed", phase: "queue", leaseRecovery: "recovered" }), "/private/corpus");
    expect(redisHarness.clients).toHaveLength(2);
    expect(redisHarness.clients.every((client) => client.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("checks the paused meta flag through fresh Redis after disconnecting the shared lease client", async () => {
    const harness = installQualityRedisHarness({ pauseHangs: true, recoveryReplyLostAfterResume: true, queueIsPausedRejectsAfterDisconnect: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["queue_read_failed"] });
    expect(harness.isPaused()).toBe(false);
    expect(redisHarness.clients.at(-1)?.hexists).toHaveBeenCalledWith("bull:video-analyze:meta", "paused");
    expect(d.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "quality_rollout_failed", leaseRecovery: "recovered" }), "/private/corpus");
  });

  it("does not resume a paused queue after recovery finds a different lease owner", async () => {
    const harness = installQualityRedisHarness({ loseOwnership: true, pauseHangs: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["queue_read_failed"] });
    expect(harness.isPaused()).toBe(true);
    expect(harness.resume).not.toHaveBeenCalled();
    expect(d.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "quality_rollout_failed", phase: "queue", leaseRecovery: "ownership_lost" }), "/private/corpus");
  });

  it("invalidates a timed-out pause before a late command can fence the queue", async () => {
    const harness = installQualityRedisHarness({ latePause: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["queue_read_failed"] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.isPaused()).toBe(false);
  });

  it("does not let a late resume unpause a newer lease owner's queue", async () => {
    const harness = installQualityRedisHarness({ resumeHangsAfterNewOwner: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined, waitForHealthy: vi.fn(async () => { throw new Error("health failed"); }) });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["health_failed"] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.isPaused()).toBe(true);
    expect(d.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "quality_rollout_failed", leaseRecovery: "ownership_lost" }), "/private/corpus");
  });

  it("uses a pre-generated canary id and recovers a timed-out add through a fresh client", async () => {
    installQualityRedisHarness({ canaryAddHangs: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["canary_failed"] });
    const queues = queueHarness.queues.filter((queue) => String(queue.name).endsWith("-quality-canary"));
    const add = queues[0].add as ReturnType<typeof vi.fn>;
    const jobId = add.mock.calls[0][2].jobId;
    expect(jobId).toMatch(/^quality-canary-[0-9a-f-]{36}$/);
    expect(queues.slice(1).some((queue) => (queue.getJob as ReturnType<typeof vi.fn>).mock.calls.some(([id]) => id === jobId))).toBe(true);
  });

  it.each(["timeout", "rejection"])("stabilizes an ambiguous canary add after %s and removes a late waiting job", async (kind) => {
    installQualityRedisHarness({ canaryAddHangs: kind === "timeout", canaryAddRejects: kind === "rejection", canaryAppearsAfterFirstRead: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d), 250);
    expect(outcome).toMatchObject({ status: "failed", reasons: ["canary_failed"] });
    const queues = queueHarness.queues.filter((queue) => String(queue.name).endsWith("-quality-canary"));
    expect(queues.slice(1).some((queue) => (queue.getJob as ReturnType<typeof vi.fn>).mock.calls.length >= 2)).toBe(true);
  });

  it("removes a waiting canary after its overall deadline before resuming the queue", async () => {
    const harness = installQualityRedisHarness({ canaryWaitingAfterAdd: true });
    const d = deps({ canaryTimeoutMs: 10, redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d), 250);
    expect(outcome).toMatchObject({ status: "failed", reasons: ["canary_failed"] });
    expect(harness.canaryJob.remove).toHaveBeenCalledTimes(1);
    expect(harness.isPaused()).toBe(false);
  });

  it("audits a lost resume reply as already recovered when fresh state is definitely unpaused", async () => {
    const harness = installQualityRedisHarness({ resumeAlreadyApplied: true });
    const d = deps({ redisOperationTimeoutMs: 10, queueCounts: undefined, runCanary: undefined, waitForHealthy: vi.fn(async () => { throw new Error("health failed"); }) });
    const outcome = await boundedResult(deployWithQualityGate(request({ services: ["worker-analyze"] }), d));
    expect(outcome).toMatchObject({ status: "failed", reasons: ["health_failed"] });
    expect(harness.isPaused()).toBe(false);
    expect(d.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "quality_rollout_failed", leaseRecovery: "recovered" }), "/private/corpus");
  });

  it("recreates explicitly named workers in order with an argv-only docker command", async () => {
    const d = deps();
    const result = await deployWithQualityGate(request(), d);
    expect(result.status).toBe("deployed");
    expect(d.spawn).toHaveBeenNthCalledWith(1, ["docker", "compose", "up", "-d", "--force-recreate", "worker-analyze"]);
    expect(d.spawn).toHaveBeenNthCalledWith(2, ["docker", "compose", "up", "-d", "--force-recreate", "worker-render"]);
    expect(d.queueCounts).toHaveBeenCalledWith("video-analyze");
    expect(d.queueCounts).toHaveBeenCalledWith("video-render");
    expect(d.appendEvent).toHaveBeenCalledTimes(2);
    expect(result.rollbackArtifactId).toContain("rollback:");
    expect(result.rollbackArgv).toEqual(expect.arrayContaining(["docker", "compose", "-f", "rollback.compose.yml", "--no-build"]));
  });

  it("fails before any mutation when no immutable rollback artifact is available", async () => {
    const d = deps({ prepareRollback: vi.fn(async () => { throw new Error("bind-mounted compose has no previous image"); }) });
    const result = await deployWithQualityGate(request(), d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("rollback_unavailable");
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it("rejects a fake rollback artifact, unsafe argv, or mutable previous reference", async () => {
    for (const artifact of [
      { schemaVersion: 1, artifactId: "fake", createdAt: "2026-09-01T12:00:00.000Z", immutable: false, verified: true, command: ["docker", "compose", "up", "-d", "--force-recreate", "worker-analyze"], previousCommitSha: "b".repeat(40) },
      { schemaVersion: 1, artifactId: "fake", createdAt: "2026-09-01T12:00:00.000Z", immutable: true, verified: true, command: ["sh", "-c", "docker compose up -d --force-recreate worker-analyze"], previousCommitSha: "b".repeat(40) },
    ]) {
      const d = deps({ prepareRollback: vi.fn(async () => artifact as never) });
      const result = await deployWithQualityGate(request({ services: ["worker-analyze"] }), d);
      expect(result.status).toBe("failed");
      expect(result.reasons).toContain("rollback_unavailable");
      expect(d.spawn).not.toHaveBeenCalled();
    }
  });

  it("uses the private corpus/config adapters and ignores legacy digest environment variables", async () => {
    const previousConfig = process.env.FEEDBACK_QUALITY_CONFIG_SHA256;
    const previousCorpus = process.env.FEEDBACK_QUALITY_CORPUS_SHA256;
    process.env.FEEDBACK_QUALITY_CONFIG_SHA256 = hash("wrong-config");
    process.env.FEEDBACK_QUALITY_CORPUS_SHA256 = hash("wrong-corpus");
    try {
      const d = deps({
        configSha256: undefined,
        corpusSha256: undefined,
        effectiveConfig: vi.fn(async () => ({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), envAllowlist: [], engine: {} })),
        root: "/private/corpus",
      });
      const result = await deployWithQualityGate(request(), d);
      expect(result.status).toBe("failed");
      expect(result.reasons).toContain("binding_mismatch");
      expect(d.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousConfig === undefined) delete process.env.FEEDBACK_QUALITY_CONFIG_SHA256; else process.env.FEEDBACK_QUALITY_CONFIG_SHA256 = previousConfig;
      if (previousCorpus === undefined) delete process.env.FEEDBACK_QUALITY_CORPUS_SHA256; else process.env.FEEDBACK_QUALITY_CORPUS_SHA256 = previousCorpus;
    }
  });

  it.each([
    ["expired", { expiresAt: "2026-08-31T00:00:00.000Z" }],
    ["wrong HEAD", {}, "b".repeat(40)],
    ["dirty tracked tree", {}, undefined, true],
  ])("fails closed for %s", async (_name, change = {}, head = commit, dirtyTracked = false) => {
    const item = decision(change as Partial<GateDeployDecision>);
    const d = deps({ readDecision: vi.fn(async () => item), gitState: vi.fn(async () => ({ head, dirtyTracked })) });
    const result = await deployWithQualityGate({ decisionId: item.decisionId, services: ["worker-analyze"] }, d);
    expect(result.status).toBe("failed");
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it("rejects unknown, duplicate, and non-canonical service ordering", async () => {
    for (const services of [["web"], ["worker-analyze", "worker-analyze"], ["worker-render", "worker-analyze"]]) {
      const d = deps();
      const result = await deployWithQualityGate(request({ services }), d);
      expect(result.status).toBe("failed");
      expect(result.reasons).toContain("invalid_service");
      expect(d.spawn).not.toHaveBeenCalled();
    }
  });

  it("stops before recreation when the mapped queue has active or waiting jobs", async () => {
    const d = deps({ queueCounts: vi.fn(async (name: string) => name === "video-analyze" ? { active: 1, waiting: 0, delayed: 0 } : { active: 0, waiting: 0, delayed: 0 }) });
    const result = await deployWithQualityGate(request({ services: ["worker-analyze", "worker-render"] }), d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("queue_nonempty");
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it("fences producers with a lease, drains active work, and always resumes after canary", async () => {
    const events: string[] = [];
    let reads = 0;
    const d = deps({
      acquireQueueLease: vi.fn(async () => ({
        drainActive: true,
        pause: vi.fn(async () => { events.push("pause"); }),
        counts: vi.fn(async () => { events.push("counts"); reads += 1; return { active: reads === 1 ? 1 : 0, waiting: 0, delayed: 0 }; }),
        runCanary: vi.fn(async () => { events.push("canary"); }),
        resume: vi.fn(async () => { events.push("resume"); }),
      })),
      spawn: vi.fn(async () => { events.push("spawn"); return { exitCode: 0 }; }),
      waitForHealthy: vi.fn(async () => { events.push("health"); }),
    });
    const result = await deployWithQualityGate(request({ services: ["worker-analyze"] }), d);
    expect(result.status).toBe("deployed");
    expect(events).toEqual(["pause", "counts", "counts", "spawn", "health", "canary", "resume"]);
  });

  it("allows only post-fence paused jobs and keeps them held until resume", async () => {
    let reads = 0;
    const d = deps({
      acquireQueueLease: vi.fn(async () => ({
        drainActive: true,
        allowPostFencePaused: true,
        pause: vi.fn(async () => undefined),
        counts: vi.fn(async () => { reads += 1; return reads === 1 ? { active: 0, waiting: 0, paused: 0 } : { active: 0, waiting: 0, paused: 1 }; }),
        runCanary: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
      })),
    });
    const result = await deployWithQualityGate(request({ services: ["worker-analyze"] }), d);
    expect(result.status).toBe("deployed");
  });

  it("fails closed without spawning when ownership is lost after drain", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }));
    const d = deps({
      spawn,
      acquireQueueLease: vi.fn(async () => ({
        pause: vi.fn(async () => undefined),
        counts: vi.fn(async () => ({ active: 0, waiting: 0 })),
        assertOwnership: vi.fn(async () => { throw new Error("redis unavailable"); }),
        resume: vi.fn(async () => undefined),
      })),
    });
    const result = await deployWithQualityGate(request({ services: ["worker-analyze"] }), d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("queue_read_failed");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resumes a paused queue when recreate or canary fails", async () => {
    const resume = vi.fn(async () => undefined);
    const d = deps({ acquireQueueLease: vi.fn(async () => ({ pause: vi.fn(async () => undefined), counts: vi.fn(async () => ({ active: 0, waiting: 0 })), resume })), runCanary: vi.fn(async () => { throw new Error("mismatch"); }) });
    const result = await deployWithQualityGate(request({ services: ["worker-analyze"] }), d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual(["canary_failed"]);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("records partial rollout and stops on health/canary failure", async () => {
    const d = deps({ waitForHealthy: vi.fn(async (service: string) => { if (service === "worker-render") throw new Error("private health detail"); }) });
    const result = await deployWithQualityGate(request(), d);
    expect(result.status).toBe("failed");
    expect(result.recreatedServices).toEqual(["worker-analyze", "worker-render"]);
    expect(d.spawn).toHaveBeenCalledTimes(2);
    expect(d.runCanary).toHaveBeenCalledTimes(1);
    expect(d.appendEvent).toHaveBeenCalledTimes(2);
    expect((d.appendEvent as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ type: "quality_rollout_failed", phase: "health", recreatedServices: ["worker-analyze", "worker-render"], leaseRecovered: true });
    expect(result.rollbackArgv).toContain("worker-analyze");
    expect(JSON.stringify(result)).not.toContain("private health detail");
  });

  it("stops and reports a canary binding mismatch without continuing to the next worker", async () => {
    const d = deps({ runCanary: vi.fn(async (service: string) => { if (service === "worker-analyze") throw new Error("wrong config"); }) });
    const result = await deployWithQualityGate(request(), d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual(["canary_failed"]);
    expect(result.recreatedServices).toEqual(["worker-analyze"]);
    expect(d.spawn).toHaveBeenCalledTimes(1);
  });

  it("validates request arrays before inspecting service values", async () => {
    const result = await deployWithQualityGate({ decisionId: decision().decisionId, services: "worker-analyze" as unknown as readonly string[] }, deps());
    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("invalid_request");
  });

  it("keeps runtime quality bindings out of ordinary dev compose", async () => {
    const compose = await readFile(join(process.cwd(), "docker-compose.yml"), "utf8");
    for (const service of ["worker-download", "worker-transcribe", "worker-analyze", "worker-render", "worker-finalize"]) {
      const section = compose.match(new RegExp(`\\n  ${service}:[\\s\\S]*?(?=\\n  [A-Za-z])`))?.[0] ?? "";
      expect(section).not.toContain("GIT_SHA=${GIT_SHA:-}");
      expect(section).not.toContain("FEEDBACK_QUALITY_CONFIG_FILE=${FEEDBACK_QUALITY_CONFIG_FILE:-}");
    }
  });

  it("keeps the private feedback corpus out of every Docker build context", async () => {
    const dockerignore = await readFile(join(__dirname, "../../../../.dockerignore"), "utf8");
    const patterns = dockerignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(patterns).toContain("apps/worker/.corpus");
    expect(patterns).not.toContain("./apps/worker/.corpus");
  });

  it("binds every allowlisted environment value, including an explicit missing null", () => {
    const config = { schemaVersion: 1, runnerVersion: 2, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), envAllowlist: ["ENGINE_FLAG", "MISSING_FLAG"], engine: {} };
    const first = effectiveConfigDigest(config, { ENGINE_FLAG: "on" });
    const second = effectiveConfigDigest(config, { ENGINE_FLAG: "off" });
    const missing = effectiveConfigDigest(config, {});
    expect(first).not.toBe(second);
    expect(first).not.toBe(missing);
  });

  it("requires a real private 0600 reason and audits exact override mismatches before deploying", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-deploy-")); roots.push(root);
    const reasonPath = join(root, "reason.txt");
    await writeFile(reasonPath, "incident review approved\n", { mode: 0o600 });
    const item = decision({ createdAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-31T00:00:00.000Z" });
    const events: unknown[] = [];
    const d = deps({ root, readDecision: vi.fn(async () => item), appendEvent: vi.fn(async (event) => { events.push(event); return { status: "committed" as const }; }) });
    const result = await deployWithQualityGate({ decisionId: item.decisionId, services: ["worker-analyze"], overrideReasonFile: reasonPath }, d);
    expect(result.status).toBe("deployed");
    expect(result.overridden).toBe(true);
    expect(events).toHaveLength(3);
    expect((events[0] as Record<string, unknown>).type).toBe("quality_rollout_override");
    expect((events[0] as Record<string, unknown>).decisionId).toBe(item.decisionId);
    expect((events[0] as Record<string, unknown>).reason).toContain("incident review");
    expect((events[1] as Record<string, unknown>).type).toBe("quality_rollback_artifact");
    expect((events[2] as Record<string, unknown>).type).toBe("quality_rollout");
  });

  it("rejects a symlink or non-0600 override reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-deploy-")); roots.push(root);
    const reasonPath = join(root, "reason.txt");
    const other = join(root, "other.txt");
    await writeFile(other, "reason", { mode: 0o600 });
    await import("node:fs/promises").then(({ symlink }) => symlink(other, reasonPath));
    const d = deps({ root });
    const result = await deployWithQualityGate({ decisionId: decision().decisionId, services: ["worker-analyze"], overrideReasonFile: reasonPath }, d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("invalid_override");
    expect(d.spawn).not.toHaveBeenCalled();
  });
});
