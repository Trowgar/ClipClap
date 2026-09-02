# Core V3 Visual Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-safe visual-event recall to the transcript-first highlight engine without changing output when the feature is off or shadowed.

**Architecture:** TRANSCRIBE derives per-second luma and motion from one ffmpeg `signalstats` pass and persists both on its JobStep. ANALYZE deterministically maps robust motion peaks to ordinary transcript-grounded candidates, observes them in shadow, and unions them before the existing merge/critic pipeline only in on mode.

**Tech Stack:** TypeScript, Node 20, ffmpeg `signalstats`, Prisma JobStep JSON, Vitest, Docker Compose.

---

### Task 1: Extract and persist the motion envelope

**Files:**
- Modify: `apps/worker/src/processors/transcribe.ts`
- Modify: `apps/worker/src/processors/__tests__/rms-envelope.test.ts`
- Modify: `apps/worker/src/processors/__tests__/transcribe.test.ts`
- Modify: `apps/worker/src/stages/transcribe.ts`
- Modify: `apps/worker/src/__tests__/stage-flow.test.ts`

- [ ] **Step 1: Write failing processor tests**

Add assertions that a synthetic moving 4-second source returns a non-empty
`motionEnvelope`, a static source stays near zero after the first sample, an audio-only
source returns `[]`, and `transcribeVideo` includes `motionEnvelope: []` when the media
probe is mocked to fail.

```ts
const envelope = await videoEnvelopes(movingFixturePath);
expect(envelope.lumaEnvelope).toHaveLength(4);
expect(envelope.motionEnvelope).toHaveLength(4);
expect(Math.max(...envelope.motionEnvelope.slice(1))).toBeGreaterThan(1);

const still = await videoEnvelopes(stillFixturePath);
expect(Math.max(...still.motionEnvelope.slice(1))).toBeLessThan(0.5);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run --root ../.. apps/worker/src/processors/__tests__/rms-envelope.test.ts apps/worker/src/processors/__tests__/transcribe.test.ts
```

Expected: failure because `videoEnvelopes` and `motionEnvelope` do not exist.

- [ ] **Step 3: Implement one-pass video envelopes**

Export a result type and parser in `transcribe.ts`:

```ts
export interface VideoEnvelopes {
  lumaEnvelope: number[];
  motionEnvelope: number[];
}

export async function videoEnvelopes(videoPath: string): Promise<VideoEnvelopes> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-nostdin", "-i", videoPath,
      "-vf", "fps=1,signalstats,metadata=print",
      "-f", "null", "-",
    ], { maxBuffer: CHILD_MAX_BUFFER_BYTES });
    return bucketVideoSignalsBySecond(stderr ?? "");
  } catch (error) {
    console.warn("videoEnvelopes: signalstats pass failed, continuing without video signals:", error);
    return { lumaEnvelope: [], motionEnvelope: [] };
  }
}
```

Parse `lavfi.signalstats.YAVG` and `lavfi.signalstats.YDIF` into independent arrays.
Keep `lumaEnvelope(path)` as a compatibility wrapper around `videoEnvelopes(path)`.
Start one `videoEnvelopesPromise` in `transcribeVideo`; populate both fields on the
single-file and chunked paths without running a second video pass.

- [ ] **Step 4: Persist the new field**

Add to `TranscribeOutcome` and the TRANSCRIBE JobStep completion payload:

```ts
motionEnvelope: outcome.motionEnvelope,
```

Extend `stage-flow.test.ts` to assert the field is written and that existing enqueue,
coverage, and job-update behavior is unchanged.

- [ ] **Step 5: Run focused tests and commit**

```bash
npx vitest run --root ../.. apps/worker/src/processors/__tests__/rms-envelope.test.ts apps/worker/src/processors/__tests__/transcribe.test.ts apps/worker/src/__tests__/stage-flow.test.ts
git add apps/worker/src/processors/transcribe.ts apps/worker/src/processors/__tests__/rms-envelope.test.ts apps/worker/src/processors/__tests__/transcribe.test.ts apps/worker/src/stages/transcribe.ts apps/worker/src/__tests__/stage-flow.test.ts
git commit -m "feat(analyze): capture per-second visual motion"
```

Expected: all focused tests pass.

### Task 2: Add closed configuration and pure visual nomination

**Files:**
- Create: `apps/worker/src/analyze-v2/visual-candidates.ts`
- Create: `apps/worker/src/__tests__/visual-candidates.test.ts`
- Modify: `apps/worker/src/analyze-v2/config.ts`
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing config tests**

```ts
expect(loadAnalyzeConfig({}).visualRecallMode).toBe("off");
expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "shadow" }).visualRecallMode).toBe("shadow");
expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "on" }).visualRecallMode).toBe("on");
expect(loadAnalyzeConfig({ ANALYZE_VISUAL_RECALL_V1: "yes" }).visualRecallMode).toBe("off");
```

Also assert positive bounded defaults: max candidates 12, cluster 12 seconds, pre 8,
post 18, maximum node distance 20.

- [ ] **Step 2: Write failing nomination tests**

Cover empty/malformed input, static envelopes, robust thresholding, local maxima,
12-second clustering, temporal diversity, maximum count, node mapping, and no-nearby-
speech rejection. Use hand-written `SentenceNode[]`; no model calls or ffmpeg fixtures.

```ts
const result = nominateVisualCandidates(nodes, [0, 1, 2, 20, 3, 2, 1], cfg);
expect(result.candidates).toHaveLength(1);
expect(result.candidates[0]).toMatchObject({ type: "visual_action" });
expect(result.telemetry.mappedCandidates).toBe(1);
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/visual-candidates.test.ts
```

- [ ] **Step 4: Implement config and the pure module**

Add to `AnalyzeConfig`:

```ts
visualRecallMode: "off" | "shadow" | "on";
visualRecallMaxCandidates: number;
visualRecallClusterSec: number;
visualRecallPreSec: number;
visualRecallPostSec: number;
visualRecallMaxNodeDistanceSec: number;
```

The pure module returns both candidates and fully numeric telemetry. It must calculate
median/MAD and p75, keep local maxima, cluster, cap, and map peak seconds to bounded node
ranges. Generated candidates use `interest` clamped to `[0.55, 0.95]`, peak-nearest
`payoffNode`, and `windowIndex = floor(peakSec / cfg.scanWindowSec)`.

- [ ] **Step 5: Document env and commit**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/visual-candidates.test.ts
git add .env.example apps/worker/src/analyze-v2/config.ts apps/worker/src/analyze-v2/visual-candidates.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/visual-candidates.test.ts
git commit -m "feat(analyze): nominate transcript-grounded visual peaks"
```

### Task 3: Wire off, shadow, and on modes into ANALYZE

**Files:**
- Modify: `apps/worker/src/analyze-v2/index.ts`
- Modify: `apps/worker/src/stages/analyze.ts`
- Modify: `apps/worker/src/__tests__/analyze-v2.test.ts`
- Modify: `apps/worker/src/__tests__/stage-flow.test.ts`
- Create: `apps/worker/src/__tests__/visual-recall-wiring.test.ts`

- [ ] **Step 1: Write mode-invariance and union tests**

Use a replay client with fixed scanner/critic/finalizer responses. Assert:

```ts
expect(off.highlights).toEqual(shadow.highlights);
expect(off.telemetry).not.toHaveProperty("visualRecall");
expect(shadow.telemetry.visualRecall.mode).toBe("shadow");
expect(on.telemetry.visualRecall.unionCandidates).toBeGreaterThan(0);
expect(criticRequest).toContain("visual_action");
```

Also prove missing motion data in shadow/on preserves normal output and emits
`no_motion_envelope`, while scanner-total-outage behavior still throws.

- [ ] **Step 2: Run the wiring tests and verify RED**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/visual-recall-wiring.test.ts apps/worker/src/__tests__/stage-flow.test.ts
```

- [ ] **Step 3: Thread JobStep signals into V2 options**

Extend `AnalyzeV2Options` with optional `motionEnvelope`. Generalize
`readTranscribeEnvelopes()` to return energy, luma, and motion in one indexed query.
Read envelopes for the normal recall-critic path only when visual mode is not `off` or
music-shorts needs them.

- [ ] **Step 4: Union before merge only in on mode**

After `runScanner` and before `mergeCandidates`:

```ts
const visual = cfg.visualRecallMode === "off"
  ? undefined
  : nominateVisualCandidates(nodes, options.motionEnvelope ?? [], cfg);
const rawCandidates = cfg.visualRecallMode === "on" && visual
  ? [...scan.candidates, ...visual.candidates]
  : scan.candidates;
const merged = mergeCandidates(rawCandidates, nodes, cfg, mode);
```

Attach `visualRecall` telemetry only in shadow/on. Count nominations surviving merge and
critic selection by their `type`. Do not mask scanner failure or transcript holes.

- [ ] **Step 5: Run wiring tests and commit**

```bash
npx vitest run --root ../.. apps/worker/src/__tests__/visual-recall-wiring.test.ts apps/worker/src/__tests__/analyze-v2.test.ts apps/worker/src/__tests__/stage-flow.test.ts
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/stages/analyze.ts apps/worker/src/__tests__/visual-recall-wiring.test.ts apps/worker/src/__tests__/analyze-v2.test.ts apps/worker/src/__tests__/stage-flow.test.ts
git commit -m "feat(analyze): add shadowable visual recall lane"
```

### Task 4: Build a real-source evaluation command

**Files:**
- Create: `apps/worker/src/scripts/eval-visual-recall.ts`
- Create: `apps/worker/src/scripts/__tests__/eval-visual-recall.test.ts`
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Write failing CLI/pure-metric tests**

The command accepts a private manifest path, never hard-coded production identifiers.
Each case contains source path, transcript path, positive windows, and optional negative
windows. Test overlap matching and gate aggregation as pure functions.

```ts
expect(matchesWindow({ start: 100, end: 120 }, { start: 110, end: 130 }, 20)).toBe(true);
expect(summarizeCases(cases).positiveRecall).toBeGreaterThanOrEqual(0.8);
```

- [ ] **Step 2: Implement the command**

The script computes video envelopes, runs nomination, prints JSON without source paths,
and exits non-zero unless:

- gaming positive recall is at least 2 human windows;
- confirmed `AS_IS` cases retain their expected windows;
- no case exceeds configured candidate cap;
- off/shadow output invariance tests pass separately.

- [ ] **Step 3: Run tests and commit**

```bash
npx vitest run --root ../.. apps/worker/src/scripts/__tests__/eval-visual-recall.test.ts
git add apps/worker/src/scripts/eval-visual-recall.ts apps/worker/src/scripts/__tests__/eval-visual-recall.test.ts apps/worker/package.json
git commit -m "test(eval): gate visual recall on real source windows"
```

### Task 5: Verify on retained incidents and tune only from evidence

**Files:**
- Create outside git: `/tmp/clipclap-core-v3-eval/manifest.json`
- Create outside git: `/tmp/clipclap-core-v3-eval/*.json`
- Modify only if evidence requires: `apps/worker/src/analyze-v2/config.ts`
- Modify only if evidence requires: `apps/worker/src/__tests__/visual-candidates.test.ts`

- [ ] **Step 1: Assemble the private corpus**

Use retained source/transcript artifacts for the paid gaming incident, the 2026-09-02
five-feedback job, and every still-retained confirmed `AS_IS` source. Keep identifiers
and paths only under `/tmp/clipclap-core-v3-eval`; never commit them.

- [ ] **Step 2: Run shadow nomination**

```bash
npm run eval:visual-recall --workspace apps/worker -- /tmp/clipclap-core-v3-eval/manifest.json
```

Expected: gaming recall gate >=2, positive preservation 100%, candidate cap respected.

- [ ] **Step 3: Tune one variable at a time if a gate fails**

Change only a config default named by the failing metric, add a unit test pinning the
new boundary, rerun the private corpus, and commit the evidence-backed change. Do not
add content-specific words, user identifiers, game names, or source-specific branches.

### Task 6: Full verification, review, integration, and production rollout

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-09-02-core-v3-visual-recall-design.md` only for final measured results

- [ ] **Step 1: Build the actual worker image**

```bash
docker build -f apps/worker/Dockerfile -t clipclap-worker-core-v3:verify .
```

- [ ] **Step 2: Run the complete worker suite inside that image**

```bash
docker run --rm --entrypoint sh clipclap-worker-core-v3:verify -lc 'cd /app && npm test --workspace apps/worker -- --run'
```

Expected: all worker tests pass, including ffmpeg/font/native suites.

- [ ] **Step 3: Run build and regression gates**

```bash
docker run --rm --entrypoint sh clipclap-worker-core-v3:verify -lc 'cd /app && npm run build --workspace apps/worker'
npm run eval:visual-recall --workspace apps/worker -- /tmp/clipclap-core-v3-eval/manifest.json
```

Expected: build exits 0 and every private-corpus gate passes.

- [ ] **Step 4: Obtain two-stage code review**

Dispatch a spec-compliance reviewer, fix every gap, re-review; then dispatch a code-
quality reviewer, fix every important issue, and re-review. Finish with a whole-branch
review against `main`.

- [ ] **Step 5: Merge and deploy shadow**

Merge the reviewed branch to `main`, rebuild `worker-transcribe` and `worker-analyze`,
set `ANALYZE_VISUAL_RECALL_V1=shadow`, and recreate only those services. Verify startup,
queue connectivity, and one controlled replay. `LONG_CLIPS` remains `off`.

- [ ] **Step 6: Promote to on only after production shadow comparison**

Compare the controlled replay's shadow nominations with the private-corpus result. If
identical and all gates remain green, set `ANALYZE_VISUAL_RECALL_V1=on`, recreate
`worker-analyze`, and verify the effective environment and logs. On any discrepancy,
return to `shadow`; no database rollback is required.

- [ ] **Step 7: Record final measurements and commit**

Append only aggregate recall, preservation, candidate-count, latency, test, and build
results to the design document. Do not commit private paths or identifiers.

