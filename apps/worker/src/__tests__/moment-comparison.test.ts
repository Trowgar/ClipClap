import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compareMomentRuns } from "../scripts/eval-moment-quality";

it("does not turn unequal review coverage into a quality gain and includes empty sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "moment-comparison-"));
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  try {
    save("run.json", { highlights: [{ start: 10, end: 20 }] });
    save("empty.json", { highlights: [] });
    save("labels.json", [{ id: "a", start: 10, end: 20 }]);
    save("reviews.json", [{ index: 0, verdict: "publishable", momentId: "a" }]);
    save("manifest.json", [
      { id: "one", baselineFile: "run.json", candidateFile: "run.json", momentsFile: "labels.json", candidateReviewsFile: "reviews.json" },
      { id: "two", baselineFile: "empty.json", candidateFile: "empty.json", momentsFile: "labels.json" },
    ]);
    const result = compareMomentRuns(join(dir, "manifest.json"));
    expect(result.baseline).toMatchObject({ sources: 2, found: 1, missed: 1, recall: 0.5, meanFixedTop3Yield: null, publishableClipsPerSource: null });
    expect(result.candidate).toMatchObject({ sources: 2, found: 1, missed: 1, recall: 0.5, meanFixedTop3Yield: 1 / 6, publishableClipsPerSource: 0.5 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects degraded recorded runs even when the pipeline returned fallback clips", () => {
  const dir = mkdtempSync(join(tmpdir(), "moment-comparison-"));
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  try {
    save("run.json", { records: [{ request: { model: "example" } }], result: { highlights: [{ start: 10, end: 20 }] } });
    save("labels.json", []);
    save("manifest.json", [{ id: "failed-provider", baselineFile: "run.json", candidateFile: "run.json", momentsFile: "labels.json" }]);
    expect(() => compareMomentRuns(join(dir, "manifest.json"))).toThrow(/incomplete model call/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { choices: [] },
  { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
  { choices: [{ finish_reason: "stop", message: { refusal: "refused", content: "{}" } }] },
  { choices: [{ finish_reason: "stop", message: { content: "" } }] },
  { choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] },
])("rejects unsuccessful structured responses: %j", response => {
  const dir = mkdtempSync(join(tmpdir(), "moment-comparison-"));
  try {
    writeFileSync(join(dir, "run.json"), JSON.stringify({ records: [{ response }], result: { highlights: [] } }));
    writeFileSync(join(dir, "labels.json"), "[]");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ id: "one", baselineFile: "run.json", candidateFile: "run.json", momentsFile: "labels.json" }]));
    expect(() => compareMomentRuns(join(dir, "manifest.json"))).toThrow(/incomplete model call/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("accepts successful recorded structured responses", () => {
  const dir = mkdtempSync(join(tmpdir(), "moment-comparison-"));
  try {
    writeFileSync(join(dir, "run.json"), JSON.stringify({ records: [{ response: { choices: [{ finish_reason: "stop", message: { content: "{}" } }] } }], result: { highlights: [] } }));
    writeFileSync(join(dir, "labels.json"), "[]");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ id: "one", baselineFile: "run.json", candidateFile: "run.json", momentsFile: "labels.json" }]));
    expect(compareMomentRuns(join(dir, "manifest.json")).baseline.clips).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it.each(["failed", "degraded"])("rejects %s optional review even with completed primary calls", status => {
  const dir = mkdtempSync(join(tmpdir(), "moment-comparison-"));
  try {
    writeFileSync(join(dir, "run.json"), JSON.stringify({ records: [], result: {
      highlights: [{ start: 1, end: 2 }], telemetry: { supplementalRecall: { status, added: 0 } },
    } }));
    writeFileSync(join(dir, "labels.json"), "[]");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ id: "one", baselineFile: "run.json", candidateFile: "run.json", momentsFile: "labels.json" }]));
    expect(() => compareMomentRuns(join(dir, "manifest.json"))).toThrow(/supplemental review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("compares real feedback from snapshots separately from editorial opportunities", () => {
  const dir = mkdtempSync(join(tmpdir(), "moment-comparison-"));
  try {
    writeFileSync(join(dir, "old.json"), JSON.stringify({ highlights: [{ start: 10, end: 20 }] }));
    writeFileSync(join(dir, "new.json"), JSON.stringify({ highlights: [{ start: 10, end: 20 }, { start: 40, end: 60 }] }));
    writeFileSync(join(dir, "labels.json"), "[]");
    writeFileSync(join(dir, "feedback.json"), JSON.stringify([
      { verdict: "AS_IS", snapshot: { startTime: 40, endTime: 60 } },
      { verdict: "NO", snapshot: { startTime: 10, endTime: 20 } },
    ]));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ id: "one", baselineFile: "old.json", candidateFile: "new.json", momentsFile: "labels.json", feedbackFile: "feedback.json" }]));
    const result = compareMomentRuns(join(dir, "manifest.json"));
    expect(result.baseline.customerFeedback).toMatchObject({ accepted: 1, acceptedCovered: 0, rejectedRepeated: 1 });
    expect(result.candidate.customerFeedback).toMatchObject({ accepted: 1, acceptedCovered: 1, rejectedRepeated: 1 });
    expect(result.candidate.publishableClipsPerSource).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
