import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { contentId } from "../feedback-quality/store";
import { deployWithQualityGate, type DeployDependencies, type DeployRequest, type GateDeployDecision } from "../feedback-quality/deploy";

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
    runnerVersion: 1,
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
    prepareRollback: vi.fn(async () => ({ schemaVersion: 1 as const, artifactId: `rollback:${hash("artifact")}`, createdAt: "2026-09-01T12:00:00.000Z", immutable: true as const, verified: true as const, command: ["docker", "compose", "up", "-d", "--force-recreate", "worker-analyze", "worker-render"], previousCommitSha: "b".repeat(40) })),
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
    expect(result.rollbackCommand).toContain("docker compose up -d --force-recreate");
  });

  it("fails before any mutation when no immutable rollback artifact is available", async () => {
    const d = deps({ prepareRollback: vi.fn(async () => { throw new Error("bind-mounted compose has no previous image"); }) });
    const result = await deployWithQualityGate(request(), d);
    expect(result.status).toBe("failed");
    expect(result.reasons).toContain("rollback_unavailable");
    expect(d.spawn).not.toHaveBeenCalled();
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
        effectiveConfig: vi.fn(async () => ({ schemaVersion: 1, runnerVersion: 1, promptFingerprint: hash("a"), modelFingerprint: hash("b"), requestFingerprint: hash("c"), envAllowlist: [], engine: {} })),
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

  it("records partial rollout and stops on health/canary failure", async () => {
    const d = deps({ waitForHealthy: vi.fn(async (service: string) => { if (service === "worker-render") throw new Error("private health detail"); }) });
    const result = await deployWithQualityGate(request(), d);
    expect(result.status).toBe("failed");
    expect(result.recreatedServices).toEqual(["worker-analyze", "worker-render"]);
    expect(d.spawn).toHaveBeenCalledTimes(2);
    expect(d.runCanary).toHaveBeenCalledTimes(1);
    expect(d.appendEvent).toHaveBeenCalledTimes(1);
    expect(result.rollbackCommand).toContain("worker-analyze");
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
