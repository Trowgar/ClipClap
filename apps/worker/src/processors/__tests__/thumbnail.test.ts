import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

import { generateThumbnail } from "../thumbnail";

describe("generateThumbnail", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    // promisify(execFile) invokes the original with a node-style callback last.
    execFileMock.mockImplementation((_file, _args, cb) =>
      cb(null, { stdout: "", stderr: "" })
    );
  });

  it("runs ffmpeg with the thumbnail filter and returns a jpg temp path", async () => {
    const out = await generateThumbnail("/tmp/source.mp4", 12.5);

    expect(out).toMatch(/clipclap-thumb-.*\.jpg$/);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [file, args] = execFileMock.mock.calls[0];
    expect(file).toBe("ffmpeg");
    expect(args).toEqual(
      expect.arrayContaining([
        "-ss",
        "12.5",
        "-i",
        "/tmp/source.mp4",
        "-frames:v",
        "1",
        "-vf",
        "thumbnail,scale=640:-2",
      ])
    );
    // Output path immediately precedes the trailing -y overwrite flag.
    expect(args[args.length - 1]).toBe("-y");
    expect(args[args.length - 2]).toBe(out);
  });

  it("clamps negative timestamps to 0", async () => {
    await generateThumbnail("/tmp/source.mp4", -5);
    const [, args] = execFileMock.mock.calls[0];
    const ssIndex = args.indexOf("-ss");
    expect(args[ssIndex + 1]).toBe("0");
  });
});
