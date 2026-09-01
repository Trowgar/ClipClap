import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { canonicalJson, sha256 } from "../feedback-learning/canonical";

/** Bumped only when the observation/deploy runner contract changes. */
export const QUALITY_RUNNER_VERSION = 2;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ObservationConfig = Readonly<{
  schemaVersion: 1;
  runnerVersion: number;
  promptFingerprint: `sha256:${string}`;
  modelFingerprint: `sha256:${string}`;
  requestFingerprint: `sha256:${string}`;
  recorded?: Readonly<{ promptFingerprint: `sha256:${string}`; modelFingerprint: `sha256:${string}`; requestFingerprint: `sha256:${string}` }>;
  envAllowlist: readonly string[];
  engine: Readonly<Record<string, unknown>>;
}>;

export class SecureConfigError extends Error {
  constructor(readonly code: "invalid" | "insecure" | "fingerprint") { super(code); this.name = "SecureConfigError"; }
}

function hash(value: unknown): value is `sha256:${string}` { return typeof value === "string" && HASH.test(value); }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactObject(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    if (typeof key !== "string" || !allowed.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
  });
}

export function validateSecureConfig(value: unknown, live = true): ObservationConfig {
  if (!plain(value) || !exactObject(value, ["schemaVersion", "runnerVersion", "promptFingerprint", "modelFingerprint", "requestFingerprint", "recorded", "envAllowlist", "engine"])) throw new SecureConfigError("invalid");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.runnerVersion) || value.runnerVersion !== QUALITY_RUNNER_VERSION || !hash(value.promptFingerprint) || !hash(value.modelFingerprint) || !hash(value.requestFingerprint) || !Array.isArray(value.envAllowlist) || value.envAllowlist.some((item) => typeof item !== "string" || !ENV_NAME.test(item)) || !plain(value.engine)) throw new SecureConfigError("invalid");
  const engine = value.engine;
  if (!exactObject(engine, ["analyze", "reframe", "musicDirection", "blackTail"]) || ["analyze", "reframe", "musicDirection", "blackTail"].some((key) => engine[key] !== undefined && !plain(engine[key]))) throw new SecureConfigError("invalid");
  if (value.recorded !== undefined) {
    if (!plain(value.recorded) || !exactObject(value.recorded, ["promptFingerprint", "modelFingerprint", "requestFingerprint"]) || !hash(value.recorded.promptFingerprint) || !hash(value.recorded.modelFingerprint) || !hash(value.recorded.requestFingerprint)) throw new SecureConfigError("fingerprint");
  }
  if (!live && value.recorded === undefined) throw new SecureConfigError("fingerprint");
  return value as unknown as ObservationConfig;
}

export async function readSecureConfig(path: string): Promise<unknown> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new SecureConfigError("insecure");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (initial.mode & 0o7777) !== 0o600 || initial.size > MAX_CONFIG_BYTES) throw new SecureConfigError("insecure");
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) { const item = await handle.read(bytes, offset, bytes.length - offset, null); if (!item.bytesRead) break; offset += item.bytesRead; }
    const final = await handle.stat();
    if (offset !== initial.size || final.size !== initial.size || final.nlink !== 1) throw new SecureConfigError("insecure");
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw new SecureConfigError("invalid"); }
  } catch (error) {
    if (error instanceof SecureConfigError) throw error;
    throw new SecureConfigError("insecure");
  } finally { await handle?.close().catch(() => undefined); }
}

export function effectiveConfigDigest(value: unknown, environment: Readonly<Record<string, string | undefined>> = process.env): `sha256:${string}` {
  return effectiveConfigDigestWithEnvironment(value, environment);
}

export function effectiveConfigDigestWithEnvironment(value: unknown, environment: Readonly<Record<string, string | undefined>>): `sha256:${string}` {
  try {
    const config = validateSecureConfig(value, true);
    const resolvedEnvironment = Object.fromEntries([...config.envAllowlist].sort().map((key) => [key, environment[key] ?? null]));
    return sha256(canonicalJson({ config, environment: resolvedEnvironment }));
  }
  catch (error) { if (error instanceof SecureConfigError) throw error; throw new SecureConfigError("invalid"); }
}
