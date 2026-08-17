# Cut Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split a detector shot at an scdet candidate (scene score 0.15-0.30) when the set of faces on screen changes across it, so the crop window is no longer a compromise between two camera angles - flag-off output byte-identical to today, measured on the 53-clip director-audit corpus.

**Architecture:** `shots.ts` runs scdet ONCE at 0.15 with `metadata=print`, keeps cuts at the configured 0.3 exactly as today and returns the 0.15-0.30 frames as `candidates`. A new pure module `cut-recovery.ts` confirms a candidate when the live face-track sets before/after it are disjoint, both non-empty, and both sub-shots clear `minShotSec`; confirmed splits get their `ShotTracks` rebuilt from the sidecar's per-sample `path`. `index.ts` is refactored into `detectRange` (I/O) + `planDetected` (pure) so the policy flag `REFRAME_CUT_RECOVERY` sits in one place and the eval script can plan one detection twice.

**Tech Stack:** TypeScript (Node 20 in the `worker-render` container), vitest 3 (run with `--root /app`), ffmpeg `scdet`/`metadata=print`, the existing YuNet Python sidecar (untouched), Prisma/Postgres read-only for the corpus manifest, R2 via `@clipclap/shared` `downloadFile`.

Spec: `docs/superpowers/specs/2026-08-17-cut-recovery-design.md`. Read it first; every task below cites the section it implements.

---

## Working rules for every task

- **Where commands run.** The host has no ffmpeg and Node 18; everything runs inside the `worker-render` container:
  - tests: `docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app <files>"`
  - typecheck: `docker compose exec -T worker-render sh -c "cd /app/apps/worker && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit"`
  - scripts: `docker compose exec -T worker-render sh -c "cd /app/apps/worker && npx tsx src/scripts/<name>.ts ..."`
  - The repo is bind-mounted at `/app`, so edits on the host are visible immediately; files the container writes are root-owned (readable, not deletable by the host user - fine).
- **Never** run `docker compose up/restart/down`, never edit `.env`, never touch prod data. Task 5's rollout is done by the architect/owner, not by an executor.
- **Commits.** Author is the repo default (`Trowgar <trowgar@yahoo.com>`), one commit per task, message in the `type(scope): what - why` style used in `git log`, **no Co-Authored-By trailer**, plain hyphens only in messages and code comments (no em/en dashes).
- **Mutation discipline.** Where a step says "mutation-test", do it literally: apply the named breakage to the source, run the test, confirm RED, revert (`git checkout -- <file>` or undo the edit), run again, confirm GREEN. A test that stays green under the mutation is a plan failure - report it, do not paper over it.
- Do not "improve" neighbouring code. The sidecar (`assets/reframe/detect_faces.py`), `buildCropPlan`, `mergeAdjacentLayouts`, `filtergraph.ts` and the persisted `CropPlan` schema are out of scope (spec §1).

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/worker/assets/reframe/director-audit.json` | Committed corpus manifest: 53 planned clips, R2 keys, ranges, persisted shots | 0 |
| `apps/worker/src/scripts/director-audit-fetch.ts` | Materialise `.corpus/director-audit/{sources,clips}` from the manifest | 0 |
| `apps/worker/src/reframe/shots.ts` | One scdet pass with scores; `parseSceneScores`, `classifyCuts`, `detectShots -> {shots, candidates}` | 1 |
| `apps/worker/src/__tests__/reframe-shots.test.ts` | Pure tests: `cutsToShots` (existing) + `parseSceneScores` + `classifyCuts` | 1 |
| `apps/worker/src/__tests__/reframe-shots-detect.test.ts` | ffmpeg-boundary tests, rewritten for the single pass | 1 |
| `apps/worker/src/reframe/cut-recovery.ts` | Pure `recoverCuts` + `sliceTracks`; the confirmation rule of spec §2b | 2 |
| `apps/worker/src/reframe/plan.ts` | Export `survivingTracks` and `MAX_PLAN_SHOTS` (no logic change) | 2 |
| `apps/worker/src/__tests__/reframe-cut-recovery.test.ts` | Tests for `recoverCuts` | 2 |
| `apps/worker/src/reframe/config.ts` | `cutRecovery` flag | 3 |
| `apps/worker/src/reframe/index.ts` | `detectRange` + `planDetected` + `computeCropPlan` composition; policy | 3 |
| `apps/worker/src/reframe/telemetry.ts` | `cutRecovery` on `ReframeCheck` | 3 |
| `apps/worker/src/stages/render.ts` | Pass `cutRecovery` into the check | 3 |
| `apps/worker/src/__tests__/reframe-config.test.ts`, `reframe-compute.test.ts`, `reframe-telemetry.test.ts` | Updated for the flag, wiring and telemetry | 3 |
| `apps/worker/src/scripts/eval-cut-recovery.ts` | OFF invariant + ON/OFF diff + sheets + rejected sample over the corpus | 4 |
| `docs/engine-notes.md` §7i, memory | Record the numbers; rollout | 5 |

---

### Task 0: Corpus manifest and fetch script (spec §3, §6 Task 0)

**Files:**
- Create: `apps/worker/assets/reframe/director-audit.json`
- Create: `apps/worker/src/scripts/director-audit-fetch.ts`

- [ ] **Step 1: Generate the manifest from the database (read-only)**

Run on the host (the SQL reads `clips` and `jobs`; nothing is written to the DB):

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -Atc "
select json_build_object(
  'note', 'Director-audit corpus, 2026-08-17: the 53 planned clips of the first outside-user corpus (11 jobs, 8 users, ru/en/ar/id). shots = the PRODUCTION cropPlan.shots as persisted, i.e. the flag-off oracle for eval-cut-recovery.ts. Sources and clips live in R2 under these keys (still present despite sourceSweptAt on 2026-08-17); director-audit-fetch.ts materialises them into outDir, which is gitignored.',
  'outDir', '.corpus/director-audit',
  'items', json_agg(json_build_object(
     'job', j.id, 'clip', c.id,
     'sourceKey', j.\"sourceArtifactKey\", 'clipKey', c.\"storageKey\",
     'start', c.\"startTime\", 'end', c.\"endTime\",
     'source', c.\"cropPlan\"->'source', 'shots', c.\"cropPlan\"->'shots'
  ) order by j.\"createdAt\", c.\"startTime\"))
from clips c join jobs j on j.id = c.\"jobId\"
where j.id in ('cmsrx4ob30003i1jxfle15qef','cmstjdr3y000ri1jxj26494q9','cmsv093kq0025i1jxdn1up8hu','cmsv0kmlk002hi1jx35h7eh1f','cmsve8dwk0030i1jxa5l0byza','cmsvegtch003li1jxf0y0ust6','cmsvo8jfo004bi1jxqp0pp4x3','cmsvv44iz005di1jxu4n6eodg','cmswcjq1h006mi1jxxg6z7h7r','cmswh2mnq006ui1jx6c606b2k','cmswiirz30072i1jxmgv89du9')
  and c.\"deletedAt\" is null and c.\"cropPlan\" is not null;" \
| python3 -m json.tool > apps/worker/assets/reframe/director-audit.json
python3 -c "import json; m=json.load(open('apps/worker/assets/reframe/director-audit.json')); print(len(m['items']), 'items;', len({i['job'] for i in m['items']}), 'jobs')"
```

Expected: `53 items; 11 jobs`. (The three Modern Warfare clips have `cropPlan = null` - a native 720x1280 source - and are correctly excluded.)

- [ ] **Step 2: Write the fetch script**

```typescript
// apps/worker/src/scripts/director-audit-fetch.ts
/**
 * Materialises the director-audit corpus from its committed manifest.
 *
 *   docker compose exec -T worker-render sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/director-audit-fetch.ts [--clips]"
 *
 * Sources (one per job) go to <outDir>/sources/<jobId>.mp4; with --clips the
 * rendered clips go to <outDir>/clips/<clipId>.mp4 too. Existing non-empty
 * files are kept. Read-only against R2. The manifest is committed, the videos
 * are not: .corpus/ is gitignored and outside the Job table, so the retention
 * sweep cannot reach it - the same reason corpus-fetch.ts exists.
 */
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { downloadFile } from "@clipclap/shared";
import { reframeAssetsDir } from "../reframe/faces";

export interface DirectorAuditItem {
  job: string;
  clip: string;
  sourceKey: string;
  clipKey: string;
  start: number;
  end: number;
  source: { width: number; height: number };
  shots: Array<{ start: number; end: number; layout: string; x: number }>;
}

export interface DirectorAuditManifest {
  note: string;
  outDir: string;
  items: DirectorAuditItem[];
}

export function manifestPath(): string {
  return join(reframeAssetsDir(), "director-audit.json");
}

/** Worker root: assets/reframe sits at apps/worker/assets/reframe. */
export function workerRoot(): string {
  return join(reframeAssetsDir(), "..", "..");
}

export async function loadManifest(): Promise<DirectorAuditManifest> {
  return JSON.parse(await readFile(manifestPath(), "utf-8")) as DirectorAuditManifest;
}

async function present(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function save(key: string, out: string): Promise<string> {
  if (await present(out)) return "cached";
  const stream = await downloadFile(key);
  const buf = Buffer.from(await new Response(stream).arrayBuffer());
  await writeFile(out, buf);
  return `${buf.length} bytes`;
}

async function main() {
  const withClips = process.argv.includes("--clips");
  const manifest = await loadManifest();
  const dir = join(workerRoot(), manifest.outDir);
  await mkdir(join(dir, "sources"), { recursive: true });
  await mkdir(join(dir, "clips"), { recursive: true });
  const seenJobs = new Set<string>();
  for (const item of manifest.items) {
    if (!seenJobs.has(item.job)) {
      seenJobs.add(item.job);
      try {
        console.log("source", item.job, await save(item.sourceKey, join(dir, "sources", `${item.job}.mp4`)));
      } catch (e) {
        console.log("source", item.job, "ERR", (e as Error).name ?? e);
      }
    }
    if (withClips) {
      try {
        console.log("clip", item.clip, await save(item.clipKey, join(dir, "clips", `${item.clip}.mp4`)));
      } catch (e) {
        console.log("clip", item.clip, "ERR", (e as Error).name ?? e);
      }
    }
  }
}

// Same guard as corpus-fetch.ts: eval-cut-recovery.ts imports the helpers
// above, and importing must not start a download.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run it and check the corpus is on disk**

```bash
docker compose exec -T worker-render sh -c "cd /app/apps/worker && npx tsx src/scripts/director-audit-fetch.ts" 2>&1 | grep -v "npm notice"
ls apps/worker/.corpus/director-audit/sources | wc -l
```

Expected: 11 lines `source <job> cached` (the audit already downloaded them today) or `... <n> bytes`; `ls` prints `11`.

- [ ] **Step 4: Typecheck and commit**

```bash
docker compose exec -T worker-render sh -c "cd /app/apps/worker && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit"
git add apps/worker/assets/reframe/director-audit.json apps/worker/src/scripts/director-audit-fetch.ts
git commit -m "chore(reframe): commit the director-audit corpus manifest and a fetch script - the 53-clip flag-off oracle must outlive the retention sweep"
```

---

### Task 1: One scdet pass with scores (spec §2a)

**Files:**
- Modify: `apps/worker/src/reframe/shots.ts` (whole file below)
- Modify: `apps/worker/src/__tests__/reframe-shots.test.ts` (append two describe blocks)
- Rewrite: `apps/worker/src/__tests__/reframe-shots-detect.test.ts`
- Modify: `apps/worker/src/reframe/index.ts:80` (consume `.shots` - one line, see step 6)
- Modify (one line each, `const { shots } = await detectShots(...)`, no other change): `apps/worker/src/scripts/corpus-baseline.ts`, `eval-anchor-sheets.ts`, `eval-bisection.ts`, `eval-blind-centre.ts`, `eval-insert-anchor.ts`, `eval-insert-rect.ts`, `eval-shift-sheets.ts` - they call `detectShots` directly and the typecheck (`tsconfig.typecheck.json` includes `src/scripts`) breaks without it; also patch the gitignored `apps/worker/.eval-frames/geom/{measure,worst-corpus}.ts` on disk

- [ ] **Step 1: Write the failing pure tests** - append to `apps/worker/src/__tests__/reframe-shots.test.ts`:

```typescript
import { classifyCuts, parseSceneScores, CANDIDATE_FLOOR } from "../reframe/shots";

/** ffmpeg stderr as `metadata=print` writes it: a frame line, then the score line. */
const scoredStderr = (rows: Array<[number, number]>) =>
  rows
    .map(
      ([t, s]) =>
        `[Parsed_metadata_2 @ 0x1] frame:0    pts:1   pts_time:${t}\n` +
        `[Parsed_metadata_2 @ 0x1] lavfi.scene_score=${s}\n`
    )
    .join("");

describe("parseSceneScores", () => {
  it("pairs every selected frame with its scene score", () => {
    expect(parseSceneScores(scoredStderr([[4.95, 0.560405], [14.35, 0.471656]]))).toEqual([
      { t: 4.95, score: 0.560405 },
      { t: 14.35, score: 0.471656 },
    ]);
  });

  it("is not fooled by ffmpeg progress noise glued onto a frame line", () => {
    // Progress lines end in \r, so a metadata line can share a physical line
    // with "frame=  1 fps=..." - seen verbatim on the corpus.
    const raw =
      "frame=    1 fps=0.0 q=-0.0 size=N/A time=00:00:05.00 speed=  10x    " +
      "[Parsed_metadata_2 @ 0x1] frame:1    pts:183680  pts_time:14.35\n" +
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.471656\n";
    expect(parseSceneScores(raw)).toEqual([{ t: 14.35, score: 0.471656 }]);
  });

  it("returns nothing for an empty pass", () => {
    expect(parseSceneScores("")).toEqual([]);
  });

  it("fails the pass when a selected frame has no score", () => {
    // Without the score the frame cannot be classified as cut or candidate,
    // and a wrong cut list is worse than the legacy fallback (spec 2a).
    const raw =
      "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:10.0\n" +
      "[Parsed_metadata_2 @ 0x1] frame:1 pts:2 pts_time:20.0\n" +
      "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.5\n";
    expect(() => parseSceneScores(raw)).toThrow(/scdet_score_missing/);
    expect(() => parseSceneScores("[x] frame:0 pts:1 pts_time:10.0\n")).toThrow(
      /scdet_score_missing/
    );
  });
});

describe("classifyCuts", () => {
  const scored = [
    { t: 4.95, score: 0.56 },
    { t: 18.27, score: 0.292 },
    { t: 20.71, score: 0.298 },
    { t: 23.31, score: 0.41 },
    { t: 42.59, score: 0.12 },
  ];

  it("keeps cuts at the configured threshold and reports the band below as candidates", () => {
    expect(classifyCuts(scored, 96, 0.3)).toEqual({
      cuts: [4.95, 23.31],
      candidates: [
        { t: 18.27, score: 0.292 },
        { t: 20.71, score: 0.298 },
      ],
    });
  });

  it("promotes the band to cuts on a long zero-cut window, leaving no candidates", () => {
    const noCut = scored.filter((s) => s.score < 0.3);
    expect(classifyCuts(noCut, 40, 0.3)).toEqual({
      cuts: [18.27, 20.71],
      candidates: [],
    });
  });

  it("does not lower the bar for a window shorter than the long-take bar", () => {
    const noCut = scored.filter((s) => s.score < 0.3);
    expect(classifyCuts(noCut, 14.9, 0.3)).toEqual({
      cuts: [],
      candidates: [
        { t: 18.27, score: 0.292 },
        { t: 20.71, score: 0.298 },
      ],
    });
  });

  it("halves a high threshold on the retry but never goes under the floor", () => {
    // 0.4 halves to 0.2 (clear of the floor): 0.25 is a cut, 0.16 is not.
    expect(classifyCuts([{ t: 10, score: 0.25 }, { t: 30, score: 0.16 }], 40, 0.4)).toEqual({
      cuts: [10],
      candidates: [{ t: 30, score: 0.16 }],
    });
    // 0.2 would halve to 0.1; the floor holds at 0.15, so 0.16 IS a cut...
    expect(classifyCuts([{ t: 10, score: 0.16 }], 40, 0.2)).toEqual({
      cuts: [10],
      candidates: [],
    });
    // ...and 0.12 is neither a cut nor a candidate. Without the floor the retry
    // would sit at 0.1 and make it a cut - this line is what catches that.
    expect(classifyCuts([{ t: 10, score: 0.12 }], 40, 0.2)).toEqual({
      cuts: [],
      candidates: [],
    });
  });

  it("never reports a candidate below the floor", () => {
    expect(classifyCuts([{ t: 5, score: CANDIDATE_FLOOR - 0.01 }], 10, 0.3).candidates).toEqual([]);
    expect(classifyCuts([{ t: 5, score: CANDIDATE_FLOOR }], 10, 0.3).candidates).toEqual([
      { t: 5, score: CANDIDATE_FLOOR },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-shots.test.ts"
```

Expected: FAIL - `parseSceneScores`/`classifyCuts`/`CANDIDATE_FLOOR` are not exported.

- [ ] **Step 3: Rewrite `apps/worker/src/reframe/shots.ts`**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import type { ReframeConfig } from "./config";
import type { Shot } from "./types";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";
const execFileAsync = promisify(execFile);

/**
 * Pure: scene-cut times (clip-relative) -> shot list covering [0, duration].
 * Segments shorter than minShotSec merge forward into the next segment
 * (the cut is simply dropped); a too-short tail merges backward into the
 * last shot. Anti-flicker per spec §5.1.
 */
export function cutsToShots(
  cutTimes: number[],
  duration: number,
  minShotSec: number
): Shot[] {
  if (!(duration > 0)) return [];
  const cuts = [...new Set(cutTimes)]
    .filter((t) => t > 0 && t < duration)
    .sort((a, b) => a - b);
  const shots: Shot[] = [];
  let pendingStart = 0;
  for (const t of [...cuts, duration]) {
    if (t - pendingStart < minShotSec) {
      if (t === duration) {
        if (shots.length > 0) shots[shots.length - 1].end = duration;
        else shots.push({ start: pendingStart, end: duration });
      }
      continue; // drop the cut - segment keeps growing into the next one
    }
    shots.push({ start: pendingStart, end: t });
    pendingStart = t;
  }
  return shots;
}

/** A scene change scdet reported BELOW the cut threshold: not a shot boundary
 *  on its own, but a place the cut-recovery layer may confirm with the face
 *  tracks. `t` is clip-relative seconds, `score` is ffmpeg's lavfi.scene_score. */
export interface CutCandidate {
  t: number;
  score: number;
}

export interface DetectedShots {
  shots: Shot[];
  candidates: CutCandidate[];
}

/**
 * A long window with ZERO cuts is re-read at half the threshold: dark
 * same-studio podcast cuts score in the 0.3-0.4 band and a missed cut merges
 * different camera angles into one mega-shot whose mixed face tracks force a
 * center layout (the empty-frame bug). Over-segmentation is self-healing -
 * adjacent same-geometry shots merge back in the plan pass - while
 * under-segmentation is not, so the retry only ever errs on the safe side.
 *
 * Since 2026-08-17 the retry is a FILTER, not a second ffmpeg run: scdet is
 * asked once for every frame scoring at least CANDIDATE_FLOOR, with the score
 * printed, and cuts / retry cuts / candidates are all read off that one list.
 * The scene score of a frame does not depend on the select threshold, so the
 * cut set at the configured threshold is exactly what the old single-threshold
 * pass returned.
 */
const LONG_TAKE_RETRY_SEC = 15;
const RETRY_THRESHOLD_FLOOR = 0.15;
/** Lowest score scdet is asked to report; the bottom of the candidate band. */
export const CANDIDATE_FLOOR = RETRY_THRESHOLD_FLOOR;

/**
 * Pairs each selected frame's `pts_time` with the `lavfi.scene_score` that
 * `metadata=print` writes right after it. Token order, not line structure:
 * ffmpeg's progress line ends in \r and can share a physical line with a
 * metadata line. A frame without a score fails the whole pass - the frame
 * cannot be classified, and a wrong cut list is worse than the legacy
 * fallback the caller degrades to.
 */
export function parseSceneScores(stderr: string): CutCandidate[] {
  const out: CutCandidate[] = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)|lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/g;
  let pending: number | null = null;
  for (const m of stderr.matchAll(re)) {
    if (m[1] !== undefined) {
      if (pending !== null) throw new Error("scdet_score_missing");
      pending = Number(m[1]);
    } else if (pending !== null) {
      out.push({ t: pending, score: Number(m[2]) });
      pending = null;
    }
  }
  if (pending !== null) throw new Error("scdet_score_missing");
  return out;
}

/** Pure: which scored frames are cuts (with the long-take retry applied) and
 *  which remain candidates. Candidates never overlap cuts. */
export function classifyCuts(
  scored: CutCandidate[],
  durationSec: number,
  sceneThreshold: number
): { cuts: number[]; candidates: CutCandidate[] } {
  let cutThreshold = sceneThreshold;
  let cuts = scored.filter((s) => s.score >= cutThreshold).map((s) => s.t);
  if (cuts.length === 0 && durationSec >= LONG_TAKE_RETRY_SEC) {
    cutThreshold = Math.max(RETRY_THRESHOLD_FLOOR, sceneThreshold / 2);
    cuts = scored.filter((s) => s.score >= cutThreshold).map((s) => s.t);
  }
  const candidates = scored.filter(
    (s) => s.score >= CANDIDATE_FLOOR && s.score < cutThreshold
  );
  return { cuts, candidates };
}

export async function detectShots(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  timeoutMs: number
): Promise<DetectedShots> {
  const scored = await scdetPass(
    sourcePath,
    startSec,
    endSec,
    Math.min(CANDIDATE_FLOOR, cfg.sceneThreshold),
    timeoutMs
  );
  const duration = endSec - startSec;
  const { cuts, candidates } = classifyCuts(scored, duration, cfg.sceneThreshold);
  return { shots: cutsToShots(cuts, duration, cfg.minShotSec), candidates };
}

/**
 * Runs ffmpeg scene detection on the highlight window only, at 320px width.
 * Timestamps are clip-relative because -ss precedes -i. `-nostats` drops the
 * progress line, which is noise here and only makes stderr bigger.
 */
async function scdetPass(
  sourcePath: string,
  startSec: number,
  endSec: number,
  threshold: number,
  timeoutMs: number
): Promise<CutCandidate[]> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-nostdin",
      "-nostats",
      "-ss", String(startSec),
      "-to", String(endSec),
      "-i", sourcePath,
      "-vf", `scale=320:-2,select='gte(scene,${threshold})',metadata=print`,
      "-f", "null", "-",
    ],
    { timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  return parseSceneScores(stderr);
}
```

- [ ] **Step 4: Run the pure tests - expect PASS**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-shots.test.ts"
```

Expected: all `cutsToShots`, `parseSceneScores`, `classifyCuts` tests PASS.

Mutation-test three of them, each RED on the named expectation, then revert to GREEN:
(a) in `classifyCuts` change `Math.max(RETRY_THRESHOLD_FLOOR, sceneThreshold / 2)` to `sceneThreshold / 2` → the `0.12`-at-threshold-`0.2` expectation of "halves a high threshold ... never goes under the floor" goes RED (0.12 becomes a cut at 0.1);
(b) in `classifyCuts` change the candidate filter's `s.score >= CANDIDATE_FLOOR` to `true` → "never reports a candidate below the floor" RED;
(c) in `parseSceneScores` delete the final `if (pending !== null) throw ...` → the second expectation of "fails the pass when a selected frame has no score" RED.

- [ ] **Step 5: Rewrite `apps/worker/src/__tests__/reframe-shots-detect.test.ts` for the single pass**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// A separate file from reframe-shots.test.ts on purpose: that one tests the
// pure functions and must stay free of module mocks. Here the ffmpeg boundary
// is mocked so the ONE-pass contract can be asserted: scdet is asked once, at
// the candidate floor, and cuts / retry / candidates are read off that list.

const h = vi.hoisted(() => ({
  /** The args of every ffmpeg invocation, in order. */
  calls: [] as string[][],
  /** One stderr body per invocation, consumed in order. */
  stderrQueue: [] as string[],
}));

vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    h.calls.push(args);
    cb(null, { stdout: "", stderr: h.stderrQueue.shift() ?? "" });
  },
}));

import { detectShots } from "../reframe/shots";
import type { ReframeConfig } from "../reframe/config";
import { DEFAULT_CAMERA } from "../reframe/camera";

/** Threshold used by each scdet invocation, read back out of the -vf argument. */
const thresholds = () =>
  h.calls.map((args) => {
    const vf = args[args.indexOf("-vf") + 1];
    return Number(/gte\(scene,([0-9.]+)\)/.exec(vf)![1]);
  });

/** ffmpeg stderr as `metadata=print` writes it. */
const scored = (rows: Array<[number, number]>) =>
  rows
    .map(
      ([t, s]) =>
        `[Parsed_metadata_2 @ 0x1] frame:0    pts:1   pts_time:${t}\n` +
        `[Parsed_metadata_2 @ 0x1] lavfi.scene_score=${s}\n`
    )
    .join("");

const cfg: ReframeConfig = {
  engine: "faces",
  sampleFps: 2,
  sceneThreshold: 0.3,
  minShotSec: 1.0,
  faceMinScore: 0.7,
  maxDetectSec: 30,
  stream: false,
  camShare: 0.4,
  faceSmallFrac: 0.06,
  faceLargeFrac: 0.1,
  motion: false,
  camera: DEFAULT_CAMERA,
  pipMaxFrac: 0.5,
  pipEdgeMin: 4.0,
};

describe("detectShots single pass", () => {
  beforeEach(() => {
    h.calls = [];
    h.stderrQueue = [];
  });

  it("asks scdet once at the candidate floor and keeps cuts at the configured threshold", async () => {
    h.stderrQueue = [scored([[12.4, 0.41], [20.0, 0.22], [31.0, 0.35]])];

    const r = await detectShots("/x.mp4", 0, 40, cfg, 5000);

    expect(thresholds()).toEqual([0.15]);
    expect(r.shots).toEqual([
      { start: 0, end: 12.4 },
      { start: 12.4, end: 31.0 },
      { start: 31.0, end: 40 },
    ]);
    expect(r.candidates).toEqual([{ t: 20.0, score: 0.22 }]);
  });

  it("uses metadata=print and drops the progress line", async () => {
    h.stderrQueue = [""];
    await detectShots("/x.mp4", 0, 10, cfg, 5000);
    const args = h.calls[0];
    expect(args).toContain("-nostats");
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "scale=320:-2,select='gte(scene,0.15)',metadata=print"
    );
  });

  it("promotes half-threshold cuts on a long zero-cut window without a second pass", async () => {
    // 0.4 halves to 0.2, clear of the 0.15 floor - so this asserts the halving
    // itself: 0.25 becomes a cut, 0.16 stays a candidate.
    h.stderrQueue = [scored([[20.0, 0.25], [30.0, 0.16]])];

    const r = await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.4 }, 5000);

    expect(thresholds()).toEqual([0.15]);
    expect(r.shots).toEqual([
      { start: 0, end: 20 },
      { start: 20, end: 40 },
    ]);
    expect(r.candidates).toEqual([{ t: 30.0, score: 0.16 }]);
  });

  it("does not lower the bar for a window shorter than the long-take bar", async () => {
    h.stderrQueue = [scored([[7.0, 0.25]])];

    const r = await detectShots("/x.mp4", 0, 14.9, cfg, 5000);

    expect(r.shots).toEqual([{ start: 0, end: 14.9 }]);
    expect(r.candidates).toEqual([{ t: 7.0, score: 0.25 }]);
  });

  it("lowers the bar for a window exactly at the long-take bar", async () => {
    h.stderrQueue = [scored([[7.0, 0.25]])];

    const r = await detectShots("/x.mp4", 600, 615, cfg, 5000);

    expect(r.shots).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 15 },
    ]);
    expect(r.candidates).toEqual([]);
  });

  it("never lets the retry threshold fall below the floor", async () => {
    // 0.1 would be the half; the floor holds it at 0.15, so 0.16 IS a cut and
    // 0.12 is neither cut nor candidate.
    h.stderrQueue = [scored([[10.0, 0.16], [20.0, 0.12]])];

    const r = await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.2 }, 5000);

    expect(thresholds()).toEqual([0.15]);
    expect(r.shots).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
    expect(r.candidates).toEqual([]);
  });

  it("moves the pass down with a configured threshold below the floor", async () => {
    h.stderrQueue = [scored([[10.0, 0.12]])];

    const r = await detectShots("/x.mp4", 0, 40, { ...cfg, sceneThreshold: 0.1 }, 5000);

    expect(thresholds()).toEqual([0.1]);
    expect(r.shots).toHaveLength(2);
    expect(r.candidates).toEqual([]);
  });

  it("passes the absolute window to ffmpeg and gets clip-relative shots back", async () => {
    // -ss before -i is what makes the timestamps clip-relative; the shot list
    // is in clip time even though the window is not.
    h.stderrQueue = [scored([[10.0, 0.5]])];

    const r = await detectShots("/x.mp4", 600, 640, cfg, 5000);

    expect(h.calls[0].slice(0, 7)).toEqual([
      "-nostdin",
      "-nostats",
      "-ss",
      "600",
      "-to",
      "640",
      "-i",
    ]);
    expect(r.shots).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
  });

  it("rejects when a selected frame carries no score", async () => {
    h.stderrQueue = ["[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:10.0\n"];

    await expect(detectShots("/x.mp4", 0, 40, cfg, 5000)).rejects.toThrow(
      /scdet_score_missing/
    );
  });
});
```

- [ ] **Step 6: Make `computeCropPlan` consume the new shape** - in `apps/worker/src/reframe/index.ts` change the two lines

```typescript
    const shots = await detectShots(sourcePath, startSec, endSec, cfg, remaining());
    shotCount = shots.length;
```

to

```typescript
    // Candidates are ignored here until cut recovery is wired (Task 3).
    const { shots } = await detectShots(sourcePath, startSec, endSec, cfg, remaining());
    shotCount = shots.length;
```

- [ ] **Step 7: Run both shot test files, the compute test, and typecheck**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-shots.test.ts apps/worker/src/__tests__/reframe-shots-detect.test.ts apps/worker/src/__tests__/reframe-compute.test.ts"
docker compose exec -T worker-render sh -c "cd /app/apps/worker && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: all PASS; typecheck clean.

- [ ] **Step 8: Smoke the single pass on a real corpus clip**

The Alipov clip `527.85-623.62` of job `cmsrx4ob30003i1jxfle15qef` (source materialised in Task 0). Run inside `worker-render`:

```bash
docker compose exec -T worker-render sh -c 'cd /app/apps/worker && cat > smoke-shots.ts <<EOF
import { detectShots } from "./src/reframe/shots";
import { loadReframeConfig } from "./src/reframe/config";
(async () => {
  const cfg = { ...loadReframeConfig(), engine: "faces" as const };
  const r = await detectShots(".corpus/director-audit/sources/cmsrx4ob30003i1jxfle15qef.mp4", 527.85, 623.62, cfg, 60000);
  console.log(JSON.stringify({ bounds: r.shots.map((s) => [s.start, s.end]), candidates: r.candidates }));
})();
EOF
npx tsx smoke-shots.ts && rm smoke-shots.ts'
```

(The script sits in `apps/worker/` so its relative imports resolve; it is deleted right after.)

Expected (recorded from the audit's `scenes/cmsrxcgk60003uqaks7oudaon.txt` - the same ffmpeg on the same file):
`bounds` = `[[0,4.95],[4.95,14.35],[14.35,15.91],[15.91,23.31],[23.31,26.63],[26.63,29.87],[29.87,32.99],[32.99,51.75],[51.75,59.63],[59.63,78.83],[78.83,84.35],[84.35,95.77]]` (the 95.63 cut is a 0.14s tail and merges backward), and `candidates` = five entries at t 18.27 (0.292175), 20.71 (0.297789), 42.59 (0.242635), 69.15 (0.236080), 89.99 (0.243011). Small float differences in the last digits are fine; different TIMES or a different count are not.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/reframe/shots.ts apps/worker/src/reframe/index.ts apps/worker/src/__tests__/reframe-shots.test.ts apps/worker/src/__tests__/reframe-shots-detect.test.ts
git commit -m "feat(reframe): one scdet pass with scores - cuts at the configured threshold as before, the 0.15-0.30 band returned as candidates, the zero-cut retry now a filter instead of a second ffmpeg run"
```

---

### Task 2: `cut-recovery.ts` - the pure mechanism (spec §2b)

**Files:**
- Modify: `apps/worker/src/reframe/plan.ts:38-40, 348` (export two names)
- Create: `apps/worker/src/reframe/cut-recovery.ts`
- Create: `apps/worker/src/__tests__/reframe-cut-recovery.test.ts`

- [ ] **Step 1: Export the two names `cut-recovery.ts` needs from `plan.ts`**

In `apps/worker/src/reframe/plan.ts` change line 40

```typescript
const MAX_PLAN_SHOTS = 90; // ffmpeg av_expr nesting fails at ~100 segments; headroom below that
```

to

```typescript
/** ffmpeg av_expr nesting fails at ~100 segments; headroom below that. Exported
 *  because cut recovery must cap its splits on the PRE-merge count: above this,
 *  buildCropPlan returns null and the whole clip falls back to the centre crop. */
export const MAX_PLAN_SHOTS = 90;
```

and line 348 `function survivingTracks(` to `export function survivingTracks(` (the doc comment above it stays). No other change.

- [ ] **Step 2: Write the failing tests** - `apps/worker/src/__tests__/reframe-cut-recovery.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { recoverCuts, sliceTracks, TURNOVER_SAMPLES } from "../reframe/cut-recovery";
import type { CutCandidate } from "../reframe/shots";
import type { FaceTrack, PathSample, Shot, ShotTracks } from "../reframe/types";

const CFG = { minShotSec: 1.0, sampleFps: 2, maxPlanShots: 90 };

/** A track seen at 2 fps from `from` (inclusive) to `to` (exclusive) at a fixed x. */
function track(id: number, from: number, to: number, x: number): FaceTrack {
  const path: PathSample[] = [];
  for (let t = from; t < to - 1e-9; t += 0.5) path.push({ t, x, y: 100, w: 200, h: 200 });
  return {
    id,
    box: { x, y: 100, w: 200, h: 200 },
    score: 0.9,
    samples: path.length,
    mouthActivity: 0.1,
    path,
  };
}

const shot = (start: number, end: number): Shot => ({ start, end });
const st = (shotIndex: number, tracks: FaceTrack[]): ShotTracks => ({
  shotIndex,
  tracks,
  camRect: null,
});
const cand = (t: number, score = 0.22): CutCandidate => ({ t, score });

describe("recoverCuts", () => {
  it("splits a shot at a candidate where the live face set changes wholesale", () => {
    // A is on screen 0-5, B 5-10: two camera angles scdet under-scored.
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toEqual([shot(0, 5), shot(5, 10)]);
    expect(r.tracksByShot.map((s) => s.shotIndex)).toEqual([0, 1]);
    // Each side keeps ONLY the face that is on screen there, with its own median.
    expect(r.tracksByShot[0].tracks.map((t) => [t.id, t.box.x, t.samples])).toEqual([[1, 100, 10]]);
    expect(r.tracksByShot[1].tracks.map((t) => [t.id, t.box.x, t.samples])).toEqual([[2, 1200, 10]]);
    expect(r.telemetry).toEqual({
      candidates: 1,
      confirmed: 1,
      rejected: { noTurnover: 0, oneSideEmpty: 0, tooShort: 0, noPath: 0 },
      capHit: 0,
    });
  });

  it("does not split when a face continues across the candidate", () => {
    // A is on screen throughout; B joins at 5. A zoom or a gesture, not a cut.
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 10, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toBe(shots); // same reference: nothing changed
    expect(r.tracksByShot).toBe(tracks);
    expect(r.telemetry.rejected.noTurnover).toBe(1);
    expect(r.telemetry.confirmed).toBe(0);
  });

  it("does not split when one side has no face", () => {
    // Face then b-roll: the whole-shot median already sits on the face.
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toBe(shots);
    expect(r.telemetry.rejected.oneSideEmpty).toBe(1);
  });

  it("does not create a sub-shot shorter than minShotSec, on either side", () => {
    // Both tracks clear the noise floor (3 and 5 samples against a max of 5),
    // the turnover is real, but one segment would be 1.5s under a 2.0s floor.
    // (A track that is on screen for only one sample is already gone at the
    // noise floor and lands in oneSideEmpty - that is the tracker's floor, not
    // this rule's, which is why the floor here is raised instead.)
    const short = { ...CFG, minShotSec: 2.0 };
    const left = recoverCuts(
      [shot(0, 4)],
      [st(0, [track(1, 0, 1.5, 100), track(2, 1.5, 4, 1200)])],
      [cand(1.5)],
      short
    );
    expect(left.shots).toEqual([shot(0, 4)]);
    expect(left.telemetry.rejected.tooShort).toBe(1);

    const right = recoverCuts(
      [shot(0, 4)],
      [st(0, [track(1, 0, 2.5, 100), track(2, 2.5, 4, 1200)])],
      [cand(2.5)],
      short
    );
    expect(right.shots).toEqual([shot(0, 4)]);
    expect(right.telemetry.rejected.tooShort).toBe(1);
  });

  it("splits twice in one shot and renumbers the shots that follow", () => {
    const shots = [shot(0, 15), shot(15, 20)];
    const tracks = [
      st(0, [track(1, 0, 5, 100), track(2, 5, 10, 700), track(3, 10, 15, 1300)]),
      st(1, [track(9, 15, 20, 400)]),
    ];

    const r = recoverCuts(shots, tracks, [cand(10), cand(5)], CFG);

    expect(r.shots).toEqual([shot(0, 5), shot(5, 10), shot(10, 15), shot(15, 20)]);
    expect(r.tracksByShot.map((s) => s.shotIndex)).toEqual([0, 1, 2, 3]);
    expect(r.tracksByShot[3].tracks.map((t) => t.id)).toEqual([9]);
    expect(r.telemetry.confirmed).toBe(2);
    // The untouched shot's tracks are the same object, just under a new index.
    expect(r.tracksByShot[3].tracks).toBe(tracks[1].tracks);
  });

  it("returns the inputs untouched when a track has no path", () => {
    const noPath: FaceTrack = { ...track(1, 0, 5, 100), path: undefined };
    const shots = [shot(0, 10)];
    const tracks = [st(0, [noPath, track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], CFG);

    expect(r.shots).toBe(shots);
    expect(r.telemetry.rejected.noPath).toBe(1);
  });

  it("stops confirming at the plan-shot cap and counts the rest", () => {
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5)], { ...CFG, maxPlanShots: 1 });

    expect(r.shots).toBe(shots);
    expect(r.telemetry.capHit).toBe(1);
    expect(r.telemetry.confirmed).toBe(0);
  });

  it("ignores candidates that sit on a shot boundary or outside every shot", () => {
    const shots = [shot(0, 10)];
    const tracks = [st(0, [track(1, 0, 5, 100), track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(0), cand(10), cand(12)], CFG);

    expect(r.telemetry.candidates).toBe(0);
    expect(r.shots).toBe(shots);
  });

  it("tests turnover on LIVE samples, so a revived track still counts as a change", () => {
    // Track 1 is seen 0-5 AND again 7-10 (the sidecar revives a stale track by
    // IoU against its last box). Around t=5 the live sets are {1} and {2}:
    // disjoint, a real change. Around t=7 they are {2} and {1,2}: not disjoint.
    const revived: FaceTrack = {
      ...track(1, 0, 5, 100),
      path: [...track(1, 0, 5, 100).path!, ...track(1, 7, 10, 100).path!],
      samples: 16,
    };
    const shots = [shot(0, 10)];
    const tracks = [st(0, [revived, track(2, 5, 10, 1200)])];

    const r = recoverCuts(shots, tracks, [cand(5), cand(7)], CFG);

    expect(r.shots).toEqual([shot(0, 5), shot(5, 10)]);
    expect(r.telemetry.confirmed).toBe(1);
    expect(r.telemetry.rejected.noTurnover).toBe(1);
  });

  it("uses TURNOVER_SAMPLES samples on each side of the candidate", () => {
    // Sanity on the exported knob so a change to it is a visible diff.
    expect(TURNOVER_SAMPLES).toBe(2);
  });
});

describe("sliceTracks", () => {
  it("keeps the last sample of the final segment (inclusive end)", () => {
    const tr = track(1, 0, 10, 100); // samples 0 .. 9.5
    const tail = sliceTracks([tr], 9.5, 10, true);
    expect(tail).toHaveLength(1);
    expect(tail[0].samples).toBe(1);
  });

  it("takes a per-coordinate median of the sub-range samples", () => {
    const tr: FaceTrack = {
      id: 1,
      box: { x: 0, y: 0, w: 0, h: 0 },
      score: 0.9,
      samples: 4,
      mouthActivity: 0,
      path: [
        { t: 0, x: 100, y: 10, w: 50, h: 50 },
        { t: 0.5, x: 300, y: 10, w: 50, h: 50 },
        { t: 1.0, x: 900, y: 10, w: 50, h: 50 },
        { t: 1.5, x: 950, y: 10, w: 50, h: 50 },
      ],
    };
    // [0, 1) -> x 100, 300 -> median 200; [1, 2) -> 900, 950 -> 925
    expect(sliceTracks([tr], 0, 1, false)[0].box.x).toBe(200);
    expect(sliceTracks([tr], 1, 2, true)[0].box.x).toBe(925);
  });

  it("drops a track with no sample in the range", () => {
    expect(sliceTracks([track(1, 0, 5, 100)], 5, 10, true)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-cut-recovery.test.ts"
```

Expected: FAIL - module `../reframe/cut-recovery` not found.

- [ ] **Step 4: Write `apps/worker/src/reframe/cut-recovery.ts`**

```typescript
import type { CutCandidate } from "./shots";
import type { FaceBox, FaceTrack, PathSample, Shot, ShotTracks } from "./types";
import { survivingTracks } from "./plan";

/**
 * Cut recovery: confirms scdet candidates (scene score in the 0.15-0.30 band,
 * see shots.ts) with the face tracks and splits the detector shot there.
 *
 * WHY. scdet at 0.3 under-scores real camera cuts in dark studios and dim film
 * scenes (0.29, 0.30 on the Alipov podcast; La Brea's Veronica clip). One
 * detector shot then spans two framings and the median-box window is a
 * compromise between angles that never coexist - a cup and a microphone for
 * 2.4s, the back of a head for 6.5s. A lower global threshold trades that
 * defect for false cuts on graphics (a 0.5s lamp shot on ar-habits). So the
 * pixel signal nominates and the face signal confirms: a candidate is a cut
 * when the set of faces on screen just before it and just after it are
 * disjoint, both sides have a face, and both sub-shots clear the shot floor.
 *
 * WHAT IT NEVER DOES. It never merges, never moves an existing boundary,
 * never invents a boundary scdet did not nominate, and returns its inputs by
 * reference when nothing is confirmed - so with the flag off (or no
 * candidates) the plan is today's plan byte for byte. The tracker, the sidecar
 * and buildCropPlan are not touched; sub-shot tracks are rebuilt from the
 * sidecar's own per-sample `path`.
 *
 * Spec: docs/superpowers/specs/2026-08-17-cut-recovery-design.md §2b.
 */

export interface CutRecoveryConfig {
  minShotSec: number;
  sampleFps: number;
  /** Cap on the PRE-merge shot count. buildCropPlan returns null above
   *  MAX_PLAN_SHOTS merged shots - a whole-clip fallback - and the pre-merge
   *  count bounds the merged count, so capping here keeps that unreachable. */
  maxPlanShots: number;
}

export interface CutRecoveryTelemetry {
  candidates: number;
  confirmed: number;
  rejected: { noTurnover: number; oneSideEmpty: number; tooShort: number; noPath: number };
  capHit: number;
}

export type CutDecision =
  | "confirmed"
  | "noTurnover"
  | "oneSideEmpty"
  | "tooShort"
  | "noPath"
  | "capHit";

export interface CutRecoveryResult {
  shots: Shot[];
  tracksByShot: ShotTracks[];
  telemetry: CutRecoveryTelemetry;
  /** Per-candidate verdicts in shot order - for the eval, not persisted. */
  decisions: Array<{ shotIndex: number; t: number; score: number; verdict: CutDecision }>;
}

/** Samples on each side of a candidate whose live face sets must be disjoint.
 *  Two at 2 fps = 1.0s: one is fragile to a single dropped detection, three
 *  reaches into neighbouring shots on fast-cut material. */
export const TURNOVER_SAMPLES = 2;

export function emptyTelemetry(): CutRecoveryTelemetry {
  return {
    candidates: 0,
    confirmed: 0,
    rejected: { noTurnover: 0, oneSideEmpty: 0, tooShort: 0, noPath: 0 },
    capHit: 0,
  };
}

/** Ids of the tracks with at least one path sample in [from, to). */
function liveIds(tracks: FaceTrack[], from: number, to: number): Set<number> {
  const ids = new Set<number>();
  for (const tr of tracks) {
    if (tr.path?.some((p) => p.t >= from && p.t < to)) ids.add(tr.id);
  }
  return ids;
}

function disjoint(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function medianBox(samples: PathSample[]): FaceBox {
  return {
    x: median(samples.map((p) => p.x)),
    y: median(samples.map((p) => p.y)),
    w: median(samples.map((p) => p.w)),
    h: median(samples.map((p) => p.h)),
  };
}

/**
 * The parent's tracks restricted to one sub-range: same id, median box over
 * the samples in range, `samples` = their count, score and mouthActivity
 * copied. The final segment includes its end so the last sample of a shot is
 * not orphaned. A track with no sample in the range is dropped.
 */
export function sliceTracks(
  tracks: FaceTrack[],
  from: number,
  to: number,
  inclusiveEnd: boolean
): FaceTrack[] {
  const out: FaceTrack[] = [];
  for (const tr of tracks) {
    const samples = (tr.path ?? []).filter(
      (p) => p.t >= from && (p.t < to || (inclusiveEnd && p.t === to))
    );
    if (samples.length === 0) continue;
    out.push({
      id: tr.id,
      box: medianBox(samples),
      score: tr.score,
      samples: samples.length,
      mouthActivity: tr.mouthActivity,
      path: samples,
    });
  }
  return out;
}

export function recoverCuts(
  shots: Shot[],
  tracksByShot: ShotTracks[],
  candidates: CutCandidate[],
  cfg: CutRecoveryConfig
): CutRecoveryResult {
  const telemetry = emptyTelemetry();
  const decisions: CutRecoveryResult["decisions"] = [];
  const byIndex = new Map(tracksByShot.map((s) => [s.shotIndex, s]));
  const w = TURNOVER_SAMPLES / cfg.sampleFps;
  let budget = cfg.maxPlanShots - shots.length;

  const outShots: Shot[] = [];
  const outTracks: ShotTracks[] = [];
  let anyConfirmed = false;

  shots.forEach((shot, i) => {
    const st = byIndex.get(i);
    const inShot = candidates
      .filter((c) => c.t > shot.start && c.t < shot.end)
      .sort((a, b) => a.t - b.t);
    telemetry.candidates += inShot.length;
    const decide = (c: CutCandidate, verdict: CutDecision) => {
      decisions.push({ shotIndex: i, t: c.t, score: c.score, verdict });
      if (verdict === "confirmed") telemetry.confirmed += 1;
      else if (verdict === "capHit") telemetry.capHit += 1;
      else telemetry.rejected[verdict] += 1;
    };

    const splits: number[] = [];
    if (inShot.length > 0) {
      const tracks = st?.tracks ?? [];
      const pathMissing = tracks.some((t) => !Array.isArray(t.path));
      if (pathMissing) {
        for (const c of inShot) decide(c, "noPath");
      } else {
        const surviving = survivingTracks(tracks);
        let segStart = shot.start;
        for (const c of inShot) {
          const before = liveIds(surviving, c.t - w, c.t);
          const after = liveIds(surviving, c.t, c.t + w);
          if (before.size === 0 || after.size === 0) {
            decide(c, "oneSideEmpty");
            continue;
          }
          if (!disjoint(before, after)) {
            decide(c, "noTurnover");
            continue;
          }
          if (c.t - segStart < cfg.minShotSec || shot.end - c.t < cfg.minShotSec) {
            decide(c, "tooShort");
            continue;
          }
          if (budget <= 0) {
            decide(c, "capHit");
            continue;
          }
          decide(c, "confirmed");
          splits.push(c.t);
          segStart = c.t;
          budget -= 1;
        }
      }
    }

    if (splits.length === 0) {
      outShots.push(shot);
      if (st) outTracks.push(st);
      return;
    }
    anyConfirmed = true;
    const bounds = [shot.start, ...splits, shot.end];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const from = bounds[k];
      const to = bounds[k + 1];
      outShots.push({ start: from, end: to });
      outTracks.push({
        shotIndex: -1, // renumbered below
        tracks: sliceTracks(st!.tracks, from, to, k + 2 === bounds.length),
        camRect: st!.camRect,
      });
    }
  });

  if (!anyConfirmed) return { shots, tracksByShot, telemetry, decisions };

  const renumbered = outTracks.map((s, idx) =>
    s.shotIndex === idx ? s : { ...s, shotIndex: idx }
  );
  return { shots: outShots, tracksByShot: renumbered, telemetry, decisions };
}
```

- [ ] **Step 5: Run the tests - expect PASS; then mutation-test**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-cut-recovery.test.ts apps/worker/src/__tests__/reframe-plan.test.ts"
```

Expected: all PASS (`reframe-plan.test.ts` is included to prove the two exports changed nothing).

Mutations, each must go RED on the named test, then revert to GREEN:
1. Replace `if (!disjoint(before, after))` with `if (false)` → "does not split when a face continues across the candidate" RED.
2. Replace `before.size === 0 || after.size === 0` with `false` → "does not split when one side has no face" RED.
3. Replace `c.t - segStart < cfg.minShotSec || shot.end - c.t < cfg.minShotSec` with `false` → "does not create a sub-shot shorter than minShotSec" RED.
4. In `sliceTracks`, replace `medianBox(samples)` with `tr.box` → "takes a per-coordinate median" RED (and the first `recoverCuts` test still passes only because its tracks are static - which is why the median test exists).
5. In `recoverCuts`, replace `liveIds(surviving, c.t - w, c.t)` with `new Set(surviving.filter(t => t.path!.some(p => p.t < c.t)).map(t => t.id))` (id lifetime instead of live window) → "revived track still counts as a change" RED.

- [ ] **Step 6: Typecheck and commit**

```bash
docker compose exec -T worker-render sh -c "cd /app/apps/worker && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit"
git add apps/worker/src/reframe/cut-recovery.ts apps/worker/src/reframe/plan.ts apps/worker/src/__tests__/reframe-cut-recovery.test.ts
git commit -m "feat(reframe): cut-recovery mechanism - confirm a scdet candidate when the live face sets around it are disjoint, both populated and both sub-shots clear the floor; sub-shot tracks rebuilt from path"
```

---

### Task 3: Wiring, flag, telemetry (spec §2c, §2d)

**Files:**
- Modify: `apps/worker/src/reframe/config.ts:4-22, 29-70`
- Rewrite: `apps/worker/src/reframe/index.ts` (whole file below)
- Modify: `apps/worker/src/reframe/telemetry.ts`
- Modify: `apps/worker/src/stages/render.ts:184-190`
- Modify: `apps/worker/src/__tests__/reframe-config.test.ts`, `reframe-compute.test.ts`, `reframe-telemetry.test.ts`, `reframe-shots-detect.test.ts` (cfg literal)

- [ ] **Step 1: Write the failing config tests** - in `apps/worker/src/__tests__/reframe-config.test.ts`, inside `describe("loadReframeConfig")`, add `cutRecovery: false,` to the `toEqual` object of "defaults to off with documented knob values" (after `motion: false,`), and add a new test:

```typescript
  it("turns cut recovery on only for the exact literal 'on'", () => {
    expect(loadReframeConfig({ REFRAME_CUT_RECOVERY: "on" }).cutRecovery).toBe(true);
    expect(loadReframeConfig({ REFRAME_CUT_RECOVERY: "true" }).cutRecovery).toBe(false);
    expect(loadReframeConfig({ REFRAME_CUT_RECOVERY: "1" }).cutRecovery).toBe(false);
    expect(loadReframeConfig({}).cutRecovery).toBe(false);
  });
```

- [ ] **Step 2: Write the failing telemetry test** - in `apps/worker/src/__tests__/reframe-telemetry.test.ts` add inside `describe("buildReframeCheck")`:

```typescript
  it("carries the cut-recovery telemetry when it ran, and omits it when it did not", () => {
    const cutRecovery = {
      candidates: 5,
      confirmed: 1,
      rejected: { noTurnover: 3, oneSideEmpty: 1, tooShort: 0, noPath: 0 },
      capHit: 0,
    };
    const v1: CropPlan = {
      version: 1,
      engine: "faces",
      source: { width: 1920, height: 1080 },
      shots: [{ start: 0, end: 5, layout: "center", x: 656 }],
    };
    expect(
      buildReframeCheck({ plan: v1, shotCount: 1, detectMs: 50, cutRecovery }).cutRecovery
    ).toEqual(cutRecovery);
    expect("cutRecovery" in buildReframeCheck({ plan: v1, shotCount: 1, detectMs: 50 })).toBe(
      false
    );
  });
```

- [ ] **Step 3: Write the failing wiring tests** - in `apps/worker/src/__tests__/reframe-compute.test.ts`:

Add `cutRecovery: false,` to the `cfg` literal (after `motion: false,`). Add these helpers below `detectorJson`:

```typescript
/** Two faces that never share the screen: A for 0-5s, B for 5-10s, one shot. */
const turnoverJson = () => {
  const path = (from: number, to: number, x: number) =>
    Array.from({ length: Math.round((to - from) * 2) }, (_, k) => ({
      t: from + k * 0.5,
      x,
      y: 180,
      w: 240,
      h: 240,
    }));
  return JSON.stringify({
    shots: [
      {
        shotIndex: 0,
        camRect: null,
        tracks: [
          { id: 1, box: { x: 100, y: 180, w: 240, h: 240 }, score: 0.9, samples: 10, mouthActivity: 0.3, path: path(0, 5, 100) },
          { id: 2, box: { x: 900, y: 180, w: 240, h: 240 }, score: 0.9, samples: 10, mouthActivity: 0.3, path: path(5, 10, 900) },
        ],
      },
    ],
  });
};

/** scdet stderr: one candidate at 5.0s scoring 0.22 - below the 0.3 bar. */
const candidateStderr =
  "[Parsed_metadata_2 @ 0x1] frame:0 pts:1 pts_time:5.0\n" +
  "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.22\n";

function turnoverPath(cmd: string, _args: string[]): ExecResult {
  if (cmd === "ffprobe") return { stdout: "1280x720\n", stderr: "" };
  if (cmd === "ffmpeg") return { stdout: "", stderr: candidateStderr };
  if (cmd === "python3") return { stdout: turnoverJson(), stderr: "" };
  throw new Error(`unexpected command ${cmd}`);
}
```

and a new describe block at the end of the file:

```typescript
describe("computeCropPlan cut recovery", () => {
  beforeEach(() => {
    h.calls = [];
    h.respond = turnoverPath;
  });

  it("leaves the plan alone and reports no telemetry with the flag off", async () => {
    const r = await computeCropPlan("/x.mp4", 0, 10, cfg);

    expect(r.plan?.shots).toHaveLength(1);
    expect(r.cutRecovery).toBeUndefined();
    expect(r.shotCount).toBe(1);
  });

  it("splits at the confirmed candidate with the flag on and reports telemetry", async () => {
    const r = await computeCropPlan("/x.mp4", 0, 10, { ...cfg, cutRecovery: true });

    expect(r.plan?.shots.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [5, 10],
    ]);
    // Two windows, one per face - the split changed the picture, not just the count.
    const xs = r.plan!.shots.map((s) => (s.layout === "single" ? s.x : NaN));
    expect(xs[0]).not.toBe(xs[1]);
    expect(r.cutRecovery).toEqual({
      candidates: 1,
      confirmed: 1,
      rejected: { noTurnover: 0, oneSideEmpty: 0, tooShort: 0, noPath: 0 },
      capHit: 0,
    });
    // shotCount stays the DETECTOR count; the recovered count is the plan's.
    expect(r.shotCount).toBe(1);
  });

  it("counts noPath and changes nothing when the sidecar sent no path", async () => {
    h.respond = (cmd, args) =>
      cmd === "python3" ? { stdout: detectorJson(1), stderr: "" } : turnoverPath(cmd, args);

    const r = await computeCropPlan("/x.mp4", 0, 10, { ...cfg, cutRecovery: true });

    expect(r.plan?.shots).toHaveLength(1);
    expect(r.cutRecovery?.rejected.noPath).toBe(1);
  });
});
```

Also add `cutRecovery: false,` to the `cfg` literal in `apps/worker/src/__tests__/reframe-shots-detect.test.ts` (after `motion: false,`).

- [ ] **Step 4: Run the three test files to verify they fail**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-config.test.ts apps/worker/src/__tests__/reframe-telemetry.test.ts apps/worker/src/__tests__/reframe-compute.test.ts"
```

Expected: FAIL (config `toEqual` mismatch, `cutRecovery` unknown property / undefined).

- [ ] **Step 5: Add the flag to `apps/worker/src/reframe/config.ts`**

In `ReframeConfig` (after `motion: boolean;`):

```typescript
  /** Cut-recovery killswitch (spec 2026-08-17-cut-recovery-design §2c). Off is
   *  today's plan byte for byte; on lets face-track turnover confirm scdet
   *  candidates in the 0.15-0.30 band. */
  cutRecovery: boolean;
```

In `loadReframeConfig` (after `motion: env.REFRAME_MOTION === "on",`):

```typescript
    // Exact literal, the REFRAME_STREAM rule.
    cutRecovery: env.REFRAME_CUT_RECOVERY === "on",
```

- [ ] **Step 6: Add the telemetry field to `apps/worker/src/reframe/telemetry.ts`**

```typescript
import { planLayoutCounts } from "./plan";
import type { CutRecoveryTelemetry } from "./cut-recovery";
import type { CropPlan, SourceProfile } from "./types";

export interface ReframeCheck {
  shotCount: number;
  detectMs: number;
  /** Derived from the counter so the two can never drift apart. */
  layouts?: ReturnType<typeof planLayoutCounts>;
  profile?: SourceProfile;
  fallbackReason?: string;
  /** Present iff cut recovery ran for this highlight (flag on, detection ok). */
  cutRecovery?: CutRecoveryTelemetry;
}

export interface ReframeCheckInput {
  plan: CropPlan | null;
  shotCount: number;
  detectMs: number;
  fallbackReason?: string;
  cutRecovery?: CutRecoveryTelemetry;
}

/** Pure: what the render stage records about one reframe attempt. */
export function buildReframeCheck(input: ReframeCheckInput): ReframeCheck {
  return {
    shotCount: input.shotCount,
    detectMs: input.detectMs,
    ...(input.plan ? { layouts: planLayoutCounts(input.plan) } : {}),
    ...(input.plan?.profile ? { profile: input.plan.profile } : {}),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    ...(input.cutRecovery ? { cutRecovery: input.cutRecovery } : {}),
  };
}
```

(`markEncodeFailed` is unchanged - its rest-spread keeps `cutRecovery`.)

- [ ] **Step 7: Rewrite `apps/worker/src/reframe/index.ts`**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import { loadReframeConfig, type ReframeConfig } from "./config";
import { detectShots, type CutCandidate } from "./shots";
import { detectFaces } from "./faces";
import { buildCropPlan, MAX_PLAN_SHOTS } from "./plan";
import { resolveCamRect } from "./cam-rect";
import { recoverCuts, type CutRecoveryTelemetry } from "./cut-recovery";
import type { CropPlan, Shot, ShotTracks } from "./types";

import { CHILD_MAX_BUFFER_BYTES } from "../child-buffer";

const execFileAsync = promisify(execFile);

export type ReframeFallbackReason =
  | "scdet_failed"
  | "detector_failed"
  | "detector_invalid_json"
  | "timeout"
  | "plan_empty";

export interface ReframeResult {
  plan: CropPlan | null;
  fallbackReason?: ReframeFallbackReason;
  detectMs: number;
  /** DETECTOR shots, before cut recovery; the recovered count is plan.shots.length. */
  shotCount: number;
  /** Present iff cut recovery ran (flag on and detection succeeded). */
  cutRecovery?: CutRecoveryTelemetry;
}

/** Everything the detectors produced for one range - what the planner is a
 *  pure function of. Exposed so the eval can plan ONE detection twice
 *  (flag off / flag on) and compare. */
export interface Detection {
  width: number;
  height: number;
  shots: Shot[];
  candidates: CutCandidate[];
  tracks: ShotTracks[];
}

export type DetectionResult =
  | { ok: true; detection: Detection; shotCount: number }
  | { ok: false; fallbackReason: ReframeFallbackReason; shotCount: number };

// execFile kills on timeout with error.killed=true
function isTimeout(error: unknown): boolean {
  return Boolean((error as { killed?: boolean } | null)?.killed);
}

async function probeDimensions(
  path: string,
  timeoutMs: number
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      path,
    ],
    { timeout: timeoutMs, maxBuffer: CHILD_MAX_BUFFER_BYTES }
  );
  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) throw new Error("probe_failed");
  return { width, height };
}

/**
 * Probe -> shots -> faces, under one wall-clock deadline (absolute ms).
 * Never throws: every failure comes back as ok:false with a machine-readable
 * reason, and the caller falls back to the legacy center crop (spec §8).
 */
export async function detectRange(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig,
  deadlineMs: number
): Promise<DetectionResult> {
  const remaining = () => Math.max(1000, deadlineMs - Date.now());
  let shotCount = 0;
  try {
    const { width, height } = await probeDimensions(sourcePath, remaining());
    const detected = await detectShots(sourcePath, startSec, endSec, cfg, remaining());
    shotCount = detected.shots.length;
    let tracks: ShotTracks[];
    try {
      tracks = await detectFaces(
        sourcePath, startSec, endSec, detected.shots, width, height, cfg, remaining()
      );
    } catch (error) {
      if (isTimeout(error)) return { ok: false, fallbackReason: "timeout", shotCount };
      if ((error as Error).message === "detector_invalid_json") {
        return { ok: false, fallbackReason: "detector_invalid_json", shotCount };
      }
      return { ok: false, fallbackReason: "detector_failed", shotCount };
    }
    return {
      ok: true,
      shotCount,
      detection: {
        width,
        height,
        shots: detected.shots,
        candidates: detected.candidates,
        tracks,
      },
    };
  } catch (error) {
    return {
      ok: false,
      fallbackReason: isTimeout(error) ? "timeout" : "scdet_failed",
      shotCount,
    };
  }
}

export interface PlannedDetection {
  plan: CropPlan | null;
  cutRecovery?: CutRecoveryTelemetry;
}

/**
 * Pure: the plan for a detection. Cut recovery runs iff cfg.cutRecovery - the
 * ONE place that policy lives. The clip-level cam rect is resolved on the
 * DETECTOR shots, before recovery, so repeating one parent's rect across its
 * sub-shots cannot swing resolveCamRect's majority vote.
 */
export function planDetected(d: Detection, cfg: ReframeConfig): PlannedDetection {
  const cam = resolveCamRect(d.tracks.map((t) => t.camRect), d.width, d.height);
  let shots = d.shots;
  let tracks = d.tracks;
  let cutRecovery: CutRecoveryTelemetry | undefined;
  if (cfg.cutRecovery) {
    const r = recoverCuts(shots, tracks, d.candidates, {
      minShotSec: cfg.minShotSec,
      sampleFps: cfg.sampleFps,
      maxPlanShots: MAX_PLAN_SHOTS,
    });
    shots = r.shots;
    tracks = r.tracksByShot;
    cutRecovery = r.telemetry;
  }
  const plan = buildCropPlan(
    shots,
    tracks,
    d.width,
    d.height,
    {
      faceSmallFrac: cfg.faceSmallFrac,
      faceLargeFrac: cfg.faceLargeFrac,
      stream: cfg.stream,
      camShare: cfg.camShare,
      motion: cfg.motion,
      camera: cfg.camera,
    },
    cam
  );
  return { plan, ...(cutRecovery ? { cutRecovery } : {}) };
}

/**
 * Shots -> faces -> layout, under one wall-clock budget (cfg.maxDetectSec).
 * Never throws: every failure returns plan:null with a machine-readable
 * reason, and the caller falls back to the legacy center crop (spec §8).
 */
export async function computeCropPlan(
  sourcePath: string,
  startSec: number,
  endSec: number,
  cfg: ReframeConfig = loadReframeConfig()
): Promise<ReframeResult> {
  const startedAt = Date.now();
  const detected = await detectRange(
    sourcePath, startSec, endSec, cfg, startedAt + cfg.maxDetectSec * 1000
  );
  const detectMs = () => Date.now() - startedAt;
  if (!detected.ok) {
    return {
      plan: null,
      fallbackReason: detected.fallbackReason,
      shotCount: detected.shotCount,
      detectMs: detectMs(),
    };
  }
  // Parity with the pre-2026-08-17 shape, where buildCropPlan sat inside the
  // same try as the detectors: a planner throw is still a fallback, never an
  // exception out of this function.
  let planned: PlannedDetection;
  try {
    planned = planDetected(detected.detection, cfg);
  } catch {
    return {
      plan: null,
      fallbackReason: "scdet_failed",
      shotCount: detected.shotCount,
      detectMs: detectMs(),
    };
  }
  const telemetry = planned.cutRecovery ? { cutRecovery: planned.cutRecovery } : {};
  if (!planned.plan) {
    return {
      plan: null,
      fallbackReason: "plan_empty",
      shotCount: detected.shotCount,
      detectMs: detectMs(),
      ...telemetry,
    };
  }
  return { plan: planned.plan, shotCount: detected.shotCount, detectMs: detectMs(), ...telemetry };
}
```

- [ ] **Step 8: Pass the telemetry through in `apps/worker/src/stages/render.ts`** - change the second `buildReframeCheck({...})` call (the one after `computeCropPlan`, currently lines 184-190) to

```typescript
          reframeChecks.push(
            buildReframeCheck({
              plan: reframe.plan,
              shotCount: reframe.shotCount,
              detectMs: reframe.detectMs,
              fallbackReason: reframe.fallbackReason,
              cutRecovery: reframe.cutRecovery,
            })
          );
```

- [ ] **Step 9: Run every reframe test file plus the render test, and typecheck**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src/__tests__/reframe-config.test.ts apps/worker/src/__tests__/reframe-telemetry.test.ts apps/worker/src/__tests__/reframe-compute.test.ts apps/worker/src/__tests__/reframe-shots-detect.test.ts apps/worker/src/__tests__/reframe-shots.test.ts apps/worker/src/__tests__/reframe-cut-recovery.test.ts apps/worker/src/__tests__/reframe-plan.test.ts apps/worker/src/__tests__/render-reframe.test.ts"
docker compose exec -T worker-render sh -c "cd /app/apps/worker && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: all PASS; typecheck clean.

Mutation: in `planDetected` change `if (cfg.cutRecovery)` to `if (true)` → "leaves the plan alone ... with the flag off" RED (`cutRecovery` defined, 2 shots). Revert, GREEN. Then change it to `if (false)` → "splits at the confirmed candidate" RED. Revert, GREEN.

- [ ] **Step 10: Run the whole worker suite once (nothing else may have moved)**

```bash
docker compose exec -T worker-render sh -c "cd /app && /app/node_modules/.bin/vitest run --root /app apps/worker/src 2>&1 | tail -8"
```

Expected: `Test Files  N passed`, `Tests  M passed`, zero failed. If any non-reframe file fails, stop and report - do not fix unrelated tests.

- [ ] **Step 11: Commit**

```bash
git add apps/worker/src/reframe/config.ts apps/worker/src/reframe/index.ts apps/worker/src/reframe/telemetry.ts apps/worker/src/stages/render.ts apps/worker/src/__tests__/reframe-config.test.ts apps/worker/src/__tests__/reframe-compute.test.ts apps/worker/src/__tests__/reframe-telemetry.test.ts apps/worker/src/__tests__/reframe-shots-detect.test.ts
git commit -m "feat(reframe): REFRAME_CUT_RECOVERY flag - detectRange + planDetected split so the policy lives in one place, telemetry rides into renderManifest; off by default and byte-identical"
```

---

### Task 4: `eval-cut-recovery.ts` and the corpus run (spec §3)

**Files:**
- Create: `apps/worker/src/scripts/eval-cut-recovery.ts`

- [ ] **Step 1: Write the script**

```typescript
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
import { recoverCuts, type CutDecision } from "../reframe/cut-recovery";
import { MAX_PLAN_SHOTS } from "../reframe/plan";
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
  telemetry?: ReturnType<typeof recoverCuts>["telemetry"];
  decisions: Array<{ t: number; score: number; verdict: CutDecision }>;
  sheets: string[];
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
        spans: [], decisions: [], sheets: [],
      });
      continue;
    }
    const off = planDetected(det.detection, { ...cfg, cutRecovery: false });
    const on = planDetected(det.detection, { ...cfg, cutRecovery: true });
    const rec = recoverCuts(det.detection.shots, det.detection.tracks, det.detection.candidates, {
      minShotSec: cfg.minShotSec, sampleFps: cfg.sampleFps, maxPlanShots: MAX_PLAN_SHOTS,
    });
    const cropW = cropWidthFor(det.detection.height);
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
      telemetry: on.cutRecovery, decisions: rec.decisions.map(({ t, score, verdict }) => ({ t, score, verdict })),
      sheets,
    };
    reports.push(r);
    console.log(
      `${item.clip} start=${item.start.toFixed(1)} off=${offInvariant} shots ${r.shotsDetector}/${r.shotsOff}->${r.shotsOn} ` +
        `diff ${r.diffSec.toFixed(1)}s of ${r.cmpSec.toFixed(1)}s ` +
        `cand ${r.telemetry?.candidates ?? 0} conf ${r.telemetry?.confirmed ?? 0} rej ${JSON.stringify(r.telemetry?.rejected ?? {})} cap ${r.telemetry?.capHit ?? 0}` +
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
  console.log(`rejected sampled: ${sampled.length} of ${rejected.length}; sheets in ${outDir}`);
  await writeFile(join(outDir, "summary.json"), JSON.stringify(reports, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck, then smoke on the two named clips**

```bash
docker compose exec -T worker-render sh -c "cd /app/apps/worker && /app/node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit"
docker compose exec -T worker-render sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-cut-recovery.ts --only cmsrxcgk60003uqaks7oudaon,cmsven6bv001xuqakfsqqwc9s --rejected-sample 4" 2>&1 | grep -v "npm notice"
```

Expected: two clip lines with `off=true`; for `cmsrxcgk6` a diff span covering roughly `[18.3, 20.7]` with `xOff 372`; for `cmsven6bv` diff spans inside `4-5`, `7.5-12`, `15-21.5`; `OFF invariant: 2/2`; sheet files under `apps/worker/.corpus/director-audit/eval-cut-recovery/`. If `off=false` on either, STOP: Task 1 or 3 broke byte-identity - report the shot lists, do not continue.

- [ ] **Step 3: Full run over the corpus (~10-12 minutes)**

```bash
docker compose exec -T worker-render sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-cut-recovery.ts --rejected-sample 30" 2>&1 | grep -v "npm notice" | tee /tmp/eval-cut-recovery.log
```

Expected shape (numbers are the deliverable, not a target): `OFF invariant: 53/53`; a total diff in seconds; per-clip lines; `summary.json` and sheets written.

- [ ] **Step 4: Fill in the acceptance table** - write it into the commit message body AND hand it to the architect:

```
OFF invariant ......... N/53   (must be 53)
diff (ON vs OFF) ...... X.Xs of 2009s, clips with diff K
Alipov 527.85 @18.3-20.7 ..... fixed? (span present, green holds the face on the sheet)
Veronica 1186.4 spans ......... fixed?
ar-habits 0.0 @12.0 (lamp) .... NO span (must be absent)
Isaiah 1831.6 @5-9.5 (cave) ... NO span, or a span the sheet shows as neutral/better
shots: detector / off / on .... counts; capHit total (must be 0)
candidates / confirmed / rejected by reason
rejected sample ............... 30 sheets, real cuts with a framing change seen: (architect fills)
```

The architect (not the executor) reads every `diff-*.jpg` sheet and the 30 `rejected-*.jpg` sheets and judges spec §3 items 3 and 5. The executor's job ends at producing the run and the table.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scripts/eval-cut-recovery.ts
git commit -m "feat(reframe): eval-cut-recovery - OFF invariant against the persisted corpus plans, ON/OFF window diff in seconds, sheets for every diff span and a rejected-candidate sample"
```

(Append the acceptance table from Step 4 to the commit body.)

---

### Task 5: Record and ship (spec §3 rollout, §6 Task 5) - architect/owner

**Files:**
- Modify: `docs/engine-notes.md` (new `### 7i.` section after 7h)
- Modify: memory `project_director_audit.md` and `MEMORY.md`

- [ ] **Step 1: engine-notes §7i** - "Cut recovery: the missed cuts, confirmed by the faces (2026-08-17)": the defect numbers from spec §0, the rule, the OFF invariant result, the seconds fixed and where, the two named regressions and what happened to them, the rejected sample verdict, shot-count growth, any knob change and its number. Add `REFRAME_CUT_RECOVERY` to the §7 flag list and move "merge-blindness and the missed cuts" open item to "missed cuts: SHIPPED, merge-blindness: open" with the pointer.
- [ ] **Step 2: memory** - update `project_director_audit.md` with the outcome; one-line pointer stays in `MEMORY.md`.
- [ ] **Step 3: rollout (owner's go required)** - only if the acceptance table passed: append `REFRAME_CUT_RECOVERY=on` to the live `.env` (Read+Edit, never sed), then `docker compose up -d worker-render` (recreate; `restart` ignores `env_file`), then inside the recreated container `npx prisma generate --schema=/app/prisma/schema.prisma`, then verify `loadReframeConfig().cutRecovery === true` from inside `worker-render`, and read `renderManifest.reframe.checks[].cutRecovery` on the next real job.
- [ ] **Step 4: Commit docs**

```bash
git add docs/engine-notes.md
git commit -m "docs(engine-notes): 7i cut recovery - measured on the 53-clip corpus, shipped behind REFRAME_CUT_RECOVERY"
```
