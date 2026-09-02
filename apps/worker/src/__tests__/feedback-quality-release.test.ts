import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import {
  createProductionRollback,
  executeRollback,
  parseImageReference,
  type ProductionReleaseDependencies,
} from "../feedback-quality/release";
import { contentId, publishBundle } from "../feedback-quality/store";

const digest = (seed: string) => sha256(seed);
const commit = "a".repeat(40);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("immutable production release adapter", () => {
  it.each(["CLIPCLAP_OCI_REVISION", "GIT_SHA", "FEEDBACK_QUALITY_CONFIG_FILE", "WORKER_ROLE", "NODE_ENV", "COMPOSE_PROJECT_NAME"])("rejects reserved production.env key %s before creating a candidate", async (key) => {
    const candidate = `registry.example/clipclap-worker@${digest("candidate")}`;
    await expect(createProductionRollback(["worker-analyze"], { candidateCommitSha: commit }, {
      root: "/private/corpus", candidateImage: candidate, composeFile: "docker-compose.production.yml", environment: Buffer.from(`${key}=override\n`), config: Buffer.from("{}"),
      readCompose: async () => Buffer.from("services: {}\n"),
      inspectImage: async (reference) => ({ reference, digest: parseImageReference(reference).digest, revision: commit }),
      inspectService: async () => ({ image: candidate }),
      publishRollback: async () => ({ status: "committed" as const }),
      exec: async () => ({ exitCode: 0, stdout: "" }),
    })).rejects.toThrow("compose_unavailable");
  });

  it("requires a digest-pinned candidate with the decision OCI revision", () => {
    expect(parseImageReference(`registry.example/clipclap-worker@${digest("candidate")}`)).toEqual({
      repository: "registry.example/clipclap-worker", digest: digest("candidate"),
    });
    expect(() => parseImageReference("registry.example/clipclap-worker:latest")).toThrow("invalid_image");
  });

  it("snapshots every old service before mutation and creates literal no-build rollback argv", async () => {
    const calls: string[][] = [];
    const old = `registry.example/clipclap-worker@${digest("old")}`;
    const candidate = `registry.example/clipclap-worker@${digest("candidate")}`;
    const dependencies: ProductionReleaseDependencies = {
      root: "/private/corpus",
      candidateImage: candidate,
      composeFile: "docker-compose.production.yml",
      readCompose: vi.fn(async () => Buffer.from("services:\n  worker-analyze: {}\n")),
      inspectImage: vi.fn(async (ref) => ({ reference: ref, digest: parseImageReference(ref).digest, revision: ref === candidate ? commit : "b".repeat(40) })),
      inspectService: vi.fn(async () => ({ image: old })),
      publishRollback: vi.fn(async (bundle: import("../feedback-quality/release").ProductionRollbackBundle) => {
        expect(bundle.rollback.command).toEqual(["docker", "compose", "--project-name", "clipclap", "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build", "worker-analyze", "worker-render"]);
        expect(bundle.rollback.previousImages?.map((item) => item.image)).toEqual([old, old]);
        expect(bundle.override.toString("utf8")).toContain("env_file: ./production.env");
        expect(bundle.override.toString("utf8")).toContain("NODE_ENV: production");
        expect(bundle.candidate?.toString("utf8")).toContain("NODE_ENV: production");
        expect(bundle.override.toString("utf8")).toContain("source: ./feedback-quality-config.json");
        return { status: "committed" as const };
      }),
      exec: vi.fn(async (argv) => { calls.push([...argv]); return { exitCode: 0, stdout: "" }; }),
    };
    const rollback = await createProductionRollback(["worker-analyze", "worker-render"], { candidateCommitSha: commit }, dependencies);
    expect(rollback.command).toEqual(["docker", "compose", "--project-name", "clipclap", "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build", "worker-analyze", "worker-render"]);
    expect(calls).toEqual([]);
  });

  it.each(["TOKEN=$SECRET", "TOKEN=${SECRET}", "TOKEN=\"quoted\"", "TOKEN=slash\\value", " TOKEN=value", "export TOKEN=value", "TOKEN=value # comment"])("rejects Compose-interpreted production.env syntax %s", async (line) => {
    const candidate = `registry.example/clipclap-worker@${digest("candidate")}`;
    await expect(createProductionRollback(["worker-analyze"], { candidateCommitSha: commit }, {
      root: "/private/corpus", candidateImage: candidate, composeFile: "docker-compose.production.yml", environment: Buffer.from(`${line}\n`), config: Buffer.from("{}"),
      readCompose: async () => Buffer.from("services: {}\n"),
      inspectImage: async (reference) => ({ reference, digest: parseImageReference(reference).digest, revision: commit }),
      inspectService: async () => ({ image: candidate }),
      publishRollback: async () => ({ status: "committed" as const }),
      exec: async () => ({ exitCode: 0, stdout: "" }),
    })).rejects.toThrow("compose_unavailable");
  });

  it("binds literal production.env bytes without reading an ambient value", async () => {
    const candidate = `registry.example/clipclap-worker@${digest("candidate")}`;
    const old = `registry.example/clipclap-worker@${digest("old")}`;
    const environment = Buffer.from("ENGINE_FLAG=literal-value\n");
    const previous = process.env.ENGINE_FLAG;
    process.env.ENGINE_FLAG = "ambient-value";
    try {
      await createProductionRollback(["worker-analyze"], { candidateCommitSha: commit }, {
        root: "/private/corpus", candidateImage: candidate, composeFile: "docker-compose.production.yml", environment, config: Buffer.from("{}"),
        readCompose: async () => Buffer.from("services: {}\n"),
        inspectImage: async (reference) => ({ reference, digest: parseImageReference(reference).digest, revision: reference === candidate ? commit : "b".repeat(40) }),
        inspectService: async () => ({ image: old }),
        publishRollback: async (bundle) => {
          expect(bundle.environment).toEqual(environment);
          expect(bundle.rollback.snapshotHashes?.["production.env"]).toBe(sha256(environment));
          expect(bundle.candidate?.toString("utf8")).not.toContain("ambient-value");
          return { status: "committed" as const };
        },
        exec: async () => ({ exitCode: 0, stdout: "" }),
      });
    } finally {
      if (previous === undefined) delete process.env.ENGINE_FLAG;
      else process.env.ENGINE_FLAG = previous;
    }
  });

  it("refuses a mismatched candidate OCI revision before reading current services", async () => {
    const candidate = `registry.example/clipclap-worker@${digest("candidate")}`;
    const inspectService = vi.fn();
    await expect(createProductionRollback(["worker-analyze"], { candidateCommitSha: commit }, {
      root: "/private/corpus", candidateImage: candidate, composeFile: "docker-compose.production.yml",
      readCompose: async () => Buffer.from("services: {}"),
      inspectImage: async (ref) => ({ reference: ref, digest: parseImageReference(ref).digest, revision: "b".repeat(40) }),
      inspectService,
      publishRollback: async () => ({ status: "committed" as const }),
      exec: async () => ({ exitCode: 0, stdout: "" }),
    })).rejects.toThrow("candidate_image_mismatch");
    expect(inspectService).not.toHaveBeenCalled();
  });

  it("binds rollback content to snapshots rather than a mutable tag", () => {
    const body = { composeSha256: digest("compose"), services: [{ service: "worker-analyze", image: `repo@${digest("old")}`, revision: "b".repeat(40) }] };
    expect(sha256(canonicalJson(body))).toMatch(/^sha256:/);
  });

  it("executes a validated standalone rollback bundle with no ambient project", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-release-")); roots.push(root);
    const old = `registry.example/clipclap-worker@${digest("old")}`;
    const candidate = `registry.example/clipclap-worker@${digest("candidate")}`;
    const env = Buffer.from("ENGINE_FLAG=on\n");
    const config = Buffer.from(JSON.stringify({ schemaVersion: 1, runnerVersion: 2, promptFingerprint: digest("p"), modelFingerprint: digest("m"), requestFingerprint: digest("r"), envAllowlist: ["ENGINE_FLAG"], engine: {} }));
    const published = await createProductionRollback(["worker-analyze"], { candidateCommitSha: commit }, {
      root, candidateImage: candidate, composeFile: "docker-compose.production.yml", projectName: "clipclap", network: "clipclap_default", environment: env, config,
      readCompose: async () => Buffer.from("services: {}\n"),
      inspectImage: async (reference) => ({ reference, digest: parseImageReference(reference).digest, revision: reference === candidate ? commit : "b".repeat(40) }),
      inspectService: async () => ({ image: old }),
      publishRollback: async (bundle) => publishBundle({ kind: "rollback", id: bundle.rollback.artifactId, files: { "rollback.json": Buffer.from(JSON.stringify(bundle.rollback)), "compose.production.yml": bundle.compose, "rollback.compose.yml": bundle.override, "candidate.compose.yml": bundle.candidate!, "production.env": bundle.environment!, "feedback-quality-config.json": bundle.config! } }, root),
      exec: async () => ({ exitCode: 0, stdout: "" }),
    });
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
    await executeRollback(published.artifactId, root, { exec, inspectService: async () => ({ image: old }), inspectImage: async (reference) => ({ reference, digest: parseImageReference(reference).digest, revision: "b".repeat(40) }) });
    expect(exec).toHaveBeenCalledWith(published.command, expect.objectContaining({ cwd: expect.stringContaining(published.artifactId), env: {} }));
  });

  it("rejects a tampered rollback argv before process execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-release-")); roots.push(root);
    const body = { createdAt: "2026-09-01T00:00:00.000Z", command: ["sh", "-c", "unsafe"], previousCommitSha: "b".repeat(40), previousImageRef: `repo@${digest("old")}`, previousImageDigest: digest("old"), composeFiles: ["compose.production.yml", "rollback.compose.yml"], composeFilesSha256: digest("compose"), services: ["worker-analyze"] as const, previousImages: [{ service: "worker-analyze" as const, image: `repo@${digest("old")}`, digest: digest("old"), revision: "b".repeat(40) }] };
    const artifactId = contentId("rollback", body);
    await publishBundle({ kind: "rollback", id: artifactId, files: { "rollback.json": Buffer.from(JSON.stringify({ schemaVersion: 1, artifactId, ...body })), "compose.production.yml": Buffer.from("services: {}\n"), "rollback.compose.yml": Buffer.from("services: {}\n") } }, root);
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
    await expect(executeRollback(artifactId, root, { exec, inspectService: vi.fn(), inspectImage: vi.fn() })).rejects.toThrow("rollback_invalid");
    expect(exec).not.toHaveBeenCalled();
  });
});
