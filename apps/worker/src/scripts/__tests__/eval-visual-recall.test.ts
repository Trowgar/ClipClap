import { describe, expect, it } from "vitest";
import {
  matchesWindow,
  summarizeCases,
  parseEvalManifest,
  runVisualRecallCli,
  type EvalCaseResult,
} from "../eval-visual-recall";

const window = (start: number, end: number) => ({ start, end });

describe("visual recall evaluation metrics", () => {
  it("uses inclusive 20 percent overlap of the shorter window", () => {
    expect(matchesWindow(window(100, 120), window(110, 130), 0.2)).toBe(true);
    expect(matchesWindow(window(100, 120), window(110, 130), 20)).toBe(true);
    expect(matchesWindow(window(0, 10), window(8, 20), 0.2)).toBe(true);
    expect(matchesWindow(window(0, 10), window(8.01, 20), 0.2)).toBe(false);
    expect(matchesWindow(window(0, 10), window(10, 20), 0.2)).toBe(false);
  });

  it("rejects malformed and non-positive windows", () => {
    expect(matchesWindow(window(0, 0), window(0, 1), 0.2)).toBe(false);
    expect(matchesWindow(window(-1, 1), window(0, 1), 0.2)).toBe(false);
    expect(matchesWindow(window(0, 1), window(0, 1), 1.2)).toBe(false);
  });

  it("aggregates recall and reports each independent gate reason", () => {
    const cases: EvalCaseResult[] = [
      {
        caseKey: "gaming-a",
        kind: "gaming",
        positiveWindows: [window(0, 10), window(100, 110), window(200, 210)],
        negativeWindows: [window(300, 310)],
        nominatedWindows: [window(1, 9), window(102, 108)],
        candidateCount: 2,
      },
      {
        caseKey: "as-is-a",
        kind: "as_is",
        positiveWindows: [window(400, 410)],
        negativeWindows: [],
        nominatedWindows: [window(401, 409)],
        candidateCount: 1,
      },
    ];

    const summary = summarizeCases(cases, {
      candidateCap: 12,
      offShadowInvariant: true,
    });

    expect(summary.positiveRecall).toBeCloseTo(0.75);
    expect(summary.gamingMatchedWindows).toBe(2);
    expect(summary.gates).toEqual({
      gamingMinimum: true,
      asIsRetention: true,
      candidateCap: true,
      offShadowInvariant: true,
    });
    expect(summary.pass).toBe(true);
  });

  it("fails gaming minimum, AS_IS retention, cap, and separate invariance gates", () => {
    const summary = summarizeCases([
      {
        caseKey: "gaming-a",
        kind: "gaming",
        positiveWindows: [window(0, 10), window(100, 110)],
        negativeWindows: [],
        nominatedWindows: [window(0, 1)],
        candidateCount: 13,
      },
      {
        caseKey: "as-is-a",
        kind: "as_is",
        positiveWindows: [window(200, 210)],
        negativeWindows: [],
        nominatedWindows: [],
        candidateCount: 0,
      },
    ], { candidateCap: 12, offShadowInvariant: false });

    expect(summary.pass).toBe(false);
    expect(summary.gates).toEqual({
      gamingMinimum: false,
      asIsRetention: false,
      candidateCap: false,
      offShadowInvariant: false,
    });
    expect(summary.failureReasons).toEqual([
      "gaming_positive_recall_below_two_windows",
      "as_is_positive_window_not_retained",
      "candidate_cap_exceeded",
      "off_shadow_invariance_not_verified",
    ]);
  });
});

describe("visual recall manifest validation and CLI output", () => {
  it("accepts the documented anonymous manifest shape", () => {
    const manifest = parseEvalManifest({
      version: 1,
      offShadowInvariant: true,
      cases: [{
        caseKey: "gaming-a",
        kind: "gaming",
        sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 20)],
      }],
    });
    expect(manifest.cases[0].caseKey).toBe("gaming-a");
  });

  it("rejects malformed manifests with a bounded case/window shape", () => {
    expect(() => parseEvalManifest({ version: 1, offShadowInvariant: true, cases: [] })).toThrow(/cases/i);
    expect(() => parseEvalManifest({
      version: 1,
      offShadowInvariant: true,
      cases: [{
        caseKey: "../production-id",
        kind: "gaming",
        sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 20)],
      }],
    })).toThrow(/caseKey/i);
    expect(() => parseEvalManifest({
      version: 1,
      offShadowInvariant: true,
      cases: [{
        caseKey: "gaming-a",
        kind: "gaming",
        sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 10)],
      }],
    })).toThrow(/window/i);
  });

  it("prints sanitized JSON and exits nonzero for a failed gate", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const result = await runVisualRecallCli(
      ["node", "eval-visual-recall.ts", "/private/manifest.json"],
      {
        stat: async () => ({ size: 100 }),
        readFile: async (path) => {
          if (path === "/private/manifest.json") {
            return JSON.stringify({
              version: 1,
              offShadowInvariant: false,
              cases: [{
                caseKey: "gaming-a",
                kind: "gaming",
                sourcePath: "/private/secret-source.mp4",
                transcriptPath: "/private/secret-transcript.json",
                positiveWindows: [window(10, 20)],
              }],
            });
          }
          return JSON.stringify({
            text: "private transcript text",
            segments: [{ start: 10, end: 20, text: "private transcript text", words: [] }],
          });
        },
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      },
      {
        loadConfig: () => ({
          visualRecallMode: "shadow",
          visualRecallMaxCandidates: 12,
        }),
        videoEnvelopes: async () => ({ lumaEnvelope: [], motionEnvelope: [0, 10, 0] }),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(errors).toHaveLength(0);
    const serialized = output.join("");
    expect(serialized).not.toContain("secret-source");
    expect(serialized).not.toContain("secret-transcript");
    expect(serialized).not.toContain("private transcript text");
    expect(serialized).toContain('"offShadowInvariant"');
    expect(JSON.parse(serialized).pass).toBe(false);
  });

  it("supports help without reading a manifest", async () => {
    const output: string[] = [];
    const result = await runVisualRecallCli(
      ["node", "eval-visual-recall.ts", "--help"],
      {
        stat: async () => { throw new Error("must not read"); },
        readFile: async () => { throw new Error("must not read"); },
        stdout: (value) => output.push(value),
        stderr: () => undefined,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(output.join(" ")).toMatch(/caseKey|offShadowInvariant|positiveWindows/);
  });
});
