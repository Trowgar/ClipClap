# Camera Director Layer 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Give the crop window a position that varies with time inside a shot, for the face group the planner
already selects, behind a flag that is off by default.

**Architecture:** The detector already computes per-frame face boxes and throws them away when it takes a
median. It will emit them as `FaceTrack.path`. A new pure module `camera.ts` turns a per-sample target
position into a keyframe trajectory using a deadzone, an eased follow and a speed cap. `plan.ts` attaches
that trajectory to `single` shots as `xs`, leaving the legacy `x` untouched. `filtergraph.ts` compiles `xs`
into a flat sum of clipped ramps, which has nesting depth 1 and so escapes the `if()` nesting limit that
caps plans at 90 shots today.

**Spec:** `docs/superpowers/specs/2026-08-05-camera-director-layer0-design.md`. Read §4.5 (order of
operations) before touching `plan.ts` - the merge pass forces trajectories to be computed after merging, not
before.

**Tech Stack:** TypeScript (worker), Python 3 + OpenCV YuNet (detector sidecar), ffmpeg `av_expr`, vitest,
python `unittest`.

**How to run things:**

```bash
# TypeScript tests
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/<file>'
# Typecheck
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
# Python tests
docker compose exec -T worker-render sh -c \
  'cd /app/apps/worker/assets/reframe && python3 -m unittest <module> -v'
# Scripts
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/<file>.ts'
```

**Branch:** `git checkout -b feat/camera-layer0` from `main` before Task 1.

---

## File structure

| file | responsibility | task |
|---|---|---|
| `apps/worker/assets/reframe/corpus.json` | new. Manifest of corpus URLs and time ranges | 1 |
| `apps/worker/src/scripts/corpus-fetch.ts` | new. Materialises the corpus into `.corpus/` | 1 |
| `apps/worker/src/scripts/corpus-baseline.ts` | new. Renders each item twice, captures detector JSON | 2 |
| `apps/worker/assets/reframe/detect_faces.py` | emits `path` per track | 3 |
| `apps/worker/assets/reframe/test_detect_path.py` | new. Python tests for `path` | 3 |
| `apps/worker/src/reframe/types.ts` | `FaceTrack.path`, `Keyframe`, `single.xs`, version 3 | 4 |
| `apps/worker/src/reframe/faces.ts` | strict parsing of `path` | 4 |
| `apps/worker/src/reframe/camera.ts` | new. The motion controller. Pure. | 5 |
| `apps/worker/src/reframe/plan.ts` | target samples, `xs` emission after merge, `sliceCropPlan` v3 | 6, 7 |
| `apps/worker/src/reframe/filtergraph.ts` | `rampX`, expression selection | 8 |
| `apps/worker/src/reframe/config.ts` | `REFRAME_MOTION` and camera knobs | 9 |
| `apps/worker/src/scripts/eval-camera-invariance.ts` | new. Check 1 | 10 |
| `apps/worker/src/scripts/eval-camera-containment.ts` | new. Check 2 | 11 |
| `apps/worker/src/scripts/eval-camera-safety.ts` | new. Checks 3 and 4 | 12 |

---

## Task 1: Corpus manifest and fetch script

**Files:**
- Create: `apps/worker/assets/reframe/corpus.json`
- Create: `apps/worker/src/scripts/corpus-fetch.ts`
- Create: `.gitignore` entry for `.corpus/`

**Context:** There is no corpus. All 21 jobs have `sourceKey = null`; every source video has been swept,
including the one §7b and §7c rest on. Nothing else in this plan can be verified until this exists. The
manifest is committed; the videos are not.

- [ ] **Step 1: Write the manifest**

Create `apps/worker/assets/reframe/corpus.json`. The URLs below are placeholders **that the operator must
replace before running the fetch** - pick public videos matching each `tests` description. Leave `url` empty
and the fetch script will skip that item with a warning rather than fail.

```json
{
  "outDir": ".corpus",
  "items": [
    { "id": "podcast-2p",   "url": "", "in": "00:00:00", "len": 90,
      "tests": "two people seated, shifting and leaning - the core case" },
    { "id": "sitcom-multi", "url": "", "in": "00:00:00", "len": 90,
      "tests": "multi-camera scripted comedy - closest to our only real user material" },
    { "id": "lockedoff-1p", "url": "", "in": "00:00:00", "len": 90,
      "tests": "single talking head, camera locked off - MUST NOT MOVE, the false-positive control" },
    { "id": "vlog-mixed",   "url": "", "in": "00:00:00", "len": 120,
      "tests": "talking head, then street, then a phone screen - mixed material at shot level" },
    { "id": "stream-cam",   "url": "", "in": "00:00:00", "len": 90,
      "tests": "gameplay with a webcam inset - stream layout regression" },
    { "id": "gameplay",     "url": "", "in": "00:00:00", "len": 90,
      "tests": "no faces - byte-identical regression guard" },
    { "id": "sports",       "url": "", "in": "00:00:00", "len": 90,
      "tests": "no anchorable faces - byte-identical regression guard" },
    { "id": "screencast",   "url": "", "in": "00:00:00", "len": 90,
      "tests": "screen recording - byte-identical regression guard" },
    { "id": "animation",    "url": "", "in": "00:00:00", "len": 90,
      "tests": "stylised faces YuNet is expected to miss - byte-identical regression guard" }
  ]
}
```

- [ ] **Step 2: Ignore the materialised videos**

Append to `.gitignore`:

```
# Reframe corpus - materialised from assets/reframe/corpus.json, never committed
.corpus/
```

- [ ] **Step 3: Write the fetch script**

Create `apps/worker/src/scripts/corpus-fetch.ts`:

```ts
/**
 * Materialises the reframe corpus from its committed manifest.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/corpus-fetch.ts"
 *
 * The manifest is committed, the videos are not. This exists because the
 * retention sweep deleted every source video this project had, including the
 * one engine-notes 7b and 7c rest on - so a corpus that lives inside the job
 * system is a corpus that disappears. `.corpus/` is outside R2, outside the
 * Job table and in .gitignore.
 *
 * Nine sequential YouTube fetches on one WARP exit is the highest-probability
 * bot-check scenario in this project, and rotation is what made YouTube work at
 * all - so this uses the SAME proxy args and the SAME rotate-and-retry wrapper
 * the download processor uses, rather than re-reading the env inline.
 */
import { createRequire } from "module";
import { mkdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { proxyArgs } from "@clipclap/shared";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { runYtDlpWithRotation } from "../processors/download";
import { reframeAssetsDir } from "../reframe/faces";

export interface CorpusItem {
  id: string;
  /** Empty until a human fills it in; such items are skipped, not failed. */
  url: string;
  /** Start offset, `HH:MM:SS` or plain seconds. */
  in: string;
  /** Duration in seconds. NOT an end time - see sectionArg. */
  len: number;
  tests: string;
}

export interface CorpusManifest {
  outDir: string;
  items: CorpusItem[];
}

/** Seconds from `HH:MM:SS`, `MM:SS` or a plain number. */
export function toSeconds(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`corpus: unparseable time ${JSON.stringify(value)}`);
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * yt-dlp's `--download-sections` value.
 *
 * The second component is an ABSOLUTE END, not a duration, so `len` has to be
 * added to `in` rather than pasted after the hyphen. `*00:00:00-+90` - the
 * obvious-looking form - is rejected outright by yt-dlp 2026.07.04 with
 * "invalid --download-sections time range", an argv parse error that fails
 * every item identically before any network work. Seconds on both sides,
 * because the timestamp form has to be reassembled and there is nothing to gain
 * from it.
 */
export function sectionArg(item: CorpusItem): string {
  const start = toSeconds(item.in);
  return `*${start}-${start + item.len}`;
}

export async function loadManifest(): Promise<CorpusManifest> {
  const raw = await readFile(join(reframeAssetsDir(), "corpus.json"), "utf-8");
  const parsed = JSON.parse(raw) as Partial<CorpusManifest>;
  // Structural check rather than a bare cast, the house style for a parsed
  // external contract (see parseDetectorOutput). A malformed manifest would
  // otherwise hand consumers an undefined `items` and surface as a TypeError
  // far from the cause.
  if (typeof parsed.outDir !== "string" || !Array.isArray(parsed.items)) {
    throw new Error("corpus: manifest must have outDir and items");
  }
  for (const item of parsed.items) {
    if (
      typeof item?.id !== "string" ||
      typeof item?.url !== "string" ||
      typeof item?.in !== "string" ||
      typeof item?.len !== "number"
    ) {
      throw new Error(`corpus: malformed item ${JSON.stringify(item?.id)}`);
    }
  }
  return parsed as CorpusManifest;
}

/** Where a materialised item lands. Resolved from `__dirname` rather than a
 *  hardcoded `/app/...`, so it is correct under tsx and under the dist layout,
 *  and matches how the manifest itself is located. */
export function corpusDir(manifest: CorpusManifest): string {
  return join(__dirname, "..", "..", manifest.outDir);
}

export function corpusPath(manifest: CorpusManifest, id: string): string {
  return join(corpusDir(manifest), `${id}.mp4`);
}

async function main() {
  const manifest = await loadManifest();
  const dir = corpusDir(manifest);
  await mkdir(dir, { recursive: true });

  let fetched = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of manifest.items) {
    const out = join(dir, `${item.id}.mp4`);
    if (!item.url) {
      console.warn(`skip ${item.id}: no url in the manifest (${item.tests})`);
      skipped += 1;
      continue;
    }
    // Existence, not integrity: a download truncated by a full disk stays a
    // permanent cache hit. Acceptable because every comparison this corpus
    // feeds is our own render against our own baseline from the SAME file, so
    // a short fixture yields less material rather than a wrong answer.
    const existing = await stat(out).catch(() => null);
    if (existing && existing.size > 0) {
      console.log(`have ${item.id} (${(existing.size / 1e6).toFixed(1)} MB)`);
      fetched += 1;
      continue;
    }
    console.log(`fetch ${item.id} ...`);
    try {
      await runYtDlpWithRotation(
        [
          ...proxyArgs(),
          "-f", "bv*[height<=1080]+ba/b[height<=1080]",
          "--download-sections", sectionArg(item),
          "--force-keyframes-at-cuts",
          "--merge-output-format", "mp4",
          "-o", out,
          item.url,
        ],
        { maxBuffer: CHILD_MAX_BUFFER_BYTES }
      );
      const got = await stat(out);
      console.log(`  ok ${item.id} (${(got.size / 1e6).toFixed(1)} MB)`);
      fetched += 1;
    } catch (error) {
      // stderr, not message. Node builds message as "Command failed: " plus the
      // whole command line, which is 239 chars without the proxy and 266 with
      // it BEFORE stderr begins - so any truncation of `message` is guaranteed
      // to cut exactly the reason and keep only the arguments.
      const stderr = (error as { stderr?: string })?.stderr ?? "";
      const reason = stderr.trim() || (error as Error).message;
      console.error(`  FAILED ${item.id}: ${reason.slice(-400)}`);
      failed += 1;
    }
  }

  console.log(
    `\n${fetched} available, ${failed} failed, ${skipped} awaiting a url in the manifest`
  );
  // A non-zero exit when something with a url did not materialise: without it
  // the documented command "succeeds" against an empty .corpus/ and no caller
  // can tell a ready corpus from total failure.
  if (failed > 0) process.exitCode = 1;
}

// Only when run directly. `loadManifest`, `corpusPath` and `sectionArg` are
// imported by the baseline and measurement scripts, and an unguarded main()
// would spawn nine downloads as an import side effect. Same guard as
// eval-bless.ts, typeof-checked for the same reason: tsx loads this as CJS
// while vitest transforms it to ESM.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'`
Expected: no output.

- [ ] **Step 5: Fill in real URLs and fetch**

The operator edits `corpus.json` with real public URLs, then runs:

`docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/corpus-fetch.ts'`

Expected: one `ok <id>` line per item with a URL. **Do not proceed past Task 2 with fewer than the
`podcast-2p`, `lockedoff-1p` and one faceless item present** - those three carry the core case, the
false-positive control and the regression guard respectively.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/assets/reframe/corpus.json apps/worker/src/scripts/corpus-fetch.ts .gitignore
git commit -m "feat(eval): a reframe corpus that the retention sweep cannot delete"
```

---

## Task 2: Baseline capture

**Files:**
- Create: `apps/worker/src/scripts/corpus-baseline.ts`

**Context:** Spec §6.0. This produces the paired baseline for check 1 level 3, verifies on real material
that two legacy renders are byte-identical (§5.4 measured that on a synthetic source without the subtitle
burn), and captures the detector JSON that checks 1 and 2 both need. **Unlike last time there is no way to
re-derive a baseline afterwards.**

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/corpus-baseline.ts`:

```ts
/**
 * Step 0 of the Layer 0 measurement plan: capture what today's engine does,
 * before any code changes.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/corpus-baseline.ts"
 *
 * Three artifacts, and they are not interchangeable:
 *   .corpus/<id>.plan.json      the v2 crop plan, and the detector output that
 *                               produced it - needed by check 1 level 2 and by
 *                               check 2's primary metric, which needs no render
 *   .corpus/<id>.base1.mp4      baseline render
 *   .corpus/<id>.base2.mp4      second render of the SAME input, so that
 *                               "two legacy renders are byte-identical" is
 *                               verified on real material with the subtitle
 *                               burn rather than assumed from a synthetic probe
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { loadManifest, corpusPath } from "./corpus-fetch";
import { detectShots } from "../reframe/shots";
import { detectFaces } from "../reframe/faces";
import { buildCropPlan } from "../reframe/plan";
import { resolveCamRect } from "../reframe/cam-rect";
import { buildFiltergraph } from "../reframe/filtergraph";
import { loadReframeConfig } from "../reframe/config";

const execFileAsync = promisify(execFile);

const CLIP_START = 0;
const CLIP_LEN = 60;

function md5(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

async function probe(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path,
  ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
  const [width, height] = stdout.trim().split("x").map(Number);
  return { width, height };
}

async function main() {
  const manifest = await loadManifest();
  const cfg = loadReframeConfig();
  let mismatches = 0;

  for (const item of manifest.items) {
    const src = corpusPath(manifest, item.id);
    const { width, height } = await probe(src).catch(() => ({ width: 0, height: 0 }));
    if (!width) {
      console.warn(`skip ${item.id}: not materialised`);
      continue;
    }
    const end = CLIP_START + CLIP_LEN;

    const shots = await detectShots(src, CLIP_START, end, cfg, 60_000);
    const tracks = await detectFaces(
      src, CLIP_START, end, shots, width, height, cfg, 120_000
    );
    const cam = resolveCamRect(tracks.map((t) => t.camRect), width, height);
    const plan = buildCropPlan(shots, tracks, width, height, {
      faceSmallFrac: cfg.faceSmallFrac,
      faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream,
      camShare: cfg.camShare,
    }, cam);

    await writeFile(
      join("/app/apps/worker", manifest.outDir, `${item.id}.plan.json`),
      JSON.stringify({ shots, tracks, plan, source: { width, height },
                       clip: { start: CLIP_START, end } }, null, 2),
      "utf-8"
    );

    if (!plan) {
      console.log(`${item.id}: no plan (legacy centre crop path) - recorded`);
      continue;
    }
    const spec = buildFiltergraph(plan);
    const renders: string[] = [];
    for (const n of [1, 2]) {
      const out = join("/app/apps/worker", manifest.outDir, `${item.id}.base${n}.mp4`);
      const filterArgs = spec.kind === "vf"
        ? ["-vf", spec.graph]
        : ["-filter_complex", spec.graph, "-map", "[vout]", "-map", "0:a?"];
      await execFileAsync("ffmpeg", [
        "-nostdin", "-ss", String(CLIP_START), "-t", String(CLIP_LEN), "-i", src,
        ...filterArgs,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart", out, "-y",
      ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
      renders.push(await md5(out));
    }
    const same = renders[0] === renders[1];
    if (!same) mismatches += 1;
    console.log(
      `${item.id}: ${plan.shots.length} shots, two renders ${same ? "IDENTICAL" : "DIFFER"} ${renders[0].slice(0, 12)}`
    );
  }

  console.log("");
  if (mismatches === 0) {
    console.log("full-file md5 is a usable invariant on real material - spec 5.4 holds");
  } else {
    console.log(
      `${mismatches} item(s) rendered differently twice. Spec 5.4's fallback applies: ` +
      `demote to decoded streamhash plus a byte comparison of filtergraph and encode args.`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'`
Expected: no output.

- [ ] **Step 3: Capture the baseline**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/corpus-baseline.ts'`

Expected: one line per materialised item, and a final line stating whether full-file md5 is usable. Record
that answer in the commit message - the rest of the plan's check 1 depends on it.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/scripts/corpus-baseline.ts
git commit -m "feat(eval): capture the pre-change baseline, twice, before any Layer 0 code"
```

---

## Task 3: The detector emits per-sample paths

**Files:**
- Modify: `apps/worker/assets/reframe/detect_faces.py`
- Create: `apps/worker/assets/reframe/test_detect_path.py`

**Context:** The boxes already exist in `tr["boxes"]`; only the median survives. The frame index is needed to
turn them into times, and today the loop appends a box without recording which frame it came from.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/assets/reframe/test_detect_path.py`:

```python
import unittest

import numpy as np

import detect_faces as df


class TestTrackPath(unittest.TestCase):
    def test_path_carries_one_entry_per_sample_in_source_pixels(self):
        track = {
            "boxes": [
                np.array([10.0, 20.0, 30.0, 40.0], np.float32),
                np.array([12.0, 20.0, 30.0, 40.0], np.float32),
            ],
            "times": [0.0, 0.5],
        }
        path = df.render_path(track, scale=2.0)
        self.assertEqual(len(path), 2)
        self.assertEqual(path[0], {"t": 0.0, "x": 20.0, "y": 40.0, "w": 60.0, "h": 80.0})
        self.assertEqual(path[1]["t"], 0.5)
        self.assertEqual(path[1]["x"], 24.0)

    def test_path_is_sorted_by_time(self):
        track = {
            "boxes": [
                np.array([1.0, 1.0, 1.0, 1.0], np.float32),
                np.array([2.0, 2.0, 2.0, 2.0], np.float32),
            ],
            "times": [1.0, 0.5],
        }
        path = df.render_path(track, scale=1.0)
        self.assertEqual([p["t"] for p in path], [0.5, 1.0])

    def test_empty_track_yields_empty_path(self):
        self.assertEqual(df.render_path({"boxes": [], "times": []}, scale=1.0), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to see it fail**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker/assets/reframe && python3 -m unittest test_detect_path -v'`
Expected: FAIL with `AttributeError: module 'detect_faces' has no attribute 'render_path'`.

- [ ] **Step 3: Record the sample time on every box**

In `detect_faces.py`, inside `main()`, the track-association block currently stores boxes without times.
Change the two places that append.

Replace:

```python
            if best is None:
                tracks.append({
                    "boxes": [box],
                    "scores": [float(det[14])],
                    "last_box": box,
                    "mouth": [],
                    "last_patch": patch,
                })
            else:
                best["boxes"].append(box)
                best["scores"].append(float(det[14]))
                best["last_box"] = box
```

with:

```python
            if best is None:
                tracks.append({
                    "boxes": [box],
                    "times": [t],
                    "scores": [float(det[14])],
                    "last_box": box,
                    "mouth": [],
                    "last_patch": patch,
                })
            else:
                best["boxes"].append(box)
                best["times"].append(t)
                best["scores"].append(float(det[14]))
                best["last_box"] = box
```

- [ ] **Step 4: Add `render_path`**

Add above `def main():` in `detect_faces.py`:

```python
def render_path(track, scale):
    """Per-sample boxes in SOURCE pixels, sorted by time.

    The median in `box` is what every existing consumer reads and it is
    unchanged. This is the same data before the median was taken, which is the
    whole of what Layer 0 needs: the planner could not express a moving camera
    because this was discarded here.

    Sorted explicitly rather than trusting insertion order. Frames are walked in
    order today, so the list is already sorted - but a caller that ever batches
    or parallelises frames would produce a path that silently runs backwards in
    time, and every consumer downstream assumes monotonic t.
    """
    rows = sorted(zip(track["times"], track["boxes"]), key=lambda r: r[0])
    return [
        {
            "t": float(t),
            "x": float(b[0]) * scale,
            "y": float(b[1]) * scale,
            "w": float(b[2]) * scale,
            "h": float(b[3]) * scale,
        }
        for t, b in rows
    ]
```

- [ ] **Step 5: Emit it**

In the output loop, add `path` to the rendered track dict. Replace:

```python
                "samples": len(tr["boxes"]),
                "mouthActivity": float(np.mean(tr["mouth"])) if tr["mouth"] else 0.0,
            })
```

with:

```python
                "samples": len(tr["boxes"]),
                "mouthActivity": float(np.mean(tr["mouth"])) if tr["mouth"] else 0.0,
                "path": render_path(tr, scale),
            })
```

- [ ] **Step 6: Run both python suites**

Run:
```
docker compose exec -T worker-render sh -c 'cd /app/apps/worker/assets/reframe && python3 -m unittest test_detect_path test_cam_rect -v'
```
Expected: all tests PASS. `test_cam_rect` must still pass - the median and the cam-rect search are untouched.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/assets/reframe/detect_faces.py apps/worker/assets/reframe/test_detect_path.py
git commit -m "feat(reframe): emit the per-sample boxes the median was hiding"
```

---

## Task 4: Types and strict parsing

**Files:**
- Modify: `apps/worker/src/reframe/types.ts`
- Modify: `apps/worker/src/reframe/faces.ts:37-65`
- Test: `apps/worker/src/__tests__/reframe-faces.test.ts`

**Context:** Spec §4.1. `path` is optional and additive: an older sidecar must not break a newer worker,
exactly as `camRect` is handled. A **present** `path` is validated as strictly as a track.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-faces.test.ts`:

```ts
describe("parseDetectorOutput path", () => {
  const track = (extra: string) =>
    `{"shots":[{"shotIndex":0,"tracks":[{"id":0,"box":{"x":1,"y":2,"w":3,"h":4},` +
    `"score":0.9,"samples":2,"mouthActivity":0.05${extra}}]}]}`;

  it("accepts a track with no path at all", () => {
    const out = parseDetectorOutput(track(""), 1);
    expect(out[0].tracks[0].path).toBeUndefined();
  });

  it("parses a well-formed path", () => {
    const out = parseDetectorOutput(
      track(`,"path":[{"t":0,"x":1,"y":2,"w":3,"h":4}]`),
      1
    );
    expect(out[0].tracks[0].path).toEqual([{ t: 0, x: 1, y: 2, w: 3, h: 4 }]);
  });

  it("rejects a path entry missing a field", () => {
    expect(() =>
      parseDetectorOutput(track(`,"path":[{"t":0,"x":1,"y":2,"w":3}]`), 1)
    ).toThrow("detector_invalid_json");
  });

  it("rejects a path that is not an array", () => {
    expect(() => parseDetectorOutput(track(`,"path":5`), 1)).toThrow(
      "detector_invalid_json"
    );
  });

  it("rejects a non-finite coordinate rather than passing NaN downstream", () => {
    expect(() =>
      parseDetectorOutput(track(`,"path":[{"t":0,"x":null,"y":2,"w":3,"h":4}]`), 1)
    ).toThrow("detector_invalid_json");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-faces.test.ts'`
Expected: FAIL - `path` is not on the type and is dropped by the parser.

- [ ] **Step 3: Add the types**

In `apps/worker/src/reframe/types.ts`, replace the `FaceTrack` interface with:

```ts
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One detector sample of one track. `t` is clip-relative seconds. */
export interface PathSample extends FaceBox {
  t: number;
}

export interface FaceTrack {
  id: number;
  /** Median box across the track's samples, SOURCE pixels. */
  box: FaceBox;
  score: number; // mean detection confidence
  samples: number; // detections associated into this track
  mouthActivity: number; // mean abs mouth-region diff between samples, 0..1
  /** Per-sample boxes, SOURCE pixels, sorted by t. Absent from older sidecar
   *  builds, which is not a contract violation. */
  path?: PathSample[];
}

/** A point on the crop window's trajectory. `t` is clip-relative seconds, `x`
 *  is the window's LEFT edge in source pixels - the same quantity as the
 *  legacy `ShotLayout.single.x`. */
export interface Keyframe {
  t: number;
  x: number;
}
```

Then replace the `single` variant of `ShotLayout`:

```ts
  | {
      start: number;
      end: number;
      layout: "single";
      /** LEGACY median x. Unchanged from v2, and never the first value of `xs`
       *  - a consumer that ignores `xs` must render exactly what v2 rendered,
       *  which is what makes "flag off equals today" falsifiable. */
      x: number;
      /** Trajectory, present only when the camera actually moves. */
      xs?: Keyframe[];
    }
```

And widen the version:

```ts
export interface CropPlan {
  version: 1 | 2 | 3;
  ...
}
```

- [ ] **Step 4: Parse it strictly**

In `apps/worker/src/reframe/faces.ts`, inside the `st.tracks.map` callback, after the existing validation
block that throws `detector_invalid_json`, and before the `return` of the track object, insert:

```ts
      // An ABSENT path is fine - an older sidecar must not break a newer
      // worker, the same rule camRect follows below. A PRESENT one is
      // validated as strictly as the track itself, because a NaN reaching the
      // camera solver would produce a crop expression ffmpeg accepts and
      // renders as garbage.
      let path: PathSample[] | undefined;
      const rawPath = (t as { path?: unknown }).path;
      if (rawPath != null) {
        if (!Array.isArray(rawPath)) throw new Error("detector_invalid_json");
        path = rawPath.map((p) => {
          const s = p as Record<string, unknown>;
          if (!num(s.t) || !num(s.x) || !num(s.y) || !num(s.w) || !num(s.h)) {
            throw new Error("detector_invalid_json");
          }
          return { t: s.t, x: s.x, y: s.y, w: s.w, h: s.h };
        });
      }
```

Change the returned object to include it:

```ts
      return {
        id: tr.id,
        box: { x: tr.box.x, y: tr.box.y, w: tr.box.w, h: tr.box.h },
        score: tr.score,
        samples: tr.samples,
        mouthActivity: tr.mouthActivity,
        ...(path ? { path } : {}),
      };
```

Add `PathSample` to the type import at the top of `faces.ts`:

```ts
import type { CamRect, FaceTrack, PathSample, Shot, ShotTracks } from "./types";
```

- [ ] **Step 5: Run tests**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-faces.test.ts'`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Typecheck and commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/types.ts apps/worker/src/reframe/faces.ts apps/worker/src/__tests__/reframe-faces.test.ts
git commit -m "feat(reframe): carry per-sample face paths through the detector contract"
```

---

## Task 5: The motion controller

**Files:**
- Create: `apps/worker/src/reframe/geometry.ts`
- Create: `apps/worker/src/reframe/camera.ts`
- Test: `apps/worker/src/__tests__/reframe-camera.test.ts`

**Context:** Spec §4.2 and §3.3. Pure, no I/O, no dependency on the planner. Deadzone decides when to start
moving, a smaller settle band decides when to stop - that difference is the hysteresis that stops the camera
hunting. Returns `null` whenever the trajectory should not be emitted, so the caller falls back to legacy
`x` without a second decision.

- [ ] **Step 0: Break the import cycle before it exists**

`camera.ts` needs `evenClamp`, which lives in `plan.ts`; `plan.ts` will import `camera.ts` in Task 6. That is
a cycle, and ESM resolves cycles by handing one module a partially-initialised copy of the other - a failure
that shows up at render time, past every test that imports only one of them. Move the three pure geometry
helpers out first.

Create `apps/worker/src/reframe/geometry.ts`:

```ts
/** Pure 9:16 geometry, in its own module so that `camera.ts` can use it without
 *  importing `plan.ts`, which imports `camera.ts` back. */

export function cropWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 16 / 2);
}

export function tileWidthFor(sourceHeight: number): number {
  return 2 * Math.round((sourceHeight * 9) / 8 / 2);
}

export function evenClamp(x: number, cropW: number, sourceWidth: number): number {
  const clamped = Math.min(Math.max(0, x), sourceWidth - cropW);
  return 2 * Math.round(clamped / 2);
}
```

In `apps/worker/src/reframe/plan.ts`, delete those three function bodies and re-export them instead, so no
existing importer changes:

```ts
import { cropWidthFor, evenClamp, tileWidthFor } from "./geometry";
export { cropWidthFor, evenClamp, tileWidthFor };
```

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'`
Expected: PASS with no test changes - this is a pure move.

Commit it on its own so the move is separable from the behaviour:

```bash
git add apps/worker/src/reframe/geometry.ts apps/worker/src/reframe/plan.ts
git commit -m "refactor(reframe): move pure geometry out of plan.ts, no behaviour change"
```

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/reframe-camera.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { solveCamera, DEFAULT_CAMERA, type TargetSample } from "../reframe/camera";

// A 1280x720 source: cropW is 406, so the window can sit anywhere in [0, 874].
const W = 1280;
const CROP = 406;

/** Targets one per half second, at a constant centre. */
const still = (cx: number, n = 20): TargetSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 0.5, cx }));

describe("solveCamera", () => {
  it("returns null when the target never leaves the deadzone", () => {
    // The control case the locked-off corpus item exists to protect: a static
    // subject must not acquire a camera move.
    const x0 = 437; // window centred at 640
    expect(solveCamera(still(640), x0, CROP, W, 0, 10, DEFAULT_CAMERA)).toBeNull();
  });

  it("returns null for a target that jitters inside the deadzone", () => {
    // 2 fps YuNet boxes wobble by a few pixels. That must not become pan.
    const targets = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.5,
      cx: 640 + (i % 2 === 0 ? 6 : -6),
    }));
    expect(solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)).toBeNull();
  });

  it("moves when the target leaves the deadzone", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA);
    expect(keys).not.toBeNull();
    expect(keys!.length).toBeGreaterThan(1);
    // ends up tracking the new position
    expect(keys!.at(-1)!.x).toBeGreaterThan(600);
  });

  it("never exceeds the speed cap between consecutive keyframes", () => {
    const targets: TargetSample[] = [
      { t: 0, cx: 200 },
      ...Array.from({ length: 19 }, (_, i) => ({ t: 0.5 + i * 0.5, cx: 1100 })),
    ];
    const keys = solveCamera(targets, 0, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    const cap = DEFAULT_CAMERA.maxSpeedFrac * CROP;
    for (let i = 1; i < keys.length; i++) {
      const dt = keys[i].t - keys[i - 1].t;
      const dx = Math.abs(keys[i].x - keys[i - 1].x);
      expect(dx / dt).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it("keeps every keyframe inside the frame", () => {
    const targets: TargetSample[] = Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.5,
      cx: i < 10 ? -500 : 5000, // targets far outside the frame on both sides
    }));
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    for (const k of keys) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(W - CROP);
    }
  });

  it("emits keyframes with strictly increasing times", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i].t).toBeGreaterThan(keys[i - 1].t);
    }
  });

  it("spans the whole shot, so the expression is total", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    expect(keys[0].t).toBe(0);
    expect(keys.at(-1)!.t).toBe(10);
  });

  it("starts at the legacy x, so the first frame is unchanged", () => {
    const targets: TargetSample[] = [
      ...still(640, 4),
      ...Array.from({ length: 16 }, (_, i) => ({ t: 2 + i * 0.5, cx: 900 })),
    ];
    const keys = solveCamera(targets, 437, CROP, W, 0, 10, DEFAULT_CAMERA)!;
    expect(keys[0].x).toBe(437);
  });

  it("returns null when fewer than two samples are available", () => {
    expect(solveCamera([{ t: 0, cx: 900 }], 437, CROP, W, 0, 10, DEFAULT_CAMERA))
      .toBeNull();
    expect(solveCamera([], 437, CROP, W, 0, 10, DEFAULT_CAMERA)).toBeNull();
  });

  it("returns null rather than truncating when it would exceed the cap", () => {
    // Alternating far targets at a high sample rate: many direction changes.
    const targets: TargetSample[] = Array.from({ length: 4000 }, (_, i) => ({
      t: i * 0.01,
      cx: i % 2 === 0 ? 100 : 1180,
    }));
    const keys = solveCamera(targets, 437, CROP, W, 0, 40, {
      ...DEFAULT_CAMERA,
      maxKeyframes: 20,
    });
    expect(keys).toBeNull();
  });

  it("does not restart moving until the target leaves the deadzone again", () => {
    // Hysteresis: settle is tighter than deadzone, so a target parked just
    // outside the settle band must not produce a permanent crawl.
    const targets: TargetSample[] = Array.from({ length: 40 }, (_, i) => ({
      t: i * 0.5,
      cx: i < 4 ? 640 : 700,
    }));
    const keys = solveCamera(targets, 437, CROP, W, 0, 20, DEFAULT_CAMERA);
    if (keys) {
      // Whatever it does, it must come to rest: the last two keyframes are equal.
      expect(keys.at(-1)!.x).toBe(keys.at(-2)!.x);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-camera.test.ts'`
Expected: FAIL - `Cannot find module '../reframe/camera'`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/reframe/camera.ts`:

```ts
import type { Keyframe } from "./types";
import { evenClamp } from "./geometry";

/** Where the anchored face group's centre sits at one detector sample.
 *  `t` is clip-relative seconds, `cx` is source pixels. */
export interface TargetSample {
  t: number;
  cx: number;
}

export interface CameraConfig {
  /** Fraction of cropW the target may drift from the window centre before the
   *  camera starts moving. */
  deadzoneFrac: number;
  /** Fraction of cropW the target must be within before the camera stops. Must
   *  be smaller than deadzoneFrac - that difference IS the hysteresis, and
   *  without it the camera re-triggers on the frame after it stops and crawls
   *  permanently. */
  settleFrac: number;
  /** Fraction of cropW per second the window may travel. */
  maxSpeedFrac: number;
  /** Never emit more than this many keyframes; over it, the caller falls back
   *  to the legacy static x. */
  maxKeyframes: number;
}

/**
 * Provisional. Spec §9.1: these have no corpus support and their first real
 * values come from looking at the corpus render. They are deliberately
 * conservative - a camera that moves too little looks like today, a camera
 * that moves too much looks broken.
 */
export const DEFAULT_CAMERA: Readonly<CameraConfig> = Object.freeze({
  deadzoneFrac: 0.12,
  settleFrac: 0.04,
  maxSpeedFrac: 0.25,
  maxKeyframes: 200,
});

/**
 * Turns a per-sample target position into a crop-window trajectory.
 *
 * Deadzone plus eased follow plus a speed cap: the window holds still while the
 * target sits inside the deadzone, eases toward it when it leaves, and stops
 * once the target is inside the tighter settle band. Stillness is the default
 * state and motion is the exception (spec §3.3).
 *
 * Returns null - meaning "emit no trajectory, use the legacy x" - when the
 * camera never moves, when there are fewer than two samples, or when the
 * trajectory would exceed `maxKeyframes`. **Never truncates**: a truncated
 * ramp parks the camera at a position no rule chose (spec §4.6).
 *
 * This decides HOW to move. It never decides WHOM to follow: the group was
 * selected once per shot by `bestFaceGroup` on the median boxes, exactly as
 * before (spec §4.3).
 */
export function solveCamera(
  targets: TargetSample[],
  legacyX: number,
  cropW: number,
  sourceWidth: number,
  spanStart: number,
  spanEnd: number,
  cfg: CameraConfig = DEFAULT_CAMERA
): Keyframe[] | null {
  if (targets.length < 2 || !(spanEnd > spanStart)) return null;

  const deadzone = cfg.deadzoneFrac * cropW;
  const settle = cfg.settleFrac * cropW;
  const maxSpeed = cfg.maxSpeedFrac * cropW;
  const ordered = [...targets].sort((a, b) => a.t - b.t);

  let x = legacyX;
  let moving = false;
  const raw: Keyframe[] = [{ t: spanStart, x }];

  for (let i = 0; i < ordered.length; i++) {
    const sample = ordered[i];
    if (sample.t <= spanStart || sample.t > spanEnd) continue;
    const prevT = raw[raw.length - 1].t;
    const dt = sample.t - prevT;
    if (dt <= 0) continue;

    // Where the window would sit if it could teleport, clamped into frame.
    const desired = evenClamp(sample.cx - cropW / 2, cropW, sourceWidth);
    const err = desired - x;
    if (!moving && Math.abs(err) > deadzone) moving = true;
    if (moving) {
      const step = Math.sign(err) * Math.min(Math.abs(err), maxSpeed * dt);
      x = evenClamp(x + step, cropW, sourceWidth);
      if (Math.abs(desired - x) <= settle) moving = false;
    }
    raw.push({ t: sample.t, x });
  }

  if (raw[raw.length - 1].t < spanEnd) {
    raw.push({ t: spanEnd, x });
  }

  // Never moved: emitting a flat trajectory would only add expression length
  // and would make a clip that should be byte-identical to legacy not be.
  if (raw.every((k) => k.x === raw[0].x)) return null;

  const keys = dropCollinear(raw);
  if (keys.length < 2) return null;
  if (keys.length > cfg.maxKeyframes) return null;
  return keys;
}

/** Removes points the ramp expression does not need: a point whose slope in
 *  equals its slope out lies on the segment its neighbours already describe.
 *  Compared as a cross product rather than as two divisions, so a zero-length
 *  interval cannot divide by zero. */
function dropCollinear(keys: Keyframe[]): Keyframe[] {
  if (keys.length <= 2) return keys;
  const out: Keyframe[] = [keys[0]];
  for (let i = 1; i < keys.length - 1; i++) {
    const a = out[out.length - 1];
    const b = keys[i];
    const c = keys[i + 1];
    const cross = (b.x - a.x) * (c.t - b.t) - (c.x - b.x) * (b.t - a.t);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(keys[keys.length - 1]);
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-camera.test.ts'`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-test the knobs**

A green suite proves nothing until each knob is shown to be load-bearing. For each mutation below, apply it,
run the suite, confirm at least one test fails, then restore with
`git checkout -- apps/worker/src/reframe/camera.ts`.

| mutation | must kill at least one test |
|---|---|
| `deadzoneFrac: 0.12` → `0` | the two "returns null" stillness tests |
| `settleFrac: 0.04` → `0.12` (equal to deadzone) | the hysteresis test |
| `maxSpeedFrac: 0.25` → `100` | the speed-cap test |
| `if (keys.length > cfg.maxKeyframes) return null;` → `keys.slice(0, cfg.maxKeyframes)` | the cap test |
| drop the `evenClamp` in the step | the in-frame test |
| `if (raw.every(...)) return null;` → deleted | the two stillness tests |

If a mutation survives, the test that claims to cover it does not. Write a test that fails under the
mutation before continuing - see `feedback_test_matches_default`: a fixture whose expected value is also
what the code produces by default proves nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/reframe/camera.ts apps/worker/src/__tests__/reframe-camera.test.ts
git commit -m "feat(reframe): a camera that holds still by default and eases when it must"
```

---

## Task 6: The planner emits trajectories

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

**Context:** **Read spec §4.5 first.** Trajectories are computed AFTER `mergeAdjacentLayouts`, over the
concatenated target path of the merged span. Computing them before the merge would let the merge discard
every trajectory but the first, re-freezing the camera over exactly the longest spans.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
import { buildTargetSamples, attachTrajectories } from "../reframe/plan";
import { DEFAULT_CAMERA } from "../reframe/camera";

describe("buildTargetSamples", () => {
  const trackWithPath = (id: number, xs: number[]) => ({
    id,
    box: { x: xs[0], y: 0, w: 100, h: 100 },
    score: 0.9,
    samples: xs.length,
    mouthActivity: 0.05,
    path: xs.map((x, i) => ({ t: i * 0.5, x, y: 0, w: 100, h: 100 })),
  });

  it("takes the midpoint of the group bounding box at each sample time", () => {
    const samples = buildTargetSamples(
      [trackWithPath(0, [100, 120]), trackWithPath(1, [300, 320])],
      0,
      1,
      500
    );
    // bbox at t=0 spans 100..400, midpoint 250
    expect(samples[0]).toEqual({ t: 0, cx: 250 });
    // bbox at t=0.5 spans 120..420, midpoint 270
    expect(samples[1]).toEqual({ t: 0.5, cx: 270 });
  });

  it("carries a missing member forward rather than dropping it", () => {
    // Dropping an absent member shrinks the bbox and moves the target without
    // any change of selection - the confound spec 4.3 forbids.
    const a = trackWithPath(0, [100, 120, 140]);
    const b = trackWithPath(1, [300]); // vanishes after t=0
    const samples = buildTargetSamples([a, b], 0, 2, 500);
    // at t=0.5, b is carried forward at 300, so bbox is 120..400, midpoint 260
    expect(samples[1]).toEqual({ t: 0.5, cx: 260 });
  });

  it("returns nothing when no member has a path", () => {
    const noPath = {
      id: 0,
      box: { x: 10, y: 0, w: 100, h: 100 },
      score: 0.9,
      samples: 3,
      mouthActivity: 0,
    };
    expect(buildTargetSamples([noPath], 0, 2, 500)).toEqual([]);
  });

  it("ignores samples outside the span", () => {
    const samples = buildTargetSamples([trackWithPath(0, [100, 120, 140])], 0.4, 0.6, 500);
    expect(samples.map((s) => s.t)).toEqual([0.5]);
  });
});

describe("attachTrajectories", () => {
  const path = (xs: number[]) => xs.map((x, i) => ({ t: i * 0.5, x, y: 0, w: 60, h: 60 }));
  const track = (id: number, xs: number[]) => ({
    id,
    box: { x: xs[0], y: 0, w: 60, h: 60 },
    score: 0.9,
    samples: xs.length,
    mouthActivity: 0.05,
    path: path(xs),
  });

  it("leaves center, split and stream layouts untouched", () => {
    const shots = [
      { start: 0, end: 5, layout: "center" as const, x: 100 },
      { start: 5, end: 10, layout: "split" as const, top: { x: 0 }, bottom: { x: 500 } },
    ];
    const out = attachTrajectories(shots, new Map(), 406, 1280, DEFAULT_CAMERA);
    expect(out).toEqual(shots);
  });

  it("leaves x untouched when it adds a trajectory", () => {
    // The whole rollback story rests on this: a consumer ignoring xs must
    // render exactly what v2 rendered.
    const groups = new Map([[0, [track(0, Array.from({ length: 20 }, (_, i) => 100 + i * 40))]]]);
    const shots = [{ start: 0, end: 10, layout: "single" as const, x: 437 }];
    const out = attachTrajectories(shots, groups, 406, 1280, DEFAULT_CAMERA);
    expect(out[0].x).toBe(437);
  });

  it("omits xs entirely when the camera does not move", () => {
    const groups = new Map([[0, [track(0, Array.from({ length: 20 }, () => 640))]]]);
    const shots = [{ start: 0, end: 10, layout: "single" as const, x: 437 }];
    const out = attachTrajectories(shots, groups, 406, 1280, DEFAULT_CAMERA);
    expect("xs" in out[0]).toBe(false);
  });

  it("spans a merged shot using the groups of every shot inside it", () => {
    // Shot 0 covers [0,5), shot 1 covers [5,10); the merge produced one span.
    const groups = new Map([
      [0, [track(0, Array.from({ length: 10 }, () => 300))]],
      [1, [track(1, Array.from({ length: 10 }, (_, i) => ({ ...path([900])[0] }) && 900))]],
    ]);
    const shots = [{ start: 0, end: 10, layout: "single" as const, x: 100 }];
    const out = attachTrajectories(shots, groups, 406, 1280, DEFAULT_CAMERA);
    // it must have seen the second half's targets, not only the first shot's
    expect(out[0].xs).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-plan.test.ts'`
Expected: FAIL - `buildTargetSamples` and `attachTrajectories` are not exported.

- [ ] **Step 3: Implement `buildTargetSamples`**

Add to `apps/worker/src/reframe/plan.ts`, above `buildCropPlan`:

```ts
/**
 * Where the anchored group's centre sits at each detector sample inside
 * `[spanStart, spanEnd]`.
 *
 * Every member contributes at every sample time. When a member has no
 * detection at some time its **last known box is carried forward** (its first
 * known box, before it appears at all). Dropping the member instead would
 * shrink the bounding box and move the target without any change of selection
 * - the confound spec §4.3 exists to prevent, arriving through the back door.
 */
export function buildTargetSamples(
  group: FaceTrack[],
  spanStart: number,
  spanEnd: number
): TargetSample[] {
  const withPath = group.filter((t) => t.path && t.path.length > 0);
  if (withPath.length === 0) return [];
  const times = [
    ...new Set(withPath.flatMap((t) => t.path!.map((p) => p.t))),
  ]
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
```

Add the imports at the top of `plan.ts`:

```ts
import type { CameraConfig, TargetSample } from "./camera";
import { DEFAULT_CAMERA, solveCamera } from "./camera";
```

and add `Keyframe` and `PathSample` to the existing `import type { ... } from "./types"` list.

- [ ] **Step 4: Implement `attachTrajectories`**

Add to `plan.ts`, below `mergeAdjacentLayouts`:

```ts
/**
 * Attaches a trajectory to every `single` shot that earns one, AFTER merging.
 *
 * Order matters and spec §4.5 explains why: `mergeAdjacentLayouts` keeps the
 * FIRST shot's geometry, so a trajectory computed per detector shot and then
 * merged would have every trajectory but the first discarded - re-freezing the
 * camera over exactly the merged spans that are longest. Concatenating
 * separately-solved trajectories is also wrong: they meet at a seam with a
 * discontinuity that does not exist today.
 *
 * So the solver runs ONCE per merged span, over the union of the target
 * samples of every detector shot inside it. A step at a detector-shot seam is
 * then just another target movement, and the deadzone decides what to do with
 * it.
 *
 * `x` is never touched.
 */
export function attachTrajectories(
  merged: ShotLayout[],
  shots: Shot[],
  groupsByShot: Map<number, FaceTrack[]>,
  cropW: number,
  sourceWidth: number,
  camera: CameraConfig = DEFAULT_CAMERA
): ShotLayout[] {
  return merged.map((span) => {
    if (span.layout !== "single") return span;
    // Each DETECTOR shot overlapping this merged span contributes samples from
    // its OWN selected group, over its own time range clipped to the span.
    //
    // Not a union of every group: carry-forward would then place a face from an
    // unrelated shot into the bounding box at a time it was never on screen,
    // moving the target with no change of selection - the confound spec 4.3
    // exists to prevent, arriving through the back door.
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
      targets,
      span.x,
      cropW,
      sourceWidth,
      span.start,
      span.end,
      camera
    );
    return xs ? { ...span, xs } : span;
  });
}
```


- [ ] **Step 5: Extract the selection, then capture it in `buildCropPlan`**

The measurement script in Task 11 must evaluate **the group the planner actually chose**. If it re-derived
that itself the two could drift, and a metric that scores a different group than the planner used is exactly
the failure this metric was rewritten to avoid. So the selection becomes one exported function that both
callers use.

Add to `plan.ts`, above `buildCropPlan`:

```ts
/**
 * The face group a shot's window is anchored on, or null when the shot has no
 * anchorable face at all.
 *
 * Extracted so that `buildCropPlan` and the containment metric cannot disagree
 * about which faces the window was pointed at. Runs on the MEDIAN boxes and is
 * called exactly once per shot - spec §4.3: this layer changes how the window
 * moves, never whom it follows.
 *
 * Knows nothing about the split layout. `buildCropPlan` tries a split between
 * the two branches below, and a shot that splits is not a `single` shot, so
 * nothing downstream asks this about it.
 */
export function selectGroupForShot(
  tracks: FaceTrack[],
  minFaceWidth: number,
  cropW: number,
  sourceWidth: number
): FaceTrack[] | null {
  const anchorable = survivingTracks(tracks).filter(
    (t) => t.box.w >= minFaceWidth
  );
  if (anchorable.length === 0) return null;
  const minX = Math.min(...anchorable.map((t) => t.box.x));
  const maxX = Math.max(...anchorable.map((t) => t.box.x + t.box.w));
  // Everything fits in one window: the group is every anchorable face.
  if (maxX - minX <= FIT_MARGIN * cropW) return anchorable;
  return bestFaceGroup(anchorable, cropW, sourceWidth);
}
```

In `buildCropPlan`, declare the map above the `layouts` assignment:

```ts
  const groupsByShot = new Map<number, FaceTrack[]>();
```

Then in the `shots.map` callback, record the group in both single-producing branches. Replace:

```ts
    if (maxX - minX <= FIT_MARGIN * cropW) {
      const x = evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
      return { start: shot.start, end: shot.end, layout: "single", x };
    }
```

with:

```ts
    if (maxX - minX <= FIT_MARGIN * cropW) {
      const x = evenClamp((minX + maxX) / 2 - cropW / 2, cropW, sourceWidth);
      groupsByShot.set(i, anchorable);
      return { start: shot.start, end: shot.end, layout: "single", x };
    }
```

and replace the final `return` of the callback:

```ts
    return {
      start: shot.start,
      end: shot.end,
      layout: "single",
      x: windowXFor(
        bestFaceGroup(anchorable, cropW, sourceWidth),
        cropW,
        sourceWidth
      ),
    };
```

with:

```ts
    // bestFaceGroup runs exactly once per shot, on the median boxes, exactly as
    // before (spec §4.3). The trajectory follows this group; it never reselects.
    const group = bestFaceGroup(anchorable, cropW, sourceWidth);
    groupsByShot.set(i, group);
    return {
      start: shot.start,
      end: shot.end,
      layout: "single",
      x: windowXFor(group, cropW, sourceWidth),
    };
```

Add a test to `apps/worker/src/__tests__/reframe-plan.test.ts` pinning that the extracted function agrees
with what the planner does:

```ts
describe("selectGroupForShot", () => {
  const t = (id: number, x: number, w = 60) => ({
    id, box: { x, y: 0, w, h: 60 }, score: 0.9, samples: 10, mouthActivity: 0.05,
  });

  it("returns every anchorable face when they all fit one window", () => {
    const group = selectGroupForShot([t(0, 100), t(1, 200)], 40, 406, 1280);
    expect(group!.map((g) => g.id).sort()).toEqual([0, 1]);
  });

  it("falls back to bestFaceGroup when they do not fit", () => {
    const group = selectGroupForShot([t(0, 0), t(1, 600), t(2, 660)], 40, 406, 1280);
    expect(group!.map((g) => g.id).sort()).toEqual([1, 2]);
  });

  it("returns null when no face clears the min-face guard", () => {
    expect(selectGroupForShot([t(0, 100, 10)], 40, 406, 1280)).toBeNull();
  });

  it("does not move when mouthActivity moves", () => {
    // 7c's invariant, restated on the extracted function so it cannot be lost
    // when the selection is reused by the measurement script.
    const quiet = [t(0, 0), t(1, 600), t(2, 660)];
    const loud = quiet.map((x, i) => ({ ...x, mouthActivity: i === 0 ? 0.9 : 0.01 }));
    expect(selectGroupForShot(loud, 40, 406, 1280)!.map((g) => g.id)).toEqual(
      selectGroupForShot(quiet, 40, 406, 1280)!.map((g) => g.id)
    );
  });
});
```

Then change the merge line and the returned version. Replace:

```ts
  const merged = mergeAdjacentLayouts(layouts, sourceWidth);
```

with:

```ts
  // Merge decides on `x` alone and is byte-identical to v2, so no motion
  // consideration can change WHICH shots merge (spec §4.5).
  const mergedByX = mergeAdjacentLayouts(layouts, sourceWidth);
  const merged = opts.motion
    ? attachTrajectories(mergedByX, shots, groupsByShot, cropW, sourceWidth, opts.camera)
    : mergedByX;
```

and replace the version expression:

```ts
    version: streamGeom ? 2 : 1,
```

with:

```ts
    // v3 iff a trajectory is actually present. A motion-enabled run that
    // produced no movement stays v2/v1 and is byte-identical to legacy.
    version: merged.some((s) => s.layout === "single" && s.xs)
      ? 3
      : streamGeom
        ? 2
        : 1,
```

- [ ] **Step 6: Extend `PlanOptions`**

In `apps/worker/src/reframe/options.ts`, add to the interface and the defaults:

```ts
  /** Emit crop trajectories at all. Off by default; the REFRAME_MOTION flag. */
  motion: boolean;
  /** Deadzone, settle band, speed cap and keyframe cap for the camera. */
  camera: CameraConfig;
```

```ts
export const DEFAULT_PLAN_OPTIONS: Readonly<PlanOptions> = Object.freeze({
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  stream: false,
  camShare: 0.4,
  motion: false,
  camera: DEFAULT_CAMERA,
});
```

with `import { DEFAULT_CAMERA, type CameraConfig } from "./camera";` at the top.

- [ ] **Step 7: Run the whole reframe suite**

Run:
```
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/'
```
Expected: PASS. **Every pre-existing assertion in `reframe-plan.test.ts` must still hold with its original
expected values** - the nine layout assertions carrying `x` of 496, 656, 596, 236 and 96 are the guard that
`x` did not move.

Two specific pre-existing tests to confirm by name rather than trust the count:
- §7c's test that the chosen window does **not** move when `mouthActivity` moves. It is a hard invariant in
  spec §7 and this task is the one that could quietly break it.
- the test that a face wider than the window centres on that face rather than reaching the split branch.

- [ ] **Step 8: Commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/plan.ts apps/worker/src/reframe/options.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "feat(reframe): attach trajectories after the merge, never before it"
```

---

## Task 7: `sliceCropPlan` accepts v3

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts:399-424`
- Test: `apps/worker/src/__tests__/reframe-plan.test.ts`

**Context:** `renderTrim` re-windows a stored plan through `sliceCropPlan`. It rejects any version that is not
1 or 2, and it shifts `start`/`end` without touching `xs`. A v3 plan sliced without shifting its keyframes
would move the camera to positions belonging to a different part of the clip.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-plan.test.ts`:

```ts
describe("sliceCropPlan with trajectories", () => {
  const v3 = {
    version: 3 as const,
    engine: "faces" as const,
    source: { width: 1280, height: 720 },
    shots: [
      {
        start: 0,
        end: 20,
        layout: "single" as const,
        x: 100,
        xs: [
          { t: 0, x: 100 },
          { t: 10, x: 300 },
          { t: 20, x: 500 },
        ],
      },
    ],
  };

  it("accepts version 3", () => {
    expect(sliceCropPlan(v3, 5, 15)).not.toBeNull();
  });

  it("shifts keyframe times by the same offset as the shot bounds", () => {
    const out = sliceCropPlan(v3, 5, 15)!;
    const shot = out.shots[0] as { xs?: Array<{ t: number; x: number }> };
    expect(shot.xs!.map((k) => k.t)).toEqual([0, 5, 10]);
  });

  it("keeps the trajectory anchored at the new boundaries", () => {
    // The window must be defined for every t in the new range, so the first
    // and last keyframes sit exactly on the new bounds.
    const out = sliceCropPlan(v3, 5, 15)!;
    const shot = out.shots[0] as { xs?: Array<{ t: number; x: number }> };
    expect(shot.xs![0].t).toBe(0);
    expect(shot.xs!.at(-1)!.t).toBe(10);
    // interpolated, not copied: at t=5 absolute the window was at 200
    expect(shot.xs![0].x).toBe(200);
  });

  it("leaves a v2 plan exactly as before", () => {
    const v2 = {
      version: 2 as const,
      engine: "faces" as const,
      source: { width: 1280, height: 720 },
      shots: [{ start: 0, end: 20, layout: "single" as const, x: 100 }],
    };
    expect(sliceCropPlan(v2, 5, 15)).toEqual({
      ...v2,
      shots: [{ start: 0, end: 10, layout: "single", x: 100 }],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-plan.test.ts'`
Expected: FAIL on `accepts version 3` - `sliceCropPlan` returns null.

- [ ] **Step 3: Implement**

In `sliceCropPlan`, replace the version guard:

```ts
    (plan.version !== 1 && plan.version !== 2) ||
```

with:

```ts
    (plan.version !== 1 && plan.version !== 2 && plan.version !== 3) ||
```

and replace the shot mapping:

```ts
  const shots = plan.shots
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({
      ...s,
      start: Math.max(0, s.start - start),
      end: Math.min(end - start, s.end - start),
    }));
```

with:

```ts
  const shots = plan.shots
    .filter((s) => s.end > start && s.start < end)
    .map((s) => {
      const shifted = {
        ...s,
        start: Math.max(0, s.start - start),
        end: Math.min(end - start, s.end - start),
      };
      if (shifted.layout !== "single" || !s.layout || !("xs" in s) || !s.xs) {
        return shifted;
      }
      return { ...shifted, xs: sliceKeyframes(s.xs, start, end) };
    });
```

and add above `sliceCropPlan`:

```ts
/** Re-windows a trajectory to `[start, end]`, expressed relative to the new
 *  start. The boundary values are INTERPOLATED rather than copied from the
 *  nearest keyframe: a slice landing mid-ramp would otherwise begin at a
 *  position the camera did not occupy at that moment, and the sliced clip would
 *  open on a jump. */
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
```

- [ ] **Step 4: Run tests**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-plan.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-plan.test.ts
git commit -m "fix(reframe): re-window trajectories when a stored plan is trimmed"
```

---

## Task 8: The filtergraph compiles trajectories

**Files:**
- Modify: `apps/worker/src/reframe/filtergraph.ts`
- Test: `apps/worker/src/__tests__/reframe-filtergraph.test.ts`

**Context:** Spec §4.4 and §5.1. `piecewiseX` nests one `if()` per segment and dies at 99. A flat sum of
clipped ramps has nesting depth 1. **`rampX` is used only when at least one shot carries a valid `xs`**, so a
clip with no motion compiles through `piecewiseX` and is byte-identical to legacy regardless of the flag.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-filtergraph.test.ts`:

```ts
import { rampX, planKeyframes } from "../reframe/filtergraph";

describe("rampX", () => {
  it("is a flat sum, never nested, so av_expr depth stays at 1", () => {
    const expr = rampX([
      { t: 0, x: 100 },
      { t: 1, x: 200 },
      { t: 2, x: 150 },
    ]);
    expect(expr).not.toContain("if(");
    // one term per x change
    expect(expr.split("+clip").length - 1 + expr.split("+-").length - 1).toBeGreaterThan(0);
  });

  it("starts at the first keyframe's x", () => {
    expect(rampX([{ t: 0, x: 100 }, { t: 1, x: 200 }])).toMatch(/^100/);
  });

  it("emits no term for a flat run", () => {
    const flat = rampX([
      { t: 0, x: 100 },
      { t: 1, x: 100 },
      { t: 2, x: 100 },
    ]);
    expect(flat).toBe("100");
  });

  it("expresses an instantaneous step as a sub-frame ramp, never a divide by zero", () => {
    const expr = rampX([
      { t: 1, x: 100 },
      { t: 1, x: 400 },
    ]);
    expect(expr).not.toContain("/0)");
    expect(expr).not.toContain("NaN");
  });

  it("throws on an empty trajectory rather than emitting an empty expression", () => {
    expect(() => rampX([])).toThrow("rampX: empty");
  });
});

describe("planKeyframes", () => {
  it("uses the centre for split and stream shots, which the tiles cover anyway", () => {
    const keys = planKeyframes(
      {
        version: 2,
        engine: "faces",
        source: { width: 1280, height: 720 },
        shots: [
          { start: 0, end: 5, layout: "split", top: { x: 0 }, bottom: { x: 800 } },
        ],
      },
      437
    );
    expect(keys.every((k) => k.x === 437)).toBe(true);
  });

  it("carries a single shot's xs through and a plain single's x as a flat pair", () => {
    const keys = planKeyframes(
      {
        version: 3,
        engine: "faces",
        source: { width: 1280, height: 720 },
        shots: [
          { start: 0, end: 5, layout: "single", x: 100 },
          {
            start: 5,
            end: 10,
            layout: "single",
            x: 300,
            xs: [{ t: 5, x: 300 }, { t: 10, x: 500 }],
          },
        ],
      },
      437
    );
    expect(keys[0]).toEqual({ t: 0, x: 100 });
    expect(keys.at(-1)).toEqual({ t: 10, x: 500 });
  });
});

describe("buildFiltergraph motion selection", () => {
  const planWithXs = {
    version: 3 as const,
    engine: "faces" as const,
    source: { width: 1280, height: 720 },
    shots: [
      {
        start: 0,
        end: 10,
        layout: "single" as const,
        x: 100,
        xs: [{ t: 0, x: 100 }, { t: 10, x: 500 }],
      },
    ],
  };
  const planWithout = {
    version: 1 as const,
    engine: "faces" as const,
    source: { width: 1280, height: 720 },
    shots: [{ start: 0, end: 10, layout: "single" as const, x: 100 }],
  };

  it("uses the nested piecewise form when no shot has a trajectory", () => {
    const spec = buildFiltergraph(planWithout);
    expect(spec.graph).toContain("x='100'");
    expect(spec.graph).not.toContain("clip(");
  });

  it("uses the ramp form when a shot has a trajectory", () => {
    const spec = buildFiltergraph(planWithXs);
    expect(spec.graph).toContain("clip(");
    expect(spec.graph).not.toContain("if(lt(t,");
  });

  it("a plan with xs stripped compiles byte-identically to the legacy plan", () => {
    // The rollback invariant: consumers that ignore xs must render v2 output.
    const stripped = {
      ...planWithXs,
      shots: planWithXs.shots.map(({ xs, ...rest }) => rest),
    };
    expect(buildFiltergraph(stripped).graph).toBe(buildFiltergraph(planWithout).graph);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-filtergraph.test.ts'`
Expected: FAIL - `rampX` and `planKeyframes` are not exported.

- [ ] **Step 3: Implement**

In `apps/worker/src/reframe/filtergraph.ts`, add after `piecewiseX`:

```ts
/** A step takes this long. Sub-frame at any frame rate this product encodes, so
 *  it is a step in every rendered frame, while giving the ramp a non-zero
 *  denominator. */
const STEP_SEC = 0.001;

/**
 * x(t) as a FLAT SUM of clipped ramps: `x0 + d1*clip((t-t0)/dt0,0,1) + ...`.
 *
 * Nesting depth 1 regardless of how many keyframes there are, which is the
 * whole reason this exists. `piecewiseX` nests one `if()` per segment and
 * ffmpeg's av_expr parser fails at 99 of them - measured, and the origin of
 * MAX_PLAN_SHOTS. Measured limits for this form: 3000 terms parse and cost 1.16x
 * encode time, and the real ceiling is the kernel's MAX_ARG_STRLEN of 131072
 * characters, because the graph is passed as one argv element. Hence the
 * 200-keyframe cap in camera.ts, which lands at about 6 KB.
 *
 * A flat run costs nothing: equal consecutive x values emit no term.
 */
export function rampX(keys: Keyframe[]): string {
  if (keys.length === 0) throw new Error("rampX: empty");
  const terms: string[] = [String(keys[0].x)];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    const delta = b.x - a.x;
    if (delta === 0) continue;
    const dt = Math.max(b.t - a.t, STEP_SEC);
    terms.push(`${delta >= 0 ? "+" : "-"}${Math.abs(delta)}*clip((t-${fmt(a.t)})/${fmt(dt)},0,1)`);
  }
  return terms.join("");
}

/**
 * The whole clip's window trajectory, in order.
 *
 * Split and stream shots contribute the centre: the tiles cover the frame while
 * they are enabled, so the base crop under them is never visible - the same
 * reasoning `buildFiltergraph` already applies to `baseX`.
 */
export function planKeyframes(plan: CropPlan, centerX: number): Keyframe[] {
  const keys: Keyframe[] = [];
  for (const shot of plan.shots) {
    if (shot.layout === "single" && shot.xs && shot.xs.length > 0) {
      keys.push(...shot.xs);
      continue;
    }
    const x =
      shot.layout === "split" || shot.layout === "stream" ? centerX : shot.x;
    keys.push({ t: shot.start, x }, { t: shot.end, x });
  }
  return keys;
}
```

Add `Keyframe` to the type import at the top of the file.

Then replace the `baseX` assignment:

```ts
  const baseX = piecewiseX(
    plan.shots.map((s) => ({
      end: s.end,
      x: s.layout === "split" || s.layout === "stream" ? centerX : s.x,
    }))
  );
```

with:

```ts
  // The ramp form is used ONLY when a trajectory is actually present. A plan
  // without one compiles through the piecewise form it always used, so a clip
  // where the camera never moves is byte-identical to legacy whatever the flag
  // says - which is what makes the rollback story testable rather than
  // promised.
  const hasTrajectory = plan.shots.some(
    (s) => s.layout === "single" && s.xs && s.xs.length > 0
  );
  const baseX = hasTrajectory
    ? rampX(planKeyframes(plan, centerX))
    : piecewiseX(
        plan.shots.map((s) => ({
          end: s.end,
          x: s.layout === "split" || s.layout === "stream" ? centerX : s.x,
        }))
      );
```

- [ ] **Step 4: Run tests**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-filtergraph.test.ts'`
Expected: PASS, including every pre-existing assertion.

- [ ] **Step 5: Verify against real ffmpeg**

A parse test in vitest proves nothing about ffmpeg. Run:

```bash
docker compose exec -T worker-render sh -c 'ffmpeg -v error -f lavfi -i color=s=1280x720:d=1 \
  -vf "crop=w=406:h=720:x='"'"'100+400*clip((t-0.00)/10.00,0,1)'"'"':y=0" -frames:v 1 -f null - && echo RAMP_OK'
```
Expected: `RAMP_OK`.

- [ ] **Step 6: Commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/filtergraph.ts apps/worker/src/__tests__/reframe-filtergraph.test.ts
git commit -m "feat(reframe): compile trajectories as a flat sum of ramps"
```

---

## Task 9: The flag

**Files:**
- Modify: `apps/worker/src/reframe/config.ts`
- Modify: `apps/worker/src/reframe/index.ts:99-111`
- Test: `apps/worker/src/__tests__/reframe-config.test.ts`

**Context:** Spec §4.6. `REFRAME_STREAM` is the precedent: an exact literal match, because a killswitch that
can be flipped by accident is not one.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/__tests__/reframe-config.test.ts`:

```ts
describe("REFRAME_MOTION", () => {
  it("is off by default", () => {
    expect(loadReframeConfig({}).motion).toBe(false);
  });

  it("requires the exact literal 'on'", () => {
    expect(loadReframeConfig({ REFRAME_MOTION: "on" }).motion).toBe(true);
    expect(loadReframeConfig({ REFRAME_MOTION: "true" }).motion).toBe(false);
    expect(loadReframeConfig({ REFRAME_MOTION: "1" }).motion).toBe(false);
    expect(loadReframeConfig({ REFRAME_MOTION: "ON" }).motion).toBe(false);
  });

  it("carries camera knobs with the documented defaults", () => {
    const cfg = loadReframeConfig({});
    expect(cfg.camera.deadzoneFrac).toBe(0.12);
    expect(cfg.camera.settleFrac).toBe(0.04);
    expect(cfg.camera.maxSpeedFrac).toBe(0.25);
    expect(cfg.camera.maxKeyframes).toBe(200);
  });

  it("lets each knob be overridden", () => {
    const cfg = loadReframeConfig({
      REFRAME_CAM_DEADZONE: "0.2",
      REFRAME_CAM_SETTLE: "0.05",
      REFRAME_CAM_MAX_SPEED: "0.5",
      REFRAME_CAM_MAX_KEYFRAMES: "50",
    });
    expect(cfg.camera).toEqual({
      deadzoneFrac: 0.2,
      settleFrac: 0.05,
      maxSpeedFrac: 0.5,
      maxKeyframes: 50,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/src/__tests__/reframe-config.test.ts'`
Expected: FAIL - `motion` is not on `ReframeConfig`.

- [ ] **Step 3: Implement**

In `apps/worker/src/reframe/config.ts`, add to the interface:

```ts
  /** Crop-trajectory killswitch. Planning runs regardless; this decides whether
   *  a trajectory is emitted at all. */
  motion: boolean;
  camera: CameraConfig;
```

and to the returned object:

```ts
    // Exact literal, the REFRAME_STREAM rule: a killswitch that can be flipped
    // by accident is not one.
    motion: env.REFRAME_MOTION === "on",
    camera: {
      deadzoneFrac: positive(env.REFRAME_CAM_DEADZONE, DEFAULT_CAMERA.deadzoneFrac),
      settleFrac: positive(env.REFRAME_CAM_SETTLE, DEFAULT_CAMERA.settleFrac),
      maxSpeedFrac: positive(env.REFRAME_CAM_MAX_SPEED, DEFAULT_CAMERA.maxSpeedFrac),
      maxKeyframes: positive(env.REFRAME_CAM_MAX_KEYFRAMES, DEFAULT_CAMERA.maxKeyframes),
    },
```

with `import { DEFAULT_CAMERA, type CameraConfig } from "./camera";` at the top.

- [ ] **Step 4: Wire it through**

In `apps/worker/src/reframe/index.ts`, extend the options object passed to `buildCropPlan`:

```ts
      {
        faceSmallFrac: cfg.faceSmallFrac,
        faceLargeFrac: cfg.faceLargeFrac,
        stream: cfg.stream,
        camShare: cfg.camShare,
        motion: cfg.motion,
        camera: cfg.camera,
      },
```

- [ ] **Step 5: Run the whole worker suite**

Run: `docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'`
Expected: PASS. Note that `tests/api.integration.test.ts` fails at repo scope for an unrelated reason (it
needs a live web server on port 80); scoping to `apps/worker/` avoids it.

- [ ] **Step 6: Commit**

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
git add apps/worker/src/reframe/config.ts apps/worker/src/reframe/index.ts apps/worker/src/__tests__/reframe-config.test.ts
git commit -m "feat(reframe): REFRAME_MOTION, off by default"
```

---

## Task 10: Check 1 - legacy invariance

**Files:**
- Create: `apps/worker/src/scripts/eval-camera-invariance.ts`

**Context:** Spec §6.2. Level 1 needs no video and guards the 96 persisted plans. Level 2 uses the detector
JSON captured in Task 2. Level 3 compares against the baseline renders under the hash policy Task 2
established.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-camera-invariance.ts`:

```ts
/**
 * Check 1 of the Layer 0 measurement plan: with the flag off, nothing changed.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-camera-invariance.ts"
 *
 * Level 1 runs against the 96 crop plans already in the database and needs no
 * video at all, which is what makes it the check that can run every time.
 * Level 2 replays the detector JSON captured by corpus-baseline.ts. Level 3
 * compares full renders.
 *
 * Read-only.
 */
import { prisma } from "@clipclap/shared";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { Prisma } from "@prisma/client";
import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
import { buildFiltergraph } from "../reframe/filtergraph";
import { buildCropPlan } from "../reframe/plan";
import { loadManifest, corpusPath } from "./corpus-fetch";
import { loadReframeConfig } from "../reframe/config";
import type { CropPlan, Shot, ShotTracks } from "../reframe/types";

const execFileAsync = promisify(execFile);

function md5(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

async function main() {
  const cfg = loadReframeConfig();
  if (cfg.motion) {
    console.error("REFRAME_MOTION is on. This check only means anything with it off.");
    process.exit(1);
  }

  // --- Level 1: the persisted plans
  const clips = await prisma.clip.findMany({
    where: { deletedAt: null, cropPlan: { not: Prisma.DbNull } },
    select: { id: true, cropPlan: true },
  });
  let level1Bad = 0;
  for (const clip of clips) {
    const plan = clip.cropPlan as unknown as CropPlan;
    const graph = buildFiltergraph(plan).graph;
    // A stored plan has no xs, so the ramp form must never be selected for it.
    if (graph.includes("clip(")) {
      level1Bad += 1;
      console.error(`  ! ${clip.id}: stored plan compiled through the ramp form`);
    }
  }
  console.log(
    `level 1: ${clips.length} stored plans, ${level1Bad} compiled differently  (must be 0)`
  );

  // --- Level 2: replay the captured detector output
  const manifest = await loadManifest();
  let level2Bad = 0;
  let level2Ran = 0;
  for (const item of manifest.items) {
    const file = join("/app/apps/worker", manifest.outDir, `${item.id}.plan.json`);
    const raw = await readFile(file, "utf-8").catch(() => null);
    if (!raw) continue;
    const cap = JSON.parse(raw) as {
      shots: Shot[];
      tracks: ShotTracks[];
      plan: CropPlan | null;
      source: { width: number; height: number };
    };
    if (!cap.plan) continue;
    level2Ran += 1;
    const replayed = buildCropPlan(
      cap.shots, cap.tracks, cap.source.width, cap.source.height,
      { faceSmallFrac: cfg.faceSmallFrac, faceLargeFrac: cfg.faceLargeFrac,
        stream: cfg.stream, camShare: cfg.camShare,
        motion: cfg.motion, camera: cfg.camera },
      null
    );
    if (JSON.stringify(replayed) !== JSON.stringify(cap.plan)) {
      level2Bad += 1;
      console.error(`  ! ${item.id}: replayed plan differs from the captured one`);
    }
  }
  console.log(`level 2: ${level2Ran} plans replayed, ${level2Bad} differ  (must be 0)`);

  // --- Level 3: full renders
  let level3Bad = 0;
  let level3Ran = 0;
  for (const item of manifest.items) {
    const dir = join("/app/apps/worker", manifest.outDir);
    const baseline = join(dir, `${item.id}.base1.mp4`);
    const baseHash = await md5(baseline).catch(() => null);
    if (!baseHash) continue;
    const file = join(dir, `${item.id}.plan.json`);
    const cap = JSON.parse(await readFile(file, "utf-8")) as {
      plan: CropPlan | null; clip: { start: number; end: number };
    };
    if (!cap.plan) continue;
    level3Ran += 1;
    const spec = buildFiltergraph(cap.plan);
    const out = join(dir, `${item.id}.flagoff.mp4`);
    const filterArgs = spec.kind === "vf"
      ? ["-vf", spec.graph]
      : ["-filter_complex", spec.graph, "-map", "[vout]", "-map", "0:a?"];
    await execFileAsync("ffmpeg", [
      "-nostdin", "-ss", String(cap.clip.start),
      "-t", String(cap.clip.end - cap.clip.start),
      "-i", corpusPath(manifest, item.id),
      ...filterArgs,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-movflags", "+faststart", out, "-y",
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
    if ((await md5(out)) !== baseHash) {
      level3Bad += 1;
      console.error(`  ! ${item.id}: render differs from the baseline`);
    }
  }
  console.log(`level 3: ${level3Ran} renders compared, ${level3Bad} differ  (must be 0)`);

  await prisma.$disconnect();
  if (level1Bad + level2Bad + level3Bad > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-camera-invariance.ts'`
Expected: three lines, each reporting 0 differences. Any non-zero is a merge blocker.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/eval-camera-invariance.ts
git commit -m "test(reframe): assert flag-off changes nothing, at three levels"
```

---

## Task 11: Check 2 - anchor containment

**Files:**
- Create: `apps/worker/src/scripts/eval-camera-containment.ts`

**Context:** Spec §6.3. The primary metric is **geometric** and needs no render: it projects the selected
group's bbox through the plan and asks whether the window held it. A detector run on the output cannot tell
*which* face it found, so "is there a face" would score a lost anchor as a success whenever a bystander stays
in shot.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-camera-containment.ts`:

```ts
/**
 * Check 2 of the Layer 0 measurement plan: did the planner keep the anchor it
 * chose, and does motion keep it better than legacy?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-camera-containment.ts"
 *
 * Paired: the same source over the same interval, legacy plan against motion
 * plan, both built from ONE captured detector run so the only difference is the
 * planner.
 *
 * The metric is geometric and needs no render (spec 6.3): the visible fraction
 * of the selected group's bbox against the crop window, computed in SOURCE
 * pixels. The output scale is uniform and monotone so it cannot change whether
 * a box is inside the window, and testing before the scale avoids an arithmetic
 * step that could only add error.
 *
 * Evaluated at the source path's own sample times, where the bbox is exact and
 * x(t) is analytic - no interpolation enters the number that decides anything.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import {
  buildCropPlan,
  buildTargetSamples,
  cropWidthFor,
  selectGroupForShot,
} from "../reframe/plan";
import { loadManifest } from "./corpus-fetch";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import type { CropPlan, FaceTrack, Keyframe, Shot, ShotTracks } from "../reframe/types";

/** Window left edge at time t: the trajectory if there is one, else legacy x. */
function windowAt(plan: CropPlan, t: number): number | null {
  const shot = plan.shots.find((s) => t >= s.start && t < s.end);
  if (!shot) return null;
  if (shot.layout === "split" || shot.layout === "stream") return null;
  if (shot.layout === "single" && shot.xs && shot.xs.length > 0) {
    return interpolate(shot.xs, t);
  }
  return shot.x;
}

function interpolate(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].x;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.x;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.x : a.x + ((b.x - a.x) * (t - a.t)) / span;
    }
  }
  return last.x;
}

/** Fraction of the group's bbox width that the window contains. */
function visibleFraction(
  group: FaceTrack[],
  t: number,
  x: number,
  cropW: number
): number | null {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const track of group) {
    const path = track.path;
    if (!path || path.length === 0) return null;
    let box = path[0];
    let exact = false;
    for (const p of path) {
      if (Math.abs(p.t - t) < 1e-6) { box = p; exact = true; break; }
      if (p.t > t) break;
      box = p;
    }
    if (!exact && path[0].t > t) return null;
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, box.x + box.w);
  }
  if (!Number.isFinite(minX)) return null;
  const width = maxX - minX;
  if (width <= 0) return null;
  const overlap = Math.max(0, Math.min(maxX, x + cropW) - Math.max(minX, x));
  return overlap / width;
}

interface Row { id: string; legacy: number; motion: number; n: number;
                legacyGap: number; motionGap: number }

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  const rows: Row[] = [];

  for (const item of manifest.items) {
    const file = join("/app/apps/worker", manifest.outDir, `${item.id}.plan.json`);
    const raw = await readFile(file, "utf-8").catch(() => null);
    if (!raw) continue;
    const cap = JSON.parse(raw) as {
      shots: Shot[]; tracks: ShotTracks[]; plan: CropPlan | null;
      source: { width: number; height: number };
    };
    if (!cap.plan) continue;

    const base = { faceSmallFrac: cfg.faceSmallFrac, faceLargeFrac: cfg.faceLargeFrac,
                   stream: cfg.stream, camShare: cfg.camShare };
    const legacy = buildCropPlan(cap.shots, cap.tracks, cap.source.width,
      cap.source.height, { ...base, motion: false, camera: DEFAULT_CAMERA }, null);
    const motion = buildCropPlan(cap.shots, cap.tracks, cap.source.width,
      cap.source.height, { ...base, motion: true, camera: cfg.camera }, null);
    if (!legacy || !motion) continue;

    const cropW = cropWidthFor(cap.source.height);
    const minFaceWidth = cfg.faceSmallFrac * cap.source.width;

    let n = 0, legacyBad = 0, motionBad = 0;
    let lRun = 0, mRun = 0, lGap = 0, mGap = 0;

    // Per DETECTOR shot, because the anchored group is a per-shot decision.
    // Using every track with a path instead would measure a group the planner
    // never chose - the same mistake as asking "is there a face in the frame".
    for (const [shotIndex, shot] of cap.shots.entries()) {
      const tracks = cap.tracks.find((t) => t.shotIndex === shotIndex)?.tracks ?? [];
      const group = selectGroupForShot(
        tracks, minFaceWidth, cropW, cap.source.width
      );
      if (!group || group.every((t) => !t.path?.length)) continue;

      const samples = buildTargetSamples(
        group, shot.start, shot.end, cap.source.width
      );
      for (const s of samples) {
        const lx = windowAt(legacy, s.t);
        const mx = windowAt(motion, s.t);
        // A split or stream shot has no single window to score; excluded from
        // the denominator rather than counted as a failure.
        if (lx === null || mx === null) continue;
        const lv = visibleFraction(group, s.t, lx, cropW);
        const mv = visibleFraction(group, s.t, mx, cropW);
        if (lv === null || mv === null) continue;
        n += 1;
        if (lv < 1) { legacyBad += 1; lRun += 1; lGap = Math.max(lGap, lRun); }
        else lRun = 0;
        if (mv < 1) { motionBad += 1; mRun += 1; mGap = Math.max(mGap, mRun); }
        else mRun = 0;
      }
    }
    if (n === 0) continue;
    rows.push({ id: item.id, n,
      legacy: (100 * legacyBad) / n, motion: (100 * motionBad) / n,
      legacyGap: lGap / 2, motionGap: mGap / 2 });
  }

  console.log("anchor containment - failure is any clipping of the SELECTED group\n");
  console.log("item              n   legacy   motion    delta   gap legacy -> motion");
  let improved = 0, regressedHard = 0, gapGrew = 0;
  for (const r of rows) {
    const delta = r.motion - r.legacy;
    if (delta < 0) improved += 1;
    if (delta > 2) regressedHard += 1;
    if (r.motionGap > r.legacyGap) gapGrew += 1;
    console.log(
      `${r.id.padEnd(15)} ${String(r.n).padStart(4)} ${r.legacy.toFixed(1).padStart(7)}% ` +
      `${r.motion.toFixed(1).padStart(7)}% ${delta.toFixed(1).padStart(7)}   ` +
      `${r.legacyGap.toFixed(1)}s -> ${r.motionGap.toFixed(1)}s`
    );
  }
  const deltas = rows.map((r) => r.motion - r.legacy).sort((a, b) => a - b);
  const median = deltas.length
    ? deltas[Math.floor(deltas.length / 2)]
    : 0;
  console.log("");
  console.log(`improved on ${improved} of ${rows.length} items, paired median delta ${median.toFixed(2)} points`);
  console.log(`items regressing by more than 2 points : ${regressedHard}   (must be 0)`);
  console.log(`items whose longest failure gap grew   : ${gapGrew}   (must be 0)`);
  console.log("");
  console.log("Pass bar (spec 6.3): failure falls on a MAJORITY of items with a negative");
  console.log("paired median, no item regresses more than 2 points, no gap grows, and the");
  console.log("locked-off control shows a motion delta of exactly 0.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-camera-containment.ts'`
Expected: one row per corpus item and the three summary lines. Record the output in the commit.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/eval-camera-containment.ts
git commit -m "test(reframe): measure whether the planner kept the anchor it chose"
```

---

## Task 12: Checks 3 and 4 - motion and runtime safety

**Files:**
- Create: `apps/worker/src/scripts/eval-camera-safety.ts`

**Context:** Spec §6.4, §6.5 and §7. The hard invariants here block a merge. The two motion thresholds are
**provisional review alerts**, not pass/fail - they have no corpus support and exist to open a conversation.

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/eval-camera-safety.ts`:

```ts
/**
 * Checks 3 and 4 of the Layer 0 measurement plan: is the motion safe, and is
 * the expression practical?
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-camera-safety.ts"
 *
 * HARD INVARIANTS (a violation blocks the merge):
 *   peak |dx/dt| never exceeds the speed cap
 *   emitted xs is absent, or holds 2..200 keyframes
 *   filtergraph argv length below the measured ceiling
 *
 * PROVISIONAL REVIEW ALERTS (they open a conversation, they do not fail):
 *   over 25% of shot time in motion
 *   over 4 direction reversals per minute
 * These have no corpus support and are replaced by measured values once the
 * first corpus render has been looked at (spec 7 and 9.1).
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { buildCropPlan, cropWidthFor } from "../reframe/plan";
import { buildFiltergraph } from "../reframe/filtergraph";
import { loadManifest } from "./corpus-fetch";
import { loadReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";
import type { CropPlan, Shot, ShotTracks } from "../reframe/types";

/** Measured 2026-08-05: 125781 chars pass, 132181 raises OSError. The kernel's
 *  MAX_ARG_STRLEN is 131072 and the graph is one argv element. */
const ARGV_CEILING = 131072;
const SAFE_ARGV = 0.5 * ARGV_CEILING;

async function main() {
  const cfg = loadReframeConfig();
  const manifest = await loadManifest();
  let hardFailures = 0;

  console.log("item            keys  peak px/s  cap px/s  moving%  rev/min  argv chars");
  for (const item of manifest.items) {
    const file = join("/app/apps/worker", manifest.outDir, `${item.id}.plan.json`);
    const raw = await readFile(file, "utf-8").catch(() => null);
    if (!raw) continue;
    const cap = JSON.parse(raw) as {
      shots: Shot[]; tracks: ShotTracks[]; plan: CropPlan | null;
      source: { width: number; height: number };
    };
    if (!cap.plan) continue;

    const plan = buildCropPlan(cap.shots, cap.tracks, cap.source.width, cap.source.height, {
      faceSmallFrac: cfg.faceSmallFrac, faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream, camShare: cfg.camShare,
      motion: true, camera: cfg.camera,
    }, null);
    if (!plan) continue;

    const cropW = cropWidthFor(cap.source.height);
    const speedCap = (cfg.camera ?? DEFAULT_CAMERA).maxSpeedFrac * cropW;
    let keys = 0, peak = 0, movingSec = 0, totalSec = 0, reversals = 0;

    for (const shot of plan.shots) {
      totalSec += shot.end - shot.start;
      if (shot.layout !== "single" || !shot.xs) continue;
      keys += shot.xs.length;
      // HARD: 2..200
      if (shot.xs.length < 2 || shot.xs.length > 200) {
        console.error(`  ! ${item.id}: emitted ${shot.xs.length} keyframes`);
        hardFailures += 1;
      }
      let lastDir = 0;
      for (let i = 1; i < shot.xs.length; i++) {
        const dt = shot.xs[i].t - shot.xs[i - 1].t;
        const dx = shot.xs[i].x - shot.xs[i - 1].x;
        if (dt <= 0) continue;
        const speed = Math.abs(dx) / dt;
        peak = Math.max(peak, speed);
        if (dx !== 0) {
          movingSec += dt;
          const dir = Math.sign(dx);
          if (lastDir !== 0 && dir !== lastDir) reversals += 1;
          lastDir = dir;
        }
      }
    }
    // HARD: speed cap
    if (peak > speedCap + 1e-6) {
      console.error(`  ! ${item.id}: peak ${peak.toFixed(1)} px/s over cap ${speedCap.toFixed(1)}`);
      hardFailures += 1;
    }
    const argv = buildFiltergraph(plan).graph.length;
    // HARD: argv ceiling
    if (argv > SAFE_ARGV) {
      console.error(`  ! ${item.id}: filtergraph ${argv} chars, over the ${SAFE_ARGV} safe ceiling`);
      hardFailures += 1;
    }
    const movingPct = totalSec > 0 ? (100 * movingSec) / totalSec : 0;
    const revPerMin = totalSec > 0 ? (60 * reversals) / totalSec : 0;
    console.log(
      `${item.id.padEnd(15)} ${String(keys).padStart(4)} ${peak.toFixed(1).padStart(10)} ` +
      `${speedCap.toFixed(1).padStart(9)} ${movingPct.toFixed(1).padStart(8)} ` +
      `${revPerMin.toFixed(1).padStart(8)} ${String(argv).padStart(11)}`
    );
    if (movingPct > 25) {
      console.log(`      alert (provisional): ${movingPct.toFixed(1)}% of shot time in motion`);
    }
    if (revPerMin > 4) {
      console.log(`      alert (provisional): ${revPerMin.toFixed(1)} direction reversals per minute`);
    }
  }

  console.log("");
  console.log(`hard invariant violations: ${hardFailures}   (must be 0)`);
  console.log("alerts above are provisional and have no corpus support - they open a");
  console.log("conversation about the knobs, they do not fail a build.");
  if (hardFailures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-camera-safety.ts'`
Expected: one row per item, `hard invariant violations: 0`.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/eval-camera-safety.ts
git commit -m "test(reframe): hard invariants for motion and runtime, alerts kept provisional"
```

---

## Task 13: Record it and finish the branch

**Files:**
- Modify: `docs/engine-notes.md`

- [ ] **Step 1: Add section 7d**

Add a `### 7d.` section to `docs/engine-notes.md`, immediately after 7c, containing:

- the defect numbers from spec §2.2 and §2.3, and the §2.4 caveat that they are a **predictor, not a causal
  result**
- the measured expression facts: nested `if()` dies at 99, a flat sum has depth 1, the real wall is the
  kernel's `MAX_ARG_STRLEN` at 131,072 characters because the graph is one argv element, and encode cost is
  1.04x at 10 keyframes and 1.10x at 100
- the order-of-operations finding from spec §4.5: trajectories MUST be attached after the merge, because the
  merge keeps the first shot's geometry and would discard every other trajectory
- the actual results of checks 1 to 4 from Tasks 10 to 12, with the numbers the runs produced
- what remains provisional: deadzone, settle, speed cap, the lost-face timeout and the 2 fps sample rate

- [ ] **Step 2: Run everything one last time**

```bash
docker compose exec -T worker-render sh -c 'cd /app && npx vitest run apps/worker/'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsc --noEmit'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker/assets/reframe && python3 -m unittest test_detect_path test_cam_rect'
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && npx tsx src/scripts/eval-camera-invariance.ts'
```

Expected: all green, invariance reporting 0 differences at all three levels.

- [ ] **Step 3: Commit and merge**

```bash
git add docs/engine-notes.md
git commit -m "docs(engine): Layer 0 - the crop window can move, behind a flag that is off"
git checkout main && git merge --no-ff feat/camera-layer0
```

**Do not enable `REFRAME_MOTION` in production as part of this merge.** The flag goes on only after the
owner has watched the corpus renders and set the four provisional knobs from what they saw (spec §9.1).

---

## Rollback

`REFRAME_MOTION=off` in `.env`, then `docker compose up -d worker-render` - **`compose restart` does not
re-read `env_file`** - then `npx prisma generate --schema=/app/prisma/schema.prisma` inside the recreated
container. This is the `REFRAME_STREAM` procedure and it is documented in `project_container_file_traps`.

Plans already written as v3 keep rendering correctly with the flag off: `buildFiltergraph` selects the ramp
form only when a shot actually carries `xs`, and `x` was never modified, so a v3 plan with the flag off
compiles through exactly the expression v2 produced.
