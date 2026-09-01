import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId } from "../feedback-quality/store";
import { deployWithQualityGate, type DeployDependencies, type DeployRequest, type GateDeployDecision, type WorkerService } from "../feedback-quality/deploy";
import { effectiveConfigDigest } from "../feedback-quality/config";

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

describe("feedback quality deployment", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
