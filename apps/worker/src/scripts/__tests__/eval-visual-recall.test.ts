import { describe, expect, it } from "vitest";
import {
  matchesWindow,
  summarizeCases,
  parseEvalManifest,
  parseInvarianceEvidence,
  invarianceGate,
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

  it("cannot pass without a confirmed AS_IS positive window", () => {
    const summary = summarizeCases([{
      caseKey: "gaming-a",
      kind: "gaming",
      positiveWindows: [window(0, 10), window(100, 110)],
      negativeWindows: [],
      nominatedWindows: [window(0, 10), window(100, 110)],
      candidateCount: 2,
    }], { candidateCap: 12, offShadowInvariant: true });
    expect(summary.gates.asIsRetention).toBe(false);
    expect(summary.failureReasons).toContain("as_is_positive_window_not_retained");
    expect(summary.pass).toBe(false);
  });

  it("matches each nomination to at most one positive target", () => {
    const summary = summarizeCases([{
      caseKey: "gaming-a",
      kind: "gaming",
      positiveWindows: [window(0, 20), window(10, 30)],
      negativeWindows: [],
      nominatedWindows: [window(0, 30)],
      candidateCount: 1,
    }], { candidateCap: 12, offShadowInvariant: true });
    expect(summary.gamingMatchedWindows).toBe(1);
    expect(summary.gates.gamingMinimum).toBe(false);
  });
});

describe("visual recall manifest validation and CLI output", () => {
  it("accepts the documented anonymous manifest shape", () => {
    const manifest = parseEvalManifest({
      version: 1,
      invarianceEvidencePath: "/private/evidence.json",
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
    expect(() => parseEvalManifest({ version: 1, invarianceEvidencePath: "/private/evidence.json", cases: [] })).toThrow(/cases/i);
    expect(() => parseEvalManifest({
      version: 1,
      invarianceEvidencePath: "/private/evidence.json",
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
      invarianceEvidencePath: "/private/evidence.json",
      cases: [{
        caseKey: "gaming-a",
        kind: "gaming",
        sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 10)],
      }],
    })).toThrow(/window/i);
  });

  it("rejects duplicate positive or negative windows", () => {
    const base = {
      version: 1,
      invarianceEvidencePath: "/private/evidence.json",
      cases: [{
        caseKey: "gaming-a",
        kind: "gaming",
        sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 20), window(10, 20)],
      }],
    };
    expect(() => parseEvalManifest(base)).toThrow(/duplicate/i);
    expect(() => parseEvalManifest({
      ...base,
      cases: [{ ...base.cases[0], positiveWindows: [window(10, 20)], negativeWindows: [window(30, 40), window(30, 40)] }],
    })).toThrow(/duplicate/i);
  });

  it("rejects overlapping positive windows and duplicate source paths across cases", () => {
    const overlapping = {
      version: 1,
      invarianceEvidencePath: "/private/evidence.json",
      cases: [{
        caseKey: "gaming-a", kind: "gaming", sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 20), window(19, 30)],
      }],
    };
    expect(() => parseEvalManifest(overlapping)).toThrow(/overlap/i);
    expect(() => parseEvalManifest({
      ...overlapping,
      cases: [
        { ...overlapping.cases[0], positiveWindows: [window(10, 20)] },
        { ...overlapping.cases[0], caseKey: "gaming-b", transcriptPath: "/private/other.json", positiveWindows: [window(30, 40)] },
      ],
    })).toThrow(/sourcePath/i);
  });

  it("reports negative controls as an unavailable hit rate when none are supplied", () => {
    const summary = summarizeCases([{
      caseKey: "as-is-a", kind: "as_is", positiveWindows: [window(0, 10)],
      negativeWindows: [], nominatedWindows: [window(0, 10)], candidateCount: 1,
    }], { candidateCap: 12, offShadowInvariant: true });
    expect(summary.negativeWindowHitRate).toBeNull();
    expect(summary.negativeControlsAvailable).toBe(false);
  });

  it("requires local absolute paths and validates invariance evidence", () => {
    expect(() => parseEvalManifest({
      version: 1,
      invarianceEvidencePath: "https://example.test/evidence.json",
      cases: [{
        caseKey: "gaming-a", kind: "gaming", sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json", positiveWindows: [window(10, 20)],
      }],
    })).toThrow(/local|absolute|path/i);
    expect(() => parseInvarianceEvidence({
      version: 1, passed: true, testName: "wrong",
      offHighlightsSha256: "0".repeat(64), shadowHighlightsSha256: "0".repeat(64),
      testedCommit: "0".repeat(40),
    })).toThrow(/testName/i);
    expect(parseInvarianceEvidence({
      version: 1, passed: true, testName: "visual-recall-wiring",
      offHighlightsSha256: "a".repeat(64), shadowHighlightsSha256: "a".repeat(64),
      testedCommit: "b".repeat(40),
    }).passed).toBe(true);
  });

  it("requires invariance evidence to match the evaluated commit and clean worktree", () => {
    const evidence = parseInvarianceEvidence({
      version: 1, passed: true, testName: "visual-recall-wiring",
      offHighlightsSha256: "a".repeat(64), shadowHighlightsSha256: "a".repeat(64),
      testedCommit: "b".repeat(40),
    });
    expect(invarianceGate(evidence, "c".repeat(40), false)).toBe(false);
    expect(invarianceGate(evidence, "b".repeat(40), true)).toBe(false);
    expect(invarianceGate(evidence, "b".repeat(40), false)).toBe(true);
  });

  it("prints sanitized JSON and exits nonzero for a failed gate", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const result = await runVisualRecallCli(
      ["node", "eval-visual-recall.ts", "/private/manifest.json"],
      {
        stat: async () => ({ size: 100, isFile: () => true }),
        readFile: async (path) => {
          if (path === "/private/manifest.json") {
            return JSON.stringify({
              version: 1,
              invarianceEvidencePath: "/private/invariance.json",
              cases: [{
                caseKey: "production-looking-job-id-123",
                kind: "gaming",
                sourcePath: "/private/secret-source.mp4",
                transcriptPath: "/private/secret-transcript.json",
                positiveWindows: [window(10, 20)],
              }],
            });
          }
          if (path === "/private/invariance.json") {
            return JSON.stringify({
              version: 1,
              passed: false,
              testName: "visual-recall-wiring",
              offHighlightsSha256: "a".repeat(64),
              shadowHighlightsSha256: "b".repeat(64),
              testedCommit: "c".repeat(40),
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
    expect(serialized).not.toContain("production-looking-job-id-123");
    expect(serialized).toContain('"separatelyVerified"');
    expect(JSON.parse(serialized).pass).toBe(false);
  });

  it("passes the invariance gate only when injected commit and clean state match", async () => {
    const output: string[] = [];
    const commit = "d".repeat(40);
    const result = await runVisualRecallCli(
      ["node", "eval-visual-recall.ts", "/private/manifest.json"],
      {
        stat: async () => ({ size: 100, isFile: () => true }),
        readFile: async (path) => {
          if (path.endsWith("manifest.json")) return JSON.stringify({
            version: 1,
            invarianceEvidencePath: "/private/invariance.json",
            cases: [{
              caseKey: "anonymous-gaming",
              kind: "gaming",
              sourcePath: "/private/source.mp4",
              transcriptPath: "/private/transcript.json",
              positiveWindows: [window(10, 14), window(20, 24)],
            }, {
              caseKey: "anonymous-as-is",
              kind: "as_is",
              sourcePath: "/private/source2.mp4",
              transcriptPath: "/private/transcript2.json",
              positiveWindows: [window(10, 14)],
            }],
          });
          if (path.endsWith("invariance.json")) return JSON.stringify({
            version: 1,
            passed: true,
            testName: "visual-recall-wiring",
            offHighlightsSha256: "a".repeat(64),
            shadowHighlightsSha256: "a".repeat(64),
            testedCommit: commit,
          });
          return JSON.stringify({
            text: "private words",
            segments: [{
              start: 10, end: 20, text: "Private words.",
              words: [{ text: "private", start: 10, end: 12 }, { text: "words", start: 12, end: 14 }],
            }, {
              start: 20, end: 24, text: "More private words.",
              words: [{ text: "more", start: 20, end: 21 }, { text: "words", start: 21, end: 23 }],
            }],
          });
        },
        stdout: (value) => output.push(value),
        stderr: () => undefined,
      },
      {
        resolveCurrentCommit: async () => commit,
        resolveWorktreeDirty: async () => false,
        videoEnvelopes: async () => ({ lumaEnvelope: [], motionEnvelope: [0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0] }),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output.join("")).offShadowInvariant).toMatchObject({
      separatelyVerified: true,
      passed: true,
    });
  });

  it("hands the stable source descriptor to the envelope processor", async () => {
    let receivedFd = -1;
    const commit = "e".repeat(40);
    const manifest = JSON.stringify({
      version: 1,
      invarianceEvidencePath: "/private/invariance.json",
      cases: [{
        caseKey: "anonymous-gaming",
        kind: "gaming",
        sourcePath: "/private/source.mp4",
        transcriptPath: "/private/transcript.json",
        positiveWindows: [window(10, 20)],
      }],
    });
    const evidence = JSON.stringify({
      version: 1, passed: true, testName: "visual-recall-wiring",
      offHighlightsSha256: "a".repeat(64), shadowHighlightsSha256: "a".repeat(64), testedCommit: commit,
    });
    const transcript = JSON.stringify({
      text: "words",
      segments: [{ start: 10, end: 14, text: "Words.", words: [{ text: "words", start: 10, end: 12 }] }],
    });
    const result = await runVisualRecallCli(
      ["node", "eval-visual-recall.ts", "/private/manifest.json"],
      {
        stat: async () => ({ size: 100, isFile: () => true }),
        readFile: async () => manifest,
        open: async (path) => ({
          fd: path.endsWith("source.mp4") ? 73 : 74,
          stat: async () => ({ size: 100, isFile: () => true }),
          readFile: async () => path.endsWith("manifest.json") ? manifest : path.endsWith("invariance.json") ? evidence : transcript,
          close: async () => undefined,
        }),
        stdout: () => undefined,
        stderr: () => undefined,
      },
      {
        resolveCurrentCommit: async () => commit,
        resolveWorktreeDirty: async () => false,
        videoEnvelopesFromFd: async (fd) => {
          receivedFd = fd;
          return { lumaEnvelope: [], motionEnvelope: [0, 10, 0] };
        },
      },
    );
    expect(receivedFd).toBe(73);
    expect(result.exitCode).toBe(1);
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
