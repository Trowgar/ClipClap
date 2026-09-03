import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { appendOutcomeEvent } from "../feedback-quality/outcome-store";
import {
  createPrismaOutcomePromotionRepository,
  digestAnalyzeStep,
  isOutcomeSourceSizeAllowed,
  MAX_OUTCOME_CASE_BYTES,
  MAX_OUTCOME_SOURCE_BYTES,
  promoteOutcomeCase,
  publishOutcomeCase,
  validateOutcomeStore,
  type OutcomePromotionDecision,
  type OutcomePromotionDependencies,
  type OutcomePromotionSnapshot,
  type OutcomeCasePublication,
} from "../feedback-quality/outcome-promote";
import { readOutcomeDecisionFile, runOutcomePromote } from "../scripts/outcome-promote";
import { runOutcomeValidate } from "../scripts/outcome-validate";

const roots: string[] = [];
const hash = (value: string) => sha256(Buffer.from(value));

function recordedBytes(): Buffer {
  return Buffer.from(`${canonicalJson({ promptFingerprint: hash("prompt"), modelFingerprint: hash("model"), requestFingerprint: hash("request"), result: { highlights: [] } })}\n`);
}

function transcript(): Record<string, unknown> {
  return { text: "private transcript", segments: [{ id: 0, start: 0, end: 10, text: "private transcript", words: [] }] };
}

function snapshot(overrides: Partial<OutcomePromotionSnapshot> = {}): OutcomePromotionSnapshot {
  const base: OutcomePromotionSnapshot = {
    job: {
      id: "job-private-1", userId: "user-private-1", status: "DONE", updatedAt: "2026-09-02T23:00:00.000Z",
      clipsGenerated: 0, clipCount: 0, noClipsReason: "NO_VIABLE_MOMENTS", analysisVersion: "core-v4-recovery-v1",
      transcriptJson: transcript(), transcriptPartial: false, sourceDurationSec: 120,
      sourceArtifactKey: "work/user-private-1/job-private-1/source.mp4", normalizedArtifactKey: null,
    },
    analyzeStep: {
      id: "step-private-1", status: "DONE", error: null, finishedAt: "2026-09-02T22:59:00.000Z",
      outputJson: { engine: "recall-critic", highlights: 0, noClipsReason: "NO_VIABLE_MOMENTS", telemetry: { path: "full" } },
    },
  };
  return { ...base, ...overrides };
}

function decision(snap = snapshot(), overrides: Record<string, unknown> = {}): OutcomePromotionDecision {
  const transcriptBytes = Buffer.from(canonicalJson(snap.job.transcriptJson));
  return {
    schemaVersion: 1,
    eventId: "outcome-event-1",
    reviewedAt: "2026-09-02T23:10:00.000Z",
    jobId: snap.job.id,
    jobUpdatedAt: snap.job.updatedAt,
    analyzeStepId: snap.analyzeStep.id,
    analyzeStepSha256: digestAnalyzeStep(snap.analyzeStep),
    analysisVersion: snap.job.analysisVersion!,
    engineFingerprint: hash("engine"),
    configSha256: hash("config"),
    transcriptSha256: sha256(transcriptBytes),
    sourceSha256: hash("source-bytes"),
    recordedResponsesSha256: sha256(recordedBytes()),
    sourceReview: "complete",
    destination: "eval",
    disposition: "recoverable_false_negative",
    confidence: "high",
    subsystem: "selection",
    expected: { approvedWindows: [{ start: 10, end: 30 }], forbiddenWindows: [{ start: 60, end: 70 }] },
    recordedResponses: [{ promptFingerprint: hash("prompt"), modelFingerprint: hash("model"), requestFingerprint: hash("request"), result: { highlights: [] } }],
    ...overrides,
  } as OutcomePromotionDecision;
}

function deps(snap = snapshot(), overrides: Partial<OutcomePromotionDependencies> = {}): OutcomePromotionDependencies {
  return {
    repository: { capture: vi.fn(async () => snap) },
    getObjectSize: vi.fn(async () => Buffer.byteLength("source-bytes")),
    downloadFile: vi.fn(async (_key, request) => {
      expect(request).toEqual({ method: "GET" });
      return Buffer.from("source-bytes");
    }),
    publish: vi.fn(async () => ({ status: "committed" as const })),
    now: () => new Date("2026-09-02T23:11:00.000Z"),
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clipclap-outcome-promote-"));
  roots.push(root);
  return join(root, "outcomes");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("zero-outcome promotion", () => {
  it("materializes a reviewed DONE zero-output job using only read dependencies", async () => {
    const dependencies = deps();
    const result = await promoteOutcomeCase(decision(), dependencies);

    expect(result).toMatchObject({ status: "promoted", set: "eval", caseVersion: expect.stringMatching(/^sha256:/) });
    expect(dependencies.repository.capture).toHaveBeenCalledOnce();
    expect(dependencies.getObjectSize).toHaveBeenCalledWith("work/user-private-1/job-private-1/source.mp4");
    expect(dependencies.downloadFile).toHaveBeenCalledOnce();
    expect((dependencies.repository as Record<string, unknown>).update).toBeUndefined();
    expect((dependencies as unknown as Record<string, unknown>).putObject).toBeUndefined();

    const publication = vi.mocked(dependencies.publish!).mock.calls[0][0];
    expect(Object.keys(publication.files).sort()).toEqual(["case.json", "recorded-responses.jsonl", "source.mp4", "transcript.json"]);
    const caseText = Buffer.from(publication.files["case.json"] as Uint8Array).toString("utf8");
    expect(caseText).not.toContain("job-private-1");
    expect(caseText).not.toContain("user-private-1");
    expect(caseText).not.toContain("step-private-1");
    expect(caseText).not.toContain("private transcript");
    expect(caseText).not.toContain("work/");
    expect(JSON.parse(caseText)).toMatchObject({
      disposition: "recoverable_false_negative", set: "eval", sourceDurationSec: 120,
      jobUpdatedAt: "2026-09-02T23:00:00.000Z", reviewedAt: "2026-09-02T23:10:00.000Z",
      materializedAt: "2026-09-02T23:11:00.000Z", freshnessSha256: expect.stringMatching(/^sha256:/),
    });
  });

  it("materializes a reviewed valid-empty control with forbidden windows only", async () => {
    const dependencies = deps();
    const result = await promoteOutcomeCase(decision(snapshot(), {
      destination: "holdout",
      disposition: "valid_empty",
      expected: { approvedWindows: [], forbiddenWindows: [{ start: 10, end: 30 }] },
    }), dependencies);
    expect(result).toMatchObject({ status: "promoted", set: "holdout" });
    const publication = vi.mocked(dependencies.publish!).mock.calls[0][0];
    expect(JSON.parse(Buffer.from(publication.files["case.json"] as Uint8Array).toString("utf8"))).toMatchObject({ disposition: "valid_empty", set: "holdout" });
  });

  it.each([
    ["nonzero stored clip count", { job: { ...snapshot().job, clipCount: 1 } }, "not_zero_output"],
    ["nonzero generated count", { job: { ...snapshot().job, clipsGenerated: 1 } }, "not_zero_output"],
    ["failed job", { job: { ...snapshot().job, status: "FAILED" } }, "technical_outcome"],
    ["failed analyze", { analyzeStep: { ...snapshot().analyzeStep, status: "FAILED", error: "timeout" } }, "technical_outcome"],
    ["partial transcript", { job: { ...snapshot().job, transcriptPartial: true } }, "partial_transcript"],
    ["partial reason", { job: { ...snapshot().job, noClipsReason: "PARTIAL_TRANSCRIPT" } }, "partial_transcript"],
    ["no usable speech", { job: { ...snapshot().job, noClipsReason: "NO_USABLE_SPEECH" } }, "source_limited"],
    ["missing transcript", { job: { ...snapshot().job, transcriptJson: null } }, "inputs_missing"],
    ["malformed transcript segment", { job: { ...snapshot().job, transcriptJson: { text: "bad", segments: [{ start: 20, end: 10, text: "bad" }] } } }, "inputs_missing"],
    ["missing duration", { job: { ...snapshot().job, sourceDurationSec: null } }, "inputs_missing"],
    ["missing source", { job: { ...snapshot().job, sourceArtifactKey: null, normalizedArtifactKey: null } }, "inputs_missing"],
  ])("rejects %s before publication", async (_name, changed, code) => {
    const snap = snapshot(changed as Partial<OutcomePromotionSnapshot>);
    const dependencies = deps(snap);
    await expect(promoteOutcomeCase(decision(snap), dependencies)).rejects.toMatchObject({ code });
    expect(dependencies.publish).not.toHaveBeenCalled();
  });

  it("rejects a snapshot with no analysis version before publication", async () => {
    const snap = snapshot({ job: { ...snapshot().job, analysisVersion: null } });
    const dependencies = deps(snap);
    await expect(promoteOutcomeCase(decision(), dependencies)).rejects.toMatchObject({ code: "inputs_missing" });
    expect(dependencies.publish).not.toHaveBeenCalled();
  });

  it.each([
    ["job identity", { jobId: "stale-job" }],
    ["job freshness", { jobUpdatedAt: "2026-09-02T22:00:00.000Z" }],
    ["analyze identity", { analyzeStepId: "stale-step" }],
    ["analyze digest", { analyzeStepSha256: hash("stale") }],
    ["analysis version", { analysisVersion: "core-v3" }],
    ["transcript digest", { transcriptSha256: hash("stale") }],
    ["source digest", { sourceSha256: hash("stale") }],
    ["recording digest", { recordedResponsesSha256: hash("stale") }],
  ])("rejects stale %s", async (_name, changed) => {
    const dependencies = deps();
    await expect(promoteOutcomeCase(decision(snapshot(), changed), dependencies)).rejects.toMatchObject({ code: "stale_input" });
    expect(dependencies.publish).not.toHaveBeenCalled();
  });

  it("rejects reviews and materializations outside bounded freshness windows", async () => {
    await expect(promoteOutcomeCase(decision(snapshot(), { reviewedAt: "2026-09-10T23:10:00.000Z" }), deps())).rejects.toMatchObject({ code: "stale_input" });
    await expect(promoteOutcomeCase(decision(), deps(snapshot(), { now: () => new Date("2026-09-04T23:11:00.000Z") }))).rejects.toMatchObject({ code: "stale_input" });
  });

  it.each([
    { sourceReview: "limited" },
    { disposition: "exclude", destination: "eval" },
    { disposition: "valid_empty", expected: { approvedWindows: [{ start: 1, end: 2 }], forbiddenWindows: [] } },
    { recordedResponses: [] },
    { note: "private note" },
  ])("rejects unsafe decision shape %#", async (changed) => {
    const dependencies = deps();
    await expect(promoteOutcomeCase(decision(snapshot(), changed), dependencies)).rejects.toMatchObject({ code: "invalid_decision" });
    expect(dependencies.repository.capture).not.toHaveBeenCalled();
  });

  it("spools a bounded source and rejects missing or oversized objects", async () => {
    const missing = deps(snapshot(), { getObjectSize: vi.fn(async () => null) });
    await expect(promoteOutcomeCase(decision(), missing)).rejects.toMatchObject({ code: "source_missing" });
    expect(missing.downloadFile).not.toHaveBeenCalled();

    const oversized = deps(snapshot(), { getObjectSize: vi.fn(async () => 2 * 1024 * 1024 * 1024 + 1) });
    await expect(promoteOutcomeCase(decision(), oversized)).rejects.toMatchObject({ code: "source_too_large" });
    expect(oversized.downloadFile).not.toHaveBeenCalled();
  });

  it("does not let an empty normalized key hide a valid source artifact", async () => {
    const snap = snapshot({ job: { ...snapshot().job, normalizedArtifactKey: "", sourceArtifactKey: "source.mp4" } });
    const dependencies = deps(snap);
    await promoteOutcomeCase(decision(snap), dependencies);
    expect(dependencies.getObjectSize).toHaveBeenCalledWith("source.mp4");
  });

  it("uses a read-only repeatable-read Prisma snapshot and exposes no mutator", async () => {
    const execute = vi.fn(async () => 0);
    const tx = {
      $executeRawUnsafe: execute,
      job: { findUnique: vi.fn(async () => ({ ...snapshot().job, _count: { clips: 0 }, updatedAt: new Date(snapshot().job.updatedAt) })) },
      jobStep: { findUnique: vi.fn(async () => ({ ...snapshot().analyzeStep, jobId: "job-private-1", step: "ANALYZE", finishedAt: new Date(snapshot().analyzeStep.finishedAt!) })) },
    };
    const transaction = vi.fn(async (operation: (value: typeof tx) => unknown, options: unknown) => {
      expect(options).toMatchObject({ isolationLevel: "RepeatableRead" });
      return operation(tx);
    });
    const repository = createPrismaOutcomePromotionRepository({ $transaction: transaction } as never);
    const captured = await repository.capture({ jobId: "job-private-1", analyzeStepId: "step-private-1" });
    expect(execute).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
    expect(captured.job.clipCount).toBe(0);
    expect((tx.job as Record<string, unknown>).update).toBeUndefined();
  });

  it("publishes atomically, enforces private modes, and rejects duplicate source content", async () => {
    const root = await temporaryRoot();
    await mkdir(root, { mode: 0o700 });
    const productionDeps = deps(snapshot(), { root, publish: undefined });
    await expect(promoteOutcomeCase(decision(), productionDeps)).resolves.toMatchObject({ status: "promoted" });
    const labels = await validateOutcomeStore(root);
    expect(labels).toEqual({ status: "valid", counts: { eval: 1, holdout: 0 }, reasons: {} });

    const caseVersion = (await promoteOutcomeCase(decision(), productionDeps).catch((error) => error)) as { code?: string };
    expect(caseVersion).toMatchObject({ code: "duplicate_event" });

    const second = snapshot({ job: { ...snapshot().job, id: "job-private-2", userId: "user-private-2", updatedAt: "2026-09-02T23:01:00.000Z" }, analyzeStep: { ...snapshot().analyzeStep, id: "step-private-2" } });
    await expect(promoteOutcomeCase(decision(second, { eventId: "outcome-event-2" }), deps(second, { root, publish: undefined }))).rejects.toMatchObject({ code: "duplicate_source" });
  });

  it("validator is read-only and rejects unsafe modes and symlinks with aggregate codes", async () => {
    const root = await temporaryRoot();
    await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    const before = await readFile(join(root, "ledger", "outcomes.jsonl"));
    await chmod(join(root, "cases"), 0o755);
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { unsafe_mode: 1 } });
    expect(await readFile(join(root, "ledger", "outcomes.jsonl"))).toEqual(before);

    await chmod(join(root, "cases"), 0o700);
    const real = join(roots[roots.length - 1], "real-case");
    await writeFile(real, "private", { mode: 0o600 });
    await symlink(real, join(root, "cases", "bad-link"));
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { unsafe_path: 1 } });
    expect((await lstat(real)).isFile()).toBe(true);
  });

  it("validator fails closed on tampered case bytes and orphan case directories", async () => {
    const root = await temporaryRoot();
    const promoted = await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    const transcriptPath = join(root, "cases", promoted.caseVersion, "transcript.json");
    await writeFile(transcriptPath, "tampered", { mode: 0o600 });
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { stale_case: 1 } });

    await rm(join(root, "cases", promoted.caseVersion), { recursive: true });
    await mkdir(join(root, "cases", hash("orphan")), { mode: 0o700 });
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: expect.objectContaining({ missing_or_invalid_case: 1, orphan_case: 1 }) });
  });

  it("validator fails standalone on missing, mismatched, and future freshness bindings", async () => {
    const root = await temporaryRoot();
    const promoted = await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    await expect(validateOutcomeStore(root, { now: new Date("2026-09-02T23:12:00.000Z") })).resolves.toMatchObject({ status: "valid" });
    await expect(validateOutcomeStore(root, { now: new Date("2026-09-02T23:00:00.000Z") })).resolves.toMatchObject({ status: "invalid", reasons: { stale_case: 1 } });

    const casePath = join(root, "cases", promoted.caseVersion, "case.json");
    const raw = JSON.parse(await readFile(casePath, "utf8"));
    delete raw.freshnessSha256;
    await writeFile(casePath, `${canonicalJson(raw)}\n`, { mode: 0o600 });
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { missing_or_invalid_case: 1 } });
  });

  it("uses the current clock by default to reject future materialization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    try {
      const future = snapshot({
        job: { ...snapshot().job, updatedAt: "2026-09-09T23:00:00.000Z" },
        analyzeStep: { ...snapshot().analyzeStep, finishedAt: "2026-09-09T22:59:00.000Z" },
      });
      const root = await temporaryRoot();
      await promoteOutcomeCase(
        decision(future, { reviewedAt: "2026-09-09T23:10:00.000Z" }),
        deps(future, { root, publish: undefined, now: () => new Date("2026-09-09T23:11:00.000Z") }),
      );
      await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { stale_case: 1 } });
    } finally { vi.useRealTimers(); }
  });

  it("rejects oversized stored case metadata before parsing", async () => {
    const root = await temporaryRoot();
    const promoted = await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    await truncate(join(root, "cases", promoted.caseVersion, "case.json"), MAX_OUTCOME_CASE_BYTES + 1);
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { missing_or_invalid_case: 1 } });
  });

  it.each(["observations", "decisions"])("requires %s to remain a private directory", async (name) => {
    const root = await temporaryRoot();
    await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    await rm(join(root, name), { recursive: true });
    await writeFile(join(root, name), "", { mode: 0o600 });
    await expect(validateOutcomeStore(root)).resolves.toMatchObject({ status: "invalid", reasons: { required_entry_type: 1 } });
  });

  it("snapshots mutable byte payloads once before validation and publication", async () => {
    const captured = vi.fn(async (_input: OutcomeCasePublication) => ({ status: "committed" as const }));
    await promoteOutcomeCase(decision(), deps(snapshot(), { publish: captured }));
    const template = captured.mock.calls[0][0];
    const root = await temporaryRoot();
    const originalSource = Buffer.from("source-bytes");
    const source = new Uint8Array(originalSource);
    const files = { ...template.files, "source.mp4": source };
    await publishOutcomeCase({
      ...template, root, files,
      afterPrepare: () => { source.fill(0x78); },
    });
    expect(await readFile(join(root, "cases", template.caseVersion, "source.mp4"))).toEqual(originalSource);
  });

  it("anchors and snapshots a file-backed payload before an adversarial source change", async () => {
    const captured = vi.fn(async (_input: OutcomeCasePublication) => ({ status: "committed" as const }));
    await promoteOutcomeCase(decision(), deps(snapshot(), { publish: captured }));
    const template = captured.mock.calls[0][0];
    const root = await temporaryRoot();
    const external = join(roots[roots.length - 1], "external-source.mp4");
    const originalSource = Buffer.from("source-bytes");
    await writeFile(external, originalSource, { mode: 0o600 });
    await publishOutcomeCase({
      ...template, root,
      files: { ...template.files, "source.mp4": { path: external, size: originalSource.length, sha256: sha256(originalSource) } },
      afterPrepare: () => writeFile(external, "source-bytes-changed", { mode: 0o600 }),
    });
    expect(await readFile(join(root, "cases", template.caseVersion, "source.mp4"))).toEqual(originalSource);
  });

  it("enforces the public source cap, including the exact boundary", async () => {
    expect(isOutcomeSourceSizeAllowed(MAX_OUTCOME_SOURCE_BYTES)).toBe(true);
    expect(isOutcomeSourceSizeAllowed(MAX_OUTCOME_SOURCE_BYTES + 1)).toBe(false);

    const captured = vi.fn(async (_input: OutcomeCasePublication) => ({ status: "committed" as const }));
    await promoteOutcomeCase(decision(), deps(snapshot(), { publish: captured }));
    const template = captured.mock.calls[0][0];
    const root = await temporaryRoot();
    const oversized = join(roots[roots.length - 1], "oversized-source.mp4");
    await writeFile(oversized, "", { mode: 0o600 });
    await truncate(oversized, MAX_OUTCOME_SOURCE_BYTES + 1);
    await expect(publishOutcomeCase({
      ...template, root,
      files: { ...template.files, "source.mp4": { path: oversized, size: MAX_OUTCOME_SOURCE_BYTES + 1, sha256: hash("irrelevant") } },
    })).rejects.toMatchObject({ code: "source_too_large" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validator retains and verifies retired immutable cases without counting them active", async () => {
    const root = await temporaryRoot();
    await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    await appendOutcomeEvent(root, { schemaVersion: 1, action: "retire", eventId: "retire-event-1", occurredAt: "2026-09-02T23:20:00.000Z", targetEventId: "outcome-event-1" });
    await expect(validateOutcomeStore(root)).resolves.toEqual({ status: "valid", counts: { eval: 0, holdout: 0 }, reasons: {} });
  });

  it("standalone publisher refuses a mismatched pre-existing case", async () => {
    const root = await temporaryRoot();
    const publication = vi.mocked(deps().publish!);
    await promoteOutcomeCase(decision(), deps(snapshot(), { root, publish: undefined }));
    const input = publication.mock.calls[0]?.[0];
    expect(input).toBeUndefined();
    await expect(publishOutcomeCase({ root, caseVersion: hash("wrong"), files: { "case.json": Buffer.from("{}") } as never, label: {} as never })).rejects.toBeDefined();
  });

  it("reads only a 0600 regular decision file without following symlinks", async () => {
    const root = await temporaryRoot();
    await mkdir(root, { mode: 0o700 });
    const path = join(root, "review.json");
    await writeFile(path, JSON.stringify(decision()), { mode: 0o600 });
    await expect(readOutcomeDecisionFile(path)).resolves.toMatchObject({ jobId: "job-private-1" });
    await chmod(path, 0o644);
    await expect(readOutcomeDecisionFile(path)).rejects.toThrow("private_file_invalid");
    await chmod(path, 0o600);
    const link = join(root, "review-link.json");
    await symlink(path, link);
    await expect(readOutcomeDecisionFile(link)).rejects.toThrow("private_file_invalid");
  });

  it("promotion CLI accepts ids only through the decision file and logs no identifiers", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const execute = vi.fn(async () => ({ status: "promoted" as const, durability: "committed" as const, caseVersion: hash("case"), set: "eval" as const }));
    const code = await runOutcomePromote(["--decision-file", "/private/review.json", "--root", "/private/outcomes"], {
      readDecision: vi.fn(async () => decision()), execute, disconnect: vi.fn(async () => undefined),
      io: { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
    });
    expect(code).toBe(0);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-private-1" }), "/private/outcomes/outcomes");
    const logs = [...output, ...errors].join("\n");
    expect(logs).toContain('"status":"promoted"');
    for (const secret of ["job-private-1", "step-private-1", "user-private-1", "outcome-event-1", hash("case")]) expect(logs).not.toContain(secret);

    expect(await runOutcomePromote(["--job-id", "job-private-1"], { readDecision: vi.fn(), execute, disconnect: vi.fn(async () => undefined), io: { stdout: () => undefined, stderr: () => undefined } })).toBe(2);
  });

  it("validator CLI prints only aggregate counts and reason codes", async () => {
    const output: string[] = [];
    const code = await runOutcomeValidate(["--root", "/private/outcomes"], {
      validate: vi.fn(async () => ({ status: "invalid" as const, counts: { eval: 2, holdout: 1 }, reasons: { stale_case: 1 } })),
      io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
    });
    expect(code).toBe(1);
    expect(output).toEqual(['{"operation":"outcome-validate","status":"invalid","counts":{"eval":2,"holdout":1},"reasons":{"stale_case":1}}']);
    expect(output.join("\n")).not.toMatch(/job-|user-|step-|sha256:/);
  });
});
