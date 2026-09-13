/** Offline comparison of recorded real-source runs and separately authored labels.
 * tsx src/scripts/eval-moment-quality.ts /private/manifest.json
 * Manifest: [{ id, baselineFile, candidateFile, momentsFile,
 *              baselineReviewsFile?, candidateReviewsFile?, feedbackFile? }]
 * Paths are relative to the manifest. Run files hold {result:{highlights:[]}}
 * or a raw analyzer result. Review absence stays unknown, never a negative.
 * Output is aggregate metrics plus per-source results; no transcript or title.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { measureMomentQuality, type ClipReview, type MomentLabel } from "../evaluation/moment-metrics";
import { measureCustomerFeedback } from "../evaluation/customer-feedback";

interface ComparisonCase { id: string; baselineFile: string; candidateFile: string; momentsFile: string; baselineReviewsFile?: string; candidateReviewsFile?: string; feedbackFile?: string }
type RecordedCall = {
  request?: {
    messages?: { content?: unknown }[];
    response_format?: { json_schema?: { name?: string } };
  };
  response?: { choices?: { finish_reason?: string; message?: { content?: string; refusal?: string } }[] };
};
const arrayKeyBySchema: Record<string, string> = {
  scan_candidates: "candidates",
  critic_verdicts: "results",
  arc_audit: "results",
  end_extension: "results",
  clip_finalizer: "clips",
  publishability_review: "clips",
  safe_end_audit: "results",
};
function expectedIds(record: RecordedCall, schema: string): string[] {
  const contents = record.request?.messages
    ?.flatMap(message => typeof message.content === "string" ? [message.content] : []) ?? [];
  const text = contents.join("\n");
  if (schema === "publishability_review") {
    try {
      const input = JSON.parse(contents.at(-1) ?? "");
      return Array.isArray(input)
        ? input.flatMap(row => row && typeof row === "object" && typeof row.id === "string" ? [row.id] : [])
        : [];
    } catch { return []; }
  }
  const marker = schema === "critic_verdicts" ? "CANDIDATE" : "CLIP";
  return [...text.matchAll(new RegExp(`^${marker}\\s+([^\\s|(-]+)`, "gm"))].map(match => match[1]);
}
function completedCall(record: RecordedCall | null): boolean {
  const choice = record?.response?.choices?.[0];
  if (choice?.finish_reason !== "stop" || choice.message?.refusal || !choice.message?.content) return false;
  try {
    const parsed = JSON.parse(choice.message.content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const schema = record?.request?.response_format?.json_schema?.name;
    if (schema === "copy_repair") {
      return typeof parsed.title === "string" && typeof parsed.description === "string";
    }
    const arrayKey = schema ? arrayKeyBySchema[schema] : undefined;
    if (!arrayKey || !Array.isArray(parsed[arrayKey])) return false;
    const expected = expectedIds(record ?? {}, schema!);
    if (!expected.length) return true;
    const actual = parsed[arrayKey]
      .flatMap((row: unknown) => {
        const id = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
        return typeof id === "string" ? [id] : [];
      });
    if (schema === "critic_verdicts" && actual.length > 0 &&
        new Set(actual).size === actual.length && actual.every((id: string) => expected.includes(id))) {
      // Critic omissions have a dedicated retry and terminal telemetry. The
      // run-level omittedDrops check below proves that retry recovered them.
      return true;
    }
    return actual.length === expected.length &&
      new Set(actual).size === actual.length &&
      expected.every(id => actual.includes(id));
  } catch { return false; }
}

function hasIncompleteQualityReview(value: any): boolean {
  const telemetry = (value.result ?? value).telemetry;
  if (!telemetry || typeof telemetry !== "object") return false;
  return ["omittedDrops", "truncatedDrops", "refusalDrops"].some(key => Number(telemetry[key]) > 0) ||
    Number(telemetry.arcAudit?.unaudited) > 0 ||
    Number(telemetry.deliveredPayoffAudit?.unaudited) > 0 ||
    telemetry.finalizerFallbackUsed === true ||
    (typeof telemetry.finalizerSkipped === "string" && telemetry.finalizerSkipped !== "disabled") ||
    (typeof telemetry.publishability?.skipped === "string" && telemetry.publishability.skipped !== "disabled");
}
export function compareMomentRuns(manifestPath: string) {
  const read = (path: string) => JSON.parse(readFileSync(resolve(dirname(manifestPath), path), "utf8"));
  const cases: ComparisonCase[] = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(cases) || !cases.length || cases.some(c => !c.id) || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("manifest needs unique nonempty source IDs");
  const rows = cases.map(c => {
    const moments: MomentLabel[] = read(c.momentsFile);
    const run = (path: string, reviewsPath?: string) => {
      const value = read(path);
      // The analyzer can return fallback clips after provider failures. Those
      // outputs are availability evidence, not a valid quality comparison.
      if (value.error || (value.records !== undefined && (!Array.isArray(value.records) || !value.records.every(completedCall)))) {
        throw new Error(`${c.id}: incomplete model call or failed run in ${path}`);
      }
      if (hasIncompleteQualityReview(value)) {
        throw new Error(`${c.id}: incomplete quality review in ${path}`);
      }
      const supplemental = (value.result ?? value).telemetry?.supplementalRecall;
      if (supplemental && ["failed", "degraded"].includes(supplemental.status)) {
        throw new Error(`${c.id}: incomplete supplemental review in ${path}`);
      }
      const reviews: ClipReview[] = reviewsPath ? read(reviewsPath) : [];
      const clips = (value.result ?? value).highlights;
      return { ...measureMomentQuality(clips, moments, reviews),
        ...(c.feedbackFile ? { customerFeedback: measureCustomerFeedback(clips, read(c.feedbackFile)) } : {}) };

    };
    return { id: c.id, baseline: run(c.baselineFile, c.baselineReviewsFile), candidate: run(c.candidateFile, c.candidateReviewsFile) };
  });
  const aggregate = (mode: "baseline" | "candidate") => {
    const sum = (field: "moments" | "found" | "publishableClips" | "boringClips" | "clips" | "unknownClips") => rows.reduce((n, r) => n + r[mode][field], 0);
    const moments = sum("moments"), found = sum("found");
    const top = (key: "top3" | "top5", k: number) => {
      const delivered = rows.reduce((n, r) => n + r[mode][key].delivered, 0);
      const reviewed = rows.reduce((n, r) => n + r[mode][key].reviewed, 0);
      const publishable = rows.reduce((n, r) => n + r[mode][key].publishable, 0);
      const slots = rows.length * k;
      const complete = delivered === reviewed;
      return {
        slots,
        delivered,
        reviewed,
        publishable,
        precision: complete ? publishable / slots : null,
        deliveredPrecision: complete && delivered ? publishable / delivered : null,
      };
    };
    const rate = (key: "boundaries" | "incomplete" | "crossScene") => {
      const assessed = rows.reduce((n, r) => n + r[mode][key].assessed, 0);
      const failed = rows.reduce((n, r) => n + r[mode][key].failed, 0);
      return { assessed, failed, rate: assessed ? failed / assessed : null };
    };
    const top3 = top("top3", 3), top5 = top("top5", 5);
    const boundaries = rate("boundaries"), incomplete = rate("incomplete"), crossScene = rate("crossScene");
    const feedbackSum = (key: keyof ReturnType<typeof measureCustomerFeedback>) =>
      rows.reduce((n, r) => n + (r[mode].customerFeedback?.[key] ?? 0), 0);
    const customerFeedback = cases.some(c => c.feedbackFile) ? {
      measuredSources: cases.filter(c => c.feedbackFile).length,
      accepted: feedbackSum("accepted"), acceptedCovered: feedbackSum("acceptedCovered"),
      rejected: feedbackSum("rejected"), rejectedRepeated: feedbackSum("rejectedRepeated"),
      editRequested: feedbackSum("editRequested"),
    } : undefined;
    return { ...(customerFeedback ? { customerFeedback } : {}), sources: rows.length, moments, found, missed: moments - found, recall: moments ? found / moments : null,
      missedGoodMomentsPerSource: (moments - found) / rows.length,
      clips: sum("clips"), publishableClipsPerSource: sum("unknownClips") ? null : sum("publishableClips") / rows.length,
      publishableClipsPerSourceLowerBound: sum("publishableClips") / rows.length,
      boringClips: sum("boringClips"), boringRate: sum("unknownClips") ? null : sum("boringClips") / sum("clips"), unknownClips: sum("unknownClips"),
      precisionAt3: top3.precision, precisionAt5: top5.precision,
      badBoundaryRate: boundaries.rate, incompleteRate: incomplete.rate, crossSceneRate: crossScene.rate,
      assessments: { top3, top5, boundaries, incomplete, crossScene },
      // Zero-output sources remain in the denominator.
      meanFixedTop3Yield: rows.some(r => r[mode].top3.fixedKYield === null) ? null : rows.reduce((n, r) => n + r[mode].top3.fixedKYield!, 0) / rows.length,
      meanFixedTop5Yield: rows.some(r => r[mode].top5.fixedKYield === null) ? null : rows.reduce((n, r) => n + r[mode].top5.fixedKYield!, 0) / rows.length,
    };
  };
  return { baseline: aggregate("baseline"), candidate: aggregate("candidate"), sources: rows };
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error("usage: eval-moment-quality.ts <manifest.json>");
  console.log(JSON.stringify(compareMomentRuns(process.argv[2]), null, 2));
}
