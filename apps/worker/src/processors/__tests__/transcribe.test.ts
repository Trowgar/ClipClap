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
    mocks.execFile.mockImplementation((_cmd, _args, optsOrCb, maybeCb) => {
      // promisify(execFile) always passes the callback LAST, so adding an
      // options object moves it from the 3rd argument to the 4th.
      const callback = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
      return callback(null, { stdout: "12.5", stderr: "" });
    });
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

  it("includes an energy envelope key on both return paths", async () => {
    const result = await transcribeVideo("/tmp/source.mp4");
    // The suite's default execFile mock returns an empty stderr for every
    // call, astats included, so there is nothing to bucket - but the key
    // must be present and typed as an array either way.
    expect(result.energyEnvelope).toEqual([]);
  });

  it("does not fail transcription when the astats pass fails", async () => {
    // Only the astats call should fail; ffmpeg extract, ffprobe duration and
    // the whisper call must all keep succeeding on their own mocked replies.
    mocks.execFile.mockImplementation((_cmd, args, optsOrCb, maybeCb) => {
      const callback = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
      const argv = args as string[];
      if (argv.includes("astats=metadata=1:reset=1:length=1,ametadata=print:key=lavfi.astats.Overall.RMS_level")) {
        return callback(new Error("ffmpeg astats exploded"));
      }
      return callback(null, { stdout: "12.5", stderr: "" });
    });

    const result = await transcribeVideo("/tmp/source.mp4");

    expect(result.energyEnvelope).toEqual([]);
    expect(result.transcription.text).toBe("hello world");
  });

  it("includes a luma envelope key on both return paths", async () => {
    const result = await transcribeVideo("/tmp/source.mp4");
    // Same reasoning as the energy envelope test above: the default mock's
    // stderr is empty for every call, signalstats included, so there is
    // nothing to bucket - the key must still be present and array-typed.
    expect(result.lumaEnvelope).toEqual([]);
  });

  it("runs the signalstats pass against the ORIGINAL video path, not the extracted audio", async () => {
    await transcribeVideo("/tmp/source.mp4");
    const signalstatsCall = mocks.execFile.mock.calls.find((call) =>
      (call[1] as string[]).includes(
        "fps=1,signalstats,metadata=print:key=lavfi.signalstats.YAVG"
      )
    );
    expect(signalstatsCall).toBeDefined();
    const argv = signalstatsCall![1] as string[];
    expect(argv[argv.indexOf("-i") + 1]).toBe("/tmp/source.mp4");
  });

  it("does not fail transcription when the signalstats pass fails", async () => {
    // Only the signalstats call should fail; ffmpeg extract, ffprobe
    // duration, astats and the whisper call must all keep succeeding on
    // their own mocked replies.
    mocks.execFile.mockImplementation((_cmd, args, optsOrCb, maybeCb) => {
      const callback = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
      const argv = args as string[];
      if (argv.includes("fps=1,signalstats,metadata=print:key=lavfi.signalstats.YAVG")) {
        return callback(new Error("ffmpeg signalstats exploded"));
      }
      return callback(null, { stdout: "12.5", stderr: "" });
    });

    const result = await transcribeVideo("/tmp/source.mp4");

    expect(result.lumaEnvelope).toEqual([]);
    expect(result.transcription.text).toBe("hello world");
  });

  it("extracts compressed audio before sending it to transcription", async () => {
    await transcribeVideo("/tmp/source.mp4");

    expect(mocks.execFile).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-b:a", "32k"]),
      // The maxBuffer is asserted here rather than ignored: ffmpeg's stderr at
      // Node's 1 MiB default is what killed a real user's job, and silencedetect
      // in this same file emits a stderr line per silence over the whole audio.
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function)
    );
    const args = mocks.execFile.mock.calls[0][1] as string[];
    expect(args.at(-2)).toMatch(/\.mp3$/);
    expect(args).not.toContain("pcm_s16le");
    expect(mocks.createReadStream).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/));
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/));
  });
});
