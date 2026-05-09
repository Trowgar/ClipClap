import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  createReadStream: vi.fn(() => "audio-stream"),
  unlink: vi.fn(),
  transcriptionCreate: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("fs", () => ({
  createReadStream: mocks.createReadStream,
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
    mocks.execFile.mockImplementation((_cmd, _args, callback) => callback(null));
    mocks.unlink.mockResolvedValue(undefined);
    mocks.transcriptionCreate.mockResolvedValue({
      text: "hello",
      segments: [{ start: 0, end: 1, text: " hello " }],
    });
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
