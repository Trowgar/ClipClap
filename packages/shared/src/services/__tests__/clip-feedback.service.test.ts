import { describe, expect, it, vi, beforeEach } from "vitest";

const clipFindFirst = vi.hoisted(() => vi.fn());
const feedbackUpsert = vi.hoisted(() => vi.fn());
const feedbackFindUnique = vi.hoisted(() => vi.fn());
const copyObjectMock = vi.hoisted(() => vi.fn());
const sendTelegramMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/prisma", () => ({
  prisma: {
    clip: { findFirst: clipFindFirst },
    clipFeedback: { upsert: feedbackUpsert, findUnique: feedbackFindUnique },
  },
}));
vi.mock("../../lib/r2", () => ({ copyObject: copyObjectMock }));
vi.mock("../telegram-notification.service", () => ({
  sendTelegramMessage: sendTelegramMessageMock,
}));

import { recordClipFeedback } from "../clip-feedback.service";

const CLIP = {
  id: "clip-1",
  jobId: "job-1",
  userId: "user-1",
  title: "A title",
  storageKey: "clips/clip-1.mp4",
  duration: 42,
  startTime: 100,
  endTime: 142,
  score: 0.8,
  clipKind: "story",
  lowQuality: false,
  hookStart: 100,
  hookEnd: 104,
  payoffAt: 130,
  cropPlan: { keyframes: [{ t: 0 }, { t: 1 }], layout: "single" },
  job: {
    analyzeEngine: "recall-critic",
    highlightsVersion: 2,
    language: "en",
    sourceDurationSec: 3600,
    transcriptJson: {
      segments: [
        { start: 90, end: 99, text: "before" },
        { start: 101, end: 120, text: "inside one" },
        { start: 121, end: 141, text: "inside two" },
        { start: 150, end: 160, text: "after" },
      ],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  clipFindFirst.mockResolvedValue(CLIP);
  feedbackFindUnique.mockResolvedValue(null);
  feedbackUpsert.mockResolvedValue({ id: "fb-1" });
  copyObjectMock.mockResolvedValue(undefined);
  sendTelegramMessageMock.mockResolvedValue(true);
});

describe("recordClipFeedback ownership", () => {
  // clipId is attacker-controlled on both surfaces. The query SHAPE is asserted
  // because a mocked prisma returns whatever it is told regardless of the
  // where-clause, so dropping `userId` - the entire guard - would be invisible
  // to a test that only checked the return value.
  // Mutation check: remove `userId` from the where and THIS assertion fails.
  it("looks the clip up by id AND owner", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    expect(clipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "clip-1", userId: "user-1" } })
    );
  });

  it("refuses a clip that belongs to someone else and writes nothing", async () => {
    clipFindFirst.mockResolvedValue(null);
    const result = await recordClipFeedback({
      clipId: "clip-1",
      userId: "intruder",
      surface: "bot",
      verdict: "NO",
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(feedbackUpsert).not.toHaveBeenCalled();
    expect(copyObjectMock).not.toHaveBeenCalled();
  });
});

describe("recordClipFeedback write shape", () => {
  it("upserts on the (clipId, userId) pair", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "AS_IS",
      locale: "ru",
    });
    const arg = feedbackUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      clipId_userId: { clipId: "clip-1", userId: "user-1" },
    });
    expect(arg.create).toMatchObject({
      clipId: "clip-1",
      jobId: "job-1",
      userId: "user-1",
      surface: "bot",
      verdict: "AS_IS",
      locale: "ru",
    });
  });

  // A reason belongs to the verdict it was given under: changing the verdict
  // must not leave the old reason attached to the new one.
  it("clears the reason when only a verdict is submitted", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "EDIT",
    });
    expect(feedbackUpsert.mock.calls[0][0].update).toMatchObject({
      verdict: "EDIT",
      reason: null,
    });
  });

  // A note arrives separately (a reply, or the web field) and must survive a
  // later verdict change.
  it("does not touch the note when recording a verdict", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    expect(feedbackUpsert.mock.calls[0][0].update).not.toHaveProperty("note");
  });

  it("writes a reason without clearing it", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      reason: "FRAMING",
    });
    const arg = feedbackUpsert.mock.calls[0][0];
    expect(arg.update).toMatchObject({ reason: "FRAMING" });
    expect(arg.update).not.toHaveProperty("verdict");
  });

  // The verdict branch sets `reason: null` to clear a stale reason, and the
  // reason branch runs after it - so a call that submits both in one tap must
  // end with the NEW reason attached, not wiped by the clear it rides in on.
  it("keeps the reason when verdict and reason are submitted together", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
      reason: "FRAMING",
    });
    const arg = feedbackUpsert.mock.calls[0][0];
    expect(arg.update).toMatchObject({ verdict: "NO", reason: "FRAMING" });
  });

  // A reply or the web note field can arrive before any verdict tap. "NO"
  // would be a lie and "AS_IS" flattery, so the first-touch row must carry the
  // honest empty string, not a guessed verdict.
  it("records an honest empty-string verdict on a note-only first touch", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      note: "left field text",
    });
    expect(feedbackUpsert.mock.calls[0][0].create.verdict).toBe("");
  });
});

describe("snapshot", () => {
  it("freezes clip and job context and slices the transcript to the clip window", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    const snapshot = feedbackUpsert.mock.calls[0][0].create.snapshot;
    expect(snapshot).toMatchObject({
      title: "A title",
      startTime: 100,
      endTime: 142,
      duration: 42,
      score: 0.8,
      clipKind: "story",
      analyzeEngine: "recall-critic",
      highlightsVersion: 2,
      language: "en",
      cropPlan: { keyframes: 2, layout: "single" },
    });
    expect(snapshot.transcript).toBe("inside one inside two");
  });

  // A regression from strict `>`/`<` to `>=`/`<=` would silently start pulling
  // in the neighbour segments that only touch the window edge. Built as a
  // local fixture, not appended to the shared CLIP, so this does not disturb
  // any test that reuses CLIP without caring about its transcript.
  it("excludes segments that only touch the clip window boundary", async () => {
    const boundaryClip = {
      ...CLIP,
      job: {
        ...CLIP.job,
        transcriptJson: {
          segments: [
            // Ends exactly at startTime (100): s.end > startTime is false.
            { start: 90, end: 100, text: "ends-at-start" },
            { start: 101, end: 120, text: "inside one" },
            { start: 121, end: 141, text: "inside two" },
            // Starts exactly at endTime (142): s.start < endTime is false.
            { start: 142, end: 150, text: "starts-at-end" },
          ],
        },
      },
    };
    clipFindFirst.mockResolvedValue(boundaryClip);

    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    const snapshot = feedbackUpsert.mock.calls[0][0].create.snapshot;
    expect(snapshot.transcript).toBe("inside one inside two");
    expect(snapshot.transcript).not.toContain("ends-at-start");
    expect(snapshot.transcript).not.toContain("starts-at-end");
  });
});

describe("evidence copy", () => {
  it("copies the clip to the feedback prefix on first feedback", async () => {
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    expect(copyObjectMock).toHaveBeenCalledWith(
      "clips/clip-1.mp4",
      "feedback/clip-1.mp4"
    );
    expect(feedbackUpsert.mock.calls[0][0].create.evidenceKey).toBe(
      "feedback/clip-1.mp4"
    );
  });

  it("does not copy again when evidence already exists", async () => {
    feedbackFindUnique.mockResolvedValue({
      id: "fb-1",
      evidenceKey: "feedback/clip-1.mp4",
    });
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "EDIT",
    });
    expect(copyObjectMock).not.toHaveBeenCalled();
  });

  // The object may already be swept - feedback on an old clip is still worth
  // having, and a tap must never be refused because the video expired.
  it("records the feedback even when the copy fails", async () => {
    copyObjectMock.mockRejectedValue(new Error("NoSuchKey"));
    const result = await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    expect(result.ok).toBe(true);
    expect(feedbackUpsert).toHaveBeenCalled();
    expect(feedbackUpsert.mock.calls[0][0].create.evidenceKey).toBeNull();
  });
});

describe("owner relay", () => {
  it("relays feedback that carries text", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      note: "the face is cut off on the left",
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramMessageMock.mock.calls[0][1])).toContain(
      "the face is cut off on the left"
    );
    delete process.env.SUPPORT_CHAT_ID;
  });

  // Twelve clips per job makes a tap-only relay a firehose. Taps live in the
  // digest and the admin page instead.
  it("does not relay a bare verdict", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      verdict: "NO",
    });
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    delete process.env.SUPPORT_CHAT_ID;
  });

  // An empty note is still a note - it is written - but relaying an empty
  // message to the owner would be noise. `if (input.note)` is the guard;
  // pinning both halves so a regression to `!== undefined` is caught even
  // though it would leave every other test green.
  it("does not relay an empty-string note", async () => {
    process.env.SUPPORT_CHAT_ID = "999";
    const result = await recordClipFeedback({
      clipId: "clip-1",
      userId: "user-1",
      surface: "bot",
      note: "",
    });
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(feedbackUpsert.mock.calls[0][0].create.note).toBe("");
    delete process.env.SUPPORT_CHAT_ID;
  });
});
