# Smart Reframe: Scene-Aware Face Crop for 9:16

**Date:** 2026-07-24
**Status:** Approved (2026-07-24) - ready for implementation plan
**Scope:** RENDER stage only. New `reframe` module (shot detection, face detection, layout planning, filtergraph build), `cut.ts`/`render.ts` touchpoints, `Clip.cropPlan` persistence, trim re-render reuse, worker image dependencies. Closes the item deferred by the 2026-07-13 highlight-core spec (§2.7: "content-aware 9:16 crop - next iteration").

## 1. Problem

The 9:16 conversion is a blind center crop, one static window for the whole clip (`cut.ts` `buildCropFilter`: `crop=ih*9/16:ih:(iw-ih*9/16)/2:0`). Two real failures from production podcast uploads:

| Shot type | What the viewer gets |
|---|---|
| Close-up, speaker centered | Fine - speaker happens to sit in the center strip |
| Wide two-person shot, people at frame edges | Empty center (furniture) fills the vertical; both speakers cropped out |

A third failure is invisible in single screenshots: podcast cameras switch between close-up and wide **inside one clip**, so even a per-clip smart offset would be right in one shot and wrong in the next. Any fix must operate per shot.

## 2. Fixed product decisions

Settled with the owner before design; the design must operate within these.

1. **Quality-first scope.** Full layout engine per shot (Approach A), not a minimal single-face crop. Chosen over immediate active-speaker tracking (Approach B): split-screen on duets is never wrong, while a wrong speaker guess is a visible defect; the layout engine is the foundation ASD plugs into later.
2. **Two faces that do not fit one 9:16 window -> split-screen stack** (both faces, top/bottom tiles). Chosen over blur letterbox (faces too small on phones) and speaker-only crop (wrong guess = defect).
3. **Zero faces -> center crop** (current behavior). Slides, gameplay, screencasts stay as they are.
4. **Reframe must never fail a render.** Any detector error, timeout, or malformed output falls back to the current center crop with a logged warning and a manifest reason. No new FAILED paths.
5. **Single encode pass stays.** Crop, split composition, and subtitle burn happen in one ffmpeg run, as today. Detection adds a bounded pre-pass (a few seconds CPU per clip), encode time is unchanged.
6. **Rollout behind an env flag** `REFRAME_ENGINE=off|faces` (code default `off`), same pattern as `ANALYZE_ENGINE`. Enabled in prod `.env` after a real-video smoke.
7. **Out of scope (roadmap):** audio-synced active-speaker detection (will enter as one more dominance signal in the layout step, no rewrite), smooth within-shot face following, per-clip layout override in the editor, blur-letterbox as a style option.

## 3. Architecture overview

Three deterministic steps per highlight, all inside the RENDER stage, producing a **CropPlan** that a pure function compiles into a single ffmpeg filtergraph:

```
render.ts (per highlight, REFRAME_ENGINE=faces)
  |- 1. detectShots()      [TS, ffmpeg scdet]   clip window -> shot boundaries
  |- 2. detect_faces.py    [Python, YuNet]      sampled frames -> face tracks per shot
  |- 3. buildCropPlan()    [TS, pure]           shots + tracks -> per-shot layout plan
  |- 4. buildFiltergraph() [TS, pure]           CropPlan (+ ass snippet) -> -vf / -filter_complex
  |- cutClips()            one encode pass, unchanged elsewhere
  |- Clip.cropPlan = plan  persisted for trim re-renders
  '- on ANY step failure -> legacy center crop + warn + manifest reason
```

Models and heuristics never emit filter strings; the LLM is not involved at all. Every decision is deterministic code over detector JSON, so the whole layout layer is unit-testable on fixtures.

## 4. Module layout

```
apps/worker/src/reframe/
  index.ts        computeCropPlan(sourcePath, highlight, cfg) - orchestrates 1-3, 30s cap
  shots.ts        ffmpeg scdet invocation + parse, micro-shot merge
  faces.ts        spawns detect_faces.py, validates JSON contract
  plan.ts         layout decisions, dominance scoring, shot merging  [pure]
  filtergraph.ts  CropPlan -> filter spec (vf | complex)             [pure]
  config.ts       env loader (REFRAME_* knobs)
  types.ts        CropPlan v1, FaceTrack, Shot, FilterSpec
apps/worker/assets/reframe/
  detect_faces.py                       thin detector sidecar
  face_detection_yunet_2023mar.onnx     ~230KB, vendored in git
```

`assets/` already ships in the production image and resolves identically in dev (tsx) and prod (`__dirname/../../assets`, the `resolveFontsDir` pattern).

## 5. Step details

### 5.1 Shot detection (TS + ffmpeg)

- `ffmpeg -ss <start> -to <end> -i source -vf "scale=320:-2,select='gte(scene,T)',showinfo" -f null -` on the highlight window only; parse frame times from showinfo. Threshold `REFRAME_SCENE_THRESHOLD` (default 0.3, 0..1 scale; a zero-cut window of 15s+ retries once at half the threshold - quiet same-studio cuts score 0.3-0.4 and a missed cut is worse than over-segmentation, which the merge pass heals).
- Shots shorter than `REFRAME_MIN_SHOT_SEC` (default 1.0) merge into their predecessor (anti-flicker).
- Zero detected cuts -> the whole clip is one shot (the common close-up case degrades to one detection pass and one static crop).
- All timestamps are clip-relative (`-ss` before `-i` resets PTS to ~0), the same convention the ASS cues already use, so filter `t` expressions and subtitle timing share one timeline.

### 5.2 Face detection (Python sidecar)

Contract: `python3 detect_faces.py --video <path> --shots <json> --fps <sampleFps> --model <onnx>` -> JSON on stdout.

- Samples frames at `REFRAME_SAMPLE_FPS` (default 2) per shot, decoded at ~640px width.
- YuNet (`cv2.FaceDetectorYN`, verified present in Alpine 3.23 `py3-opencv` 4.12) detects boxes + 5 landmarks; detections below `REFRAME_FACE_MIN_SCORE` (default 0.7) drop.
- Greedy IoU association into per-shot **tracks**; per track: median box, mean score, sample count, and `mouthActivity` - mean absolute pixel difference of the mouth region between consecutive samples of the track (cheap proto-ASD signal, ready for real ASD later).
- Python is deliberately thin: detection, association, mouth motion. **No layout decisions.** Output is validated in `faces.ts` against a strict schema; any violation -> fallback.

### 5.3 Layout plan (TS, pure)

Geometry: single/center crop window is `cropW = ih*9/16` full-height; a split tile is 1080x960 output, full source height, `tileW = ih*9/8` source width.

Per shot, given its tracks:

| Situation | Layout |
|---|---|
| 0 tracks | `center` - static centered window |
| All track boxes fit inside one window (bounding box width <= 0.9 * cropW) | `single` - window centered on the bounding-box center x |
| Exactly 2 tracks, not fitting | `split` - tiles centered per face; source-leftmost face takes the top tile (stable, no reordering jitter) |
| 3+ tracks, not fitting | `split` of the top-2 by dominance if both clearly lead the rest (each >= 1.5x the third's score), else `center` |

- Dominance score: normalized box area + centrality + mouthActivity, fixed weights in code (not env; tune via fixtures).
- All x offsets clamp to `[0, iw - cropW]` (or `tileW`) and round to even integers (libx264 chroma).
- **Merge pass:** adjacent shots with the same layout and near-identical geometry (single: |dx| < 4% of iw; split: same track pair) merge into one plan window, so the virtual camera does not twitch on soft scene cuts.

### 5.4 Filtergraph build (TS, pure)

`buildFiltergraph(plan, assSnippet?) -> { kind: "vf" | "complex", graph: string }`

- **No split shots:** stays `-vf`. Piecewise-constant crop x over time: `crop=cropW:ih:x='if(lt(t,3.20),412,if(lt(t,7.80),100,650))':0,scale=1080:1920[,ass=...]`.
- **Any split shot:** `-filter_complex`. The source splits into a base chain (piecewise single/center crop, scaled 1080x1920) plus top and bottom tile chains (piecewise x each, scaled 1080x960) overlaid at y=0 and y=960 with `enable='between(t,a,b)+between(t,c,d)...'` covering exactly the split windows; the ass snippet terminates the graph. Two overlay chains total regardless of shot count.
- The existing `createAssFilter` snippet is appended verbatim in both modes; subtitle style and position are unchanged in v1 (on split shots captions overlay the bottom tile, accepted for v1).
- Numeric formatting is fixed to 2 decimals; expression commas are escaped per ffmpeg filter syntax. This function owns every string-safety concern and is exhaustively unit-tested.

### 5.5 Pipeline touchpoints

- `cut.ts`: `cutClips` accepts an optional prebuilt `FilterSpec`; when present it is used (`-vf` or `-filter_complex` + explicit maps), when absent the legacy `buildCropFilter()` path runs unchanged.
- `render.ts` (clips mode): when `REFRAME_ENGINE=faces`, call `computeCropPlan` per highlight under a `REFRAME_MAX_DETECT_SEC` (default 30) timeout; `null` result -> legacy path. Persist the plan on `Clip.cropPlan`; aggregate `renderManifest.reframe = { engine, shotCount, layoutCounts, detectMs, fallbackReason? }` per clip.
- `render.ts` (trim mode, clean-source path): re-window the stored `cropPlan` to the trim range `[start, end]` (clip-relative, exactly like `sliceCues`) and rebuild the filtergraph from it - trim re-renders stop center-cropping too. The trim-from-clip-file path is untouched (the clip is already vertical).
- Thumbnails: unchanged (16:9 source frame).

## 6. Data model

Prisma migration (migrations only, no `db push`):

- `Clip.cropPlan Json?` - CropPlan v1, clip-relative seconds:

```json
{
  "version": 1,
  "engine": "faces",
  "source": { "width": 1920, "height": 1080 },
  "shots": [
    { "start": 0, "end": 12.4, "layout": "single", "x": 412 },
    { "start": 12.4, "end": 31.0, "layout": "split",
      "top": { "x": 0 }, "bottom": { "x": 700 } },
    { "start": 31.0, "end": 57.5, "layout": "center", "x": 656 }
  ]
}
```

`renderManifest.reframe` carries the observability summary (no schema change; renderManifest is already Json).

## 7. Configuration

| Env | Default | Meaning |
|---|---|---|
| `REFRAME_ENGINE` | `off` | `off` = legacy center crop; `faces` = this design |
| `REFRAME_SAMPLE_FPS` | `2` | face-detection sampling rate |
| `REFRAME_SCENE_THRESHOLD` | `0.3` | scdet scene score cut (0..1); zero-cut 15s+ windows retry at half |
| `REFRAME_MIN_SHOT_SEC` | `1.0` | micro-shots below this merge into the predecessor |
| `REFRAME_FACE_MIN_SCORE` | `0.7` | YuNet confidence floor |
| `REFRAME_MAX_DETECT_SEC` | `30` | wall cap for shots+faces per clip; overrun -> fallback |

Dominance weights and the fit margin (0.9) are code constants tuned via fixtures, not env.

## 8. Failure handling

Every failure funnels to the same place: `computeCropPlan` returns `null` with a reason, render uses the legacy center crop, the reason lands in `renderManifest.reframe.fallbackReason` and a `console.warn`. Enumerated reasons: `scdet_failed`, `detector_failed`, `detector_invalid_json`, `timeout`, `plan_empty`. The render outcome for the user is never worse than today's behavior.

## 9. Dependencies and deploy

- `apps/worker/Dockerfile` base layer: `apk add --no-cache py3-opencv py3-numpy` (verified on Alpine 3.23: opencv 4.12 with `FaceDetectorYN`; image grows ~150MB). All five worker stage containers share the image; only worker-render uses the new deps.
- YuNet model vendored in git (~230KB ONNX), no network fetch at build or runtime.
- Deploy on linearis-prod: `docker compose up -d --build` (real rebuild - new apk layer), then the standard per-container `prisma generate` + shared build ritual, plus `prisma migrate deploy` for `Clip.cropPlan`.

## 10. Testing

- **Unit (TS, vitest, worker container):**
  - `plan.ts`: fixture detections reproducing both production screenshots (close-up centered -> single; wide duet at edges -> split), 0/1/2/3 faces, group fitting one window, dominant-pair vs chaotic 3+, micro-shot merge, same-layout merge, clamp and even-pixel rounding.
  - `filtergraph.ts`: piecewise x expressions, enable windows exactly covering split shots, vf vs complex mode switch, ass snippet composition, escaping, 2-decimal formatting.
  - plan re-windowing for trim (mirrors `sliceCues` tests).
  - `cut.ts` FilterSpec pass-through; legacy path untouched when spec absent.
- **Python:** structural self-check on synthetic input (runs where cv2 exists, skips otherwise); the script stays thin enough that the JSON contract test in `faces.ts` is the real gate.
- **Smoke (pre-rollout):** the production podcast video that produced both screenshots, before/after comparison; verify split appears on the wide shot, single on close-ups, subtitles intact, A/V drift checks still green.

## 11. Rollout

1. Merge, rebuild worker images, run migration.
2. Smoke on the known podcast upload with `REFRAME_ENGINE=faces` (single job).
3. Flip `.env` to `faces` for all jobs; watch `renderManifest.reframe` fallback reasons and layout counts.
4. Kill switch: `REFRAME_ENGINE=off` reverts to center crop instantly, no rebuild.

## 12. Rejected alternatives

- **Immediate full active-speaker tracking:** highest ceiling, but audio-visual sync R&D risk, heavier CPU, and a wrong speaker guess is a worse defect than a split that always shows both. The layout engine keeps its upgrade path open.
- **Blur letterbox for duets:** preserves scene atmosphere but faces are too small on phones; may return later as a style option.
- **Per-shot segment encode + concat:** simpler filters, but breaks single-pass subtitle burn and doubles encode passes; the time-windowed filtergraph keeps one pass.
- **MediaPipe face mesh:** no musl wheels on Alpine; YuNet via apk py3-opencv is verified and sufficient for box + 5 landmarks.
- **Debian base-image switch for ML deps:** unnecessary once YuNet on Alpine was verified; avoids image churn across all worker stages.
