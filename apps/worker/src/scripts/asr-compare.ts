// apps/worker/src/scripts/asr-compare.ts
/**
 * ASR provider comparison harness - Groq ASR spec §4.
 *
 * COSTS MONEY on first run per (source, model): each missing capture is bought
 * from the live API and cached as JSON next to the corpus audio, so re-runs
 * are free and the captures are the measurement record.
 *
 * Run inside a worker container with the corpus copied to /tmp/asr-corpus
 * (Task 4 of the plan has the exact docker compose cp commands):
 *
 *   tsx src/scripts/asr-compare.ts --dir /tmp/asr-corpus/asr-russian --id cmsrx4ob30003i1jxfle15qef --control
 *   tsx src/scripts/asr-compare.ts --dir /tmp/asr-corpus/asr-arabic --id cmsoarjd00079uhfjfj72esb9
 *
 * --control buys ONE extra whisper-1 run (the same-audio self-jitter yardstick
 * of spec §4.1). Needs OPENAI_API_KEY (in the container env) and GROQ_API_KEY
 * (pass with docker compose exec -e).
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { alignTokens } from "./asr-align";
import { loadTranscript } from "./asr-metrics";
import { whisperLanguageToIso } from "../analyze-v2/language";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function capture(
  client: OpenAI,
  model: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  if (existsSync(outPath)) {
    console.log(`  cached: ${outPath}`);
    return;
  }
  console.log(`  BUYING ${model} -> ${outPath}`);
  const startedAt = Date.now();
  // Exactly whisperCall's request (transcribe.ts): verbose_json, word+segment
  // granularities, no language hint - the single-call production path.
  const response = await client.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model,
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
  });
  const elapsedMs = Date.now() - startedAt;
  writeFileSync(
    outPath,
    JSON.stringify({ ...(response as object), _meta: { model, elapsedMs, recordedAt: new Date().toISOString() } })
  );
  console.log(`  done in ${(elapsedMs / 1000).toFixed(1)}s`);
}

async function main() {
  const dir = arg("dir");
  const id = arg("id");
  if (!dir || !id) {
    console.error("usage: asr-compare.ts --dir <corpus dir> --id <jobId> [--control]");
    process.exit(1);
  }
  const audio = join(dir, `${id}.mp3`);
  const referencePath = join(dir, `${id}.whisper1.json`);
  if (!existsSync(audio) || !existsSync(referencePath)) {
    console.error(`missing ${audio} or ${referencePath}`);
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is not set - pass it with docker compose exec -e");
    process.exit(1);
  }

  const candidates: Array<{ label: string; path: string }> = [];
  if (has("control")) {
    const p = join(dir, `${id}.whisper1-control.json`);
    await capture(openai, "whisper-1", audio, p);
    candidates.push({ label: "whisper-1 control (self-jitter)", path: p });
  }
  for (const model of GROQ_MODELS) {
    const p = join(dir, `${id}.groq-${model}.json`);
    await capture(groq, model, audio, p);
    candidates.push({ label: `groq ${model}`, path: p });
  }

  const reference = loadTranscript(JSON.parse(readFileSync(referencePath, "utf8")));
  const refCovPct = reference.totalSpanSec > 0 ? (100 * reference.coveredSec) / reference.totalSpanSec : 0;
  console.log(`\n== ${id} vs stored whisper-1 reference ==`);
  console.log(
    `reference: ${reference.tokens.length} tokens, coverage ${reference.coveredSec.toFixed(0)}s` +
      ` (${refCovPct.toFixed(1)}%), language ${reference.languageRaw}`
  );
  console.log(
    "| candidate | subs | ins | del | per-1k tokens | coverage | Δcov pp | monotonicity | language -> iso | call |"
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of candidates) {
    const parsed = JSON.parse(readFileSync(c.path, "utf8"));
    const t = loadTranscript(parsed);
    const a = alignTokens(reference.tokens, t.tokens);
    const per1k = ((a.substitutions + a.insertions + a.deletions) * 1000) / Math.max(1, a.tokensA);
    const covPct = t.totalSpanSec > 0 ? (100 * t.coveredSec) / t.totalSpanSec : 0;
    const iso = t.languageRaw ? whisperLanguageToIso(t.languageRaw) : null;
    const call = parsed._meta ? `${(parsed._meta.elapsedMs / 1000).toFixed(1)}s` : "-";
    console.log(
      `| ${c.label} | ${a.substitutions} | ${a.insertions} | ${a.deletions} | ${per1k.toFixed(1)}` +
        ` | ${t.coveredSec.toFixed(0)}s (${covPct.toFixed(1)}%) | ${(covPct - refCovPct).toFixed(1)}` +
        ` | ${t.monotonicityViolations} | ${t.languageRaw} -> ${iso} | ${call} |`
    );
  }
  console.log(
    "\nSpec §4.5 rule: a Groq model passes if its per-1k-token delta is within 2x of the" +
      "\nwhisper-1 control row (indel-dominant profile preserved), Δcov within 5pp, iso correct."
  );
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
