/** Offline comparison of recorded real-source runs and separately authored labels.
 * tsx src/scripts/eval-moment-quality.ts /private/manifest.json
 * Manifest: [{ id, baselineFile, candidateFile, momentsFile,
 *              baselineReviewsFile?, candidateReviewsFile? }]
 * Paths are relative to the manifest. Run files hold {result:{highlights:[]}}
 * or a raw analyzer result. Review absence stays unknown, never a negative.
 * Output is aggregate metrics plus per-source results; no transcript or title.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { measureMomentQuality, type ClipReview, type MomentLabel } from "../evaluation/moment-metrics";

interface ComparisonCase { id: string; baselineFile: string; candidateFile: string; momentsFile: string; baselineReviewsFile?: string; candidateReviewsFile?: string }
type RecordedCall = { response?: { choices?: { finish_reason?: string; message?: { content?: string; refusal?: string } }[] } };
function completedCall(record: RecordedCall | null): boolean {
  const choice = record?.response?.choices?.[0];
  if (choice?.finish_reason !== "stop" || choice.message?.refusal || !choice.message?.content) return false;
  try { JSON.parse(choice.message.content); return true; } catch { return false; }
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
      const reviews: ClipReview[] = reviewsPath ? read(reviewsPath) : [];
      return measureMomentQuality((value.result ?? value).highlights, moments, reviews);
    };
    return { id: c.id, baseline: run(c.baselineFile, c.baselineReviewsFile), candidate: run(c.candidateFile, c.candidateReviewsFile) };
  });
  const aggregate = (mode: "baseline" | "candidate") => {
    const sum = (field: "moments" | "found" | "publishableClips" | "boringClips" | "clips" | "unknownClips") => rows.reduce((n, r) => n + r[mode][field], 0);
    const moments = sum("moments"), found = sum("found");
    return { sources: rows.length, moments, found, missed: moments - found, recall: moments ? found / moments : null,
      clips: sum("clips"), publishableClipsPerSource: sum("unknownClips") ? null : sum("publishableClips") / rows.length,
      publishableClipsPerSourceLowerBound: sum("publishableClips") / rows.length,
      boringClips: sum("boringClips"), unknownClips: sum("unknownClips"),
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
