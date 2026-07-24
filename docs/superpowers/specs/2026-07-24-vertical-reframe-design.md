# Speaker-Aware Vertical Reframe - Design

**Date:** 2026-07-24
**Status:** Design - ready to implement (v1)
**Author:** Trowgar

## Problem

Clips are cropped to 9:16 vertical with a **static center crop** in
[apps/worker/src/processors/cut.ts](../../../apps/worker/src/processors/cut.ts):

```
crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920   // always the middle strip
```

This works when the speaker is centered (close-up), but **fails on wide shots**:
in a podcast two-shot the speakers sit on the sides and the center of the frame
is empty (a table, a radio, a rug). The center crop keeps the empty middle and
crops the actual people out of frame.

Observed on a real upload (science podcast, job `cmrvawjxs00129pvw0oe1c1kv`):
- Close-up clip ("Бактерии, поедающие пластик") - speaker centered → crop fine.
- Wide two-shot clip ("Что может уничтожить человечество") - two people on the
  sides, vintage radio in the middle → vertical showed the radio, cropped both
  speakers out.

This is **not** a highlight-selection bug and **not** bad source video - the
moment selection was correct and the video is a normal wide two-shot. It is a
crop/reframe defect at the CUT step.

## Design: branch the composition by number of detected faces

Before cutting each clip, run a lightweight face-detection pass over sampled
frames of the clip's time range, then pick the composition:

- **1 face** → 9:16 crop centered on that face (not the geometric center).
- **2 faces, far apart** → **split-screen stacked** (each person 1080×960, vstack).
- **0 faces / detection fails** → **blur-backdrop fallback** (wide shot centered
  over a blurred fill; safe, never wrong, faces small).

Rationale for split-screen as the two-person default (over "crop to the active
speaker"): it has **no catastrophic failure mode** (always shows both, never the
wrong person) and needs only face **detection**, not active-speaker tracking
(audio + lip-sync), which is the hard, error-prone part. Crop-to-speaker is
deferred to a later version. Blur is the fallback, not the primary, because it
shrinks faces.

## Environment constraint (will bite if ignored)

The worker image is **`node:20-alpine` (musl)**. `pip install
mediapipe`/`opencv-python` ship glibc-only wheels and will **not install**. Use
the Alpine packages instead:

```dockerfile
RUN apk add --no-cache py3-opencv opencv-data
```

Detector: **OpenCV DNN (res10 SSD)** - bundle `deploy.prototxt` +
`res10_300x300_ssd_iter_140000.caffemodel` (~10 MB) in the repo; it tolerates
head turns. Haar cascade (`haarcascade_frontalface_default.xml`, ships with
opencv) is the zero-download fallback but is frontal-only and weak for podcasts
where people turn their heads. Prefer DNN.

## Step 1 - detector: `apps/worker/scripts/detect_faces.py`

Input: `videoPath start end`. Sample ~12 frames evenly across `[start, end]`
(`cv2.VideoCapture` + `CAP_PROP_POS_MSEC`), run the DNN detector per frame,
cluster face centers by X. Output JSON:

```json
{ "frameW": 1920, "frameH": 1080,
  "layout": "single|split|blur",
  "faces": [{ "cx": 1450, "cy": 540, "w": 300, "h": 300 }] }
```

Decision logic:
- 0 stable faces → `blur`.
- 1 cluster → `single`, `cx` = median X across samples.
- 2 clusters with `dx > frameW*0.25` → `split` (order `cx1 < cx2`).
- 2 clusters close together (both near center) → `single` on their combined
  center (they already fit one crop).
- >2 → take the 2 largest/most-present, else `blur`.

v1 is **static per clip** (median position, no panning) → no jitter.

## Step 2 - FFmpeg composition (concrete filters)

**single** (`CX` = face center X in source pixels):
```
crop=w=ih*9/16:h=ih:x='clip(CX-ih*9/16/2,0,iw-ih*9/16)':y=0,scale=1080:1920
```

**split-screen** (needs `-filter_complex`, tiles are 9:8 each):
```
[0:v]crop=w=ih*9/8:h=ih:x='clip(CX1-ih*9/8/2,0,iw-ih*9/8)':y=0,scale=1080:960[top];
[0:v]crop=w=ih*9/8:h=ih:x='clip(CX2-ih*9/8/2,0,iw-ih*9/8)':y=0,scale=1080:960[bot];
[top][bot]vstack[v]
```
Left person on top, right on bottom; each fills its half.

**blur fallback**:
```
[0:v]scale=-1:1920,crop=1080:1920,boxblur=20:3[bg];
[0:v]scale=1080:-2[fg];
[bg][fg]overlay=(W-w)/2:(H-h)/2[v]
```

## Step 3 - integration into `cut.ts`

- New `apps/worker/src/processors/reframe.ts`:
  `detectLayout(videoPath, start, end): Promise<Layout>` (spawns the python
  script) + `buildReframeFilter(layout): { filter: string; complex: boolean }`.
- In `cutClips`, per highlight: `const layout = await detectLayout(videoPath,
  h.start, h.end)` → build the filter → **branch the ffmpeg invocation**:
  - `single` / `blur` → `-vf <filter>` (as today, composed with `extraFilter`).
  - `split` → `-filter_complex "...[v]" -map "[v]" -map 0:a` (single input `0:v`
    used twice).
- ⚠️ The only non-obvious code fork: split **cannot** go through `-vf` (multiple
  labeled inputs + vstack) - it must use `-filter_complex` + `-map`.

## Step 4 - subtitles

Subtitles are burned in the SUBTITLES step after cutting. In split-screen the
seam sits at y=960 - keep subtitles at the **bottom (~y 1650-1750)**, off the
seam. Verify/adjust the subtitle y-position in the subtitles processor.

## Scope

- **v1 (this task):** DNN detect + 3-way branch + static-per-clip + subs bottom.
  Fixes the observed wide-shot crop.
- **v2 (later):** smooth pan for `single` when the face moves (zoompan /
  per-segment crop).
- **v3 (dream, deferred):** active-speaker detection → crop to whoever is
  talking. Hardest, worst failure mode (camera on the listener) - do not build
  until active-speaker detection is reliable.

## Verification

Re-run the science podcast (`cmrvawjxs00129pvw0oe1c1kv`):
- "человечество" (wide two-shot) → **split-screen with two faces**.
- "бактерии" (close-up) → **single**, cropped to the face.
- A b-roll / faceless segment → **blur**, does not crash.

Add these three as reframe regression fixtures (sampled frames + expected
layout) so the branch logic is covered without re-rendering full videos.

## Open questions

- DNN model bundling: commit the ~10 MB caffemodel to the repo, or fetch at
  image build? (Leaning: commit, so builds are hermetic.)
- Two faces close but not centered (both left-of-center): `single` on their
  midpoint, or `split`? v1: `single` on midpoint if `dx < frameW*0.25`.
