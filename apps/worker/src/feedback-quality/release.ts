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
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const NETWORK = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const SERVICES = new Set<WorkerService>(["worker-download", "worker-transcribe", "worker-analyze", "worker-render", "worker-finalize"]);
const EXEC_OPTIONS = { shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 } as const;

export type ImageReference = Readonly<{ repository: string; digest: string }>;
export type ImageInspection = Readonly<{ reference: string; digest: string; revision: string }>;
export type ServiceInspection = Readonly<{ image: string; healthy?: boolean }>;
export type RollbackService = Readonly<{ service: WorkerService; image: string; digest: string; revision: string }>;
export type ProductionRollbackBundle = Readonly<{
  rollback: RollbackArtifact;
  compose: Buffer;
  override: Buffer;
  candidate?: Buffer;
  environment?: Buffer;
  config?: Buffer;
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
  projectName?: string;
  network?: string;
  environment?: Buffer;
  config?: Buffer;
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

function composeOverride(services: readonly RollbackService[], network = "clipclap_default"): Buffer {
  const lines = ["services:"];
  for (const item of services) {
    lines.push(`  ${item.service}:`, `    image: ${item.image}`, "    env_file: ./production.env", "    environment:", `      WORKER_ROLE: ${item.service.slice("worker-".length)}`, "      FEEDBACK_QUALITY_CONFIG_FILE: /run/clipclap/feedback-quality-config.json", "    volumes:", "      - type: bind", "        source: ./feedback-quality-config.json", "        target: /run/clipclap/feedback-quality-config.json", "        read_only: true", "    networks:", "      default: null");
  }
  lines.push("networks:", "  default:", "    external: true", `    name: ${network}`);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function rollbackBody(createdAt: string, services: readonly RollbackService[], composeSha256: string, projectName: string, network: string, candidateImage: string) {
  const command = ["docker", "compose", "--project-name", projectName, "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build", ...services.map((item) => item.service)];
  return { createdAt, command, previousCommitSha: services[0].revision, previousImageRef: services[0].image, previousImageDigest: services[0].digest, composeFiles: ["compose.production.yml", "rollback.compose.yml"], composeFilesSha256: composeSha256, services: services.map((item) => item.service), previousImages: services.map((item) => ({ service: item.service, image: item.image, digest: item.digest, revision: item.revision })), projectName, network, candidateImage };
}

function candidateCompose(services: readonly WorkerService[], image: string, network: string): Buffer {
  const lines = ["services:"];
  for (const service of services) lines.push(`  ${service}:`, `    image: ${image}`, "    env_file: ./production.env", "    environment:", `      WORKER_ROLE: ${service.slice("worker-".length)}`, "      FEEDBACK_QUALITY_CONFIG_FILE: /run/clipclap/feedback-quality-config.json", "      FEEDBACK_QUALITY_ROLLOUT_INSTANCE_ID: ${FEEDBACK_QUALITY_ROLLOUT_INSTANCE_ID:?release adapter only}", "    volumes:", "      - type: bind", "        source: ./feedback-quality-config.json", "        target: /run/clipclap/feedback-quality-config.json", "        read_only: true", "    networks:", "      default: null");
  lines.push("networks:", "  default:", "    external: true", `    name: ${network}`);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** Creates the rollback before deployment has touched a service.  Both candidate
 * and all live services are verified by immutable digest and OCI revision. */
export async function createProductionRollback(services: readonly WorkerService[], decision: Pick<GateDeployDecision, "candidateCommitSha">, dependencies: ProductionReleaseDependencies): Promise<RollbackArtifact> {
  const candidate = parseImageReference(dependencies.candidateImage);
  const projectName = dependencies.projectName ?? "clipclap";
  const network = dependencies.network ?? "clipclap_default";
  if (!COMMIT.test(decision.candidateCommitSha) || !PROJECT.test(projectName) || !NETWORK.test(network) || services.length === 0 || services.some((service, index) => !SERVICES.has(service) || (index > 0 && service <= services[index - 1]))) throw new ProductionReleaseError("rollback_invalid");
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
  if (/\bbuild\s*:|\.\/apps\/|\.\/packages\//.test(compose.toString("utf8"))) throw new ProductionReleaseError("compose_unavailable");
  const override = composeOverride(old, network);
  const composeSha256 = sha256(Buffer.concat([compose, override]));
  const createdAt = new Date().toISOString();
  const body = rollbackBody(createdAt, old, composeSha256, projectName, network, dependencies.candidateImage);
  const artifact: RollbackArtifact = { schemaVersion: 1, artifactId: contentId("rollback", body), ...body };
  const result = await dependencies.publishRollback({ rollback: artifact, compose, override, candidate: candidateCompose(services, dependencies.candidateImage, network), environment: dependencies.environment, config: dependencies.config });
  if (result.status !== "committed" && result.status !== "noop") throw new ProductionReleaseError("rollback_publish_failed");
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

async function readPrivateSnapshot(path: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size === 0 || info.size > 8 * 1024 * 1024) throw new Error();
    const bytes = await handle.readFile(); const final = await handle.stat();
    if (final.size !== info.size || final.nlink !== 1) throw new Error();
    return bytes;
  } catch { throw new ProductionReleaseError("compose_unavailable"); }
  finally { await handle?.close().catch(() => undefined); }
}

function parseEnvironment(bytes: Buffer): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.prototype.hasOwnProperty.call(output, match[1])) throw new ProductionReleaseError("compose_unavailable");
    output[match[1]] = match[2];
  }
  return output;
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

function productionAdapter(candidateImage: string, composeFile: string, root: string, projectName = "clipclap", network = "clipclap_default", environment?: Buffer, config?: Buffer): ProductionReleaseDependencies {
  return {
    root, candidateImage, composeFile, projectName, network, environment, config,
    readCompose: readPrivateCompose,
    inspectImage: async (reference) => {
      const response = await defaultExec(["docker", "image", "inspect", reference]);
      if (response.exitCode !== 0) throw new ProductionReleaseError("previous_image_mismatch");
      return parseDockerInspect(response.stdout, reference);
    },
    inspectService: async (service) => {
      const ids = await defaultExec(["docker", "ps", "--filter", `label=com.docker.compose.project=${projectName}`, "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}"]);
      const id = ids.stdout.trim();
      if (ids.exitCode !== 0 || !/^[a-f0-9]{12,64}$/.test(id)) throw new ProductionReleaseError("previous_image_mismatch");
      const inspected = await defaultExec(["docker", "inspect", id]);
      if (inspected.exitCode !== 0) throw new ProductionReleaseError("previous_image_mismatch");
      try {
        const item = JSON.parse(inspected.stdout) as Array<{ Config?: { Image?: unknown }; State?: { Running?: unknown; Health?: { Status?: unknown } } }>;
        if (typeof item[0]?.Config?.Image !== "string") throw new Error();
        const state = item[0]?.State;
        if (state?.Running !== true || state.Health?.Status === "unhealthy") throw new Error();
        return { image: item[0].Config.Image, healthy: state?.Health?.Status === undefined || state.Health.Status === "healthy" };
      } catch { throw new ProductionReleaseError("previous_image_mismatch"); }
    },
    publishRollback: async (bundle) => publishBundle({ kind: "rollback", id: bundle.rollback.artifactId, files: {
      "rollback.json": Buffer.from(`${canonicalJson(bundle.rollback)}\n`),
      "compose.production.yml": bundle.compose,
      "rollback.compose.yml": bundle.override,
      ...(bundle.candidate && bundle.environment && bundle.config ? { "candidate.compose.yml": bundle.candidate, "production.env": bundle.environment, "feedback-quality-config.json": bundle.config } : {}),
    } }, root),
    exec: defaultExec,
  };
}

/** Production-only dependency adapter. It deliberately selects the immutable
 * compose file and adds --no-build; ordinary development compose is never used. */
export function createProductionDeployDependencies(candidateImage: string, projectName: string, composeFile = resolve(process.cwd(), "docker-compose.production.yml"), root: string, network = process.env.CLIPCLAP_PRODUCTION_NETWORK ?? "clipclap_default", environmentFile = process.env.CLIPCLAP_PRODUCTION_ENV_FILE, configFile = process.env.FEEDBACK_QUALITY_CONFIG_HOST): Pick<DeployDependencies, "prepareRollback" | "spawnProduction" | "waitForHealthy" | "configSha256"> {
  const candidate = parseImageReference(candidateImage);
  if (!PROJECT.test(projectName) || !NETWORK.test(network) || !environmentFile || !configFile) throw new ProductionReleaseError("rollback_invalid");
  let artifact: RollbackArtifact | undefined;
  const snapshots = Promise.all([readPrivateSnapshot(environmentFile), readPrivateSnapshot(configFile)]).then(([environment, config]) => ({ environment, config, parsed: parseEnvironment(environment) }));
  const release = productionAdapter(candidateImage, composeFile, root, projectName, network);
  return {
    configSha256: async () => {
      const snapshot = await snapshots;
      const config = JSON.parse(snapshot.config.toString("utf8"));
      const { effectiveConfigDigest } = await import("./config");
      return effectiveConfigDigest(config, snapshot.parsed);
    },
    prepareRollback: async (services, decision) => {
      const snapshot = await snapshots;
      artifact = await createProductionRollback(services, decision, { ...release, environment: snapshot.environment, config: snapshot.config });
      return artifact;
    },
    spawnProduction: async (_argv, environment) => {
      if (!artifact) throw new ProductionReleaseError("rollback_invalid");
      const services = _argv.slice(5) as WorkerService[];
      const cwd = resolve(root, "rollbacks", artifact.artifactId);
      const response = await release.exec(["docker", "compose", "--project-name", projectName, "-f", "candidate.compose.yml", "up", "-d", "--force-recreate", "--no-build", ...services], { cwd, env: { FEEDBACK_QUALITY_ROLLOUT_INSTANCE_ID: environment.FEEDBACK_QUALITY_ROLLOUT_INSTANCE_ID } });
      return { exitCode: response.exitCode };
    },
    waitForHealthy: async (service) => {
      const live = await release.inspectService(service);
      if (live.healthy === false) throw new ProductionReleaseError("rollback_verify_failed");
      const inspected = await release.inspectImage(live.image);
      const expected = await release.inspectImage(candidateImage);
      if (inspected.digest !== candidate.digest || inspected.revision !== expected.revision) throw new ProductionReleaseError("rollback_verify_failed");
    },
  };
}

export function createProductionRollbackDependencies(composeFile = resolve(process.cwd(), "docker-compose.production.yml"), root = process.env.FEEDBACK_QUALITY_ROOT ?? ""): Pick<ProductionReleaseDependencies, "exec" | "inspectService" | "inspectImage"> {
  const projectName = process.env.CLIPCLAP_PRODUCTION_PROJECT ?? "";
  if (!PROJECT.test(projectName)) throw new ProductionReleaseError("rollback_invalid");
  const adapter = productionAdapter(`local/rollback-placeholder@sha256:${"0".repeat(64)}`, composeFile, root, projectName);
  return { exec: adapter.exec, inspectService: adapter.inspectService, inspectImage: adapter.inspectImage };
}

export async function executeRollback(artifactId: string, root: string, dependencies: Pick<ProductionReleaseDependencies, "exec" | "inspectService" | "inspectImage">): Promise<void> {
  let files: ReadonlyMap<string, Uint8Array>;
  try { files = await readBundle("rollback", artifactId, root); } catch { throw new ProductionReleaseError("rollback_invalid"); }
  let rollback: RollbackArtifact & { previousImages?: readonly RollbackService[] };
  try { rollback = JSON.parse(Buffer.from(files.get("rollback.json") ?? []).toString("utf8")); } catch { throw new ProductionReleaseError("rollback_invalid"); }
  const expectedKeys = ["schemaVersion", "artifactId", "createdAt", "command", "previousCommitSha", "previousImageRef", "previousImageDigest", "composeFiles", "composeFilesSha256", "services", "previousImages", "projectName", "network", "candidateImage"];
  if (!rollback || rollback.schemaVersion !== 1 || Reflect.ownKeys(rollback).length !== expectedKeys.length || !Reflect.ownKeys(rollback).every((key) => typeof key === "string" && expectedKeys.includes(key)) || rollback.artifactId !== artifactId || !Array.isArray(rollback.command) || rollback.command.some((part) => typeof part !== "string" || /[\0\r\n]/.test(part)) || !Array.isArray(rollback.services) || !Array.isArray(rollback.previousImages) || rollback.previousImages.length !== rollback.services.length || !PROJECT.test(rollback.projectName ?? "") || !NETWORK.test(rollback.network ?? "") || typeof rollback.candidateImage !== "string" || !files.has("compose.production.yml") || !files.has("rollback.compose.yml") || !files.has("candidate.compose.yml") || !files.has("production.env") || !files.has("feedback-quality-config.json")) throw new ProductionReleaseError("rollback_invalid");
  const expectedId = contentId("rollback", (() => { const { schemaVersion: _schema, artifactId: _id, ...body } = rollback; return body; })());
  if (expectedId !== artifactId) throw new ProductionReleaseError("rollback_invalid");
  const argv = rollback.command;
  const serviceNames = rollback.services as WorkerService[];
  if (serviceNames.length === 0 || serviceNames.some((service, index) => !SERVICES.has(service) || (index > 0 && service <= serviceNames[index - 1])) || JSON.stringify(argv) !== JSON.stringify(["docker", "compose", "--project-name", rollback.projectName, "-f", "rollback.compose.yml", "up", "-d", "--force-recreate", "--no-build", ...serviceNames])) throw new ProductionReleaseError("rollback_invalid");
  const compose = Buffer.from(files.get("compose.production.yml")!);
  const override = Buffer.from(files.get("rollback.compose.yml")!);
  if (sha256(Buffer.concat([compose, override])) !== rollback.composeFilesSha256 || !override.equals(composeOverride(rollback.previousImages, rollback.network!)) || !Buffer.from(files.get("candidate.compose.yml")!).equals(candidateCompose(serviceNames, rollback.candidateImage!, rollback.network!)) || /\bbuild\s*:|\.\/apps\/|\.\/packages\//.test(compose.toString("utf8"))) throw new ProductionReleaseError("rollback_invalid");
  try { parseEnvironment(Buffer.from(files.get("production.env")!)); JSON.parse(Buffer.from(files.get("feedback-quality-config.json")!).toString("utf8")); } catch { throw new ProductionReleaseError("rollback_invalid"); }
  for (let index = 0; index < rollback.previousImages.length; index += 1) {
    const expected = rollback.previousImages[index];
    if (!expected || expected.service !== serviceNames[index] || !SERVICES.has(expected.service) || !COMMIT.test(expected.revision) || parseImageReference(expected.image).digest !== expected.digest || !HASH.test(expected.digest)) throw new ProductionReleaseError("rollback_invalid");
  }
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
