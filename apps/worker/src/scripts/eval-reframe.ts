/**
 * Visual harness for the reframe engine.
 *
 *   npx tsx src/scripts/eval-reframe.ts <video> <start> <end> [outDir]
 *
 * Writes <outDir>/plan.json and <outDir>/sheet.jpg - the computed plan and a
 * contact sheet of frames rendered through it. Reframe decisions are checked
 * against pixels, not against argument.
 */
import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { computeCropPlan } from "../reframe";
import { loadReframeConfig } from "../reframe/config";
import { buildFiltergraph } from "../reframe/filtergraph";

const execFileAsync = promisify(execFile);

async function main() {
  const [video, startArg, endArg, outArg] = process.argv.slice(2);
  if (!video || !startArg || !endArg) {
    console.error(
      "usage: tsx src/scripts/eval-reframe.ts <video> <start> <end> [outDir]"
    );
    process.exit(1);
  }
  const start = Number(startArg);
  const end = Number(endArg);
  const outDir = outArg || "/tmp/eval-reframe";
  await mkdir(outDir, { recursive: true });

  const cfg = { ...loadReframeConfig(), engine: "faces" as const };
  const result = await computeCropPlan(video, start, end, cfg);
  await writeFile(
    join(outDir, "plan.json"),
    JSON.stringify(result, null, 2),
    "utf-8"
  );
  console.log(
    `shots=${result.shotCount} detectMs=${result.detectMs} fallback=${result.fallbackReason ?? "none"}`
  );
  if (!result.plan) {
    console.log("no plan - nothing to render");
    return;
  }
  console.log(JSON.stringify(result.plan.profile ?? {}, null, 2));

  const spec = buildFiltergraph(result.plan);
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
    // Input seeking rebases output timestamps to ~0, so the clip-relative
    // `enable` windows of the FIRST shot are what a single grabbed frame
    // activates - whatever absolute time it came from. The sheet therefore
    // shows tile geometry, not the time-windowing (spec §12).
    if (spec.kind === "vf") args.push("-vf", `${spec.graph},setsar=1`);
    else args.push("-filter_complex", spec.graph, "-map", "[vout]");
    args.push("-q:v", "3", join(outDir, `f${i}.jpg`), "-y");
    await execFileAsync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
  }
  await execFileAsync("ffmpeg", [
    "-nostdin", "-v", "error",
    "-pattern_type", "glob", "-i", join(outDir, "f*.jpg"),
    "-filter_complex", "scale=270:480,setsar=1,tile=6x1",
    "-frames:v", "1", "-q:v", "3", join(outDir, "sheet.jpg"), "-y",
  ]);
  console.log(`wrote ${join(outDir, "sheet.jpg")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
