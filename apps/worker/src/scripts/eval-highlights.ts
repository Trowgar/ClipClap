/**
 * Offline eval harness for the V2 highlight engine (spec gates, see
 * docs/superpowers/specs/2026-07-13-highlight-core-recall-judge-design.md section 11).
 *
 * Usage (inside a worker container, needs OPENAI_API_KEY):
 *   npx tsx src/scripts/eval-highlights.ts /app/eval/manifest.json
 *
 * Manifest: JSON array of cases. Each case:
 * {
 *   "id": "podcast-01",
 *   "transcriptJsonFile": "transcripts/podcast-01.json",  // relative to manifest dir; a Job.transcriptJson dump
 *   "expected": {
 *     "zeroClips": false,
 *     "language": "ru",
 *     "moments": [{ "start": 125.0, "end": 180.5, "payoffAt": 160.0 }]
 *   }
 * }
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { TranscriptionResult } from "@clipclap/shared";

interface EvalMoment {
  start: number;
  end: number;
  payoffAt?: number;
}

interface EvalCase {
  id: string;
  transcriptJsonFile: string;
  expected: { zeroClips?: boolean; language?: string; moments: EvalMoment[] };
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("usage: tsx src/scripts/eval-highlights.ts <manifest.json>");
    process.exit(1);
  }
  const cases: EvalCase[] = JSON.parse(readFileSync(manifestPath, "utf8"));
  const baseDir = dirname(manifestPath);
  const cfg = loadAnalyzeConfig();

  let momentsTotal = 0;
  let momentsFound = 0;
  const startErrors: number[] = [];
  const endErrors: number[] = [];
  let payoffContained = 0;
  let payoffTotal = 0;
  let languageWrong = 0;
  let zeroClipFalseNegatives = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const c of cases) {
    const transcription: TranscriptionResult = JSON.parse(
      readFileSync(join(baseDir, c.transcriptJsonFile), "utf8")
    );
    const result = await analyzeHighlightsV2(transcription, { cfg });
    totalInputTokens += result.usage.inputTokens;
    totalOutputTokens += result.usage.outputTokens;

    if (c.expected.zeroClips) {
      if (result.highlights.length > 0) {
        console.log(`[${c.id}] expected 0 clips, got ${result.highlights.length}`);
      }
      continue;
    }
    if (result.highlights.length === 0 && c.expected.moments.length > 0) {
      zeroClipFalseNegatives += 1;
      console.log(`[${c.id}] FALSE NEGATIVE: 0 clips (reason ${result.noClipsReason})`);
    }

    for (const m of c.expected.moments) {
      momentsTotal += 1;
      const hit = result.highlights.find((h) => {
        const overlap = Math.min(h.end, m.end) - Math.max(h.start, m.start);
        return overlap > 0.5 * (m.end - m.start);
      });
      if (!hit) continue;
      momentsFound += 1;
      startErrors.push(Math.abs(hit.start - m.start));
      endErrors.push(Math.abs(hit.end - m.end));
      if (m.payoffAt !== undefined) {
        payoffTotal += 1;
        if (hit.start < m.payoffAt && m.payoffAt <= hit.end) payoffContained += 1;
      }
      if (c.expected.language && hit.language && hit.language !== c.expected.language) {
        languageWrong += 1;
      }
    }
    console.log(
      `[${c.id}] clips=${result.highlights.length} tier=${String(result.telemetry["tier"] ?? "n/a")}`
    );
  }

  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
  const quantile = (xs: number[], q: number) => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };

  console.log("\n=== GATES (spec section 11) ===");
  console.log(`recall (shipped vs labeled)      ${pct(momentsFound, momentsTotal)}   gate >= 90%`);
  console.log(`median start error               ${quantile(startErrors, 0.5).toFixed(2)}s   gate <= 1.0s`);
  console.log(`median end error                 ${quantile(endErrors, 0.5).toFixed(2)}s   gate <= 1.0s`);
  console.log(`p95 boundary error               ${Math.max(quantile(startErrors, 0.95), quantile(endErrors, 0.95)).toFixed(2)}s   gate <= 3.0s`);
  console.log(`payoff containment               ${pct(payoffContained, payoffTotal)}   gate >= 98%`);
  console.log(`wrong-language copy              ${pct(languageWrong, momentsFound)}   gate <= 1%`);
  console.log(`0-clip false negatives           ${zeroClipFalseNegatives}   gate <= 1`);
  console.log(`tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
  console.log("(precision requires human judgment of shipped clips - review the per-case logs)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
