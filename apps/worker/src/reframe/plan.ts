import type {
  CamRect,
  CropPlan,
  FaceTrack,
  Keyframe,
  PathSample,
  Shot,
  ShotLayout,
  ShotTracks,
  SourceClass,
  SourceProfile,
  StreamGeometry,
} from "./types";
import { DEFAULT_PLAN_OPTIONS, type PlanOptions } from "./options";
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
const MAX_PLAN_SHOTS = 90; // ffmpeg av_expr nesting fails at ~100 segments; headroom below that
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
function windowXFor(
  group: FaceTrack[],
  cropW: number,
  sourceWidth: number
): number {
  const minX = Math.min(...group.map((t) => t.box.x));
  const maxX = Math.max(...group.map((t) => t.box.x + t.box.w));
  return evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
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
function survivingTracks(shotTracks: FaceTrack[]): FaceTrack[] {
  const maxSamples = Math.max(0, ...shotTracks.map((t) => t.samples));
  return shotTracks.filter(
    (t) =>
      t.samples >= MIN_TRACK_SAMPLES && t.samples >= MIN_SAMPLE_FRAC * maxSamples
  );
}

/** Is this face inside the resolved inset?
 *
 *  Tolerant by 2px on each edge: the rect is a median of per-shot detections and
 *  the track box is a median of per-sample boxes, so exact containment is luck.
 *
 *  Exported because two different questions need it - "does this shot show the
 *  streamer" and "may this face anchor the window" - and a second copy of the
 *  tolerance would drift from this one. The tolerance is the part that was
 *  reasoned about; the comparison is not. */
export function isInsideInset(track: FaceTrack, rect: CamRect): boolean {
  return (
    track.box.x >= rect.x - 2 &&
    track.box.x + track.box.w <= rect.x + rect.w + 2 &&
    track.box.y >= rect.y - 2 &&
    track.box.y + track.box.h <= rect.y + rect.h + 2
  );
}

/** The face this shot shows inside the resolved inset, if any. */
function faceInInset(tracks: FaceTrack[], rect: CamRect): FaceTrack | undefined {
  return tracks.find((t) => isInsideInset(t, rect));
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
 * Every member contributes at every sample time. When a member has no
 * detection at some time its last known box is carried forward - its first
 * known box, before it appears at all. Dropping the member instead would
 * shrink the bounding box and move the target with no change of selection,
 * which is the confound the frozen-anchor rule exists to prevent, arriving
 * through the back door.
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

  return times.map((t) => {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const track of withPath) {
      const box = boxAt(track.path!, t);
      minX = Math.min(minX, box.x);
      maxX = Math.max(maxX, box.x + box.w);
    }
    return { t, cx: (minX + maxX) / 2 };
  });
}

/** The track's box at time `t`: the exact sample if there is one, otherwise the
 *  most recent earlier sample, otherwise the earliest sample. */
function boxAt(path: PathSample[], t: number): PathSample {
  let chosen = path[0];
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

  // --- Source classification (spec §4). One pass over the tracks the detector
  // already produced, plus the clip-level rect resolved by resolveCamRect.
  const camRect = cam?.rect ?? null;
  const minFaceWidth = opts.faceSmallFrac * sourceWidth;
  const allTracks = tracksByShot.flatMap((s) => survivingTracks(s.tracks));
  const widestFace = Math.max(0, ...allTracks.map((t) => t.box.w));
  const faceFrac = sourceWidth > 0 ? widestFace / sourceWidth : 0;

  let streamGeom: StreamGeometry | null = null;
  let contentX = centerX;
  let profile: SourceProfile;

  if (allTracks.length === 0) {
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
  } else {
    streamGeom = solveStreamGeometry({
      sourceWidth,
      sourceHeight,
      camRect,
      camShare: opts.camShare,
    });
    if (!streamGeom) {
      profile = {
        class: "small_face",
        faceFrac,
        reason: "stream_no_fit",
        camRectScore: camRect.score,
      };
    } else {
      profile = { class: "stream", faceFrac, camRectScore: camRect.score };
      contentX = streamContentX(
        freeBand(camRect, sourceWidth),
        streamGeom.contentCrop.w,
        sourceWidth,
        sourceWidth / 2
      );
    }
  }

  // The anchor rule. `profile` is settled before this point, which is what lets
  // the rule read the class. Built once so the two reads below cannot disagree.
  const anchorPolicy: AnchorPolicy = {
    minFaceWidth,
    sourceClass: profile.class,
    camRect,
  };

  // The group each shot's `single` window was anchored on, recorded as the
  // layouts are built so the trajectory layer below cannot re-run selection and
  // silently follow someone else.
  const groupsByShot = new Map<number, FaceTrack[]>();
  const layouts = shots.map((shot, i): ShotLayout => {
    // Keep only tracks that clear the noise floor AND are seen often enough
    // relative to the dominant track.
    const tracks = survivingTracks(byIndex.get(i) ?? []);
    if (streamGeom && camRect) {
      // A shot only splits if it actually shows the streamer: advertisement
      // cards, intermissions and replays have no face inside the inset.
      const inInset = faceInInset(tracks, camRect);
      if (!inInset) {
        return { start: shot.start, end: shot.end, layout: "center", x: centerX };
      }
      return {
        start: shot.start,
        end: shot.end,
        layout: "stream",
        cam: {
          x: streamCamX(
            camRect,
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
      return { start: shot.start, end: shot.end, layout: "center", x: centerX };
    }
    const minX = Math.min(...anchorable.map((t) => t.box.x));
    const maxX = Math.max(...anchorable.map((t) => t.box.x + t.box.w));
    if (maxX - minX <= FIT_MARGIN * cropW) {
      const x = evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
      groupsByShot.set(i, group);
      return { start: shot.start, end: shot.end, layout: "single", x };
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
      x: windowXFor(group, cropW, sourceWidth),
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
