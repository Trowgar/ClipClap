import { describe, expect, it, vi } from "vitest";
import { lstat } from "node:fs/promises";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { createPrismaQualityPromotionRepository } from "../feedback-quality/repository";
import { MAX_EVIDENCE_BYTES, MAX_SOURCE_BYTES, promoteFeedbackCase, retireFeedbackCase, type PromotionDecision, type PromotionDependencies } from "../feedback-quality/promote";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const updatedAt = "2026-08-31T12:00:00.000Z";
const snapshotHash = sha256(canonicalJson({ title: "clip" }));
const candidateHash = sha256(`feedback-1\n${updatedAt}\n${snapshotHash}`);
type AuthorityLock = NonNullable<PromotionDependencies["withV1AuthorityLock"]>;

function decision(overrides: Partial<PromotionDecision> = {}): PromotionDecision {
  return {
    schemaVersion: 1,
    eventId: "review-event-1",
    feedbackId: "feedback-1",
    feedbackUpdatedAt: updatedAt,
    snapshotSha256: snapshotHash,
    candidateVersion: candidateHash,
    clipId: "clip-1",
    jobId: "job-1",
    userId: "user-1",
    verdict: "AS_IS",
    disposition: "positive",
    set: "eval",
    subsystem: "selection",
    confidence: "high",
    engineCause: "reproducible",
    evidence: "permanent",
    expected: { approvedMoment: true, completeBoundary: true, sourceWindow: { start: 1, end: 7 } },
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    feedback: {
      id: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", verdict: "AS_IS",
      surface: "bot", reason: null, note: null, snapshot: { title: "clip" }, evidenceKey: "evidence/clip.mp4", locale: null, createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt),
    },
      clip: {
      id: "clip-1", jobId: "job-1", storageKey: "clips/clip.mp4", duration: 12,
      startTime: 1, endTime: 7, title: "clip", subtitleTrack: null, cropPlan: null,
      language: "en", clipKind: "speech", hookStart: 1, hookEnd: 2, payoffAt: 5,
    },
      job: {
      id: "job-1", userId: "user-1", transcriptJson: { segments: [{ start: 0, end: 8, text: "hello" }] },
      transcriptPartial: false, sourceKey: "sources/job.mp4", sourceArtifactKey: "artifacts/job.mp4",
      normalizedArtifactKey: null, sourceDurationSec: 12,
    },
    ...overrides,
  };
}

function deps(overrides: Partial<PromotionDependencies> = {}): PromotionDependencies {
  return {
    repository: { capture: vi.fn(async () => snapshot()) },
    withV1AuthorityLock: vi.fn(async function <T>(operation: () => Promise<T>): Promise<T> { return operation(); }) as AuthorityLock,
    resolveV1Approval: vi.fn(async () => ({ eventId: "v1-event-1", feedbackId: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", feedbackUpdatedAt: updatedAt, snapshotSha256: snapshotHash, candidateVersion: candidateHash, destination: "eval" as const })),
    root: "/tmp/quality",
    publishCaseAndLabel: vi.fn(async (_input, _root, guard) => { await guard?.(); return { status: "committed" as const }; }),
    appendLabelEvent: vi.fn(async () => ({ status: "committed" as const })),
    qualityDestinationGuard: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...overrides,
  };
}

describe("quality feedback promotion", () => {
  it("promotes only an exact, replayable AS_IS identity and downloads evidence with GET", async () => {
    const dependencies = deps();
    const result = await promoteFeedbackCase(decision(), dependencies);
    expect(result.status).toBe("committed");
    expect(dependencies.downloadFile).toHaveBeenCalledWith("evidence/clip.mp4", { method: "GET" });
    expect(dependencies.publishCaseAndLabel).toHaveBeenCalledWith(expect.objectContaining({
      label: expect.objectContaining({ disposition: "positive", verdict: "AS_IS" }),
      files: expect.objectContaining({ "case.json": expect.any(Uint8Array), "transcript.json": expect.any(Uint8Array), "source-or-evidence.mp4": expect.objectContaining({ path: expect.any(String), size: 3, sha256: expect.stringMatching(/^sha256:/) }) }),
    }), "/tmp/quality", expect.any(Function));
  });

  it.each([
    ["subjective", "subjective"], ["source", "source"], ["missing evidence", "missing_evidence"],
  ] as const)("excludes %s negative feedback", async (_name, cause) => {
    const dependencies = deps({ repository: { capture: vi.fn(async () => snapshot({ feedback: { ...snapshot().feedback, verdict: "NO" } })) } });
    const result = await promoteFeedbackCase(decision({ verdict: "NO", disposition: "exclude", engineCause: cause, evidence: "missing" }), dependencies);
    expect(result.status).toBe("excluded");
    expect(dependencies.publishCaseAndLabel).not.toHaveBeenCalled();
    expect(dependencies.appendLabelEvent).toHaveBeenCalledWith(expect.objectContaining({ disposition: "exclude", reason: cause }), "/tmp/quality", expect.objectContaining({ beforeCommit: expect.any(Function) }));
    expect(dependencies.downloadFile).not.toHaveBeenCalled();
  });

  it("rejects stale feedback before downloading or publishing", async () => {
    const dependencies = deps({ repository: { capture: vi.fn(async () => snapshot({ feedback: { ...snapshot().feedback, updatedAt: new Date("2026-08-31T12:00:01.000Z") } })) } });
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(dependencies.publishCaseAndLabel).not.toHaveBeenCalled();
    expect(dependencies.downloadFile).not.toHaveBeenCalled();
  });

  it("rejects a positive label without a permanent evidence or complete transcript", async () => {
    const dependencies = deps({ repository: { capture: vi.fn(async () => snapshot({ job: { ...snapshot().job, transcriptPartial: true } })) } });
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ code: "inputs_missing" });
  });

  it("promotes a reproducible EDIT/NO only as a confirmed engine negative", async () => {
    const dependencies = deps({ repository: { capture: vi.fn(async () => snapshot({ feedback: { ...snapshot().feedback, verdict: "EDIT" } })) } });
    const result = await promoteFeedbackCase(decision({ verdict: "EDIT", disposition: "confirmed_negative" }), dependencies);
    expect(result.status).toBe("committed");
    expect(dependencies.publishCaseAndLabel).toHaveBeenCalledWith(expect.objectContaining({ label: expect.objectContaining({ disposition: "confirmed_negative", verdict: "EDIT" }) }), "/tmp/quality", expect.any(Function));
  });

  it("promotes a reproducible NO only as a confirmed engine negative", async () => {
    const dependencies = deps({ repository: { capture: vi.fn(async () => snapshot({ feedback: { ...snapshot().feedback, verdict: "NO" } })) } });
    const result = await promoteFeedbackCase(decision({ verdict: "NO", disposition: "confirmed_negative" }), dependencies);
    expect(result.status).toBe("committed");
    expect(dependencies.withV1AuthorityLock).not.toHaveBeenCalled();
    expect(dependencies.publishCaseAndLabel).toHaveBeenCalledWith(expect.objectContaining({ label: expect.objectContaining({ disposition: "confirmed_negative", verdict: "NO" }) }), "/tmp/quality", expect.any(Function));
  });

  it("refuses an EDIT/NO labelled as subjective, source-caused, or missing evidence", async () => {
    for (const engineCause of ["subjective", "source", "missing_evidence"] as const) {
      const dependencies = deps();
      await expect(promoteFeedbackCase(decision({ verdict: "NO", disposition: "confirmed_negative", engineCause }), dependencies)).rejects.toMatchObject({ code: "unsupported_label" });
      expect(dependencies.publishCaseAndLabel).not.toHaveBeenCalled();
    }
  });

  it("requires the V1 approval identity to match a positive label exactly", async () => {
    const dependencies = deps();
    dependencies.resolveV1Approval = vi.fn(async () => ({ eventId: "v1-event-1", feedbackId: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", feedbackUpdatedAt: updatedAt, snapshotSha256: snapshotHash, candidateVersion: candidateHash, destination: "holdout" as const }));
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(dependencies.publishCaseAndLabel).not.toHaveBeenCalled();
  });

  it("requires a real V1 approval resolver and checks every approval identity field", async () => {
    const missing = deps({ resolveV1Approval: vi.fn(async () => null) });
    await expect(promoteFeedbackCase(decision(), missing)).rejects.toMatchObject({ code: "approval_missing" });
    const approval = { eventId: "v1-event-1", feedbackId: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", feedbackUpdatedAt: updatedAt, snapshotSha256: snapshotHash, candidateVersion: candidateHash, destination: "eval" as const };
    for (const field of ["feedbackId", "clipId", "jobId", "userId", "feedbackUpdatedAt", "snapshotSha256", "candidateVersion", "destination"] as const) {
      const wrong = deps({ resolveV1Approval: vi.fn(async () => ({ ...approval, [field]: field === "destination" ? "holdout" : field === "feedbackUpdatedAt" ? "2026-08-31T12:00:01.000Z" : field === "snapshotSha256" || field === "candidateVersion" ? sha("e") : "other-id" } as never)) });
      await expect(promoteFeedbackCase(decision(), wrong)).rejects.toMatchObject({ code: "identity_mismatch" });
      expect(wrong.publishCaseAndLabel).not.toHaveBeenCalled();
    }
  });

  it("does not read V1 approval until its authority lock is acquired", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = vi.fn();
    const dependencies = deps({
      withV1AuthorityLock: vi.fn(async function <T>(operation: () => Promise<T>): Promise<T> { acquired(); await held; return operation(); }) as AuthorityLock,
      resolveV1Approval: vi.fn(async () => null),
    });
    const pending = promoteFeedbackCase(decision(), dependencies);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquired).toHaveBeenCalledOnce();
    expect(dependencies.resolveV1Approval).not.toHaveBeenCalled();
    release();
    await expect(pending).rejects.toMatchObject({ code: "approval_missing" });
    expect(dependencies.publishCaseAndLabel).not.toHaveBeenCalled();
  });

  it("holds V1 authority through the guarded V2 publication when approval is unchanged", async () => {
    const phases: string[] = [];
    const dependencies = deps({
      withV1AuthorityLock: vi.fn(async function <T>(operation: () => Promise<T>): Promise<T> { phases.push("v1-acquired"); const result = await operation(); phases.push("v1-released"); return result; }) as AuthorityLock,
      resolveV1Approval: vi.fn(async () => { phases.push("approval-read"); return { eventId: "v1-event-1", feedbackId: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", feedbackUpdatedAt: updatedAt, snapshotSha256: snapshotHash, candidateVersion: candidateHash, destination: "eval" as const }; }),
      publishCaseAndLabel: vi.fn(async (_input, _root, guard) => { phases.push("v2-publish"); await guard?.(); phases.push("v2-done"); return { status: "committed" as const }; }),
    });
    await expect(promoteFeedbackCase(decision(), dependencies)).resolves.toMatchObject({ status: "committed" });
    expect(phases).toEqual(["v1-acquired", "approval-read", "v2-publish", "v2-done", "v1-released"]);
  });

  it("does not download source for selection/boundary when a source key happens to exist", async () => {
    const dependencies = deps();
    await promoteFeedbackCase(decision({ subsystem: "boundary" }), dependencies);
    expect(dependencies.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("does not require a transcript for framing when evidence and source are present", async () => {
    const dependencies = deps({ repository: { capture: vi.fn(async () => snapshot({ job: { ...snapshot().job, transcriptJson: null } })) } });
    await expect(promoteFeedbackCase(decision({ subsystem: "framing", expected: { approvedMoment: true, completeBoundary: true } }), dependencies)).resolves.toMatchObject({ status: "committed" });
  });

  it("passes a destination guard into the atomic publisher", async () => {
    const dependencies = deps();
    await promoteFeedbackCase(decision(), dependencies);
    expect(dependencies.publishCaseAndLabel).toHaveBeenCalledWith(expect.anything(), "/tmp/quality", expect.any(Function));
  });

  it("enforces the permanent destination lock before any evidence download", async () => {
    const dependencies = deps({ qualityDestinationGuard: vi.fn(async () => { throw new Error("destination_locked"); }), qualityDestinationPreflight: vi.fn(async () => { throw new Error("destination_locked"); }) });
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ message: "destination_locked" });
    expect(dependencies.downloadFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized artifact from HEAD without issuing its GET", async () => {
    const getObjectSize = vi.fn(async () => MAX_EVIDENCE_BYTES + 1);
    const dependencies = deps({ getObjectSize });
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ code: "artifact_too_large" });
    expect(getObjectSize).toHaveBeenCalledWith("evidence/clip.mp4");
    expect(dependencies.downloadFile).not.toHaveBeenCalled();
  });

  it("cancels an oversized response stream at the byte cap", async () => {
    const cancel = vi.fn(async () => undefined);
    const oversizedChunk = new Uint8Array(1);
    Object.defineProperty(oversizedChunk, "byteLength", { value: MAX_EVIDENCE_BYTES + 1 });
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(oversizedChunk); },
      cancel,
    });
    const dependencies = deps({ downloadFile: vi.fn(async () => oversized) });
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ code: "artifact_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an oversized Buffer before copying it", async () => {
    const dependencies = deps({ downloadFile: vi.fn(async () => Buffer.alloc(MAX_EVIDENCE_BYTES + 1)) });
    await expect(promoteFeedbackCase(decision(), dependencies)).rejects.toMatchObject({ code: "artifact_too_large" });
  });

  it("bounds a source stream independently of the evidence stream", async () => {
    const cancel = vi.fn(async () => undefined);
    const sourceChunk = new Uint8Array(1);
    Object.defineProperty(sourceChunk, "byteLength", { value: MAX_SOURCE_BYTES + 1 });
    const sourceStream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(sourceChunk); }, cancel });
    const dependencies = deps({ downloadFile: vi.fn(async (key: string) => key.startsWith("artifacts/") ? sourceStream : new Uint8Array([1])) });
    await expect(promoteFeedbackCase(decision({ subsystem: "framing", expected: { approvedMoment: true, completeBoundary: true } }), dependencies)).rejects.toMatchObject({ code: "artifact_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the reader when a response chunk is invalid or read rejects", async () => {
    const invalidCancel = vi.fn(async () => undefined);
    const invalid = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue("not bytes" as never); }, cancel: invalidCancel });
    const invalidDeps = deps({ downloadFile: vi.fn(async () => invalid) });
    await expect(promoteFeedbackCase(decision(), invalidDeps)).rejects.toMatchObject({ code: "inputs_missing" });
    expect(invalidCancel).toHaveBeenCalledOnce();
    const rejectedCancel = vi.fn(async () => undefined);
    const rejected = { getReader: () => ({ read: vi.fn(async () => { throw new Error("read failed"); }), cancel: rejectedCancel, releaseLock: vi.fn() }) } as unknown as ReadableStream<Uint8Array>;
    const rejectedDeps = deps({ downloadFile: vi.fn(async () => rejected) });
    await expect(promoteFeedbackCase(decision(), rejectedDeps)).rejects.toThrow("read failed");
    expect(rejectedCancel).toHaveBeenCalledOnce();
  });

  it("cleans the private spool after successful and failed publication", async () => {
    let successPath = "";
    const success = deps({ publishCaseAndLabel: vi.fn(async (input, _root, guard) => { successPath = (input.files["source-or-evidence.mp4"] as { path: string }).path; await guard?.(); return { status: "committed" as const }; }) });
    await promoteFeedbackCase(decision(), success);
    await expect(lstat(successPath)).rejects.toMatchObject({ code: "ENOENT" });
    let failurePath = "";
    const failure = deps({ publishCaseAndLabel: vi.fn(async (input) => { failurePath = (input.files["source-or-evidence.mp4"] as { path: string }).path; throw new Error("publish failed"); }) });
    await expect(promoteFeedbackCase(decision(), failure)).rejects.toThrow("publish failed");
    await expect(lstat(failurePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes a reference-only non-render case without downloading a source artifact", async () => {
    const dependencies = deps({
      repository: { capture: vi.fn(async () => snapshot({ job: { ...snapshot().job, sourceArtifactKey: null, normalizedArtifactKey: null } })) },
    });
    const result = await promoteFeedbackCase(decision({ subsystem: "selection", expected: { approvedMoment: true, completeBoundary: true, sourceWindow: { start: 1, end: 7 }, referenceOnly: true } }), dependencies);
    expect(result.status).toBe("committed");
    expect(dependencies.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("retires a label by appending a new correction event and never rewriting history", async () => {
    const append = vi.fn(async () => ({ status: "committed" as const }));
    const result = await retireFeedbackCase({ action: "retire", targetEventId: "review-event-1", reason: "operator correction" }, { root: "/tmp/quality", eventId: () => "retire-event-1", appendLabelEvent: append });
    expect(result).toEqual({ status: "committed", eventId: "retire-event-1" });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ action: "retire", operation: "retire", targetEventId: "review-event-1", reason: "operator correction" }), "/tmp/quality", expect.objectContaining({ beforeCommit: expect.any(Function) }));
  });
});

describe("quality promotion repository", () => {
  it("starts a read-only repeatable-read transaction before any SELECT and exposes capture only", async () => {
    const calls: string[] = [];
    const tx: any = {
      $executeRawUnsafe: vi.fn(async (sql: string) => { calls.push(sql); return 0; }),
      clipFeedback: { findUnique: vi.fn(async () => ({ id: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", surface: "bot", verdict: "AS_IS", reason: null, note: null, snapshot: { title: "clip" }, evidenceKey: "evidence/clip.mp4", locale: null, createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt) })) },
      clip: { findUnique: vi.fn(async () => ({ id: "clip-1", jobId: "job-1", storageKey: "clips/clip.mp4", duration: 12, startTime: 1, endTime: 7, title: "clip", subtitleTrack: null, cropPlan: null, language: "en", clipKind: "speech", hookStart: 1, hookEnd: 2, payoffAt: 5 })) },
      job: { findUnique: vi.fn(async () => ({ id: "job-1", userId: "user-1", transcriptJson: { segments: [] }, transcriptPartial: false, sourceKey: "sources/job.mp4", sourceArtifactKey: null, normalizedArtifactKey: null, sourceDurationSec: 12 })) },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: any) => unknown) => callback(tx)) };
    const repository = createPrismaQualityPromotionRepository(client as never);
    expect(Object.keys(repository)).toEqual(["capture"]);
    const captured = await repository.capture({ feedbackId: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", feedbackUpdatedAt: updatedAt, snapshotSha256: snapshotHash, candidateVersion: candidateHash, destination: "eval" });
    expect(captured).not.toHaveProperty("v1Approval");
    expect(calls).toEqual(["SET TRANSACTION READ ONLY"]);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it("treats empty artifact keys as missing instead of selecting them", async () => {
    const tx: any = {
      $executeRawUnsafe: vi.fn(async () => 0),
      clipFeedback: { findUnique: vi.fn(async () => ({ id: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", surface: "bot", verdict: "AS_IS", reason: null, note: null, snapshot: { title: "clip" }, evidenceKey: "", locale: null, createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt) })) },
      clip: { findUnique: vi.fn(async () => ({ id: "clip-1", jobId: "job-1", storageKey: "clips/clip.mp4", duration: 12, startTime: 1, endTime: 7, title: "clip", subtitleTrack: null, cropPlan: null, language: "en", clipKind: "speech", hookStart: 1, hookEnd: 2, payoffAt: 5 })) },
      job: { findUnique: vi.fn(async () => ({ id: "job-1", userId: "user-1", transcriptJson: { segments: [] }, transcriptPartial: false, sourceKey: "sources/job.mp4", sourceArtifactKey: "source.mp4", normalizedArtifactKey: "", sourceDurationSec: 12 })) },
    };
    const repository = createPrismaQualityPromotionRepository({ $transaction: vi.fn(async (callback: (transaction: any) => unknown) => callback(tx)) } as never);
    const captured = await repository.capture({ feedbackId: "feedback-1", clipId: "clip-1", jobId: "job-1", userId: "user-1", feedbackUpdatedAt: updatedAt, snapshotSha256: snapshotHash, candidateVersion: candidateHash, destination: "eval" });
    expect(captured.feedback.evidenceKey).toBeNull();
    expect(captured.job.normalizedArtifactKey).toBeNull();
    expect(captured.job.sourceArtifactKey).toBe("source.mp4");
  });
});
