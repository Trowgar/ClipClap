import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  createReadStream: vi.fn(() => "audio-stream"),
  statSync: vi.fn(() => ({ size: 1024 })),
  unlink: vi.fn(),
  transcriptionCreate: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("fs", () => ({
  createReadStream: mocks.createReadStream,
  statSync: mocks.statSync,
}));

vi.mock("fs/promises", () => ({
  unlink: mocks.unlink,
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: mocks.transcriptionCreate,
      },
    },
  })),
}));

import { transcribeVideo } from "../transcribe";

describe("transcribeVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // execFileAsync (via promisify) resolves with the value after the err arg;
    // ffprobe duration reads `.stdout`, ffmpeg extract ignores the result.
    mocks.execFile.mockImplementation((_cmd, _args, callback) =>
      callback(null, { stdout: "12.5", stderr: "" })
    );
    mocks.statSync.mockReturnValue({ size: 1024 });
    mocks.unlink.mockResolvedValue(undefined);
    mocks.transcriptionCreate.mockResolvedValue({
      text: "hello world",
      segments: [{ start: 0, end: 1.5, text: " hello world " }],
      words: [
        { word: "hello", start: 0, end: 0.6 },
        { word: "world", start: 0.7, end: 1.4 },
      ],
    });
  });

  it("requests word and segment granularity", async () => {
    await transcribeVideo("/tmp/source.mp4");
    expect(mocks.transcriptionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp_granularities: ["segment", "word"],
      })
    );
  });

  it("attaches words to their segment by time overlap", async () => {
    const result = await transcribeVideo("/tmp/source.mp4");
    expect(result.transcription.segments[0].words).toEqual([
      { text: "hello", start: 0, end: 0.6 },
      { text: "world", start: 0.7, end: 1.4 },
    ]);
  });

  it("survives a response without words (segment-only fallback)", async () => {
    mocks.transcriptionCreate.mockResolvedValue({
      text: "hello",
      segments: [{ start: 0, end: 1, text: " hello " }],
    });
    const result = await transcribeVideo("/tmp/source.mp4");
    expect(result.transcription.segments[0].words).toBeUndefined();
  });

  it("extracts compressed audio before sending it to transcription", async () => {
    await transcribeVideo("/tmp/source.mp4");

    expect(mocks.execFile).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-b:a", "32k"]),
      expect.any(Function)
    );
    const args = mocks.execFile.mock.calls[0][1] as string[];
    expect(args.at(-2)).toMatch(/\.mp3$/);
    expect(args).not.toContain("pcm_s16le");
    expect(mocks.createReadStream).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/));
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/));
  });
});
