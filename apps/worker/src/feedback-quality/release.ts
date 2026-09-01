import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import type { DeployDependencies, GateDeployDecision, RollbackArtifact, WorkerService } from "./deploy";
import { contentId, publishBundle, readBundle, type CommitResult } from "./store";

const execFileAsync = promisify(execFile);
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SERVICES = new Set<WorkerService>(["worker-download", "worker-transcribe", "worker-analyze", "worker-render", "worker-finalize"]);
const EXEC_OPTIONS = { shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 } as const;

export type ImageReference = Readonly<{ repository: string; digest: string }>;
export type ImageInspection = Readonly<{ reference: string; digest: string; revision: string }>;
export type ServiceInspection = Readonly<{ image: string }>;
export type RollbackService = Readonly<{ service: WorkerService; image: string; digest: string; revision: string }>;
export type ProductionRollbackBundle = Readonly<{
  rollback: RollbackArtifact;
  compose: Buffer;
  override: Buffer;
}>;

export type ProductionReleaseDependencies = Readonly<{
  root: string;
  candidateImage: string;
  composeFile: string;
  readCompose: (path: string) => Promise<Buffer>;
  inspectImage: (reference: string) => Promise<ImageInspection>;
  inspectService: (service: WorkerService) => Promise<ServiceInspection>;
  publishRollback: (bundle: ProductionRollbackBundle) => Promise<CommitResult>;
  exec: (argv: readonly string[], options?: Readonly<{ cwd?: string; env?: Readonly<Record<string, string | undefined>> }>) => Promise<Readonly<{ exitCode: number; stdout: string }>>;
}>;

export class ProductionReleaseError extends Error {
  constructor(readonly code: "invalid_image" | "candidate_image_mismatch" | "previous_image_mismatch" | "compose_unavailable" | "rollback_publish_failed" | "rollback_invalid" | "rollback_process_failed" | "rollback_verify_failed") { super(code); this.name = "ProductionReleaseError"; }
}

export function parseImageReference(value: string): ImageReference {
  if (typeof value !== "string" || value.includes("\0") || /[\r\n\s]/.test(value)) throw new ProductionReleaseError("invalid_image");
  const match = /^(?<repository>[a-z0-9][a-z0-9._/:@-]*)@(?<digest>sha256:[0-9a-f]{64})$/.exec(value);
  if (!match?.groups || !HASH.test(match.groups.digest)) throw new ProductionReleaseError("invalid_image");
  return { repository: match.groups.repository, digest: match.groups.digest };
}

function composeOverride(services: readonly RollbackService[]): Buffer {
  const lines = ["services:"];
  for (const item of services) {
    lines.push(`  ${item.service}:`, `    image: ${item.image}`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function rollbackBody(createdAt: string, services: readonly RollbackService[], composeSha256: string, previousCommitSha: string) {
  const command = ["docker", "compose", "-f", "compose.production.yml", "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build", ...services.map((item) => item.service)];
  return { createdAt, command, previousCommitSha, previousImageRef: services[0].image, previousImageDigest: services[0].digest, composeFiles: ["compose.production.yml", "rollback.compose.yml"], composeFilesSha256: composeSha256, services: services.map((item) => item.service), previousImages: services.map((item) => ({ service: item.service, image: item.image, digest: item.digest, revision: item.revision })) };
}

/** Creates the rollback before deployment has touched a service.  Both candidate
 * and all live services are verified by immutable digest and OCI revision. */
export async function createProductionRollback(services: readonly WorkerService[], decision: Pick<GateDeployDecision, "candidateCommitSha">, dependencies: ProductionReleaseDependencies): Promise<RollbackArtifact> {
  const candidate = parseImageReference(dependencies.candidateImage);
  if (!COMMIT.test(decision.candidateCommitSha) || services.length === 0 || services.some((service) => !SERVICES.has(service))) throw new ProductionReleaseError("rollback_invalid");
  const inspectedCandidate = await dependencies.inspectImage(dependencies.candidateImage);
  if (inspectedCandidate.digest !== candidate.digest || inspectedCandidate.revision !== decision.candidateCommitSha) throw new ProductionReleaseError("candidate_image_mismatch");
  let compose: Buffer;
  try { compose = await dependencies.readCompose(dependencies.composeFile); }
  catch { throw new ProductionReleaseError("compose_unavailable"); }
  const old: RollbackService[] = [];
  for (const service of services) {
    const current = await dependencies.inspectService(service);
    const reference = parseImageReference(current.image);
    const inspected = await dependencies.inspectImage(current.image);
    if (inspected.digest !== reference.digest || !COMMIT.test(inspected.revision)) throw new ProductionReleaseError("previous_image_mismatch");
    old.push({ service, image: current.image, digest: reference.digest, revision: inspected.revision });
  }
  const override = composeOverride(old);
  const composeSha256 = sha256(Buffer.concat([compose, override]));
  const createdAt = new Date().toISOString();
  const body = rollbackBody(createdAt, old, composeSha256, old[0].revision);
  const artifact: RollbackArtifact = { schemaVersion: 1, artifactId: contentId("rollback", body), ...body };
  const result = await dependencies.publishRollback({ rollback: artifact, compose, override });
  if (result.status !== "committed" && result.status !== "noop" && result.status !== "committed_durability_uncertain") throw new ProductionReleaseError("rollback_publish_failed");
  return artifact;
}

async function readPrivateCompose(path: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error();
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (final.size !== info.size || final.nlink !== 1) throw new Error();
    return bytes;
  } catch { throw new ProductionReleaseError("compose_unavailable"); }
  finally { await handle?.close().catch(() => undefined); }
}

async function defaultExec(argv: readonly string[], options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string | undefined>> }> = {}): Promise<{ exitCode: number; stdout: string }> {
  try {
    const response = await execFileAsync(argv[0], argv.slice(1), { ...EXEC_OPTIONS, cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env });
    return { exitCode: 0, stdout: String(response.stdout ?? "") };
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    return { exitCode: 1, stdout: output };
  }
}

function parseDockerInspect(output: string, wanted: string): ImageInspection {
  try {
    const item = JSON.parse(output) as Array<{ RepoDigests?: unknown; Config?: { Labels?: Record<string, unknown> } }>;
    const repoDigests = item[0]?.RepoDigests;
    const revision = item[0]?.Config?.Labels?.["org.opencontainers.image.revision"];
    const parsed = parseImageReference(wanted);
    if (!Array.isArray(repoDigests) || !repoDigests.includes(wanted) || typeof revision !== "string" || !COMMIT.test(revision)) throw new Error();
    return { reference: wanted, digest: parsed.digest, revision };
  } catch { throw new ProductionReleaseError("previous_image_mismatch"); }
}

function productionAdapter(candidateImage: string, composeFile: string, root: string): ProductionReleaseDependencies {
  return {
    root, candidateImage, composeFile,
    readCompose: readPrivateCompose,
    inspectImage: async (reference) => {
      const response = await defaultExec(["docker", "image", "inspect", reference]);
      if (response.exitCode !== 0) throw new ProductionReleaseError("previous_image_mismatch");
      return parseDockerInspect(response.stdout, reference);
    },
    inspectService: async (service) => {
      const ids = await defaultExec(["docker", "compose", "-f", composeFile, "ps", "-q", service]);
      const id = ids.stdout.trim();
      if (ids.exitCode !== 0 || !/^[a-f0-9]{12,64}$/.test(id)) throw new ProductionReleaseError("previous_image_mismatch");
      const inspected = await defaultExec(["docker", "inspect", id]);
      if (inspected.exitCode !== 0) throw new ProductionReleaseError("previous_image_mismatch");
      try {
        const item = JSON.parse(inspected.stdout) as Array<{ Config?: { Image?: unknown } }>;
        if (typeof item[0]?.Config?.Image !== "string") throw new Error();
        return { image: item[0].Config.Image };
      } catch { throw new ProductionReleaseError("previous_image_mismatch"); }
    },
    publishRollback: async (bundle) => publishBundle({ kind: "rollback", id: bundle.rollback.artifactId, files: {
      "rollback.json": Buffer.from(`${canonicalJson(bundle.rollback)}\n`),
      "compose.production.yml": bundle.compose,
      "rollback.compose.yml": bundle.override,
    } }, root),
    exec: defaultExec,
  };
}

/** Production-only dependency adapter. It deliberately selects the immutable
 * compose file and adds --no-build; ordinary development compose is never used. */
export function createProductionDeployDependencies(candidateImage: string, composeFile = resolve(process.cwd(), "docker-compose.production.yml"), root: string): Pick<DeployDependencies, "prepareRollback" | "spawnProduction" | "waitForHealthy"> {
  const candidate = parseImageReference(candidateImage);
  const release = productionAdapter(candidateImage, composeFile, root);
  return {
    prepareRollback: (services, decision) => createProductionRollback(services, decision, release),
    spawnProduction: async (_argv, environment) => {
      const services = _argv.slice(5) as WorkerService[];
      const response = await release.exec(["docker", "compose", "-f", composeFile, "up", "-d", "--force-recreate", "--no-build", ...services], { env: { ...environment, CLIPCLAP_WORKER_IMAGE: candidateImage } });
      return { exitCode: response.exitCode };
    },
    waitForHealthy: async (service) => {
      const response = await release.exec(["docker", "compose", "-f", composeFile, "ps", "--format", "json", "--status", "running", service]);
      if (response.exitCode !== 0 || !response.stdout.includes(service)) throw new ProductionReleaseError("rollback_verify_failed");
      const live = await release.inspectService(service);
      const inspected = await release.inspectImage(live.image);
      const expected = await release.inspectImage(candidateImage);
      if (inspected.digest !== candidate.digest || inspected.revision !== expected.revision) throw new ProductionReleaseError("rollback_verify_failed");
    },
  };
}

export function createProductionRollbackDependencies(composeFile = resolve(process.cwd(), "docker-compose.production.yml"), root = process.env.FEEDBACK_QUALITY_ROOT ?? ""): Pick<ProductionReleaseDependencies, "exec" | "inspectService" | "inspectImage"> {
  const adapter = productionAdapter(`local/rollback-placeholder@sha256:${"0".repeat(64)}`, composeFile, root);
  return { exec: adapter.exec, inspectService: adapter.inspectService, inspectImage: adapter.inspectImage };
}

export async function executeRollback(artifactId: string, root: string, dependencies: Pick<ProductionReleaseDependencies, "exec" | "inspectService" | "inspectImage">): Promise<void> {
  let files: ReadonlyMap<string, Uint8Array>;
  try { files = await readBundle("rollback", artifactId, root); } catch { throw new ProductionReleaseError("rollback_invalid"); }
  let rollback: RollbackArtifact & { previousImages?: readonly RollbackService[] };
  try { rollback = JSON.parse(Buffer.from(files.get("rollback.json") ?? []).toString("utf8")); } catch { throw new ProductionReleaseError("rollback_invalid"); }
  if (!rollback || rollback.artifactId !== artifactId || !Array.isArray(rollback.command) || rollback.command.some((part) => typeof part !== "string" || /[\0\r\n]/.test(part)) || !Array.isArray(rollback.previousImages) || rollback.previousImages.length !== rollback.services.length || !files.has("compose.production.yml") || !files.has("rollback.compose.yml")) throw new ProductionReleaseError("rollback_invalid");
  const expectedId = contentId("rollback", (() => { const { schemaVersion: _schema, artifactId: _id, ...body } = rollback; return body; })());
  if (expectedId !== artifactId) throw new ProductionReleaseError("rollback_invalid");
  const argv = rollback.command;
  if (JSON.stringify(argv.slice(0, 10)) !== JSON.stringify(["docker", "compose", "-f", "compose.production.yml", "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build"])) throw new ProductionReleaseError("rollback_invalid");
  const cwd = resolve(root, "rollbacks", artifactId);
  const response = await dependencies.exec(argv, { cwd });
  if (response.exitCode !== 0) throw new ProductionReleaseError("rollback_process_failed");
  for (const expected of rollback.previousImages) {
    if (!SERVICES.has(expected.service) || parseImageReference(expected.image).digest !== expected.digest) throw new ProductionReleaseError("rollback_invalid");
    const live = await dependencies.inspectService(expected.service);
    if (live.image !== expected.image) throw new ProductionReleaseError("rollback_verify_failed");
    const inspected = await dependencies.inspectImage(live.image);
    if (inspected.digest !== expected.digest || inspected.revision !== expected.revision) throw new ProductionReleaseError("rollback_verify_failed");
  }
}
