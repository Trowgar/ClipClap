import type {
  CamRect,
  CropPlan,
  FaceBox,
  FaceTrack,
  Keyframe,
  PathSample,
  Saliency,
  SaliencyShadow,
  Shot,
  ShotLayout,
  ShotTracks,
  SourceClass,
  SourceProfile,
  StreamGeometry,
} from "./types";
import {
  DEFAULT_PLAN_OPTIONS,
  DEFAULT_STREAM_FACE_CEILING,
  type PlanOptions,
} from "./options";
import {
  DEFAULT_CAMERA,
  solveCamera,
  type CameraConfig,
  type TargetSample,
} from "./camera";
import type { CamRectResolution } from "./cam-rect";
import {
  freeBand,
  solveStreamGeometry,
  streamCamX,
  streamContentX,
} from "./stream-geometry";
// These three moved to `geometry.ts` so that `camera.ts` can use them without
// importing this module, which will import `camera.ts` back. Re-exported here
// so that every existing importer of `plan.ts` keeps working unchanged.
import { cropWidthFor, evenClamp, tileWidthFor } from "./geometry";
export { cropWidthFor, evenClamp, tileWidthFor };

// Layout constants - tuned via fixtures, deliberately NOT env knobs (spec §7).
const FIT_MARGIN = 0.9; // face bbox must fit in 90% of the crop window
const DOMINANCE_LEAD = 1.5; // top-2 must each lead the 3rd by this factor
const MERGE_DX_FRAC = 0.04; // same-layout shots merge when |dx| < 4% of iw
const MIN_TRACK_SAMPLES = 2; // 1-sample tracks are detector noise
const MIN_SAMPLE_FRAC = 0.3; // tracks seen in <30% of the dominant track's samples are transient noise
/** ffmpeg av_expr nesting fails at ~100 segments; headroom below that. Exported
 *  because cut recovery must cap its splits on the PRE-merge count: above this,
 *  buildCropPlan returns null and the whole clip falls back to the centre crop. */
export const MAX_PLAN_SHOTS = 90;

// D4 virtual-cam multipliers (spec 2026-08-19-stream-reframe-v2 §3). PROVISIONAL:
// the corpus render decides them, not a fixture - see `synthesizeVirtualCamRect`.
// Exported so tests pin geometry by referencing these, not by re-typing their
// values as literals that silently go stale the next time a real render moves
// one (as the 0.55->0.75 headroom bump did on 2026-08-19).
export const VIRTUAL_CAM_WIDTH_FACES = 3.2; // cam tile width, in multiples of face width
// Owner-reviewed 2026-08-19 on the real rendered tox sample: at 0.55, the
// streamer's pompadour extended above face.y - 0.55*face.h and got cut by
// the cam tile's top edge - hair is not covered by the YuNet face box, so
// headroom sized only off that box was too tight. 0.75 clears it on that
// source. Still provisional - one source, one haircut.
export const VIRTUAL_CAM_HEADROOM_FRAC = 0.75; // cam tile top, in face heights above faceTop
// Chin-coverage floor, added 2026-08-19 after the tox live-acceptance run: its
// real YuNet face box is h/w 1.32 (taller than a typical face box), so the
// 16:9-of-width height alone put the synthesized bottom at 314 - 11px ABOVE
// the real face bottom (325.3) - `isInsideInset` failed and the one shot
// rendered `center` instead of `stream` despite the clip classifying `stream`.
// This constant forces bottom coverage by construction (below) rather than by
// retuning WIDTH_FACES/HEADROOM_FRAC to fit one probe.
export const VIRTUAL_CAM_CHIN_FRAC = 0.15; // required clearance below faceBottom, in face heights
const W_AREA = 0.5;
const W_CENTER = 0.3;
const W_MOUTH = 0.2;

export function dominance(
  t: FaceTrack,
  sourceWidth: number,
  sourceHeight: number
): number {
  const area = (t.box.w * t.box.h) / (sourceWidth * sourceHeight);
  const cx = t.box.x + t.box.w / 2;
  const centrality = 1 - Math.abs(cx - sourceWidth / 2) / (sourceWidth / 2);
  return (
    W_AREA * Math.min(1, area * 20) +
    W_CENTER * centrality +
    W_MOUTH * Math.min(1, t.mouthActivity * 10)
  );
}

/** How much of this face the window at `x` shows, as a fraction of its width. */
export function faceVisibility(
  track: FaceTrack,
  x: number,
  cropW: number
): number {
  const left = Math.max(track.box.x, x);
  const right = Math.min(track.box.x + track.box.w, x + cropW);
  return Math.max(0, right - left) / track.box.w;
}

/**
 * How badly a window cuts a face, from its visible fraction.
 *
 * Exactly 0 when the face is wholly inside or wholly outside, 1 when exactly
 * half of it shows. That zero is what lets this whole design avoid inventing a
 * threshold: "no face is bisected" is not a band somebody had to choose, it is
 * the case where the minimum of this function happens to be zero.
 *
 * A face 99% inside scores 0.02 - a hair off the edge, correctly, rather than
 * being lumped in with a person split down the middle.
 */
export function bisectionSeverity(visible: number): number {
  return 1 - Math.abs(2 * visible - 1);
}

/** The window a set of faces asks for: centred on their bbox, clamped into
 *  frame. Measured innocent - across 22 shipped single shots the anchor sits a
 *  median of 0.005 cropW from the nearest face centre (engine-notes §7b). */
export function windowXFor(
  group: FaceTrack[],
  cropW: number,
  sourceWidth: number
): number {
  const minX = Math.min(...group.map((t) => t.box.x));
  const maxX = Math.max(...group.map((t) => t.box.x + t.box.w));
  return evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
}

/**
 * MUSIC-ONLY (spec 2026-08-23-music-shorts v1.1): where a FACELESS shot's
 * centre crop goes. Owner-diagnosed defect on the Believer corpus render: a
 * geometric centre crop on a shot with no anchorable face put the actual
 * subject (a silhouette against starfield) at the frame edge, half the
 * window showing empty background. The detector's per-shot saliency
 * centroid (`detect_faces.py`'s `saliency_from_columns`) says where the
 * visual mass actually sits, so a musicMode shot centres THERE instead -
 * clamped into the valid crop range and even-snapped exactly like `centerX`
 * itself, the same arithmetic `windowXFor` already uses for a face group.
 *
 * Falls back to `centerX` whenever `saliency` is null (no sampled frames, or
 * an older sidecar build) - the frozen-geometry contract this function must
 * not touch is "no saliency data in, no change in behaviour", not "musicMode
 * on, geometry always moves".
 */
export function centerXForShot(
  saliency: Saliency | null | undefined,
  centerX: number,
  cropW: number,
  sourceWidth: number
): number {
  if (!saliency) return centerX;
  return evenClamp(saliency.x - cropW / 2, cropW, sourceWidth);
}

/**
 * SHADOW TELEMETRY ONLY (spec 2026-08-24-camera-visual-anchoring, mechanism
 * B). Packages what `centerXForShot` WOULD have returned for a faceless
 * shot, without ever touching the shot's real `x`. Null exactly when
 * `saliency` is null - no data, no shadow, mirroring `centerXForShot`'s own
 * fallback so "shadow present" and "an active anchor would have moved the
 * window" are the same fact.
 *
 * Deliberately calls `centerXForShot` rather than re-deriving its arithmetic:
 * this function's whole job is "what would the ACTIVE anchor have said",
 * which only means something if it is asking the same question the active
 * anchor asks.
 */
export function saliencyShadowFor(
  saliency: Saliency | null | undefined,
  centerX: number,
  cropW: number,
  sourceWidth: number
): SaliencyShadow | null {
  if (!saliency) return null;
  const suggestedX = centerXForShot(saliency, centerX, cropW, sourceWidth);
  return {
    centroidX: saliency.x,
    spreadFrac: saliency.spreadFrac,
    suggestedX,
    deltaPx: suggestedX - centerX,
  };
}

/**
 * Where the crop window goes, given the faces it must hold and the faces it
 * must not cut in half.
 *
 * The window used to be centred on its anchor group and nothing asked what its
 * edges did to anyone else, so a second person just outside the group was
 * sliced down the middle - measured at 225s of 1250s anchored time, in 13 of 53
 * real clips, worst span 68s. The owner's case: two faces spanning 603px in a
 * 608px window, rejected by FIT_MARGIN, the larger anchored alone and the other
 * left half in frame.
 *
 * Four stages, in order, over the positions that keep every group member whole:
 *
 *   1. If today's window already cuts nobody, KEEP IT. No search runs.
 *   2. Otherwise minimise the worst-cut outsider.
 *   3. Among equally-uncut positions, show the most face - prefer taking a
 *      person in to pushing them out of frame.
 *   4. Among those, sit nearest to the position the planner already computes.
 *
 * Stage 1 is the scope of this change stated as code. What was measured and
 * complained about is the 225 seconds where a face IS bisected; a shot where
 * nobody is cut was never in that set and has no business moving. An earlier
 * version had no stage 1 and leaned on stage 4 to produce that outcome as a
 * side effect. It does not. Two fixtures caught it:
 *
 *   - "keeps a speck invisible while a face above the guard exists" moved from
 *     x=46 to x=102. A 30px speck at 680..710 - 1.6% of the frame, well under
 *     the min-face guard - is wholly OUTSIDE today's window and can be framed
 *     whole from x=102, so stage 3 walked the window toward it and off the only
 *     real person in the shot. That is engine-notes 7a's defect arriving
 *     through a side door.
 *   - "rejects a group that fills the window with no margin" moved from x=302
 *     to x=100, abandoning the central face the planner had deliberately
 *     anchored on in order to frame a face at the other end that was already
 *     safely out of shot.
 *
 * In both, today's window cut nobody. Stage 1 refuses them both by construction
 * rather than by arithmetic that happens to land right, and it is not a new
 * threshold: `=== 0` is `bisectionSeverity`'s own zero, the same zero this
 * design already rests on.
 *
 * Stage 3 is the editorial preference the severity score cannot express. Wholly
 * inside and wholly outside are BOTH exactly 0 - that is what makes the zero
 * threshold-free, and it is also why the score alone cannot choose between
 * framing the listening host and deleting him. On the owner's clip 65 of the
 * 180 candidate positions score 0, in two disjoint bands: evict at [256, 378]
 * and include at [610, 614]. Stage 4 alone picks eviction, 58px from today's
 * 436 against 174px. Stage 3 is what makes it include, and "he should be whole,
 * not gone" is what the complaint actually said.
 *
 * When nobody can be spared - a crowded shot where some face straddles an edge
 * wherever the window goes - stage 2 returns the least-bad position rather than
 * giving up.
 *
 * `others` must be every surviving face not in the group, INCLUDING those below
 * the min-face guard. The guard decides what may ANCHOR a window; it says
 * nothing about who may be SLICED by one, and a small face still reads as a
 * person when the edge cuts it in half.
 *
 * No cap on how far the window may move, deliberately. That decision waits on
 * frame strips, and a number chosen before them would be chosen from nothing.
 */
export function placeWindow(
  group: FaceTrack[],
  others: FaceTrack[],
  cropW: number,
  sourceWidth: number
): number {
  const todaysX = windowXFor(group, cropW, sourceWidth);
  // `group.length === 0` is load-bearing: an empty group makes `groupLeft`
  // Infinity and `groupRight` -Infinity, which is a WIDE candidate range rather
  // than an empty one, so the search below would return a real-looking x for a
  // window anchored on nobody. `others.length === 0` is, since stage 1 arrived,
  // redundant - no outsiders means nothing is cut means stage 1 returns this
  // same value. Kept because it states the intent at the top where a reader
  // looks for it, and because it saves a pass over the range.
  if (group.length === 0 || others.length === 0) return todaysX;

  // Every group member is whole exactly on this contiguous range.
  const groupLeft = Math.min(...group.map((t) => t.box.x));
  const groupRight = Math.max(...group.map((t) => t.box.x + t.box.w));
  const lo = Math.max(0, Math.ceil((groupRight - cropW) / 2) * 2);
  const hi = Math.min(sourceWidth - cropW, Math.floor(groupLeft / 2) * 2);
  // Empty range: the group is wider than the window - a close-up. 7c already
  // centres on it and accepts the slice; there is no better position to find.
  if (lo > hi) return todaysX;

  // Stage 1. Nobody is cut where the window already is, so this shot is not the
  // defect and does not move. See the header: without this, stage 3 walks the
  // window toward any outsider it could frame whole, including a 30px speck.
  let todaysWorst = 0;
  for (const other of others) {
    const s = bisectionSeverity(faceVisibility(other, todaysX, cropW));
    if (s > todaysWorst) todaysWorst = s;
  }
  if (todaysWorst === 0) return todaysX;

  let bestX = todaysX;
  let bestWorst = Infinity;
  let bestSeen = -Infinity;
  for (let x = lo; x <= hi; x += 2) {
    let worst = 0;
    let seen = 0;
    for (const other of others) {
      const visible = faceVisibility(other, x, cropW);
      seen += visible;
      const s = bisectionSeverity(visible);
      if (s > worst) worst = s;
    }
    // Stages 2, 3, 4 as one lexicographic comparison: worst cut ascending,
    // then total face shown descending, then distance from today's x ascending.
    const better = worst < bestWorst - 1e-9;
    const sameWorst = Math.abs(worst - bestWorst) <= 1e-9;
    const moreSeen = sameWorst && seen > bestSeen + 1e-9;
    const tied =
      sameWorst &&
      Math.abs(seen - bestSeen) <= 1e-9 &&
      Math.abs(x - todaysX) < Math.abs(bestX - todaysX);
    if (better || moreSeen || tied) {
      bestWorst = worst;
      bestSeen = seen;
      bestX = x;
    }
  }
  return bestX;
}

/** The faces one 9:16 window can hold WHOLE, chosen by how much face it would
 *  then show.
 *
 *  This is the answer to "several faces, no window holds them all" - the case
 *  that is 31 of the 35 multi-face shots measured in §7b, and that used to end
 *  in a blind centre crop with the nearest face a median 0.27 cropW away and
 *  outside the window entirely in 4 of 12 clips.
 *
 *  Total face area, deliberately: how much face a window contains is a
 *  measurable property of the frame. Who is speaking is not - `mouthActivity`
 *  is a 2fps mean absolute difference of a mouth patch that a head turn or a
 *  jittering box produces as readily as speech, nothing here validates it as
 *  speech, and `dominance` agrees with it in only 17 of 35 multi-face shots.
 *  So this does not claim to find the speaker; it claims to point the window
 *  where the faces are instead of where they are not. Anchoring on the speaker
 *  needs a per-shot ground-truth fixture first.
 *
 *  Only maximal runs are scored: any sub-run of a fitting run has strictly
 *  less area, so it can never win. Ties go to the group nearest the frame
 *  centre and then to the leftmost - pinned in tests, because the failure mode
 *  of an unstated tie-break is "whichever face the detector listed first". */
export function bestFaceGroup(
  anchorable: FaceTrack[],
  cropW: number,
  sourceWidth: number
): FaceTrack[] {
  const sorted = [...anchorable].sort(
    (a, b) => a.box.x - b.box.x || a.box.w - b.box.w || a.id - b.id
  );
  const fit = FIT_MARGIN * cropW;
  let best: FaceTrack[] = [];
  let bestArea = -1;
  let bestOffCentre = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const group: FaceTrack[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let area = 0;
    for (let j = i; j < sorted.length; j++) {
      const box = sorted[j].box;
      const nextMin = Math.min(minX, box.x);
      const nextMax = Math.max(maxX, box.x + box.w);
      if (nextMax - nextMin > fit) break;
      minX = nextMin;
      maxX = nextMax;
      area += box.w * box.h;
      group.push(sorted[j]);
    }
    if (group.length === 0) continue;
    const offCentre = Math.abs((minX + maxX) / 2 - sourceWidth / 2);
    if (area > bestArea || (area === bestArea && offCentre < bestOffCentre)) {
      best = group;
      bestArea = area;
      bestOffCentre = offCentre;
    }
  }
  // Every face is wider than the window itself - a close-up. Centre on the
  // biggest one and accept the slice; there is no framing that avoids it.
  if (best.length === 0 && anchorable.length > 0) {
    best = [
      [...anchorable].sort(
        (a, b) => b.box.w * b.box.h - a.box.w * a.box.h || a.box.x - b.box.x
      )[0],
    ];
  }
  return best;
}

/** The stacked two-shot, or null when these faces cannot have one.
 *
 *  The gate is the tiles themselves, measured after the clamp: a tile is
 *  `ih*9/8`, two of them need 2.25h of source, and every source this product
 *  has seen is 16:9 or narrower. On 1280x720 the widest separation two tiles
 *  can reach is 470px against a tile width of 810 - a 42% overlap FLOOR, and
 *  the 124 splits already shipped measure a median of 48% and a maximum of
 *  98.5% (engine-notes §7b). Every judge read that as a broken video before
 *  reading it as a scene. `bottom.x - top.x >= tileW` is that constraint
 *  stated exactly: it is satisfiable only when `2 * tileW <= sourceWidth`
 *  (aspect 2.25:1 and wider), and it also subsumes the old `tileW <=
 *  sourceWidth` encode guard, since tiles that far apart both fit in frame.
 *
 *  Making the tiles narrow enough to be disjoint on 16:9 means cropping each
 *  tile vertically as well - a different filtergraph and a different project.
 *  Not attempted here. */
function trySplit(
  anchorable: FaceTrack[],
  tileW: number,
  sourceWidth: number,
  sourceHeight: number
): { layout: "split"; top: { x: number }; bottom: { x: number } } | null {
  let pair = anchorable;
  if (anchorable.length > 2) {
    const scored = [...anchorable].sort(
      (a, b) =>
        dominance(b, sourceWidth, sourceHeight) -
        dominance(a, sourceWidth, sourceHeight)
    );
    const third = dominance(scored[2], sourceWidth, sourceHeight);
    const clearLead =
      dominance(scored[0], sourceWidth, sourceHeight) >= DOMINANCE_LEAD * third &&
      dominance(scored[1], sourceWidth, sourceHeight) >= DOMINANCE_LEAD * third;
    if (!clearLead) return null;
    pair = [scored[0], scored[1]];
  }
  if (pair.length < 2) return null;
  const [left, right] = [...pair].sort(
    (a, b) => a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2)
  );
  const top = {
    x: evenClamp(left.box.x + left.box.w / 2 - tileW / 2, tileW, sourceWidth),
  };
  const bottom = {
    x: evenClamp(right.box.x + right.box.w / 2 - tileW / 2, tileW, sourceWidth),
  };
  if (bottom.x - top.x < tileW) return null;
  return { layout: "split", top, bottom };
}

/** Tracks that clear the per-shot noise floor - the "surviving" tracks the
 *  classifier and the min-face guard must agree about. A stray low-sample
 *  track must not widen the fit bbox, become a split tile pointing at
 *  nothing, or reclassify a stream source as a podcast. */
export function survivingTracks(shotTracks: FaceTrack[]): FaceTrack[] {
  const maxSamples = Math.max(0, ...shotTracks.map((t) => t.samples));
  return shotTracks.filter(
    (t) =>
      t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
  );
}

// D1b (spec 2026-08-19-stream-reframe-v2). This is the SAME rule and the
// SAME value as FACE_CONTAIN_SLOP_FRAC in assets/reframe/detect_faces.py's
// find_cam_rect - two languages, one rule; if you change one, change the
// other (python side should gain the mirror of this comment - out of scope
// here, that file is another agent's).
//
// Measured 2026-08-19 on strogo: 7 of 8 shots already resolve the exact GT
// rect (src 0,0,350,160), but the widest surviving face track is
// (163.56, 73.04, 98.82, 93.52) - bottom 166.56, 6.56px past the rect's
// bottom edge (160), 7% of the face's own height. `isInsideInset`'s
// hardcoded 2px-per-edge tolerance (sized for median-vs-median jitter, not a
// detector box legitimately overhanging a correctly-resolved rect) rejected
// it, so `widestFaceInInset` said false, D5's rect-first branch never fired,
// and strogo stayed `normal_face` despite a dead-on rect.
//
// A detector box may overhang the true inset by real pixels and still BE
// the inset - shrinking it 10% per edge toward its own centre before the 2px
// check covers strogo's 7% with margin, while a 25% overhang (the duet-
// podcast shape `widestFaceInInset`'s own regression test protects) still
// fails: see reframe-plan.test.ts's bound-pin test.
const FACE_CONTAIN_SLOP_FRAC = 0.1;

/** Is this face inside the resolved inset?
 *
 *  The box is first shrunk `FACE_CONTAIN_SLOP_FRAC` per edge toward its own
 *  centre (D1b, spec 2026-08-19-stream-reframe-v2 - a detector box may
 *  overhang a correctly-resolved rect by real pixels and still BE it), then
 *  the shrunk box is tested with the ORIGINAL 2px-per-edge floor: the rect is
 *  a median of per-shot detections and the track box is a median of
 *  per-sample boxes, so exact containment is luck even after the shrink, and
 *  a tiny face's shrink can round to sub-pixel - the 2px floor still catches
 *  that jitter on its own.
 *
 *  Exported because two different questions need it - "does this shot show the
 *  streamer" and "may this face anchor the window" - and a second copy of the
 *  tolerance would drift from this one. The tolerance is the part that was
 *  reasoned about; the comparison is not. */
export function isInsideInset(track: FaceTrack, rect: CamRect): boolean {
  const shrinkW = FACE_CONTAIN_SLOP_FRAC * track.box.w;
  const shrinkH = FACE_CONTAIN_SLOP_FRAC * track.box.h;
  const box = {
    x: track.box.x + shrinkW,
    y: track.box.y + shrinkH,
    w: track.box.w - 2 * shrinkW,
    h: track.box.h - 2 * shrinkH,
  };
  return (
    box.x >= rect.x - 2 &&
    box.x + box.w <= rect.x + rect.w + 2 &&
    box.y >= rect.y - 2 &&
    box.y + box.h <= rect.y + rect.h + 2
  );
}

/** The face this shot shows inside the resolved inset, if any. */
function faceInInset(tracks: FaceTrack[], rect: CamRect): FaceTrack | undefined {
  return tracks.find((t) => isInsideInset(t, rect));
}

/**
 * Does ANY track tied for the clip's widest surviving face sit inside `rect`?
 *
 * Ties are resolved permissively - it is enough that one of them does, the
 * same "the group could be it" spirit as `anchorableTracks`. This is D5's
 * extra join for the rect-first gate in `buildCropPlan` (spec
 * 2026-08-19-stream-reframe-v2 §3): a resolvable camRect on its own only says
 * "some rectangle of border energy fits somewhere in this frame", which is a
 * different claim from "this small face is a webcam inset". Scoped to the
 * NEW rect-first branch only - the pre-D5 branch at the bottom of the
 * classification chain never asked this and must not start asking now, or a
 * sub-floor clip that used to classify `stream` on rect existence alone would
 * silently stop. See `buildCropPlan`'s "leaves podcast and facecam sources on
 * the existing path" test for the regression this join exists to prevent: a
 * 16:9 duet where an unrelated, easily-solvable camRect must not turn the
 * clip into `stream`.
 *
 * Exported (D1b, spec 2026-08-19-stream-reframe-v2) so strogo's rect-vs-
 * overhang shape can be pinned directly, not only through `buildCropPlan`'s
 * full classification.
 */
export function widestFaceInInset(
  tracks: FaceTrack[],
  widestFace: number,
  rect: CamRect
): boolean {
  return tracks.some((t) => t.box.w === widestFace && isInsideInset(t, rect));
}

/**
 * D4: synthesizes a camRect around a face box when no real rect could be
 * found at all - the only mechanism that can ever serve a borderless or
 * chroma-key cam, which edge detection cannot see (tox's true sides measured
 * 0.31/0.62 against edge_min 4.0; spec 2026-08-19-stream-reframe-v2 §2, §3
 * D4). Width is `VIRTUAL_CAM_WIDTH_FACES` face-widths centred on the face,
 * top sits `VIRTUAL_CAM_HEADROOM_FRAC` face-heights above the face box for
 * headroom. Height is the LARGER of 16:9-of-width and enough to clear
 * `VIRTUAL_CAM_CHIN_FRAC` face-heights below the face box - a bottom-
 * coverage floor, by construction, not a retuned aspect: a tall face box
 * (h/w > 16:9-implied) must not push the face's chin past the synthesized
 * rect's bottom edge (measured on tox - see the constant's comment). The
 * synthesized rect's own aspect may therefore exceed 16:9;
 * `solveStreamGeometry` cover-crops any camRect to the output aspect inside
 * `CAM_SHARE_MIN`/`CAM_SHARE_MAX`, so a taller rect just yields a taller cam
 * tile, never a broken one.
 *
 * Even-snaps and frame-clamps with the EXACT arithmetic `resolveCamRect`
 * uses (cam-rect.ts): floor the top-left down to even, size from the
 * ORIGINAL right/bottom edge against the new top-left and ceil to even, then
 * clamp so the rect cannot reach past the frame. cam-rect.ts's closing
 * comment documents the crop-past-frame encode failure (ffmpeg error -22)
 * this discipline exists to prevent - a synthesized rect must be exactly as
 * encode-safe as a detected one, not "safe enough because it's usually small".
 * Run AFTER the coverage math below, not before: the chin guarantee is about
 * where the UNCLAMPED bottom edge sits relative to the face, and frame-edge
 * clamping can only cut the rect shorter at the frame boundary, where the
 * face cannot extend past anyway (a face detected inside the frame can never
 * have its chin cut off by clamping to that same frame).
 *
 * `score` is 0: this rect was never detected, only inferred, so there is no
 * edge evidence to report.
 */
export function synthesizeVirtualCamRect(
  face: FaceBox,
  sourceWidth: number,
  sourceHeight: number
): CamRect {
  const rawW = VIRTUAL_CAM_WIDTH_FACES * face.w;
  const rawY = face.y - VIRTUAL_CAM_HEADROOM_FRAC * face.h;
  const aspectBottom = rawY + (rawW * 9) / 16;
  const chinBottom = face.y + face.h + VIRTUAL_CAM_CHIN_FRAC * face.h;
  const rawBottom = Math.max(aspectBottom, chinBottom);
  const rawH = rawBottom - rawY;
  const rawX = face.x + face.w / 2 - rawW / 2;

  const x = Math.max(0, 2 * Math.floor(rawX / 2));
  const y = Math.max(0, 2 * Math.floor(rawY / 2));
  const w = 2 * Math.ceil((rawX + rawW - x) / 2);
  const h = 2 * Math.ceil((rawY + rawH - y) / 2);
  return {
    x,
    y,
    w: Math.min(w, 2 * Math.floor((sourceWidth - x) / 2)),
    h: Math.min(h, 2 * Math.floor((sourceHeight - y) / 2)),
    score: 0,
  };
}

/**
 * D4's attempt: synthesize a rect around `face` and try to solve stream
 * geometry with it, exactly like a real rect would be tried. Null when the
 * synthesized rect does not yield a solvable geometry (e.g. the free band
 * left over is too narrow) - the caller falls through to the untouched
 * legacy chain in that case, the same as a real rect that fails to solve.
 */
function attemptVirtualCam(
  face: FaceBox,
  sourceWidth: number,
  sourceHeight: number,
  camShare: number
): { rect: CamRect; geom: StreamGeometry } | null {
  const rect = synthesizeVirtualCamRect(face, sourceWidth, sourceHeight);
  const geom = solveStreamGeometry({ sourceWidth, sourceHeight, camRect: rect, camShare });
  return geom ? { rect, geom } : null;
}

/**
 * The `stream` profile plus the geometry-derived content offset, built from
 * an already-solved `StreamGeometry`. One formula, called from both the D5
 * rect-first branch and the pre-D5 branch at the end of the classification
 * chain in `buildCropPlan`, so the two paths cannot compute a `stream` clip
 * differently.
 */
function buildStreamProfile(
  geom: StreamGeometry,
  rect: CamRect,
  faceFrac: number,
  sourceWidth: number
): { profile: SourceProfile; streamGeom: StreamGeometry; contentX: number } {
  return {
    profile: { class: "stream", faceFrac, camRectScore: rect.score },
    streamGeom: geom,
    contentX: streamContentX(
      freeBand(rect, sourceWidth),
      geom.contentCrop.w,
      sourceWidth,
      sourceWidth / 2
    ),
  };
}

/**
 * Question one: is this clip stream-shaped?
 *
 * The ABSOLUTE guard, unchanged, and the thing that decides `normal_face`
 * versus `small_face` and therefore whether the stream layout is even
 * considered.
 *
 * Deliberately a different function from `canAnchor` even though both read
 * `minFaceWidth`. They answer different questions and now answer them
 * differently; merging them back breaks the stream layout in one direction and
 * makes a streamer's webcam an anchor in the other, which is engine-notes 7a's
 * defect from either side.
 */
export function hasNormalSizedFace(
  widestFace: number,
  minFaceWidth: number
): boolean {
  return widestFace >= minFaceWidth;
}

/**
 * Question two: may this face anchor the crop window?
 *
 * The guard exists for one case - a streamer's webcam inset, where centring a
 * 9:16 window on a small face yields a truncated webcam plus a slice of chat
 * overlay (7a, measured). Applied to every source it also refuses the two men
 * at opposite ends of a podcast table, at 5.2% and 5.5% of frame width, and
 * centres on the table between them. Measured at 298 seconds of 1679 delivered.
 *
 * So the guard is relaxed only where the case it protects cannot arise:
 *   - the clip must classify `normal_face`. Classification runs per clip, and
 *     both `small_face` clips in the corpus are the stream-shaped ones,
 *     including the Booster CS2 source. This condition is what makes the webcam
 *     unreachable as an anchor, by construction rather than by inspection.
 *   - the face must not sit inside a resolved inset. Belt and braces: no
 *     measured case needs it, it costs nothing because the predicate already
 *     exists, and it closes a clip that classifies `normal_face` on a large
 *     facecam while carrying a small inset as well.
 *
 * No new constant. `minFaceWidth` is unchanged at 6% of frame width.
 */
export function canAnchor(
  track: FaceTrack,
  minFaceWidth: number,
  sourceClass: SourceClass,
  camRect: CamRect | null
): boolean {
  if (track.box.w >= minFaceWidth) return true;
  if (sourceClass !== "normal_face") return false;
  if (camRect && isInsideInset(track, camRect)) return false;
  return true;
}

/** What governs whether a face may anchor. Passed as one object so a caller
 *  cannot supply the threshold and forget the class - the combination is the
 *  rule, not the number. */
export interface AnchorPolicy {
  minFaceWidth: number;
  sourceClass: SourceClass;
  camRect: CamRect | null;
}

/**
 * The faces this shot's window may be pointed at. THE one answer - both
 * `buildCropPlan` and `selectGroupForShot` read it from here.
 *
 * Strict first, relaxed only as a fallback. The guard applies exactly as it
 * always has whenever ANY face clears it; `canAnchor` is consulted only for a
 * shot where nothing did.
 *
 * That ordering is the rule, not an optimisation, and it is what confines the
 * change to the defect:
 *   - The measured defect IS the empty strict set. All 298 defective seconds of
 *     1679 are shots where no face cleared the guard, `anchorable` came back
 *     empty and the planner centred blind - on the table between two men at
 *     5.2% and 5.5% of frame width. A shot that already had an anchorable face
 *     was never in the defect set and has no business moving, so here it cannot:
 *     "every shot that already had an anchorable face keeps its existing x"
 *     holds by construction, not by test.
 *   - This set is not only the anchor. It also feeds `trySplit` and the
 *     fits-in-one-window bbox. Relaxing it unconditionally let a 30px speck at
 *     0.94% of frame width into `trySplit`'s DOMINANCE_LEAD check beside two
 *     real 300px faces, where its near-perfect centrality (0.978) lifted third
 *     place to 0.3968 against 0.4855 for each real face - 1.5 * 0.3968 > 0.4855,
 *     no clear lead, and a legitimate split collapsed to a single shot showing
 *     one of the two people. Behind the fallback the speck is reachable only
 *     when both real faces are already absent, so it can never be in that
 *     comparison, and a persistent background bystander can never widen the
 *     bbox while a real speaker is over 6%.
 *
 * One function and not two filters, because the two used to be written out
 * separately and had to agree: when they disagreed, `selectGroupForShot`
 * returned a group while the caller's set was empty, `Math.min(...[])` gave
 * `Infinity`, and the plan carried `x: NaN` into the filtergraph. Sharing the
 * answer makes that unreachable rather than merely untested.
 */
export function anchorableTracks(
  tracks: FaceTrack[],
  policy: AnchorPolicy
): FaceTrack[] {
  const surviving = survivingTracks(tracks);
  const strict = surviving.filter((t) => t.box.w >= policy.minFaceWidth);
  if (strict.length > 0) return strict;
  return surviving.filter((t) =>
    canAnchor(t, policy.minFaceWidth, policy.sourceClass, policy.camRect)
  );
}

/**
 * The face group a shot's window is anchored on, or null when the shot has no
 * anchorable face at all.
 *
 * Extracted so that `buildCropPlan` and the containment metric cannot disagree
 * about which faces the window was pointed at. Runs on the MEDIAN boxes and is
 * called exactly once per shot: this layer changes how the window moves, never
 * whom it follows.
 *
 * Knows nothing about the split layout. `buildCropPlan` tries a split between
 * the two branches below, and a shot that splits is not a `single` shot, so
 * nothing downstream asks this about it.
 *
 * The min-face guard is no longer absolute here: `anchorableTracks` relaxes it
 * for a shot where no face cleared it at all, which is why the policy and not
 * the bare threshold is what this takes. The set itself comes from there and is
 * not re-derived, for the same reason this function exists at all.
 */
export function selectGroupForShot(
  tracks: FaceTrack[],
  policy: AnchorPolicy,
  cropW: number,
  sourceWidth: number
): FaceTrack[] | null {
  const anchorable = anchorableTracks(tracks, policy);
  if (anchorable.length === 0) return null;
  const minX = Math.min(...anchorable.map((t) => t.box.x));
  const maxX = Math.max(...anchorable.map((t) => t.box.x + t.box.w));
  if (maxX - minX <= FIT_MARGIN * cropW) return anchorable;
  return bestFaceGroup(anchorable, cropW, sourceWidth);
}

/**
 * Where the anchored group's centre sits at each detector sample inside
 * `[spanStart, spanEnd]`.
 *
 * Every member contributes at every sample time after its first observation.
 * When a member has no detection at some later time its last known box is
 * carried forward. A member that has not appeared yet does not widen the
 * target with a future box.
 */
export function buildTargetSamples(
  group: FaceTrack[],
  spanStart: number,
  spanEnd: number
): TargetSample[] {
  const withPath = group.filter((t) => t.path && t.path.length > 0);
  if (withPath.length === 0) return [];
  const times = [...new Set(withPath.flatMap((t) => t.path!.map((p) => p.t)))]
    .filter((t) => t >= spanStart && t <= spanEnd)
    .sort((a, b) => a - b);

  return times.flatMap((t) => {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const track of withPath) {
      const box = boxAt(track.path!, t);
      if (!box) continue;
      minX = Math.min(minX, box.x);
      maxX = Math.max(maxX, box.x + box.w);
    }
    return minX === Infinity ? [] : [{ t, cx: (minX + maxX) / 2 }];
  });
}

/** The track's box at time `t`: the exact sample if there is one, otherwise the
 *  most recent earlier sample. */
function boxAt(path: PathSample[], t: number): PathSample | undefined {
  let chosen: PathSample | undefined;
  for (const p of path) {
    if (p.t > t) break;
    chosen = p;
  }
  return chosen;
}

export function buildCropPlan(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  sourceWidth: number,
  sourceHeight: number,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS,
  cam: CamRectResolution | null = null
): CropPlan | null {
  if (shots.length === 0) return null;
  const cropW = cropWidthFor(sourceHeight);
  const tileW = tileWidthFor(sourceHeight);
  // Already vertical or narrower: nothing to reframe, let the legacy path run.
  if (cropW >= sourceWidth) return null;
  const centerX = evenClamp((sourceWidth - cropW) / 2, cropW, sourceWidth);
  const byIndex = new Map(tracksByShot.map((s) => [s.shotIndex, s.tracks]));
  // MUSIC-ONLY (spec 2026-08-23-music-shorts v1.1): per-shot saliency, read
  // only when `opts.musicMode` is set - see `centerXForShot` and the
  // `spreadFrac` attachment below. Building the map unconditionally is free
  // (a lookup nobody performs); gating the READS on `opts.musicMode` is what
  // keeps every non-music plan byte-identical.
  const saliencyByIndex = new Map(
    tracksByShot.map((s) => [s.shotIndex, s.saliency ?? null])
  );

  // --- Source classification (spec §4, extended by D5 of
  // 2026-08-19-stream-reframe-v2 §3/§5B). One pass over the tracks the
  // detector already produced, plus the clip-level rect resolved by
  // resolveCamRect.
  const camRect = cam?.rect ?? null;
  const minFaceWidth = opts.faceSmallFrac * sourceWidth;
  const streamFaceCeiling = opts.streamFaceCeiling ?? DEFAULT_STREAM_FACE_CEILING;
  const allTracks = tracksByShot.flatMap((s) => survivingTracks(s.tracks));
  const widestFace = Math.max(0, ...allTracks.map((t) => t.box.w));
  const faceFrac = sourceWidth > 0 ? widestFace / sourceWidth : 0;

  // One attempt at the stream geometry for this clip, shared by the D5 gate
  // below and the pre-D5 branch further down: solveStreamGeometry is pure,
  // depending only on camRect/sourceWidth/sourceHeight/camShare and never on
  // which branch is asking, so there is exactly one call site for it.
  const streamAttempt =
    opts.stream && camRect
      ? solveStreamGeometry({ sourceWidth, sourceHeight, camRect, camShare: opts.camShare })
      : null;

  // D5's extra join - see `widestFaceInInset` for why the rect-first branch
  // needs it and the pre-D5 branch below must not.
  const rectFirstFace = camRect !== null && widestFaceInInset(allTracks, widestFace, camRect);

  // D4: synthesize a rect around the widest surviving face and try to solve
  // stream geometry with it, computed unconditionally (same discipline as
  // `streamAttempt` above - solveStreamGeometry is pure, so there is exactly
  // one call site whether the rect was detected or synthesized here). Ties on
  // `widestFace` resolve to the FIRST tying track in `allTracks` order -
  // deterministic, not "whichever `.find` happens to hit".
  const widestFaceBox = allTracks.find((t) => t.box.w === widestFace)?.box ?? null;
  const virtualCamAttempt =
    opts.stream &&
    opts.streamVirtualCam &&
    camRect === null &&
    widestFaceBox !== null &&
    faceFrac > 0 &&
    faceFrac < streamFaceCeiling
      ? attemptVirtualCam(widestFaceBox, sourceWidth, sourceHeight, opts.camShare)
      : null;

  let streamGeom: StreamGeometry | null = null;
  let contentX = centerX;
  let profile: SourceProfile;
  // The rect the per-shot loop and the anchor policy below actually use.
  // Equal to `camRect` (real, possibly null) everywhere except the D4 branch,
  // which points it at the synthesized rect - so "does this shot show the
  // streamer" and "where does the cam window sit" work identically for a
  // virtual cam and a real one, off the ONE rect this plan actually solved
  // geometry against.
  let effectiveCamRect: CamRect | null = camRect;

  if (
    opts.stream &&
    allTracks.length > 0 &&
    hasNormalSizedFace(widestFace, minFaceWidth) &&
    faceFrac < streamFaceCeiling &&
    rectFirstFace &&
    camRect !== null &&
    streamAttempt !== null
  ) {
    // D5: rect-first under a ceiling. A face at or above the normal_face
    // floor but still under `streamFaceCeiling` gets the stream layout
    // BEFORE normal_face is even considered - this is what lets a real
    // corner-cam stream (measured strogo/tox 0.076-0.077, both above
    // faceSmallFrac 0.06) ever reach `stream`. Under the unchanged chain
    // below, they hit normal_face first and the rect is never asked.
    ({ profile, streamGeom, contentX } = buildStreamProfile(
      streamAttempt,
      camRect,
      faceFrac,
      sourceWidth
    ));
  } else if (
    opts.stream &&
    opts.streamVirtualCam &&
    allTracks.length > 0 &&
    faceFrac > 0 &&
    faceFrac < streamFaceCeiling &&
    camRect === null &&
    virtualCamAttempt !== null
  ) {
    // D4: the ONLY mechanism that can ever serve a borderless/chroma-key cam
    // (spec 2026-08-19-stream-reframe-v2 §2, §3 D4) - edge detection has
    // nothing to find on that class (tox's true sides score 0.31/0.62 vs
    // edge_min 4.0), so D5's rect-first branch above can never reach it: no
    // real camRect exists to satisfy it. Placed immediately after D5's branch
    // and before the legacy chain, gated on `camRect === null` so a real
    // rect - real or unresolved-but-present - always takes the branches
    // above/below this one; only the "no rect at all" case reaches here. A
    // synthesized rect that fails to solve leaves `virtualCamAttempt` null,
    // so this condition is false and the legacy chain runs exactly as it
    // does today (normal_face/small_face, untouched).
    ({ profile, streamGeom, contentX } = buildStreamProfile(
      virtualCamAttempt.geom,
      virtualCamAttempt.rect,
      faceFrac,
      sourceWidth
    ));
    profile = { ...profile, virtualCam: true };
    effectiveCamRect = virtualCamAttempt.rect;
  } else if (allTracks.length === 0) {
    profile = { class: "faceless", faceFrac };
  } else if (hasNormalSizedFace(widestFace, minFaceWidth)) {
    // Anything at or above the floor keeps the existing single/split rules.
    profile = { class: "normal_face", faceFrac };
  } else if (!camRect) {
    // "no inset here" and "the inset moved" are different facts about a
    // source, and section 11 counts them separately.
    profile = {
      class: "small_face",
      faceFrac,
      reason: cam?.reason ?? "stream_no_rect",
    };
  } else if (!opts.stream) {
    profile = {
      class: "small_face",
      faceFrac,
      reason: "stream_disabled",
      camRectScore: camRect.score,
    };
  } else if (!streamAttempt) {
    profile = {
      class: "small_face",
      faceFrac,
      reason: "stream_no_fit",
      camRectScore: camRect.score,
    };
  } else {
    ({ profile, streamGeom, contentX } = buildStreamProfile(
      streamAttempt,
      camRect,
      faceFrac,
      sourceWidth
    ));
  }

  // The anchor rule. `profile` is settled before this point, which is what lets
  // the rule read the class. Built once so the two reads below cannot disagree.
  const anchorPolicy: AnchorPolicy = {
    minFaceWidth,
    sourceClass: profile.class,
    camRect: effectiveCamRect,
  };

  // The group each shot's `single` window was anchored on, recorded as the
  // layouts are built so the trajectory layer below cannot re-run selection and
  // silently follow someone else.
  const groupsByShot = new Map<number, FaceTrack[]>();
  const layouts = shots.map((shot, i): ShotLayout => {
    // Keep only tracks that clear the noise floor AND are seen often enough
    // relative to the dominant track.
    const tracks = survivingTracks(byIndex.get(i) ?? []);
    // MUSIC-ONLY: undefined off the music path, so every `...(shotSpreadFrac
    // !== undefined ? { spreadFrac: shotSpreadFrac } : {})` below is a no-op
    // there. Read once per shot rather than at each return site so a shot
    // cannot carry two different answers depending which branch it takes.
    const shotSpreadFrac = opts.musicMode
      ? (saliencyByIndex.get(i) ?? null)?.spreadFrac
      : undefined;
    if (streamGeom && effectiveCamRect) {
      // A shot only splits if it actually shows the streamer: advertisement
      // cards, intermissions and replays have no face inside the inset.
      const inInset = faceInInset(tracks, effectiveCamRect);
      if (!inInset) {
        return {
          start: shot.start,
          end: shot.end,
          layout: "center",
          x: centerX,
          ...(shotSpreadFrac !== undefined ? { spreadFrac: shotSpreadFrac } : {}),
        };
      }
      return {
        start: shot.start,
        end: shot.end,
        layout: "stream",
        cam: {
          x: streamCamX(
            effectiveCamRect,
            streamGeom.camCrop.w,
            inInset.box.x + inInset.box.w / 2
          ),
        },
        content: { x: contentX },
      };
    }
    // Measured 3.4% of frame width on a 1280x720 stream VOD, against 15-30%
    // for podcasts and facecams. A face this small is a webcam inset or a
    // bystander; centring a 9:16 window on it yields a truncated inset plus
    // whatever overlay sits under it (spec §4.1). Scoped by `anchorableTracks`
    // to the shots where that can actually be what a small face means, and read
    // from there rather than filtered here so that this set and the one
    // `selectGroupForShot` works on are the same set - see there.
    const anchorable = anchorableTracks(tracks, anchorPolicy);
    // WHOM the window follows comes from `selectGroupForShot` and nowhere else.
    // Recording a group chosen by a copy of that logic would let the planner and
    // the containment metric drift apart, which is the whole reason the function
    // was extracted. The fits test below stays here: it decides the LAYOUT, not
    // the anchor. Null exactly when `anchorable` is empty, so it also owns the
    // min-face guard's verdict.
    //
    // It re-runs `survivingTracks` over tracks that have already been through
    // it. Checked, not assumed: the second pass is a no-op. The track holding
    // `maxSamples` always clears both clauses of its own filter (`>= 2` once
    // `maxSamples >= 2`, and `>= 0.3 * itself`), so `maxSamples` is unchanged on
    // the second pass and every survivor survives again; when nothing clears the
    // first pass the second sees an empty list and returns one. The evidence is
    // the suite: "ignores 1-sample noise tracks" and "drops a stray low-sample
    // track" now run through both passes and still land on their original x.
    const group = selectGroupForShot(tracks, anchorPolicy, cropW, sourceWidth);
    if (!group) {
      // MUSIC-ONLY: the exact defect this task fixes. No anchorable face ->
      // a geometric centre crop, which on a faceless shot puts whatever IS
      // on screen wherever it happens to sit relative to the frame, not the
      // window - see `centerXForShot`. Off the music path (`shotSpreadFrac`
      // undefined implies `opts.musicMode` is falsy, since the two are read
      // from the same guard) this is exactly `centerX`, byte-identical to v1.
      const x = opts.musicMode
        ? centerXForShot(saliencyByIndex.get(i), centerX, cropW, sourceWidth)
        : centerX;
      // SHADOW TELEMETRY ONLY (spec 2026-08-24-camera-visual-anchoring,
      // mechanism B). Off the music path (musicMode already applies saliency
      // actively above, so the shadow must never fire there too - it would
      // record what the ACTIVE anchor "would have done" while it is already
      // doing it) and only when the flag is on: what an active anchor WOULD
      // suggest for this shot, recorded but never applied to `x` above. Null
      // whenever `saliencyShadowFor` has no data, which then makes the
      // spread below a no-op exactly like `shotSpreadFrac` does.
      const saliencyShadow =
        opts.saliencyShadow && !opts.musicMode
          ? saliencyShadowFor(saliencyByIndex.get(i), centerX, cropW, sourceWidth)
          : null;
      return {
        start: shot.start,
        end: shot.end,
        layout: "center",
        x,
        ...(shotSpreadFrac !== undefined ? { spreadFrac: shotSpreadFrac } : {}),
        ...(saliencyShadow ? { saliencyShadow } : {}),
      };
    }
    // Everyone the window must not bisect: every surviving face this shot has
    // that the window is not anchored on. Derived from `tracks`, which is
    // already `survivingTracks(...)` - `faceVisibility` divides by box width and
    // a zero-width detector box would put a NaN into the search, where it
    // compares false against everything and silently distorts the winner.
    // Deliberately NOT filtered by the min-face guard: that guard decides who
    // may anchor, not who may be sliced. Identity, not id: `group` is a filtered
    // subset of these same objects, never a copy.
    const others = tracks.filter((t) => !group.includes(t));
    const minX = Math.min(...anchorable.map((t) => t.box.x));
    const maxX = Math.max(...anchorable.map((t) => t.box.x + t.box.w));
    if (maxX - minX <= FIT_MARGIN * cropW) {
      // `selectGroupForShot` returns `anchorable` unchanged on this branch, so
      // the old `evenClamp((minX + maxX) / 2 - cropW / 2, ...)` over
      // `anchorable` is exactly `placeWindow`'s tie-break over `group`. One
      // definition of where a window goes, not two that have to agree.
      const x = placeWindow(group, others, cropW, sourceWidth);
      groupsByShot.set(i, group);
      return {
        start: shot.start,
        end: shot.end,
        layout: "single",
        x,
        ...(shotSpreadFrac !== undefined ? { spreadFrac: shotSpreadFrac } : {}),
      };
    }
    const split = trySplit(anchorable, tileW, sourceWidth, sourceHeight);
    if (split) return { start: shot.start, end: shot.end, ...split };
    // No window holds every face and no split is available. Anchor on the
    // faces one window CAN hold rather than centring blind on the furniture
    // between them (engine-notes §7b: 44% of shot time, and in 4 of 12 clips
    // the nearest face was outside the centred window altogether).
    // Same `group` the fits branch above would have used: one selection per
    // shot, decided in one place, driving both `x` and the trajectory.
    groupsByShot.set(i, group);
    return {
      start: shot.start,
      end: shot.end,
      layout: "single",
      x: placeWindow(group, others, cropW, sourceWidth),
      ...(shotSpreadFrac !== undefined ? { spreadFrac: shotSpreadFrac } : {}),
    };
  });

  // Merge decides on `x` alone and is byte-identical to v2, so no motion
  // consideration can change WHICH shots merge.
  const mergedByX = mergeAdjacentLayouts(layouts, sourceWidth);
  const merged = opts.motion
    ? attachTrajectories(mergedByX, shots, groupsByShot, cropW, sourceWidth, opts.camera)
    : mergedByX;
  // piecewiseX nests one if() per shot; ffmpeg's av_expr parser fails at 100
  // nested segments ("Missing ')' or too many args"). Bail so the orchestrator
  // falls back to a plain centered crop rather than emitting a broken graph.
  if (merged.length > MAX_PLAN_SHOTS) return null;
  return {
    // v2 exists to carry stream geometry; a v2 plan without it would be a
    // representable-but-invalid state every consumer would have to defend
    // against.
    // v3 iff a trajectory is actually present. A motion-enabled run that
    // produced no movement stays v2/v1 and is byte-identical to legacy.
    version: merged.some((s) => s.layout === "single" && s.xs)
      ? 3
      : streamGeom
        ? 2
        : 1,
    engine: "faces",
    source: { width: sourceWidth, height: sourceHeight },
    profile,
    ...(streamGeom ? { stream: streamGeom } : {}),
    shots: merged,
  };
}

/** Same layout + near-identical geometry -> one window; the FIRST shot's
 *  geometry wins so the virtual camera stays put on soft scene cuts. */
export function mergeAdjacentLayouts(
  shots: ShotLayout[],
  sourceWidth: number
): ShotLayout[] {
  const maxDx = MERGE_DX_FRAC * sourceWidth;
  const merged: ShotLayout[] = [];
  for (const shot of shots) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const same =
        (prev.layout === "center" && shot.layout === "center") ||
        (prev.layout === "single" &&
          shot.layout === "single" &&
          Math.abs(prev.x - shot.x) <= maxDx) ||
        (prev.layout === "split" &&
          shot.layout === "split" &&
          Math.abs(prev.top.x - shot.top.x) <= maxDx &&
          Math.abs(prev.bottom.x - shot.bottom.x) <= maxDx) ||
        (prev.layout === "stream" &&
          shot.layout === "stream" &&
          Math.abs(prev.cam.x - shot.cam.x) <= maxDx &&
          Math.abs(prev.content.x - shot.content.x) <= maxDx);
      if (same) {
        prev.end = shot.end;
        continue;
      }
    }
    merged.push({ ...shot });
  }
  return merged;
}

/**
 * Attaches a trajectory to every `single` span that earns one, AFTER merging.
 *
 * Order matters. `mergeAdjacentLayouts` keeps the FIRST shot's geometry, so a
 * trajectory computed per detector shot and then merged would have every
 * trajectory but the first discarded - re-freezing the camera over exactly the
 * merged spans that are longest. Concatenating separately-solved trajectories
 * is also wrong: they meet at a seam with a discontinuity that does not exist
 * today. So the solver runs ONCE per merged span.
 *
 * `x` is never touched.
 */
export function attachTrajectories<T extends ShotLayout>(
  merged: T[],
  shots: Shot[],
  groupsByShot: Map<number, FaceTrack[]>,
  cropW: number,
  sourceWidth: number,
  camera: CameraConfig = DEFAULT_CAMERA
): (T & { xs?: Keyframe[] })[] {
  // Generic in the element type only so that a caller holding a narrower type
  // than the full `ShotLayout` union - a test with a `single` literal, say -
  // gets that type back with `xs` on it, instead of a union whose other arms
  // have no `x` to read. Runtime behaviour is exactly the non-generic version.
  return merged.map((span) => {
    if (span.layout !== "single") return span as T & { xs?: Keyframe[] };
    // Each DETECTOR shot overlapping this merged span contributes samples from
    // its OWN selected group, over its own time range clipped to the span.
    //
    // Not a union of every group: carry-forward would then place a face from an
    // unrelated shot into the bounding box at a time it was never on screen,
    // moving the target with no change of selection.
    const targets: TargetSample[] = [];
    for (const [i, shot] of shots.entries()) {
      if (!(shot.end > span.start && shot.start < span.end)) continue;
      const group = groupsByShot.get(i);
      if (!group) continue;
      targets.push(
        ...buildTargetSamples(
          group,
          Math.max(shot.start, span.start),
          Math.min(shot.end, span.end)
        )
      );
    }
    const xs = solveCamera(
      targets, span.x, cropW, sourceWidth, span.start, span.end, camera
    );
    // Writing `x: xs[0].x` here would be inert TODAY - `solveCamera` seeds its
    // first keyframe with the legacy x and `dropCollinear` always keeps it, so
    // `xs[0].x === span.x` by construction, and mutation testing confirmed no
    // test can tell the two apart. It stays out anyway, because that identity
    // is a property of the SOLVER, not of this function: if the solver ever
    // seeded from somewhere else, the assignment would start overwriting the
    // legacy x and the rollback story would break with nothing to catch it.
    return (xs ? { ...span, xs } : span) as T & { xs?: Keyframe[] };
  });
}

/** Re-windows a trajectory to `[start, end]`, expressed relative to the new
 *  start. The boundary values are INTERPOLATED rather than copied from the
 *  nearest keyframe: a slice landing mid-ramp would otherwise begin at a
 *  position the camera did not occupy at that moment, and the trimmed clip
 *  would open on a jump the original never had. */
export function sliceKeyframes(
  keys: Keyframe[],
  start: number,
  end: number
): Keyframe[] {
  const at = (t: number): number => {
    if (t <= keys[0].t) return keys[0].x;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.x;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1];
      const b = keys[i];
      if (t <= b.t) {
        const span = b.t - a.t;
        if (span <= 0) return b.x;
        return a.x + ((b.x - a.x) * (t - a.t)) / span;
      }
    }
    return last.x;
  };
  const inner = keys
    .filter((k) => k.t > start && k.t < end)
    .map((k) => ({ t: k.t - start, x: k.x }));
  return [
    { t: 0, x: at(start) },
    ...inner,
    { t: end - start, x: at(end) },
  ];
}

/** Re-window a stored plan to a [start, end] sub-range of the same clip
 *  (mirror of sliceCues). Null when nothing overlaps or version is unknown. */
export function sliceCropPlan(
  plan: CropPlan,
  start: number,
  end: number
): CropPlan | null {
  if (
    !plan ||
    (plan.version !== 1 && plan.version !== 2 && plan.version !== 3) ||
    !Array.isArray(plan.shots) ||
    !plan.source ||
    typeof plan.source.width !== "number" ||
    typeof plan.source.height !== "number" ||
    !(end > start)
  ) {
    return null;
  }
  const shots = plan.shots
    .filter((s) => s.end > start && s.start < end)
    .map((s) => {
      const shifted = {
        ...s,
        start: Math.max(0, s.start - start),
        end: Math.min(end - start, s.end - start),
      };
      // `xs` only ever exists on a `single` shot, and only on a v3 plan where
      // the camera actually moved. Everything else - center, split, stream, and
      // a still `single` - falls straight through with just its bounds shifted,
      // and must NOT gain an `xs` key it never had: a plan is compared against
      // its v1/v2 self to prove "flag off equals today", and an empty-but-
      // present trajectory would break that comparison for no gain.
      const xs = "xs" in s ? s.xs : undefined;
      if (s.layout !== "single" || !xs || xs.length === 0) return shifted;
      // Keyframe `t` shares the shot's CLIP-relative timebase (attachTrajectories
      // hands solveCamera the span bounds, not zero), so the trajectory has to be
      // re-windowed to the part of THIS shot the trim actually keeps, then moved
      // into the new clip's timebase. For a shot that spans the whole trim those
      // two steps collapse to "subtract start", but a shot clipped by the trim's
      // leading edge would otherwise emit keyframes that run past its own end.
      const from = Math.max(s.start, start);
      const to = Math.min(s.end, end);
      const rewound = sliceKeyframes(xs, from, to).map((k) => ({
        t: k.t + shifted.start,
        x: k.x,
      }));
      return { ...shifted, xs: rewound };
    });
  if (shots.length === 0) return null;
  return { ...plan, shots };
}

export function planLayoutCounts(
  plan: CropPlan
): Record<"single" | "split" | "center" | "stream", number> {
  const counts = { single: 0, split: 0, center: 0, stream: 0 };
  for (const s of plan.shots) counts[s.layout] += 1;
  return counts;
}
