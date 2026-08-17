// apps/worker/src/scripts/eval-cut-recovery.ts
/**
 * Cut recovery, measured on the director-audit corpus (spec §3).
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-cut-recovery.ts [--only clipId,clipId] [--rejected-sample 30]"
 *
 * For every manifest item: ONE detection (probe + scdet + sidecar), then the
 * plan with the flag OFF and with it ON from that same detection. Prints:
 *   - OFF invariant: the OFF plan's shots equal the PRODUCTION shots persisted
 *     in the manifest (start/end within 1e-3, layout and x exact);
 *   - ON vs OFF: seconds where the window moves by more than 0.25 cropW,
 *     shot counts, candidate verdicts;
 *   - one contact sheet per diff span (red = OFF window, green = ON window)
 *     and one per sampled REJECTED candidate (red = OFF window at t-0.5/t+0.5),
 *     under .corpus/director-audit/eval-cut-recovery/.
 * Read-only against DB and R2 (needs the corpus on disk: director-audit-fetch.ts).
 */
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { detectRange, planDetected } from "../reframe";
import { loadReframeConfig } from "../reframe/config";
import { cropWidthFor } from "../reframe/geometry";
import type { CutDecision, CutRecoveryTelemetry } from "../reframe/cut-recovery";
import type { CropPlan, ShotLayout } from "../reframe/types";
import { loadManifest, workerRoot, type DirectorAuditItem } from "./director-audit-fetch";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);
const DIFF_FRAC = 0.25;
const GRID_SEC = 0.5;

interface Span {
  t0: number;
  t1: number;
  xOff: number;
  xOn: number;
}

interface ClipReport {
  clip: string;
  job: string;
  start: number;
  end: number;
  offInvariant: boolean | "no_plan";
  fallback?: string;
  shotsDetector: number;
  shotsOff: number;
  shotsOn: number;
  diffSec: number;
  cmpSec: number;
  spans: Span[];
  telemetry?: CutRecoveryTelemetry;
  decisions: Array<{ t: number; score: number; verdict: CutDecision }>;
  /** Source class OFF -> ON; a flip means one split re-laid-out the whole clip. */
  profileOff?: string;
  profileOn?: string;
  profileFlip: boolean;
  /** Confirmed splits whose ON sub-shot fell to a centre crop where OFF had a face window. */
  facelessSubShots: number;
  sheets: string[];
}

function shotAt(plan: CropPlan, t: number): ShotLayout | undefined {
  return plan.shots.find((s) => t >= s.start && t < s.end);
}

function xAt(plan: CropPlan, t: number): number | null {
  for (const s of plan.shots) {
    if (t >= s.start && t < s.end) {
      return s.layout === "single" || s.layout === "center" ? s.x : null;
    }
  }
  return null;
}

function shotsEqual(persisted: DirectorAuditItem["shots"], shots: ShotLayout[]): boolean {
  if (persisted.length !== shots.length) return false;
  return persisted.every((p, i) => {
    const s = shots[i];
    const x = s.layout === "single" || s.layout === "center" ? s.x : NaN;
    return (
      p.layout === s.layout &&
      Math.abs(p.start - s.start) < 1e-3 &&
      Math.abs(p.end - s.end) < 1e-3 &&
      (Number.isNaN(x) || p.x === x)
    );
  });
}

function diffPlans(
  off: CropPlan,
  on: CropPlan,
  duration: number,
  cropW: number
): { diffSec: number; cmpSec: number; spans: Span[] } {
  let diffSec = 0;
  let cmpSec = 0;
  const spans: Span[] = [];
  let cur: Span | null = null;
  for (let t = GRID_SEC / 2; t < duration; t += GRID_SEC) {
    const a = xAt(off, t);
    const b = xAt(on, t);
    if (a === null || b === null) {
      if (cur) spans.push(cur);
      cur = null;
      continue;
    }
    cmpSec += GRID_SEC;
    if (Math.abs(a - b) > DIFF_FRAC * cropW) {
      diffSec += GRID_SEC;
      if (cur && cur.xOff === a && cur.xOn === b) cur.t1 = t + GRID_SEC / 2;
      else {
        if (cur) spans.push(cur);
        cur = { t0: t - GRID_SEC / 2, t1: t + GRID_SEC / 2, xOff: a, xOn: b };
      }
    } else if (cur) {
      spans.push(cur);
      cur = null;
    }
  }
  if (cur) spans.push(cur);
  return { diffSec, cmpSec, spans };
}

/** Source frames at absolute times with the OFF window in red and (optionally)
 *  the ON window in green, tiled into one JPEG. */
async function sheet(
  source: string,
  frames: Array<{ abs: number; xOff: number; xOn?: number }>,
  cropW: number,
  out: string
): Promise<void> {
  const tmp: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const boxes = [`drawbox=x=${f.xOff}:y=0:w=${cropW}:h=ih:color=red@0.9:t=8`];
    if (f.xOn !== undefined) {
      boxes.push(`drawbox=x=${f.xOn}:y=8:w=${cropW}:h=ih-16:color=lime@0.9:t=6`);
    }
    const path = `${out}.${i}.jpg`;
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-v", "error",
        "-ss", Math.max(0, f.abs).toFixed(2),
        "-i", source,
        "-frames:v", "1",
        "-vf", `${boxes.join(",")},scale=480:270`,
        "-q:v", "3", "-y", path,
      ],
      { maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    tmp.push(path);
  }
  const cols = Math.min(frames.length, 3);
  const rows = Math.ceil(frames.length / cols);
  // Proven on this ffmpeg (8.0) during the audit: glob the numbered tiles in.
  await execFileAsync(
    "ffmpeg",
    [
      "-nostdin", "-v", "error",
      "-pattern_type", "glob", "-i", `${out}.*.jpg`,
      "-filter_complex", `tile=${cols}x${rows}:padding=2:color=white`,
      "-frames:v", "1", "-q:v", "3", "-y", out,
    ],
    { maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  await Promise.all(tmp.map((p) => rm(p, { force: true })));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const manifest = await loadManifest();
  const only = arg("--only")?.split(",");
  const rejectedSample = Number(arg("--rejected-sample") ?? "30");
  const corpus = join(workerRoot(), manifest.outDir);
  const outDir = join(corpus, "eval-cut-recovery");
  await mkdir(outDir, { recursive: true });
  const cfg = { ...loadReframeConfig(), engine: "faces" as const };
  const reports: ClipReport[] = [];

  for (const item of manifest.items) {
    if (only && !only.includes(item.clip)) continue;
    const source = join(corpus, "sources", `${item.job}.mp4`);
    const duration = item.end - item.start;
    const det = await detectRange(source, item.start, item.end, cfg, Date.now() + cfg.maxDetectSec * 1000);
    if (!det.ok) {
      console.log(`${item.clip} DETECTION FAILED ${det.fallbackReason}`);
      reports.push({
        clip: item.clip, job: item.job, start: item.start, end: item.end,
        offInvariant: "no_plan", fallback: det.fallbackReason,
        shotsDetector: det.shotCount, shotsOff: 0, shotsOn: 0, diffSec: 0, cmpSec: 0,
        spans: [], decisions: [], profileFlip: false, facelessSubShots: 0, sheets: [],
      });
      continue;
    }
    const off = planDetected(det.detection, { ...cfg, cutRecovery: false });
    const on = planDetected(det.detection, { ...cfg, cutRecovery: true });
    const decisions = on.decisions ?? [];
    const cropW = cropWidthFor(det.detection.height);
    // A confirmed split whose sub-shot lost its faces to the noise floor and fell
    // to centre where OFF had a face window - the regression the Task 2 review
    // asked to be counted rather than guarded against.
    let facelessSubShots = 0;
    if (off.plan && on.plan) {
      for (const d of decisions) {
        if (d.verdict !== "confirmed") continue;
        const offAt = shotAt(off.plan, d.t);
        const onAt = shotAt(on.plan, d.t);
        const onBefore = shotAt(on.plan, d.t - 0.01);
        if (offAt?.layout === "single" && (onAt?.layout === "center" || onBefore?.layout === "center")) {
          facelessSubShots += 1;
        }
      }
    }
    const offInvariant = off.plan ? shotsEqual(item.shots, off.plan.shots) : "no_plan";
    const d = off.plan && on.plan ? diffPlans(off.plan, on.plan, duration, cropW) : { diffSec: 0, cmpSec: 0, spans: [] };
    const sheets: string[] = [];
    for (const [k, s] of d.spans.entries()) {
      const mid = (s.t0 + s.t1) / 2;
      const times = [s.t0 + 0.3, mid, Math.max(s.t0 + 0.3, s.t1 - 0.3)].map((t) => item.start + t);
      const outPath = join(outDir, `diff-${item.clip}-${k}-${s.t0.toFixed(1)}-${s.t1.toFixed(1)}.jpg`);
      await sheet(source, times.map((abs) => ({ abs, xOff: s.xOff, xOn: s.xOn })), cropW, outPath);
      sheets.push(outPath);
    }
    const r: ClipReport = {
      clip: item.clip, job: item.job, start: item.start, end: item.end,
      offInvariant, shotsDetector: det.shotCount,
      shotsOff: off.plan?.shots.length ?? 0, shotsOn: on.plan?.shots.length ?? 0,
      diffSec: d.diffSec, cmpSec: d.cmpSec, spans: d.spans,
      telemetry: on.cutRecovery, decisions: decisions.map(({ t, score, verdict }) => ({ t, score, verdict })),
      profileOff: off.plan?.profile?.class, profileOn: on.plan?.profile?.class,
      profileFlip: (off.plan?.profile?.class ?? "none") !== (on.plan?.profile?.class ?? "none"),
      facelessSubShots,
      sheets,
    };
    reports.push(r);
    console.log(
      `${item.clip} start=${item.start.toFixed(1)} off=${offInvariant} shots ${r.shotsDetector}/${r.shotsOff}->${r.shotsOn} ` +
        `diff ${r.diffSec.toFixed(1)}s of ${r.cmpSec.toFixed(1)}s ` +
        `cand ${r.telemetry?.candidates ?? 0} conf ${r.telemetry?.confirmed ?? 0} rej ${JSON.stringify(r.telemetry?.rejected ?? {})} cap ${r.telemetry?.capHit ?? 0}` +
        (r.profileFlip ? ` PROFILE FLIP ${r.profileOff}->${r.profileOn}` : "") +
        (r.facelessSubShots ? ` facelessSubShots ${r.facelessSubShots}` : "") +
        (r.spans.length ? ` spans ${JSON.stringify(r.spans.map((s) => [s.t0, s.t1, s.xOff, s.xOn]))}` : "")
    );
  }

  // Rejected-candidate sample: every k-th rejected candidate across the corpus.
  const rejected = reports.flatMap((r) =>
    r.decisions.filter((x) => x.verdict !== "confirmed" && x.verdict !== "capHit").map((x) => ({ r, x }))
  );
  const step = Math.max(1, Math.floor(rejected.length / Math.max(1, rejectedSample)));
  const sampled = rejected.filter((_, i) => i % step === 0).slice(0, rejectedSample);
  for (const [k, { r, x }] of sampled.entries()) {
    const item = manifest.items.find((i) => i.clip === r.clip)!;
    const source = join(corpus, "sources", `${item.job}.mp4`);
    const shot = item.shots.find((s) => x.t >= s.start && x.t < s.end);
    const cropW = cropWidthFor(item.source.height);
    const outPath = join(outDir, `rejected-${k}-${r.clip}-${x.t.toFixed(2)}-${x.verdict}.jpg`);
    await sheet(
      source,
      [
        { abs: item.start + x.t - 0.5, xOff: shot?.x ?? 0 },
        { abs: item.start + x.t + 0.5, xOff: shot?.x ?? 0 },
      ],
      cropW,
      outPath
    );
  }

  const ok = reports.filter((r) => r.offInvariant === true).length;
  const total = reports.length;
  const diffSec = reports.reduce((a, r) => a + r.diffSec, 0);
  const cmpSec = reports.reduce((a, r) => a + r.cmpSec, 0);
  const sum = (f: (r: ClipReport) => number) => reports.reduce((a, r) => a + f(r), 0);
  console.log("");
  console.log(`OFF invariant: ${ok}/${total}`);
  console.log(`diff: ${diffSec.toFixed(1)}s of ${cmpSec.toFixed(1)}s (${((100 * diffSec) / Math.max(1, cmpSec)).toFixed(2)}%), clips with diff ${reports.filter((r) => r.diffSec > 0).length}`);
  console.log(`shots: detector ${sum((r) => r.shotsDetector)}, plan off ${sum((r) => r.shotsOff)}, plan on ${sum((r) => r.shotsOn)}`);
  console.log(
    `candidates ${sum((r) => r.telemetry?.candidates ?? 0)} confirmed ${sum((r) => r.telemetry?.confirmed ?? 0)} ` +
      `noTurnover ${sum((r) => r.telemetry?.rejected.noTurnover ?? 0)} oneSideEmpty ${sum((r) => r.telemetry?.rejected.oneSideEmpty ?? 0)} ` +
      `tooShort ${sum((r) => r.telemetry?.rejected.tooShort ?? 0)} noPath ${sum((r) => r.telemetry?.rejected.noPath ?? 0)} capHit ${sum((r) => r.telemetry?.capHit ?? 0)}`
  );
  console.log(`profile flips: ${reports.filter((r) => r.profileFlip).length}; faceless sub-shots after a confirmed split: ${sum((r) => r.facelessSubShots)}`);
  console.log(`rejected sampled: ${sampled.length} of ${rejected.length}; sheets in ${outDir}`);
  await writeFile(join(outDir, "summary.json"), JSON.stringify(reports, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
