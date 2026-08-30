import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

const mocks = vi.hoisted(() => ({
  startJobStep: vi.fn(),
  completeJobStep: vi.fn(),
  failJobStep: vi.fn(),
  jobFindUniqueOrThrow: vi.fn(),
  jobUpdate: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  clipUpdateMany: vi.fn(),
  clipCreate: vi.fn(),
  jobStepFindUnique: vi.fn(),
  queueAdd: vi.fn(),
  uploadFile: vi.fn(),
  downloadVideo: vi.fn(),
  cutClips: vi.fn(),
  probeTimeline: vi.fn(),
  generateThumbnail: vi.fn(),
}));

vi.mock("@clipclap/shared", () => ({
  jobStepService: {
    startJobStep: mocks.startJobStep,
    completeJobStep: mocks.completeJobStep,
    failJobStep: mocks.failJobStep,
  },
  prisma: {
    job: { findUniqueOrThrow: mocks.jobFindUniqueOrThrow, update: mocks.jobUpdate },
    user: { findUniqueOrThrow: mocks.userFindUniqueOrThrow },
    clip: { updateMany: mocks.clipUpdateMany, create: mocks.clipCreate },
    jobStep: { findUnique: mocks.jobStepFindUnique },
  },
  getStageQueue: () => ({ add: mocks.queueAdd }),
  uploadFile: mocks.uploadFile,
  computeClipExpiresAt: () => undefined,
}));

vi.mock("../processors/download", () => ({ downloadVideo: mocks.downloadVideo }));
vi.mock("../processors/cut", () => ({ cutClips: mocks.cutClips }));
vi.mock("../processors/normalize", () => ({ probeTimeline: mocks.probeTimeline }));
vi.mock("../processors/thumbnail", () => ({ generateThumbnail: mocks.generateThumbnail }));

import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { runRenderStage } from "../stages/render";

const workDir = mkdtempSync(join(tmpdir(), "safe-end-render-artifact-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function dockerFfmpeg(args: string[]): void {
  execFileSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${workDir}:/work`,
      "-w", "/work",
      "--entrypoint", "ffmpeg",
      "clipclapio-worker-render:latest",
      ...args,
    ],
    { stdio: "pipe" },
  );
}

function makeSource(path: string): void {
  dockerFfmpeg([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=96x96:rate=10", "-t", "30",
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1",
    "-pix_fmt", "yuv420p", "-map_metadata", "-1",
    "-metadata", "creation_time=1970-01-01T00:00:00Z", basename(path),
  ]);
}

function transcript() {
  const segments = Array.from({ length: 12 }, (_, index) => {
    const start = index * 5;
    return {
      start,
      end: start + 4.5,
      text: `Invented scene sentence ${index}.`,
      words: [
        { text: "Invented", start, end: start + 1 },
        { text: "scene", start: start + 1.1, end: start + 2 },
        { text: "sentence", start: start + 2.1, end: start + 3 },
        { text: `${index}.`, start: start + 3.1, end: start + 4.5 },
      ],
    };
  });
  return { text: segments.map((segment) => segment.text).join(" "), segments, language: "en" };
}

function recordedClient() {
  const replies: Record<string, unknown> = {
    scan_candidates: { candidates: [{ start_node: 2, end_node: 4, payoff_node: 3, interest: 0.9, type: "story", thread: null }] },
    critic_verdicts: { results: [{
      id: "c0", keep: true, score: 0.8, grounded: true, self_contained: true,
      start_node: 2, payoff_node: 3, end_node: 4, hook_start_node: 2, hook_end_node: 3,
      title: "Invented title", description: "Invented description.", title_evidence_nodes: [3],
      description_evidence_nodes: [3], language: "en",
    }] },
    safe_end_audit: { results: [{ id: "c0", outcome: "hard_handoff", reason: "next_question", extendToNode: null }] },
    clip_finalizer: { clips: [{ id: "c0", verdict: "ship", drop_reason: null, duplicate_of: null, shared_claim: null, title: null, title_evidence_nodes: null, trim_start_node: null }] },
  };
  const schemas: string[] = [];
  const create = vi.fn(async (body: { response_format: { json_schema: { name: string } } }) => {
    const schema = body.response_format.json_schema.name;
    schemas.push(schema);
    return {
      choices: [{ message: { content: JSON.stringify(replies[schema]), refusal: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  });
  return { client: { chat: { completions: { create } } } as never, schemas };
}

async function analyze(mode: "off" | "shadow") {
  const recorded = recordedClient();
  const result = await analyzeHighlightsV2(transcript(), {
    cfg: loadAnalyzeConfig({ SAFE_END_AUDIT: mode }),
    client: recorded.client,
    sourceDurationSec: 60,
  });
  return { ...result, schemas: recorded.schemas };
}

async function renderPersistedHighlights(label: string, highlights: unknown) {
  const sourcePath = join(workDir, `${label}-source.mp4`);
  const cutPath = join(workDir, `${label}-cut.mp4`);
  makeSource(sourcePath);
  let uploaded: Buffer | undefined;
  mocks.jobFindUniqueOrThrow.mockResolvedValue({
    id: `job-${label}`,
    normalizedArtifactKey: null,
    sourceArtifactKey: `work/u1/job-${label}/source.mp4`,
    transcriptJson: transcript(),
    highlights,
    subtitles: false,
  });
  mocks.downloadVideo.mockResolvedValue(sourcePath);
  mocks.cutClips.mockImplementationOnce(async (_sourcePath: string, [highlight]: Array<{ start: number; end: number }>) => {
    // The mock is the cutter seam, but it produces a genuine H.264 MP4 with the
    // same container FFmpeg the render worker ships. Its bytes are what the
    // mocked upload boundary retains below; no R2 request is made.
    dockerFfmpeg([
      "-y", "-ss", String(highlight.start), "-t", String(highlight.end - highlight.start),
      "-i", "/work/" + basename(sourcePath), "-map", "0:v:0", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
      "-metadata", "creation_time=1970-01-01T00:00:00Z", basename(cutPath),
    ]);
    return [{ highlight, clipPath: cutPath }];
  });
  mocks.uploadFile.mockImplementation(async (_key: string, filePath: string, mimeType: string) => {
    if (mimeType === "video/mp4") uploaded = readFileSync(filePath);
  });

  await runRenderStage({ mode: "clips", jobId: `job-${label}`, userId: "u1" });

  const cutInput = mocks.cutClips.mock.calls.at(-1)?.[1]?.[0];
  expect(uploaded).toBeDefined();
  return {
    cutInput,
    artifactBytes: uploaded!,
    artifactHash: createHash("sha256").update(uploaded!).digest("hex"),
  };
}

describe("safe-end shadow rendered-media invariance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REFRAME_ENGINE", "off");
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "off");
    mocks.userFindUniqueOrThrow.mockResolvedValue({ plan: "STARTER", billingCycle: "MONTHLY" });
    mocks.clipUpdateMany.mockResolvedValue({ count: 0 });
    mocks.clipCreate.mockResolvedValue({ id: "clip1" });
    mocks.jobStepFindUnique.mockResolvedValue(null);
    mocks.probeTimeline.mockResolvedValue({ formatStart: 0, videoStart: 0, audioStart: 0, hasAudio: false, hasVideo: true });
    mocks.generateThumbnail.mockRejectedValue(new Error("thumbnail intentionally out of scope"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders identical persisted media bytes for real V2 off and shadow analyzer results", async () => {
    const off = await analyze("off");
    const shadow = await analyze("shadow");

    expect(off.schemas).toEqual(["scan_candidates", "critic_verdicts", "clip_finalizer"]);
    expect(shadow.schemas).toEqual(["scan_candidates", "critic_verdicts", "safe_end_audit", "clip_finalizer"]);
    expect(shadow.highlights).toEqual(off.highlights);

    const offRender = await renderPersistedHighlights("off", structuredClone(off.highlights));
    const shadowRender = await renderPersistedHighlights("shadow", structuredClone(shadow.highlights));

    expect(shadowRender.cutInput).toEqual(offRender.cutInput);
    expect(shadowRender.artifactBytes.equals(offRender.artifactBytes)).toBe(true);
    expect(shadowRender.artifactHash).toBe(offRender.artifactHash);
  });
});
