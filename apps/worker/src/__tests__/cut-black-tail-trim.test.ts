import { beforeEach, describe, expect, it, vi } from "vitest";

// Black-tail trim (spec 2026-08-25-cjk-subtitles.md §Black-tail trim, design
// B). Job cmt8155fa: moment selection snapped the exit to a payoff-like line
// ("il vient de mourir") right where the source cuts to black for 3.5s - the
// rendered clip ends on a blank frame with the caption still on screen.
// RENDER_BLACK_TAIL_TRIM probes the source's own last PROBE_SEC=2s with
// blackdetect and, when the clip genuinely ends on black, pulls the cut end
// back to just before black starts.
//
// stderr fixtures always carry BOTH black_start and black_end on the same
// line - verified against a real ffmpeg 8.0.1 build (this container) and the
// real French source that under our exact -ss/-t/-f null command, blackdetect
// ALWAYS flushes black_end, even when the black period runs all the way to
// the probe's own end (0.02-0.04s short of the nominal duration, hence
// BLACK_TAIL_END_TOLERANCE_SEC). A black_start-only line is not a shape real
// ffmpeg produces here and is not exercised.
//
// Reference numbers from the spec's real French evidence: source black
// starts 74.83, clip nominal end 75.06 -> trimmed to ~74.79 (MARGIN_SEC 0.04),
// and the caption ("vient de mourir", ends 74.76) survives.

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({
  // promisify(execFile) always passes the callback LAST.
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { cutClips, resolveBlackTailEnd } from "../processors/cut";

function callback(rest: unknown[]) {
  return rest.find((a) => typeof a === "function") as (
    err: Error | null,
    res: { stdout: string; stderr: string }
  ) => void;
}

function options(rest: unknown[]) {
  return rest.find(
    (a) => typeof a === "object" && a !== null
  ) as Record<string, unknown> | undefined;
}

/** True for the probe's own ffmpeg invocation (`-f null -`); false for the
 *  actual cut, which always names a real output file instead. */
function isProbeCall(args: string[]): boolean {
  return args.includes("-f") && args[args.indexOf("-f") + 1] === "null";
}

const SOURCE = "/tmp/fake-source.mp4";
const highlight = { start: 57.9, end: 75.06, title: "clip", reason: "test" };

// end=75.06 -> probe covers [probeStart, end] = [73.06, 75.06], probeDuration
// 2s. Every stderr fixture below is relative to that probe window.
const PROBE_DURATION = 2;

describe("resolveBlackTailEnd", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
  });

  it("(a) trims to black_start - MARGIN_SEC when black_end lands within tolerance of the probe's true end (0.02s short - the realistic ffmpeg 8.0.1 shape)", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // black_start:1.77 -> source-absolute 74.83 (the French evidence
    // number). black_end:1.98 = PROBE_DURATION - 0.02, inside the 0.08s
    // tolerance - blackdetect really did flush this close to the probe end.
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, {
        stdout: "",
        stderr: "black_start:1.77 black_end:1.98 black_duration:0.21",
      });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(result.end).toBeCloseTo(74.79, 5);
    expect(result.trimmedSec).toBeCloseTo(0.27, 5);
  });

  it("(a) probe argv: accurate seek before -i, correct -t, -an, the exact blackdetect filter, and the -f null - tail", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    let probeArgs: string[] | null = null;
    execFileMock.mockImplementation((_cmd, args, ...rest) => {
      probeArgs = args;
      callback(rest)(null, {
        stdout: "",
        stderr: "black_start:1.77 black_end:1.98 black_duration:0.21",
      });
    });

    await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(probeArgs).not.toBeNull();
    const args = probeArgs!;
    // Accurate seek: -ss BEFORE -i, not after (input seeking, not the slow
    // decode-and-discard form) - probeStart = end - PROBE_SEC = 75.06 - 2.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("73.06");
    expect(args[args.indexOf("-t") + 1]).toBe("2");
    expect(args).toContain("-an");
    expect(args[args.indexOf("-vf") + 1]).toBe("blackdetect=d=0.1:pix_th=0.10");
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("(b) does not trim when the black period closes well before the probe's own end (a mid-window flash)", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // Probe duration is 2s; black closes at relative 1.0, a full second of
    // real footage follows before the probed segment (and the clip) ends.
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, {
        stdout: "",
        stderr: "black_start:0.7 black_end:1.0 black_duration:0.3",
      });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
  });

  it("(b2) adversarial: black_end 0.13s short of the probe's true end - just OUTSIDE the 0.08s tolerance - does not trim", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // black_end at PROBE_DURATION - 0.13 = 1.87: real content follows for
    // 0.13s before the probe (and the clip) actually ends. Close enough to
    // the boundary that a loose tolerance would wrongly trim this.
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, {
        stdout: "",
        stderr: `black_start:1.5 black_end:${PROBE_DURATION - 0.13} black_duration:0.37`,
      });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
  });

  it("(c) does not trim when black starts earlier than the final MAX_TRIM_SEC (1.5s) - a moment-selection problem, not a tail", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // black_start relative 0.3 -> source-absolute 73.36, which is 1.70s
    // before the end - past the 1.5s ceiling. black_end within tolerance so
    // this actually reaches the distance-cap gate, not the "no match" path.
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, {
        stdout: "",
        stderr: "black_start:0.3 black_end:1.98 black_duration:1.68",
      });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
  });

  it("(cap) never applies more than MAX_TRIM_SEC even when black_start sits exactly on the 1.5s boundary (margin would otherwise push it to 1.54s)", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // black_start relative 0.50 -> source-absolute 73.56 -> raw distance from
    // end (75.06) is EXACTLY 1.5s. Subtracting MARGIN_SEC naively would trim
    // 1.54s; the clamp must keep the APPLIED trim at <= 1.5s.
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, {
        stdout: "",
        stderr: "black_start:0.50 black_end:1.98 black_duration:1.48",
      });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(75.06 - result.end).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(result.trimmedSec).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it("(d) does not trim, and never throws, when the probe itself fails", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(new Error("ffmpeg exited 1"), { stdout: "", stderr: "" });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("(d2) does not trim when the probe times out, and the probe is actually run with a 5s timeout", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // node's execFile sets killed:true (and usually a signal) on a timeout.
    const timeoutError = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
    });
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(timeoutError, { stdout: "", stderr: "" });
    });

    const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);

    expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
    const opts = options(execFileMock.mock.calls[0].slice(2));
    expect(opts?.timeout).toBe(5000);
  });

  it("(e) is inert - never invokes the probe - unless the flag is the exact literal \"on\"", async () => {
    const stderrThatWouldTrim = "black_start:1.77 black_end:1.98 black_duration:0.21";
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, { stdout: "", stderr: stderrThatWouldTrim });
    });

    for (const value of ["off", "ON", "true", "1"]) {
      vi.stubEnv("RENDER_BLACK_TAIL_TRIM", value);
      const result = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);
      expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
    }
    delete process.env.RENDER_BLACK_TAIL_TRIM;
    const unset = await resolveBlackTailEnd(SOURCE, 57.9, 75.06, "job1", 0);
    expect(unset).toEqual({ end: 75.06, trimmedSec: 0 });

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("(f) skips a trim that would drop the clip below the minimum duration floor", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    // start=65, end=75.06: nominal duration 10.06s. A trim to ~74.79 would
    // leave 9.79s - under the 12s floor - so the trim is skipped even though
    // the black-tail condition itself is satisfied.
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, {
        stdout: "",
        stderr: "black_start:1.77 black_end:1.98 black_duration:0.21",
      });
    });

    const result = await resolveBlackTailEnd(SOURCE, 65, 75.06, "job1", 0);

    expect(result).toEqual({ end: 75.06, trimmedSec: 0 });
  });
});

describe("cutClips black-tail trim wiring", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
  });

  it("threads the trimmed end into the real cut's -to argument and into CutResult.effectiveEnd", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    let cutArgs: string[] | null = null;
    execFileMock.mockImplementation((_cmd, args, ...rest) => {
      const cb = callback(rest);
      if (isProbeCall(args)) {
        cb(null, {
          stdout: "",
          stderr: "black_start:1.77 black_end:1.98 black_duration:0.21",
        });
      } else {
        cutArgs = args;
        cb(null, { stdout: "", stderr: "" });
      }
    });

    const [result] = await cutClips(SOURCE, [highlight], undefined, null, undefined, {
      jobId: "job1",
      clipIndex: 0,
    });

    expect(cutArgs).not.toBeNull();
    expect(cutArgs![cutArgs!.indexOf("-to") + 1]).toBe("74.79");
    expect(result.effectiveEnd).toBeCloseTo(74.79, 5);
  });

  it("never probes and cuts at the nominal end when no blackTailTrim context is supplied, even with the flag on - byte-identical to every call site that doesn't opt in", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "on");
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, { stdout: "", stderr: "" });
    });

    const [result] = await cutClips(SOURCE, [highlight]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-to") + 1]).toBe("75.06");
    expect(result.effectiveEnd).toBe(75.06);
  });

  it("(e) flag off: the probe never runs and the cut args are identical to today even WITH a trim context supplied", async () => {
    vi.stubEnv("RENDER_BLACK_TAIL_TRIM", "off");
    execFileMock.mockImplementation((_cmd, _args, ...rest) => {
      callback(rest)(null, { stdout: "", stderr: "" });
    });

    const [result] = await cutClips(SOURCE, [highlight], undefined, null, undefined, {
      jobId: "job1",
      clipIndex: 0,
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf("-to") + 1]).toBe("75.06");
    expect(result.effectiveEnd).toBe(75.06);
  });
});
