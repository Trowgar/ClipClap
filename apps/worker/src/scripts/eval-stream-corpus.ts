/**
 * Corpus harness for stream-reframe-v2 (spec 2026-08-19-stream-reframe-v2,
 * task D). Runs every hand-labeled probe in .corpus/stream-v2/probes through
 * computeCropPlan twice - REFRAME_STREAM on and off - and reports:
 *
 *   - a per-entry table: class/reason/camRectScore/faceFrac/detectMs/verdict
 *   - the D6 "crosshair visible" check for every entry that classified stream
 *   - an OFF-parity assertion for the three controls (llHw/DOMER/buster):
 *     class must match AND the plan must be byte-identical on/off
 *
 * Modeled on eval-reframe.ts - same computeCropPlan/loadReframeConfig import
 * style and the same contact-sheet ffmpeg pattern, duplicated here (not
 * imported) because eval-reframe.ts is owned by other in-flight work.
 *
 *   npx tsx src/scripts/eval-stream-corpus.ts [probesDir] [outDir]
 */
import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { computeCropPlan } from "../reframe";
import { loadReframeConfig, type ReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";
import type { CropPlan } from "../reframe/types";

const execFileAsync = promisify(execFile);

const CORPUS = [
  { file: "strogo.mp4", start: 5, end: 45, expect: "stream", note: "CS2 corner-flush TL cam" },
  { file: "tox_4X88jJU.mp4", start: 2, end: 29, expect: "stream", note: "react, borderless BR cam (needs virtual-cam task)" },
  { file: "Rtt2StnXpxw.mp4", start: 5, end: 40, expect: "stream", note: "Minecraft floating TL cam" },
  { file: "tw-recrent.mp4", start: 2, end: 28, expect: "stream", note: "Elden Ring floating ML cam" },
  { file: "llHwLxzg_Fk.mp4", start: 2, end: 30, expect: "faceless", note: "Dota, no cam - control" },
  { file: "8sMckL_u1n4.mp4", start: 2, end: 18, expect: "normal_face", note: "fullscreen face - control" },
  { file: "tw-buster.mp4", start: 1, end: 15, expect: "normal_face", note: "fullscreen IRL - control" },
] as const;

/** Reproduces eval-reframe.ts's per-clip contact-sheet rendering, namespaced
 *  per corpus entry so multiple runs can share one outDir. */
async function renderSheet(
  video: string,
  plan: CropPlan,
  start: number,
  end: number,
  outDir: string,
  fileTag: string
): Promise<void> {
  const spec = buildFiltergraph(plan);
  const frames = 6;
  const step = (end - start) / frames;
  for (let i = 0; i < frames; i++) {
    const t = start + step * i;
    const args = [
      "-nostdin", "-v", "error",
      "-ss", String(t),
      "-i", video,
      "-frames:v", "1",
    ];
    if (spec.kind === "vf") args.push("-vf", `${spec.graph},setsar=1`);
    else args.push("-filter_complex", spec.graph, "-map", "[vout]");
    args.push("-q:v", "3", join(outDir, `${fileTag}.f${i}.jpg`), "-y");
    await execFileAsync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
  }
  await execFileAsync("ffmpeg", [
    "-nostdin", "-v", "error",
    "-pattern_type", "glob", "-i", join(outDir, `${fileTag}.f*.jpg`),
    "-filter_complex", "scale=270:480,setsar=1,tile=6x1",
    "-frames:v", "1", "-q:v", "3", join(outDir, `${fileTag}.sheet.jpg`), "-y",
  ]);
}

function fmtNum(v: number | undefined, digits: number): string {
  return v === undefined ? "-" : v.toFixed(digits);
}

function row(cols: string[], widths: number[]): string {
  return cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
}

const WIDTHS = [18, 12, 16, 6, 6, 8, 6];

async function main() {
  const [probesArg, outArg] = process.argv.slice(2);
  const probesDir = resolve(process.cwd(), probesArg || ".corpus/stream-v2/probes");
  const outDir = outArg || "/tmp/eval-stream-corpus";
  await mkdir(outDir, { recursive: true });

  const base = loadReframeConfig();
  const cfgOn: ReframeConfig = { ...base, engine: "faces", stream: true };
  const cfgOff: ReframeConfig = { ...base, engine: "faces", stream: false };

  console.log(row(
    ["file", "class", "reason", "camScr", "faceFr", "detMs", "verdict"],
    WIDTHS
  ));

  let expectedOk = 0;
  const controls = CORPUS.filter((e) => e.expect !== "stream");
  let controlsClean = 0;
  let controlInvariantBroken = false;

  const streamRows: string[] = [];

  for (const entry of CORPUS) {
    const video = join(probesDir, entry.file);
    const isControl = entry.expect !== "stream";

    const resultOn = await computeCropPlan(video, entry.start, entry.end, cfgOn);
    const resultOff = await computeCropPlan(video, entry.start, entry.end, cfgOff);

    const profile = resultOn.plan?.profile;
    const classLabel = profile?.class ?? `FALLBACK(${resultOn.fallbackReason ?? "unknown"})`;
    const classMatches = profile?.class === entry.expect;
    if (classMatches) expectedOk++;

    let verdict: "OK" | "MISS" | "DRIFT" = classMatches ? "OK" : "MISS";
    if (classMatches && isControl) {
      const shotsOnStr = JSON.stringify(resultOn.plan?.shots ?? null);
      const shotsOffStr = JSON.stringify(resultOff.plan?.shots ?? null);
      const classOffMatches = profile?.class === resultOff.plan?.profile?.class;
      if (shotsOnStr !== shotsOffStr || !classOffMatches) verdict = "DRIFT";
    }
    if (isControl) {
      if (verdict === "OK") controlsClean++;
      else controlInvariantBroken = true; // MISS or DRIFT on a control
    }

    console.log(row(
      [
        entry.file,
        classLabel,
        profile?.reason ?? "-",
        fmtNum(profile?.camRectScore, 2),
        fmtNum(profile?.faceFrac, 3),
        String(resultOn.detectMs),
        verdict,
      ],
      WIDTHS
    ));

    await writeFile(
      join(outDir, `${entry.file}.plan.json`),
      JSON.stringify(resultOn.plan, null, 2),
      "utf-8"
    );
    if (resultOn.plan) {
      await renderSheet(video, resultOn.plan, entry.start, entry.end, outDir, entry.file);
    }

    if (profile?.class === "stream" && resultOn.plan) {
      const plan = resultOn.plan;
      const sourceWidth = plan.source.width;
      const contentW = plan.stream?.contentCrop.w;
      const centerX = sourceWidth / 2;
      const streamShots = plan.shots.filter((s) => s.layout === "stream");
      if (streamShots.length === 0 || contentW === undefined) {
        streamRows.push(`${entry.file}: class=stream but no stream shot/geometry found - CENTER-OUT`);
      } else {
        streamShots.forEach((s, i) => {
          const x = s.layout === "stream" ? s.content.x : NaN;
          const inside = centerX >= x && centerX <= x + contentW;
          streamRows.push(
            `${entry.file} shot${i}: content x=${x} w=${contentW} center=${centerX} ` +
            `${inside ? "OK" : "CENTER-OUT"}`
          );
        });
      }
    }
  }

  console.log("");
  console.log("content crop check (D6 crosshair visible):");
  if (streamRows.length === 0) console.log("  (no entries classified stream)");
  for (const line of streamRows) console.log(`  ${line}`);

  console.log("");
  console.log(`${expectedOk}/7 expected, ${controlsClean}/${controls.length} controls clean`);

  if (controlInvariantBroken) {
    console.log("CONTROL INVARIANT BROKEN: a control MISSed its class or DRIFTed on/off - see table above");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
