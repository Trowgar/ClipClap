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
 *     in the manifest (start/end within 1e-3, layout and x exact (single/center));
 *   - ON vs OFF: seconds where the window moves by more than 0.25 cropW (the
 *     display bar), and separately seconds where it moves by ANY amount, shot
 *     counts, and candidate verdicts;
 *   - one contact sheet per diff span (red = OFF window, green = ON window),
 *     one per confirmed split regardless of whether it crossed the diff bar
 *     (split-<clip>-<t>.jpg - what a below-bar split actually did), and one
 *     per sampled REJECTED candidate (red = OFF window at t-0.5/t+0.5), all
 *     under .corpus/director-audit/eval-cut-recovery/.
 * The numeric results are written to summary.json (summary-only.json under
 * --only) right after the analysis loop, before any sheet is drawn - a sheet
 * failure is caught and recorded per clip (ClipReport.sheetErrors) rather
 * than aborting the run and losing everything already computed. Exits 1 if
 * the OFF invariant failed anywhere or any clip fell back.
 * Reads only the committed manifest and local corpus files; writes only
 * under .corpus/director-audit/eval-cut-recovery/.
 */
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
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
  /** Grid seconds where the window moved at all (any px), not just past the diff bar. */
  movedSec: number;
  /** Largest |xOff - xOn| seen anywhere in the clip, in px. */
  maxAbsDx: number;
  /** cropWidthFor(det.detection.height) - the one source of truth for this clip's crop width. */
  cropW: number;
  spans: Span[];
  telemetry?: CutRecoveryTelemetry;
  decisions: Array<{ t: number; score: number; verdict: CutDecision }>;
  /** Source class OFF -> ON; a flip means one split re-laid-out the whole clip. */
  profileOff?: string;
  profileOn?: string;
  profileFlip: boolean;
  /** Confirmed splits whose ON sub-shot fell to a centre crop where OFF had a face window. */
  facelessSubShots: number;
  /** Set only when telemetry.confirmed === 0: the OFF/ON plans must be identical. */
  onEqualsOffWhenNothingConfirmed?: boolean;
  sheets: string[];
  /** Sheet-drawing failures for this clip, recorded rather than fatal. */
  sheetErrors: string[];
}

/** Everything a sheet-drawing pass needs that isn't worth persisting in the
 *  (JSON-serialized) ClipReport: the plans themselves and where to read frames from. */
interface Work {
  item: DirectorAuditItem;
  source: string;
  off: CropPlan | null;
  on: CropPlan | null;
  cropW: number;
  report: ClipReport;
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
): { diffSec: number; cmpSec: number; spans: Span[]; movedSec: number; maxAbsDx: number } {
  let diffSec = 0;
  let cmpSec = 0;
  let movedSec = 0;
  let maxAbsDx = 0;
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
    if (a !== b) movedSec += GRID_SEC;
    maxAbsDx = Math.max(maxAbsDx, Math.abs(a - b));
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
  return { diffSec, cmpSec, spans, movedSec, maxAbsDx };
}

/** Removes numbered tile frames left over from an earlier call with this same
 *  `out` path (a crashed prior attempt, or a re-run with a different frame
 *  count) so the glob below only ever picks up THIS call's frames. */
async function clearStaleTiles(out: string): Promise<void> {
  const dir = dirname(out);
  const prefix = `${basename(out)}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(prefix) && e.endsWith(".jpg"))
      .map((e) => rm(join(dir, e), { force: true }))
  );
}

/** Source frames at absolute times with the OFF window in red and (optionally)
 *  the ON window in green, tiled into one JPEG. */
async function sheet(
  source: string,
  frames: Array<{ abs: number; xOff: number; xOn?: number }>,
  cropW: number,
  out: string
): Promise<void> {
  await clearStaleTiles(out);
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
  // Stale tiles from an earlier call are cleared above, so the glob can only
  // ever match frames this call just wrote.
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

/** HEAD sha for the summary header; "unknown" if git isn't available in this
 *  container or the command otherwise fails - never fatal to the run. */
async function gitSha(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const manifest = await loadManifest();
  const only = arg("--only")?.split(",");
  if (only) {
    const matched = manifest.items.filter((i) => only.includes(i.clip)).length;
    if (matched === 0) {
      console.warn(`--only matched zero manifest items: ${only.join(",")}`);
    }
  }
  const rejectedSampleRaw = Number(arg("--rejected-sample"));
  const rejectedSample = Number.isFinite(rejectedSampleRaw) ? rejectedSampleRaw : 30;
  const corpus = join(workerRoot(), manifest.outDir);
  const outDir = join(corpus, "eval-cut-recovery");
  await mkdir(outDir, { recursive: true });
  const cfg = { ...loadReframeConfig(), engine: "faces" as const };
  const reports: ClipReport[] = [];
  const works: Work[] = [];

  for (const item of manifest.items) {
    if (only && !only.includes(item.clip)) continue;
    const source = join(corpus, "sources", `${item.job}.mp4`);
    const duration = item.end - item.start;
    const det = await detectRange(source, item.start, item.end, cfg, Date.now() + cfg.maxDetectSec * 1000);
    if (!det.ok) {
      console.log(`${item.clip} DETECTION FAILED ${det.fallbackReason}`);
      const report: ClipReport = {
        clip: item.clip, job: item.job, start: item.start, end: item.end,
        offInvariant: "no_plan", fallback: det.fallbackReason,
        shotsDetector: det.shotCount, shotsOff: 0, shotsOn: 0,
        diffSec: 0, cmpSec: 0, movedSec: 0, maxAbsDx: 0, cropW: 0,
        spans: [], decisions: [], profileFlip: false, facelessSubShots: 0,
        sheets: [], sheetErrors: [],
      };
      reports.push(report);
      works.push({ item, source, off: null, on: null, cropW: 0, report });
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
      for (const dec of decisions) {
        if (dec.verdict !== "confirmed") continue;
        const offAt = shotAt(off.plan, dec.t);
        const onAt = shotAt(on.plan, dec.t);
        const onBefore = shotAt(on.plan, dec.t - 0.01);
        if (offAt?.layout === "single" && (onAt?.layout === "center" || onBefore?.layout === "center")) {
          facelessSubShots += 1;
        }
      }
    }
    const offInvariant = off.plan ? shotsEqual(item.shots, off.plan.shots) : "no_plan";
    const d = off.plan && on.plan
      ? diffPlans(off.plan, on.plan, duration, cropW)
      : { diffSec: 0, cmpSec: 0, spans: [] as Span[], movedSec: 0, maxAbsDx: 0 };
    // With nothing confirmed, cut recovery must be a no-op: the ON plan is
    // read off the SAME shots/tracks as OFF. Byte identity, not just "close".
    let onEqualsOffWhenNothingConfirmed: boolean | undefined;
    if (off.plan && on.plan && (on.cutRecovery?.confirmed ?? 0) === 0) {
      onEqualsOffWhenNothingConfirmed = JSON.stringify(off.plan) === JSON.stringify(on.plan);
    }
    const report: ClipReport = {
      clip: item.clip, job: item.job, start: item.start, end: item.end,
      offInvariant, shotsDetector: det.shotCount,
      shotsOff: off.plan?.shots.length ?? 0, shotsOn: on.plan?.shots.length ?? 0,
      diffSec: d.diffSec, cmpSec: d.cmpSec, movedSec: d.movedSec, maxAbsDx: d.maxAbsDx, cropW,
      spans: d.spans,
      telemetry: on.cutRecovery,
      decisions: decisions.map(({ t, score, verdict }) => ({ t, score, verdict })),
      profileOff: off.plan?.profile?.class, profileOn: on.plan?.profile?.class,
      profileFlip: (off.plan?.profile?.class ?? "none") !== (on.plan?.profile?.class ?? "none"),
      facelessSubShots,
      onEqualsOffWhenNothingConfirmed,
      sheets: [],
      sheetErrors: [],
    };
    reports.push(report);
    works.push({ item, source, off: off.plan, on: on.plan, cropW, report });
    console.log(
      `${item.clip} start=${item.start.toFixed(1)} off=${offInvariant} shots ${report.shotsDetector}/${report.shotsOff}->${report.shotsOn} ` +
        `diff ${report.diffSec.toFixed(1)}s of ${report.cmpSec.toFixed(1)}s moved ${report.movedSec.toFixed(1)}s max ${report.maxAbsDx.toFixed(0)}px ` +
        `cand ${report.telemetry?.candidates ?? 0} conf ${report.telemetry?.confirmed ?? 0} rej ${JSON.stringify(report.telemetry?.rejected ?? {})} cap ${report.telemetry?.capHit ?? 0}` +
        (report.profileFlip ? ` PROFILE FLIP ${report.profileOff}->${report.profileOn}` : "") +
        (report.facelessSubShots ? ` facelessSubShots ${report.facelessSubShots}` : "") +
        (report.spans.length ? ` spans ${JSON.stringify(report.spans.map((s) => [s.t0, s.t1, s.xOff, s.xOn]))}` : "")
    );
  }

  // Write the numeric results BEFORE any sheet is drawn: a crash inside ffmpeg
  // must never erase a corpus run whose analysis already succeeded. --only
  // runs get their own filename so a partial re-run never clobbers the full
  // corpus record.
  const header = {
    generatedAtNote: "stamp after run",
    gitSha: await gitSha(),
    cfg: {
      sceneThreshold: cfg.sceneThreshold,
      minShotSec: cfg.minShotSec,
      sampleFps: cfg.sampleFps,
      faceSmallFrac: cfg.faceSmallFrac,
      stream: cfg.stream,
      motion: cfg.motion,
      cutRecovery: "off/on both planned",
    },
  };
  const summaryPath = join(outDir, only ? "summary-only.json" : "summary.json");
  await writeFile(summaryPath, JSON.stringify({ header, reports }, null, 1));

  const workByClip = new Map(works.map((w) => [w.item.clip, w]));

  // Sheets: every ffmpeg failure is caught and recorded per clip instead of
  // aborting - the numbers above are already safe on disk by this point.
  for (const w of works) {
    if (!w.off || !w.on) continue;
    const { item, source, off, on, cropW, report } = w;
    for (const [k, s] of report.spans.entries()) {
      const shortSpan = s.t1 - s.t0 < 1.0;
      const mid = (s.t0 + s.t1) / 2;
      const relTimes = shortSpan ? [mid] : [s.t0 + 0.3, mid, s.t1 - 0.3];
      const times = relTimes.map((t) => item.start + t);
      const outPath = join(outDir, `diff-${item.clip}-${k}-${s.t0.toFixed(1)}-${s.t1.toFixed(1)}.jpg`);
      try {
        await sheet(source, times.map((abs) => ({ abs, xOff: s.xOff, xOn: s.xOn })), cropW, outPath);
        report.sheets.push(outPath);
      } catch (e) {
        report.sheetErrors.push(`diff-${k}: ${(e as Error).message}`);
      }
    }
    // One sheet per CONFIRMED split, regardless of whether it crossed the
    // diff bar - this is what shows a below-bar split actually did.
    for (const dec of report.decisions) {
      if (dec.verdict !== "confirmed") continue;
      const frames: Array<{ abs: number; xOff: number; xOn: number }> = [];
      for (const dt of [-0.5, 0.5]) {
        const tRel = dec.t + dt;
        const xOff = xAt(off, tRel);
        const xOn = xAt(on, tRel);
        if (xOff === null || xOn === null) continue;
        frames.push({ abs: item.start + tRel, xOff, xOn });
      }
      if (frames.length === 0) continue;
      const outPath = join(outDir, `split-${item.clip}-${dec.t.toFixed(2)}.jpg`);
      try {
        await sheet(source, frames, cropW, outPath);
        report.sheets.push(outPath);
      } catch (e) {
        report.sheetErrors.push(`split-${dec.t.toFixed(2)}: ${(e as Error).message}`);
      }
    }
  }

  // Rejected-candidate sample: evenly spaced across the FULL rejected array
  // (not an early stride window) so the tail - later jobs - is reachable and
  // every job is covered proportionally to how many candidates it produced.
  const rejected = reports.flatMap((r) =>
    r.decisions.filter((x) => x.verdict !== "confirmed" && x.verdict !== "capHit").map((x) => ({ r, x }))
  );
  const sampleCount = Math.max(0, Math.min(rejectedSample, rejected.length));
  const sampled = Array.from({ length: sampleCount }, (_, i) =>
    rejected[Math.floor((i * rejected.length) / sampleCount)]
  );
  for (const [k, { r, x }] of sampled.entries()) {
    const w = workByClip.get(r.clip);
    if (!w) continue;
    const item = w.item;
    const shot = item.shots.find((s) => x.t >= s.start && x.t < s.end);
    const outPath = join(outDir, `rejected-${k}-${r.clip}-${x.t.toFixed(2)}-${x.verdict}.jpg`);
    try {
      await sheet(
        w.source,
        [
          { abs: item.start + x.t - 0.5, xOff: shot?.x ?? 0 },
          { abs: item.start + x.t + 0.5, xOff: shot?.x ?? 0 },
        ],
        r.cropW,
        outPath
      );
      r.sheets.push(outPath);
    } catch (e) {
      r.sheetErrors.push(`rejected-${k}-${x.t.toFixed(2)}: ${(e as Error).message}`);
    }
  }

  const ok = reports.filter((r) => r.offInvariant === true).length;
  const total = reports.length;
  const diffSec = reports.reduce((a, r) => a + r.diffSec, 0);
  const cmpSec = reports.reduce((a, r) => a + r.cmpSec, 0);
  const movedSecTotal = reports.reduce((a, r) => a + r.movedSec, 0);
  const changedClips = reports.filter((r) => r.shotsOff !== r.shotsOn || r.movedSec > 0).length;
  const sum = (f: (r: ClipReport) => number) => reports.reduce((a, r) => a + f(r), 0);
  const nothingConfirmed = reports.filter((r) => r.onEqualsOffWhenNothingConfirmed !== undefined);
  const nothingConfirmedOk = nothingConfirmed.filter((r) => r.onEqualsOffWhenNothingConfirmed === true).length;
  const sheetErrorsTotal = sum((r) => r.sheetErrors.length);

  console.log("");
  console.log(`OFF invariant: ${ok}/${total}`);
  console.log(`diff: ${diffSec.toFixed(1)}s of ${cmpSec.toFixed(1)}s (${((100 * diffSec) / Math.max(1, cmpSec)).toFixed(2)}%), clips with diff ${reports.filter((r) => r.diffSec > 0).length}`);
  console.log(`moved (any px): ${movedSecTotal.toFixed(1)}s; clips whose plan changed (shot count or any window): ${changedClips}`);
  console.log(`shots: detector ${sum((r) => r.shotsDetector)}, plan off ${sum((r) => r.shotsOff)}, plan on ${sum((r) => r.shotsOn)}`);
  console.log(
    `candidates ${sum((r) => r.telemetry?.candidates ?? 0)} confirmed ${sum((r) => r.telemetry?.confirmed ?? 0)} ` +
      `noTurnover ${sum((r) => r.telemetry?.rejected.noTurnover ?? 0)} oneSideEmpty ${sum((r) => r.telemetry?.rejected.oneSideEmpty ?? 0)} ` +
      `tooShort ${sum((r) => r.telemetry?.rejected.tooShort ?? 0)} noPath ${sum((r) => r.telemetry?.rejected.noPath ?? 0)} capHit ${sum((r) => r.telemetry?.capHit ?? 0)}`
  );
  console.log(`profile flips: ${reports.filter((r) => r.profileFlip).length}; faceless sub-shots after a confirmed split: ${sum((r) => r.facelessSubShots)}`);
  console.log(`ON==OFF on ${nothingConfirmedOk}/${nothingConfirmed.length} clips with nothing confirmed (must be ${nothingConfirmed.length}/${nothingConfirmed.length})`);
  console.log(`rejected sampled: ${sampled.length} of ${rejected.length}; sheets in ${outDir}`);
  console.log(`sheet errors: ${sheetErrorsTotal}${sheetErrorsTotal ? " (see per-clip sheetErrors in the report)" : ""}`);
  console.log(`summary written to ${summaryPath}`);

  if (ok !== total || reports.some((r) => r.fallback)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
