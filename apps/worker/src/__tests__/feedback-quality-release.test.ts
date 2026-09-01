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
        expect(bundle.override.toString("utf8")).toContain("source: ./feedback-quality-config.json");
        return { status: "committed" as const };
      }),
      exec: vi.fn(async (argv) => { calls.push([...argv]); return { exitCode: 0, stdout: "" }; }),
    };
    const rollback = await createProductionRollback(["worker-analyze", "worker-render"], { candidateCommitSha: commit }, dependencies);
    expect(rollback.command).toEqual(["docker", "compose", "--project-name", "clipclap", "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build", "worker-analyze", "worker-render"]);
    expect(calls).toEqual([]);
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
