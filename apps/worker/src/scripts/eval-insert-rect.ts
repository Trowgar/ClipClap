/**
 * Can the webcam-inset detector be reused as a general "face inside a graphic"
 * layer? Measured over the real corpus, not argued from one shot.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-insert-rect.ts"
 *
 * THE DEFECT THIS IS ABOUT
 * ------------------------
 *
 * On clip `cmshgsrvr00091445kr748jsv` the source shows a host speaking on the
 * left and a rounded-corner graphic insert holding a STILL PORTRAIT on the
 * right. The portrait's face is 351px wide, the live host's is 241px, the
 * planner anchors on total face area, so the clip opens on 7.7 seconds of a
 * motionless card instead of the person talking.
 *
 * Two signals were proposed for telling a photograph from a person and both
 * were measured dead on that very shot: the card's box moves MORE than the
 * host's (13.9px against 3.2px, because the card slowly zooms) and its
 * `mouthActivity` is 0.016 against the host's 0.044 - lower, same order, no
 * separation to put a threshold in. That is why this script measures the
 * RECTANGLE instead of the face: whether a graphic insert is present is a
 * property of the frame, not of how still someone is holding their head.
 *
 * WHAT IS MEASURED, AND WHY THREE COLUMNS
 * ---------------------------------------
 *
 * `find_cam_rect` is gated twice in `detect_faces.py`, and both gates decide the
 * outcome before the detector is consulted:
 *
 *   - the search runs only if the DOMINANT track is already under
 *     `faceSmallFrac * sourceWidth`, so a large portrait card is never looked
 *     for at all;
 *   - the median edge map is built once from the first EDGE_SAMPLE_MAX frames
 *     of the CLIP and reused for every shot, so an insert appearing after the
 *     first ~12 seconds is searched for in a map it never contributed to.
 *
 * `probe_insert_rect.py` calls the same `median_edge_map` and `find_cam_rect`
 * per track under each relaxation - gate honoured, gate lifted, gate lifted with
 * a per-shot edge map - so the three buckets the result has to be split into
 * ("caught today", "caught after a clear fix", "not this feature class") come
 * out of the data rather than out of a judgement call.
 *
 * ACCEPTANCE IS MEASURED AT THE SHIPPED THRESHOLD, NOT INFERRED FROM A LOW ONE.
 * `find_cam_rect` returns the LARGEST rectangle clearing its threshold, not the
 * strongest, so lowering the threshold does not merely reveal weaker results -
 * it changes which rectangle wins. Probed at a floor of 1.0 on the Booster
 * stream, the winner was a box whose right edge had run off the webcam into the
 * game HUD, reporting 1.35; the webcam's own tighter, stronger rectangle was
 * never reported because a bigger one had already beaten it on area. A first
 * version of this script drew its conclusion from exactly those numbers, and
 * they cannot support one. So each relaxation is searched TWICE: once at
 * `pipEdgeMin`, which answers "would this be accepted", and once at the probe
 * floor, which shows near misses and the geometry a relaxed threshold would
 * pick. Only the first decides anything.
 *
 * §7a's note on that constant - 26 true detections at 5.65-8.84, strongest false
 * candidate 1.54, one streamer, one layout, one video - is the evidence being
 * re-tested here.
 *
 * WHAT THIS SCRIPT CANNOT DECIDE
 * ------------------------------
 *
 * Whether a rectangle it found is a graphic insert, a webcam, a doorway, a
 * window or a picture on the wall. `find_cam_rect` scores border edge energy and
 * a framed picture behind a speaker is a rectangle with excellent borders. The
 * ROLE of every hit, the false positives and the misses are decided by looking
 * at the annotated frames this writes, and a reader who skips that step has a
 * table of numbers about nothing.
 *
 * Read-only: no database writes, no R2 writes, no job touched. Nothing under
 * `.corpus/` is committed.
 */
import { execFile } from "child_process";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { getPresignedDownloadUrl, prisma } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { loadReframeConfig } from "../reframe/config";
import { detectFaces, reframeAssetsDir } from "../reframe/faces";
import { detectShots } from "../reframe/shots";
import type { FaceBox, FaceTrack, Shot, ShotTracks } from "../reframe/types";
import { corpusDir, loadManifest } from "./corpus-fetch";

const execFileAsync = promisify(execFile);

/** The corpus `eval-bisection.ts` and `eval-shift-sheets.ts` measure on. */
const SINCE = new Date("2026-08-06T00:00:00Z");

const SHOTS_TIMEOUT_MS = 120_000;
const FACES_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 300_000;

/** Copies of the planner's private noise floor, as in the other eval scripts.
 *  Both clauses, not just the easy one - a partial copy scores tracks the
 *  planner discarded. */
const MIN_TRACK_SAMPLES = 2;
const MIN_SAMPLE_FRAC = 0.3;
function survivingTracks(tracks: FaceTrack[]): FaceTrack[] {
  const maxSamples = Math.max(0, ...tracks.map((t) => t.samples));
  return tracks.filter(
    (t) =>
      t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
  );
}

interface ProbeRect extends FaceBox {
  score: number;
}

interface ProbeTrack {
  id: number;
  box: FaceBox;
  samples: number;
  passesSizeGate: boolean;
  shippedLike: ProbeRect | null;
  /** Searched AT the shipped threshold: these decide "would it be accepted". */
  ungatedAt: ProbeRect | null;
  pershotAt: ProbeRect | null;
  /** Searched at the probe floor: near misses and the geometry a relaxed
   *  threshold would pick. Never used to decide acceptance - `find_cam_rect`
   *  returns the LARGEST box above its threshold, so a lower floor reports a
   *  bigger, weaker rectangle and hides a tighter, stronger one. */
  ungated: ProbeRect | null;
  pershot: ProbeRect | null;
}

interface ProbeShot {
  shotIndex: number;
  edgeFrames: number;
  camRect: (FaceBox & { score?: number }) | null;
  tracks: ProbeTrack[];
}

/** One row per (shot, track) that the probe found a rectangle for, plus the
 *  context needed to judge it without re-running anything. */
interface Hit {
  clipId: string;
  title: string;
  artifactKey: string;
  clipStart: number;
  shotIndex: number;
  shotStart: number;
  shotEnd: number;
  sourceWidth: number;
  sourceHeight: number;
  trackId: number;
  faceBox: FaceBox;
  faceFrac: number;
  /** Which configuration found it, best first: pershot beats ungated beats
   *  shipped only in the sense of "needs more work to reach". */
  rect: ProbeRect;
  config: "shippedLike" | "ungatedAt" | "pershotAt" | "ungated" | "pershot";
  /** Whether the rectangle clears the shipped `pipEdgeMin`. False rows are the
   *  interesting ones: right geometry, wrong score, is a different problem from
   *  no geometry at all. */
  passes: boolean;
  /** Faces of OTHER surviving tracks that lie wholly outside this rectangle.
   *  The whole proposal rests on this being non-empty: demoting a face inside a
   *  graphic is only safe when somebody outside it can take the anchor. */
  liveOutside: number;
  outsideWidest: number;
  /** Every other surviving face, drawn on the rendered frame so a reader can
   *  see who the window would have gone to instead. */
  otherBoxes: FaceBox[];
  /** True when this track is the one the planner would anchor on - the widest
   *  surviving track. Those are the hits that would actually change a clip. */
  isAnchor: boolean;
  /** True when the shot starts the clip: the opening is where this hurts. */
  atClipStart: boolean;
}

/** An anchor face the search proposed no rectangle for, at any score. These are
 *  where a MISS would live, and a miss is invisible in the hit table. */
interface Miss {
  clipId: string;
  title: string;
  artifactKey: string;
  clipStart: number;
  shotIndex: number;
  shotStart: number;
  shotEnd: number;
  faceBox: FaceBox;
  otherBoxes: FaceBox[];
  others: number;
}

/** How many of each get a rendered frame. Small enough that every one is
 *  actually looked at - a sheet nobody reads is not evidence. */
const HIT_SAMPLE = 10;
const MISS_SAMPLE = 8;

function overlaps(box: FaceBox, rect: FaceBox): boolean {
  return (
    box.x < rect.x + rect.w &&
    box.x + box.w > rect.x &&
    box.y < rect.y + rect.h &&
    box.y + box.h > rect.y
  );
}

/**
 * Runs the probe for one clip: frames out once with ffmpeg, the shipped sidecar
 * for the tracks, then `probe_insert_rect.py` over the same frames.
 *
 * The frames are extracted with the SAME command `detectFaces` uses - same fps,
 * same 640 scale, same jpeg quality. A different sampling would give the edge
 * map different pixels and the probe would be measuring a detector that does
 * not exist.
 */
async function runProbe(
  url: string,
  startSec: number,
  endSec: number,
  shots: Shot[],
  width: number,
  height: number,
  cfg: ReturnType<typeof loadReframeConfig>,
  detected: { shots: unknown[] }
): Promise<ProbeShot[]> {
  const workDir = await mkdtemp(join(tmpdir(), "clipclap-rectprobe-"));
  try {
    const framesDir = join(workDir, "frames");
    await mkdir(framesDir);
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-ss", String(startSec),
        "-to", String(endSec),
        "-i", url,
        "-vf", `fps=${cfg.sampleFps},scale=640:-2`,
        "-q:v", "5",
        join(framesDir, "frame-%05d.jpg"),
        "-y",
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    const shotsPath = join(workDir, "shots.json");
    const detectedPath = join(workDir, "detected.json");
    await writeFile(shotsPath, JSON.stringify(shots), "utf-8");
    await writeFile(detectedPath, JSON.stringify(detected), "utf-8");
    const { stdout } = await execFileAsync(
      "python3",
      [
        join(reframeAssetsDir(), "probe_insert_rect.py"),
        "--frames-dir", framesDir,
        "--shots", shotsPath,
        "--fps", String(cfg.sampleFps),
        "--detected", detectedPath,
        "--source-width", String(width),
        "--source-height", String(height),
        "--face-small-frac", String(cfg.faceSmallFrac),
        "--pip-max-frac", String(cfg.pipMaxFrac),
        "--pip-edge-min", String(cfg.pipEdgeMin),
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
    );
    return (JSON.parse(stdout).shots ?? []) as ProbeShot[];
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The shipped sidecar, run a second time for its raw JSON.
 *
 * `detectFaces` parses and discards the document, and the probe needs the same
 * track ids and median boxes the planner saw. Re-deriving them from the parsed
 * `ShotTracks` is exactly equivalent and is what this does - the raw call is
 * avoided rather than duplicated, so there is one detection run per clip and no
 * chance of the two disagreeing.
 */
function asDetectedDocument(tracks: ShotTracks[]): { shots: unknown[] } {
  return {
    shots: tracks.map((st) => ({
      shotIndex: st.shotIndex,
      camRect: st.camRect,
      tracks: st.tracks.map((t) => ({
        id: t.id,
        box: t.box,
        samples: t.samples,
      })),
    })),
  };
}

async function main() {
  // Optional clip ids, for smoke-testing the probe on a known case before
  // paying for the whole corpus. No argument means the whole corpus, which is
  // the only form any conclusion may be drawn from.
  const only = new Set(process.argv.slice(2));
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const outDir = join(corpusDir(manifest), "insert-rect");
  await mkdir(outDir, { recursive: true });

  const jobs = await prisma.job.findMany({
    where: { createdAt: { gte: SINCE }, normalizedArtifactKey: { not: null } },
    select: {
      id: true,
      originalFilename: true,
      normalizedArtifactKey: true,
      clips: {
        where: { deletedAt: null },
        select: { id: true, title: true, startTime: true, endTime: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const hits: Hit[] = [];
  const noRect: Miss[] = [];
  let clips = 0;
  let failed = 0;
  let shotsExamined = 0;
  let shotsWithTracks = 0;
  /** Shots where production itself returned a camRect - today's behaviour. */
  let shippedRects = 0;
  const failures: string[] = [];
  /** Every score the probe saw, so the distribution decides the threshold. */
  const scoresUngated: number[] = [];
  const scoresPershot: number[] = [];
  const scoresUngatedAt: number[] = [];
  const scoresPershotAt: number[] = [];

  for (const [ji, job] of jobs.entries()) {
    if (job.clips.length === 0) continue;
    const url = await getPresignedDownloadUrl(job.normalizedArtifactKey!, 7200);
    const label = (job.originalFilename ?? job.id).slice(0, 44);
    for (const [ci, clip] of job.clips.entries()) {
      if (only.size > 0 && !only.has(clip.id)) continue;
      process.stderr.write(
        `[job ${ji + 1}/${jobs.length} clip ${ci + 1}/${job.clips.length}] ` +
          `${clip.id} ${(clip.endTime - clip.startTime).toFixed(0)}s ${label}\n`
      );
      try {
        const { stdout } = await execFileAsync(
          "ffprobe",
          [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            "-read_intervals", `${clip.startTime}%+1`,
            url,
          ],
          { maxBuffer: CHILD_MAX_BUFFER_BYTES }
        );
        const [W, H] = stdout.trim().split("x").map(Number);
        if (!W || !H) throw new Error("probe_failed");
        const shots = await detectShots(
          url, clip.startTime, clip.endTime, cfg, SHOTS_TIMEOUT_MS
        );
        const tracks = await detectFaces(
          url, clip.startTime, clip.endTime, shots, W, H, cfg, FACES_TIMEOUT_MS
        );
        const probe = await runProbe(
          url, clip.startTime, clip.endTime, shots, W, H, cfg,
          asDetectedDocument(tracks)
        );
        clips += 1;

        for (const ps of probe) {
          shotsExamined += 1;
          if (ps.camRect) shippedRects += 1;
          const shot = shots[ps.shotIndex];
          if (!shot) continue;
          const surviving = survivingTracks(
            tracks.find((t) => t.shotIndex === ps.shotIndex)?.tracks ?? []
          );
          if (surviving.length === 0) continue;
          shotsWithTracks += 1;
          const widest = surviving.reduce((a, b) => (b.box.w > a.box.w ? b : a));

          for (const pt of ps.tracks) {
            if (pt.ungated) scoresUngated.push(pt.ungated.score);
            if (pt.pershot) scoresPershot.push(pt.pershot.score);
            if (pt.ungatedAt) scoresUngatedAt.push(pt.ungatedAt.score);
            if (pt.pershotAt) scoresPershotAt.push(pt.pershotAt.score);
            // Best configuration that produced a rectangle at or above the
            // SHIPPED threshold. Below it, the detector as configured today
            // would reject the rectangle, and calling that a hit would count a
            // near miss as a success.
            // Order matters: the acceptance columns first, so a track that is
            // genuinely detectable is reported as detectable rather than as
            // the weaker box the probe floor would have picked.
            const chosen: Array<[Hit["config"], ProbeRect | null]> = [
              ["shippedLike", pt.shippedLike],
              ["ungatedAt", pt.ungatedAt],
              ["pershotAt", pt.pershotAt],
              ["ungated", pt.ungated],
              ["pershot", pt.pershot],
            ];
            // EVERY rectangle is kept, not only those clearing `pipEdgeMin`.
            // Keeping only the passing ones cannot distinguish the two answers
            // this whole run exists to separate: a detector that finds the
            // right rectangle and scores it too low - a threshold problem, and
            // fixable - from one that never proposes that rectangle at all,
            // which is the feature class failing. The threshold is applied when
            // counting, and the geometry is judged from the frames.
            const others = surviving.filter((t) => t.id !== pt.id);
            const found = chosen.find(([, r]) => r !== null);
            if (!found || !found[1]) {
              if (widest.id === pt.id) {
                noRect.push({
                  clipId: clip.id,
                  title: clip.title ?? "(untitled)",
                  artifactKey: job.normalizedArtifactKey!,
                  clipStart: clip.startTime,
                  shotIndex: ps.shotIndex,
                  shotStart: shot.start,
                  shotEnd: shot.end,
                  faceBox: pt.box,
                  otherBoxes: others.map((t) => t.box),
                  others: others.length,
                });
              }
              continue;
            }
            const rect = chosen.reduce<ProbeRect>(
              (best, [, r]) => (r && r.score > best.score ? r : best),
              found[1]
            );
            const outside = others.filter((t) => !overlaps(t.box, rect));
            hits.push({
              clipId: clip.id,
              title: clip.title ?? "(untitled)",
              artifactKey: job.normalizedArtifactKey!,
              clipStart: clip.startTime,
              shotIndex: ps.shotIndex,
              shotStart: shot.start,
              shotEnd: shot.end,
              sourceWidth: W,
              sourceHeight: H,
              trackId: pt.id,
              faceBox: pt.box,
              faceFrac: pt.box.w / W,
              rect,
              config:
                chosen.find(([, r]) => r === rect)?.[0] ?? found[0],
              passes: rect.score >= cfg.pipEdgeMin,
              liveOutside: outside.length,
              outsideWidest: outside.reduce((m, t) => Math.max(m, t.box.w), 0),
              otherBoxes: others.map((t) => t.box),
              isAnchor: widest.id === pt.id,
              atClipStart: shot.start < 0.05,
            });
          }
        }
      } catch (error) {
        failed += 1;
        failures.push(`${clip.id} ${(error as Error).message.slice(0, 140)}`);
      }
    }
  }

  const pct = (xs: number[], p: number) =>
    xs.length === 0
      ? NaN
      : [...xs].sort((a, b) => a - b)[
          Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))
        ];

  console.log("\n=== corpus");
  console.log(`  jobs / clips           : ${jobs.length} / ${clips}  (failed ${failed})`);
  console.log(`  detector shots         : ${shotsExamined}  (with surviving tracks ${shotsWithTracks})`);
  console.log(`  shots where PRODUCTION returned a camRect: ${shippedRects}`);

  console.log("\n=== rectangle scores the probe saw (threshold today is " + cfg.pipEdgeMin + ")");
  for (const [name, xs] of [
    ["clip-wide, probe floor", scoresUngated],
    ["per-shot, probe floor", scoresPershot],
    ["clip-wide, AT threshold", scoresUngatedAt],
    ["per-shot, AT threshold", scoresPershotAt],
  ] as const) {
    if (xs.length === 0) {
      console.log(`  ${name.padEnd(24)}: none`);
      continue;
    }
    console.log(
      `  ${name.padEnd(24)}: n=${xs.length}  min ${Math.min(...xs).toFixed(2)}  ` +
        `p25 ${pct(xs, 25).toFixed(2)}  p50 ${pct(xs, 50).toFixed(2)}  ` +
        `p75 ${pct(xs, 75).toFixed(2)}  p90 ${pct(xs, 90).toFixed(2)}  ` +
        `max ${Math.max(...xs).toFixed(2)}  ` +
        `>= ${cfg.pipEdgeMin}: ${xs.filter((v) => v >= cfg.pipEdgeMin).length}`
    );
  }

  const passing = hits.filter((h) => h.passes);
  const byConfig = (c: Hit["config"]) => passing.filter((h) => h.config === c);
  console.log("\n=== rectangles proposed, and how many the shipped threshold accepts");
  console.log(`  (shot, track) pairs with ANY rectangle : ${hits.length}`);
  console.log(`  of those, clearing pipEdgeMin ${cfg.pipEdgeMin}          : ${passing.length}`);
  console.log(`    caught as shipped       : ${byConfig("shippedLike").length}`);
  console.log(`    needs the size gate off : ${byConfig("ungated").length}`);
  console.log(`    needs a per-shot map too: ${byConfig("pershot").length}`);
  const anchors = passing.filter((h) => h.isAnchor);
  console.log(`  passing hits on the ANCHOR face : ${anchors.length}  (these are the ones that would change a clip)`);
  console.log(`    with a live face outside: ${anchors.filter((h) => h.liveOutside > 0).length}  (safe to demote)`);
  console.log(`    nobody outside          : ${anchors.filter((h) => h.liveOutside === 0).length}  (demoting would blind the crop - must fall back)`);
  console.log(`    at clip start           : ${anchors.filter((h) => h.atClipStart).length}`);

  console.log("\n=== every anchor-face rectangle, best score first (P = clears the threshold)");
  const ranked = [...hits.filter((h) => h.isAnchor)].sort(
    (a, b) => b.rect.score - a.rect.score
  );
  for (const [i, h] of ranked.entries()) {
    console.log(
      `  ${String(i + 1).padStart(3)} ${h.passes ? "P" : " "} ${h.config.padEnd(11)} score ${h.rect.score.toFixed(2).padStart(6)}  ` +
        `face w=${h.faceBox.w.toFixed(0)} (${(h.faceFrac * 100).toFixed(1)}%)  ` +
        `rect ${h.rect.w.toFixed(0)}x${h.rect.h.toFixed(0)} @${h.rect.x.toFixed(0)},${h.rect.y.toFixed(0)}  ` +
        `outside ${h.liveOutside} (widest ${h.outsideWidest.toFixed(0)})  ` +
        `${h.atClipStart ? "OPENING " : "        "}` +
        `${h.shotStart.toFixed(1)}-${h.shotEnd.toFixed(1)}s  ${h.clipId.slice(0, 8)} ${h.title.slice(0, 40)}`
    );
  }

  // MISSES cannot be found in this table, only outside it: a graphic insert the
  // search never proposed a rectangle for looks exactly like an ordinary shot.
  // So a sample of anchor faces with NO rectangle is rendered too, ranked by
  // anchor width - the defect's signature is a big face taking the window while
  // somebody else is on screen, and a card portrait is big by construction.
  const missCandidates = [...noRect]
    .filter((m) => m.others > 0)
    .sort((a, b) => b.faceBox.w - a.faceBox.w)
    .slice(0, MISS_SAMPLE);
  console.log(`\n=== anchor faces with NO rectangle at any score: ${noRect.length}`);
  console.log(`  of those with another face on screen: ${noRect.filter((m) => m.others > 0).length}`);
  console.log(`  rendering the ${missCandidates.length} widest, to look for insets the search never proposed`);

  console.log("\n=== rendering frames");
  const toRender: Array<{ name: string; kind: string; h: Hit | Miss }> = [
    ...ranked.slice(0, HIT_SAMPLE).map((h, i) => ({
      name: `hit-${String(i + 1).padStart(2, "0")}-${h.clipId.slice(0, 8)}-s${h.shotIndex}`,
      kind: "rect proposed",
      h: h as Hit | Miss,
    })),
    ...missCandidates.map((m, i) => ({
      name: `miss-${String(i + 1).padStart(2, "0")}-${m.clipId.slice(0, 8)}-s${m.shotIndex}`,
      kind: "no rect",
      h: m as Hit | Miss,
    })),
  ];
  for (const item of toRender) {
    const h = item.h;
    const at = h.clipStart + (h.shotStart + h.shotEnd) / 2;
    const out = join(outDir, `${item.name}.png`);
    // The probed face in RED, every other surviving face in BLUE, the proposed
    // rectangle in GREEN. Full frame, because a crop cannot show that the
    // anchor was a card standing beside a live speaker - which is the entire
    // question. `drawtext` has no font in this image and would fail the graph,
    // so every label is on stdout.
    const boxes = [
      `drawbox=x=${h.faceBox.x}:y=${h.faceBox.y}:w=${h.faceBox.w}:h=${h.faceBox.h}:color=red:t=4`,
      ...h.otherBoxes.map(
        (b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=blue:t=4`
      ),
      ...("rect" in h
        ? [`drawbox=x=${h.rect.x}:y=${h.rect.y}:w=${h.rect.w}:h=${h.rect.h}:color=lime:t=6`]
        : []),
      "scale=960:-2",
    ].join(",");
    console.log(
      `  ${item.name}  ${item.kind}` +
        ("rect" in h ? `  score ${h.rect.score.toFixed(2)} ${h.passes ? "PASSES" : "below threshold"}` : "") +
        `  face ${h.faceBox.w.toFixed(0)}px  others ${h.otherBoxes.length}  ` +
        `${h.shotStart.toFixed(1)}-${h.shotEnd.toFixed(1)}s  ${h.title.slice(0, 40)}`
    );
    try {
      const url = await getPresignedDownloadUrl(h.artifactKey, 7200);
      await execFileAsync(
        "ffmpeg",
        [
          "-nostdin", "-v", "error",
          "-ss", at.toFixed(3),
          "-i", url,
          "-vf", boxes,
          "-frames:v", "1",
          out, "-y",
        ],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER_BYTES }
      );
    } catch (error) {
      console.log(`      ! render failed: ${(error as Error).message.slice(0, 160)}`);
    }
  }

  await writeFile(
    join(outDir, "hits.json"),
    JSON.stringify(
      { hits, noRect, scoresUngated, scoresPershot, scoresUngatedAt, scoresPershotAt },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`\n  wrote ${join(outDir, "hits.json")}`);

  if (failures.length > 0) {
    console.log(`\n=== clips that failed (${failures.length})`);
    for (const f of failures) console.log(`  ${f}`);
  }

  console.log(
    "\nNo role, no false positive and no miss is decided by this table. " +
      "Render the frames and look at them."
  );

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
