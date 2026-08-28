# Standalone Clip Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a low-confidence clip with an explicit `standalone.ok=false` audit result from reaching the finalizer when the same candidate set contains a fully clean alternative, without ever emptying the set.

**Architecture:** Add a deterministic pure filter between the existing arc-downrank stage and `finalizeClips`. The filter reads immutable critic scores and arc-audit flags, returns a stable ordered candidate list plus explicit telemetry and drop records, while `index.ts` owns feature gating and the shared `droppedVerdicts` stream.

**Tech Stack:** TypeScript, Node.js 22, Vitest 3, analyze-v2 worker pipeline, Git.

---

## File map

- Create `apps/worker/src/analyze-v2/standalone-filter.ts`: pure alternative-aware filtering policy and its result types.
- Create `apps/worker/src/__tests__/standalone-filter.test.ts`: exhaustive policy tests with no model or pipeline mocks.
- Modify `apps/worker/src/analyze-v2/config.ts`: fail-closed `standaloneFilterEnabled` config property.
- Modify `.env.example`: document `ANALYZE_STANDALONE_FILTER_V1=off` and its dependency on `ARC_AUDIT=on`.
- Modify `apps/worker/src/__tests__/analyze-config.test.ts`: exact-literal flag parsing tests.
- Modify `apps/worker/src/__tests__/helpers/eval-fingerprint.ts`: include the behavior-changing flag in `EngineFingerprint`.
- Modify `apps/worker/src/__tests__/eval-fingerprint.test.ts`: pin the default and mismatch behavior.
- Modify `apps/worker/src/analyze-v2/index.ts`: run the filter after arc-downrank, record drops, pass the exact result to the finalizer, and publish telemetry.
- Modify `apps/worker/src/__tests__/arc-downrank-wiring.test.ts`: reuse the existing arc-audit pipeline harness to prove dark mode, ordering, finalizer input, telemetry, and drop provenance.
- Modify `docs/engine-notes.md`: record the measured rule, rollout gate, and non-empty-set invariant.

Do not modify or commit `apps/worker/src/tmp-audit.ts`; it is unrelated untracked diagnostic work.

### Task 1: Pure standalone filter

**Files:**
- Create: `apps/worker/src/__tests__/standalone-filter.test.ts`
- Create: `apps/worker/src/analyze-v2/standalone-filter.ts`

- [ ] **Step 1: Write the failing pure-policy tests**

Create `apps/worker/src/__tests__/standalone-filter.test.ts` with these helpers and assertions:

```ts
import { describe, expect, it } from "vitest";
import { filterStandaloneClips } from "../analyze-v2/standalone-filter";
import type { ArcFlags, SnappedClip } from "../analyze-v2/types";

const clip = (id: string, score: number): SnappedClip =>
  ({ verdict: { id, score } } as SnappedClip);

const flags = (
  entryOk: boolean,
  exitOk: boolean,
  standaloneOk: boolean,
  repaired: { entry?: true; exit?: true } = {}
): ArcFlags => ({
  entry: { ok: entryOk, ...(repaired.entry ? { repaired: true as const } : {}) },
  exit: { ok: exitOk, ...(repaired.exit ? { repaired: true as const } : {}) },
  standalone: { ok: standaloneOk },
});

const run = (clips: SnappedClip[], rows: Array<[string, ArcFlags]>) =>
  filterStandaloneClips(clips, new Map(rows), 0.6, 0.15);

describe("filterStandaloneClips", () => {
  it("drops the measured 0.67 standalone failure when a fully clean alternative exists", () => {
    const clean = clip("clean", 0.82);
    const rejected = clip("rejected", 0.67);
    const result = run(
      [clean, rejected],
      [
        ["clean", flags(true, true, true)],
        ["rejected", flags(true, true, false)],
      ]
    );

    expect(result.clips).toEqual([clean]);
    expect(result.drops).toEqual([{ id: "rejected", score: 0.67 }]);
    expect(result.telemetry).toEqual({
      considered: 2,
      eligible: 1,
      dropped: 1,
      bypassedNoCleanAlternative: 0,
    });
  });

  it("fails open when no fully clean alternative exists", () => {
    const rejected = clip("rejected", 0.67);
    const entryFlagged = clip("entry", 0.9);
    const input = [rejected, entryFlagged];
    const result = run(
      input,
      [
        ["rejected", flags(true, true, false)],
        ["entry", flags(false, true, true)],
      ]
    );

    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({
      considered: 2,
      eligible: 1,
      dropped: 0,
      bypassedNoCleanAlternative: 1,
    });
  });

  it("keeps a high-score standalone failure and exact threshold equality", () => {
    const high = clip("high", 0.76);
    const equal = clip("equal", 0.75);
    const clean = clip("clean", 0.8);
    const result = run(
      [high, equal, clean],
      [
        ["high", flags(true, true, false)],
        ["equal", flags(true, true, false)],
        ["clean", flags(true, true, true)],
      ]
    );

    expect(result.clips).toEqual([high, equal, clean]);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({
      considered: 3,
      eligible: 0,
      dropped: 0,
      bypassedNoCleanAlternative: 0,
    });
  });

  it("does not target entry-only or exit-only failures", () => {
    const entry = clip("entry", 0.2);
    const exit = clip("exit", 0.2);
    const clean = clip("clean", 0.8);
    const result = run(
      [entry, exit, clean],
      [
        ["entry", flags(false, true, true)],
        ["exit", flags(true, false, true)],
        ["clean", flags(true, true, true)],
      ]
    );

    expect(result.clips).toEqual([entry, exit, clean]);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({
      considered: 3,
      eligible: 0,
      dropped: 0,
      bypassedNoCleanAlternative: 0,
    });
  });

  it("treats missing flags as neither failure nor clean alternative", () => {
    const missing = clip("missing", 0.9);
    const rejected = clip("rejected", 0.67);
    const input = [missing, rejected];
    const result = run(input, [["rejected", flags(true, true, false)]]);

    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({
      considered: 2,
      eligible: 1,
      dropped: 0,
      bypassedNoCleanAlternative: 1,
    });
  });

  it("does not count repaired-only audit history as a clean alternative", () => {
    const repaired = clip("repaired", 0.9);
    const rejected = clip("rejected", 0.67);
    const input = [repaired, rejected];
    const result = run(
      input,
      [
        ["repaired", flags(false, true, true, { entry: true })],
        ["rejected", flags(true, true, false)],
      ]
    );

    expect(result.clips).toBe(input);
    expect(result.drops).toEqual([]);
    expect(result.telemetry).toEqual({
      considered: 2,
      eligible: 1,
      dropped: 0,
      bypassedNoCleanAlternative: 1,
    });
  });

  it("preserves order, object identity, and critic scores", () => {
    const first = clip("first", 0.81);
    const rejected = clip("rejected", 0.67);
    const last = clip("last", 0.79);
    const result = run(
      [first, rejected, last],
      [
        ["first", flags(true, true, true)],
        ["rejected", flags(true, true, false)],
        ["last", flags(true, true, true)],
      ]
    );

    expect(result.clips).toEqual([first, last]);
    expect(result.clips[0]).toBe(first);
    expect(result.clips[1]).toBe(last);
    expect(rejected.verdict.score).toBe(0.67);
    expect(first.verdict.score).toBe(0.81);
    expect(last.verdict.score).toBe(0.79);
    expect(result.drops).toEqual([{ id: "rejected", score: 0.67 }]);
    expect(result.telemetry).toEqual({
      considered: 3,
      eligible: 1,
      dropped: 1,
      bypassedNoCleanAlternative: 0,
    });
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/standalone-filter.test.ts
```

Expected: FAIL because `../analyze-v2/standalone-filter` does not exist.

- [ ] **Step 3: Implement the minimal pure filter**

Create `apps/worker/src/analyze-v2/standalone-filter.ts`:

```ts
import { isFullyOk } from "./arc-audit";
import type { ArcFlags, SnappedClip } from "./types";

export interface StandaloneFilterTelemetry {
  considered: number;
  eligible: number;
  dropped: number;
  bypassedNoCleanAlternative: number;
}

export interface StandaloneFilterDrop {
  id: string;
  score: number;
}

export interface StandaloneFilterResult {
  clips: SnappedClip[];
  drops: StandaloneFilterDrop[];
  telemetry: StandaloneFilterTelemetry;
}

export function filterStandaloneClips(
  clips: SnappedClip[],
  arcFlags: ReadonlyMap<string, ArcFlags>,
  scoreThreshold: number,
  penalty: number
): StandaloneFilterResult {
  const eligible = clips.filter((clip) => {
    const flags = arcFlags.get(clip.verdict.id);
    return (
      flags?.standalone.ok === false &&
      clip.verdict.score - penalty < scoreThreshold
    );
  });

  const telemetry: StandaloneFilterTelemetry = {
    considered: clips.length,
    eligible: eligible.length,
    dropped: 0,
    bypassedNoCleanAlternative: 0,
  };

  const hasFullyCleanAlternative = clips.some((clip) =>
    isFullyOk(arcFlags.get(clip.verdict.id))
  );
  if (!hasFullyCleanAlternative) {
    telemetry.bypassedNoCleanAlternative = eligible.length;
    return { clips, drops: [], telemetry };
  }

  const droppedIds = new Set(eligible.map((clip) => clip.verdict.id));
  const drops = eligible.map((clip) => ({
    id: clip.verdict.id,
    score: clip.verdict.score,
  }));
  telemetry.dropped = drops.length;

  return {
    clips: clips.filter((clip) => !droppedIds.has(clip.verdict.id)),
    drops,
    telemetry,
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command again.

Expected: 1 test file passes and all 7 tests pass.

- [ ] **Step 5: Typecheck the new module**

Run:

```bash
npm run typecheck -w @clipclap/worker
```

Expected: exit code 0.

- [ ] **Step 6: Commit the pure policy**

```bash
git add apps/worker/src/analyze-v2/standalone-filter.ts apps/worker/src/__tests__/standalone-filter.test.ts
git commit -m "feat(worker): add standalone clip filter policy"
```

### Task 2: Fail-closed configuration and replay fingerprint

**Files:**
- Modify: `apps/worker/src/analyze-v2/config.ts:190-225,450-485`
- Modify: `.env.example:75-95`
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`
- Modify: `apps/worker/src/__tests__/helpers/eval-fingerprint.ts:270-290,405-480`
- Modify: `apps/worker/src/__tests__/eval-fingerprint.test.ts:15-115,245-270`

- [ ] **Step 1: Add failing config and fingerprint assertions**

Append this test inside the existing `describe("loadAnalyzeConfig", ...)` block in `apps/worker/src/__tests__/analyze-config.test.ts`:

```ts
it("arms the standalone filter only for the exact literal on", () => {
  expect(loadAnalyzeConfig({}).standaloneFilterEnabled).toBe(false);
  expect(
    loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "on" }).standaloneFilterEnabled
  ).toBe(true);
  expect(
    loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "true" }).standaloneFilterEnabled
  ).toBe(false);
  expect(
    loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "1" }).standaloneFilterEnabled
  ).toBe(false);
  expect(
    loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "ON" }).standaloneFilterEnabled
  ).toBe(false);
});
```

In `apps/worker/src/__tests__/eval-fingerprint.test.ts`, add `standaloneFilterEnabled` to the complete object expected in the first test:

```ts
standaloneFilterEnabled: baseCfg.standaloneFilterEnabled,
```

Add this default assertion to the `computeFingerprint` describe block:

```ts
it("records the standalone filter as dark by default", () => {
  expect(computeFingerprint(baseCfg).standaloneFilterEnabled).toBe(false);
});
```

Add this mismatch assertion to the `assertFingerprintMatches` describe block:

```ts
it("fails when the standalone filter switch changed", () => {
  const changed = computeFingerprint({ ...baseCfg, standaloneFilterEnabled: true });
  expect(() => assertFingerprintMatches("case", { ...current }, changed, vi.fn())).toThrow(
    /standaloneFilterEnabled/
  );
});
```

- [ ] **Step 2: Run config and fingerprint tests and verify RED**

Run:

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/eval-fingerprint.test.ts
```

Expected: FAIL because `AnalyzeConfig` and `EngineFingerprint` do not yet expose `standaloneFilterEnabled`.

- [ ] **Step 3: Add the config property and parser**

In `AnalyzeConfig` in `apps/worker/src/analyze-v2/config.ts`, immediately after `arcDownrankEnabled`, add:

```ts
/** Alternative-aware standalone failure filter. It is evaluated only with
 * arcAuditEnabled, after arc downrank and before the finalizer. Off by default
 * because it can remove a candidate from a real user's finalizer input. */
standaloneFilterEnabled: boolean;
```

In the object returned by `loadAnalyzeConfig`, immediately after `arcDownrankEnabled`, add:

```ts
standaloneFilterEnabled: env.ANALYZE_STANDALONE_FILTER_V1 === "on",
```

- [ ] **Step 4: Add the fingerprint property**

In `EngineFingerprint` in `apps/worker/src/__tests__/helpers/eval-fingerprint.ts`, immediately after `arcDownrankEnabled`, add:

```ts
/** Whether the alternative-aware standalone filter may remove a candidate
 * before the finalizer. It changes finalizer input without making a request
 * of its own, so replay must record the switch explicitly. */
standaloneFilterEnabled: boolean;
```

In `computeFingerprint`, immediately after `arcDownrankEnabled`, add:

```ts
standaloneFilterEnabled: cfg.standaloneFilterEnabled,
```

Do not add a fixture variant or rewrite fixture recordings in this task. The new flag defaults off, existing fingerprints are partial by design, and the synthetic mismatch test proves the new key detects drift.

- [ ] **Step 5: Document the operational flag**

In `.env.example`, after the arc-audit-related options and before smart reframe, add:

```dotenv
# Removes an explicit standalone failure only when its 0.15-penalized score is
# below CLIP_SCORE_THRESHOLD and another fully clean candidate exists. No-ops
# unless ARC_AUDIT=on. Exact literal `on`; ships dark for measured rollout.
ANALYZE_STANDALONE_FILTER_V1=off # off | on
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/eval-fingerprint.test.ts
npm run typecheck -w @clipclap/worker
```

Expected: both test files pass and typecheck exits 0.

- [ ] **Step 7: Commit config and fingerprint work**

```bash
git add .env.example apps/worker/src/analyze-v2/config.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/helpers/eval-fingerprint.ts apps/worker/src/__tests__/eval-fingerprint.test.ts
git commit -m "feat(worker): gate standalone filter rollout"
```

### Task 3: Production pipeline wiring

**Files:**
- Modify: `apps/worker/src/__tests__/arc-downrank-wiring.test.ts`
- Modify: `apps/worker/src/analyze-v2/index.ts:1-20,615-675,830-925`

- [ ] **Step 1: Add failing dark-mode and live-path wiring tests**

Add this helper next to `arcDownrankOf` in `apps/worker/src/__tests__/arc-downrank-wiring.test.ts`:

```ts
const standaloneFilterOf = (telemetry: Record<string, unknown>) =>
  telemetry.standaloneFilter as
    | {
        considered: number;
        eligible: number;
        dropped: number;
        bypassedNoCleanAlternative: number;
      }
    | undefined;
```

Append these tests inside `describe("arc-downrank policy wiring", ...)` so they reuse the file's exact scanner, critic, audit, and finalizer stubs:

```ts
it("keeps behavior and telemetry dark when the standalone feature flag is off", async () => {
  const cfg = loadAnalyzeConfig({ ARC_AUDIT: "on" });
  const { client } = stubClient({
    scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
    critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.67)] },
    arc_audit: { results: [auditRow("c0", true, true, false)] },
    clip_finalizer: { clips: [shipRow("c0")] },
  });

  const result = await analyzeHighlightsV2(transcript(), { client, cfg });
  expect(result.highlights).toHaveLength(1);
  expect("standaloneFilter" in result.telemetry).toBe(false);
});

it("keeps behavior and telemetry dark when the filter is on but arc audit is off", async () => {
  const cfg = loadAnalyzeConfig({ ANALYZE_STANDALONE_FILTER_V1: "on" });
  const { client, requests } = stubClient({
    scan_candidates: { candidates: [scanCandidate(10, 14, 13)] },
    critic_verdicts: { results: [verdict("c0", 10, 14, 13, 0.67)] },
    clip_finalizer: { clips: [shipRow("c0")] },
  });

  const result = await analyzeHighlightsV2(transcript(), { client, cfg });
  expect(schemasOf(requests)).not.toContain("arc_audit");
  expect(result.highlights).toHaveLength(1);
  expect("standaloneFilter" in result.telemetry).toBe(false);
});

it("removes the measured standalone failure before the finalizer and records provenance", async () => {
  const cfg = loadAnalyzeConfig({
    ARC_AUDIT: "on",
    ANALYZE_STANDALONE_FILTER_V1: "on",
  });
  const { client, requests } = stubClient({
    scan_candidates: {
      candidates: [scanCandidate(10, 14, 13), scanCandidate(20, 24, 23)],
    },
    critic_verdicts: {
      results: [verdict("c0", 10, 14, 13, 0.82), verdict("c1", 20, 24, 23, 0.67)],
    },
    arc_audit: {
      results: [auditRow("c0", true, true, true), auditRow("c1", true, true, false)],
    },
    clip_finalizer: { clips: [shipRow("c0")] },
  });

  const result = await analyzeHighlightsV2(transcript(), { client, cfg });
  const prompt = userFor(requests, "clip_finalizer");
  expect(prompt).toContain("CLIP c0 |");
  expect(prompt).not.toContain("CLIP c1 |");
  expect(result.telemetry.selectedForFinalizer).toBe(1);
  expect(standaloneFilterOf(result.telemetry)).toEqual({
    considered: 2,
    eligible: 1,
    dropped: 1,
    bypassedNoCleanAlternative: 0,
  });
  expect(result.telemetry.droppedVerdicts).toContainEqual({
    id: "c1",
    stage: "standalone_filter",
    reason: "not_self_contained",
    score: 0.67,
  });
});

it("runs after arc downrank and counts only the candidates it receives", async () => {
  const cfg = loadAnalyzeConfig({
    ARC_AUDIT: "on",
    ARC_DOWNRANK: "on",
    ANALYZE_STANDALONE_FILTER_V1: "on",
  });
  const { client } = stubClient({
    scan_candidates: {
      candidates: [
        scanCandidate(5, 9, 8),
        scanCandidate(15, 19, 18),
        scanCandidate(25, 29, 28),
      ],
    },
    critic_verdicts: {
      results: [
        verdict("c0", 5, 9, 8, 0.82),
        verdict("c1", 15, 19, 18, 0.65),
        verdict("c2", 25, 29, 28, 0.67),
      ],
    },
    arc_audit: {
      results: [
        auditRow("c0", true, true, true),
        auditRow("c1", false, false, true),
        auditRow("c2", true, true, false),
      ],
    },
    clip_finalizer: { clips: [shipRow("c0")] },
  });

  const result = await analyzeHighlightsV2(transcript(), { client, cfg });
  expect(arcDownrankOf(result.telemetry)).toEqual({ considered: 3, penalized: 1, dropped: 1 });
  expect(standaloneFilterOf(result.telemetry)).toEqual({
    considered: 2,
    eligible: 1,
    dropped: 1,
    bypassedNoCleanAlternative: 0,
  });
  expect(result.telemetry.selectedForFinalizer).toBe(1);
});
```

- [ ] **Step 2: Run the wiring test and verify RED**

Run:

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/arc-downrank-wiring.test.ts
```

Expected: the new live-path assertions fail because `index.ts` does not yet invoke the filter or publish its telemetry.

- [ ] **Step 3: Import and invoke the filter after arc downrank**

Add this import near the other analyze-v2 stage imports in `apps/worker/src/analyze-v2/index.ts`:

```ts
import { filterStandaloneClips } from "./standalone-filter";
```

Immediately after the existing arc-downrank block and before `finalizeClips`, add:

```ts
let standaloneFilterTelemetry:
  | {
      considered: number;
      eligible: number;
      dropped: number;
      bypassedNoCleanAlternative: number;
    }
  | undefined;
let afterStandaloneFilter = afterArcDownrank;

if (cfg.standaloneFilterEnabled && cfg.arcAuditEnabled) {
  const filtered = filterStandaloneClips(
    afterArcDownrank,
    arcFlags,
    cfg.scoreThreshold,
    cfg.arcDownrankPenalty2
  );
  afterStandaloneFilter = filtered.clips;
  standaloneFilterTelemetry = filtered.telemetry;
  for (const drop of filtered.drops) {
    droppedVerdicts.push({
      id: drop.id,
      stage: "standalone_filter",
      reason: "not_self_contained",
      score: drop.score,
    });
  }
}
```

Change the third argument passed to `finalizeClips` from:

```ts
afterArcDownrank,
```

to:

```ts
afterStandaloneFilter,
```

- [ ] **Step 4: Wire exact telemetry and finalizer input count**

In the final telemetry object, change:

```ts
selectedForFinalizer: afterArcDownrank.length,
```

to:

```ts
selectedForFinalizer: afterStandaloneFilter.length,
```

After the conditional `arcDownrank` telemetry spread, add:

```ts
...(standaloneFilterTelemetry
  ? { standaloneFilter: standaloneFilterTelemetry }
  : {}),
```

Keep this telemetry key absent when either required flag is off. Do not add a zero-valued dark-stage placeholder.

- [ ] **Step 5: Run the pure, config, fingerprint, and wiring tests**

Run:

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . apps/worker/src/__tests__/standalone-filter.test.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/eval-fingerprint.test.ts apps/worker/src/__tests__/arc-downrank-wiring.test.ts
```

Expected: all four files pass. The wiring file must prove the known `0.67` shape never appears in the finalizer prompt when the clean alternative exists.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck -w @clipclap/worker
```

Expected: exit code 0.

- [ ] **Step 7: Commit production wiring**

```bash
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/arc-downrank-wiring.test.ts
git commit -m "fix(worker): filter weak standalone clips"
```

### Task 4: Engine record and complete verification

**Files:**
- Modify: `docs/engine-notes.md`
- Verify only: all files changed in Tasks 1-3

- [ ] **Step 1: Record the rule and evidence in engine notes**

Add a dated paragraph near the existing arc-downrank record in `docs/engine-notes.md`:

```markdown
**Standalone alternative filter (2026-08-28).** User feedback exposed a one-axis gap the global
arc downrank intentionally leaves inert: a `0.67` clip shipped with `standalone.ok=false` and no
entry or exit defect. A fixed-cohort retrospective simulation over 40 DONE RECALL_CRITIC jobs and
173 shipped clips found that a hard standalone gate would empty 3 jobs, while the alternative-aware
rule identifies 16 clips across 12 jobs and empties none. With `ARC_AUDIT=on` and
`ANALYZE_STANDALONE_FILTER_V1=on`, the stage runs after arc downrank and before FINALIZE. It removes
only explicit standalone failures whose `score - arcDownrankPenalty2` is strictly below
`scoreThreshold`, and only when another candidate is fully clean. Missing flags and repaired-only
flags never establish the clean alternative. Critic scores are never mutated, and the feature ships
dark pending rollout measurement.
```

- [ ] **Step 2: Run focused regression tests**

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . \
  apps/worker/src/__tests__/standalone-filter.test.ts \
  apps/worker/src/__tests__/arc-downrank-wiring.test.ts \
  apps/worker/src/__tests__/arc-audit.test.ts \
  apps/worker/src/__tests__/arc-audit-wiring.test.ts \
  apps/worker/src/__tests__/finalize.test.ts \
  apps/worker/src/__tests__/eval-fingerprint.test.ts \
  apps/worker/src/__tests__/eval-regressions.test.ts \
  apps/worker/src/__tests__/eval-variants.test.ts
```

Expected: every listed test file passes.

- [ ] **Step 3: Run the complete worker suite**

```bash
npx --yes node@22 ./node_modules/vitest/vitest.mjs run --root . apps/worker/src
```

Expected: the complete worker suite passes with zero failed tests.

- [ ] **Step 4: Run final typecheck**

```bash
npm run typecheck -w @clipclap/worker
```

Expected: exit code 0.

- [ ] **Step 5: Audit the diff and protected file boundary**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~3..HEAD
git diff HEAD~3..HEAD -- apps/worker/src/analyze-v2/standalone-filter.ts apps/worker/src/analyze-v2/config.ts apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/standalone-filter.test.ts apps/worker/src/__tests__/arc-downrank-wiring.test.ts apps/worker/src/__tests__/analyze-config.test.ts apps/worker/src/__tests__/helpers/eval-fingerprint.ts apps/worker/src/__tests__/eval-fingerprint.test.ts .env.example docs/engine-notes.md
```

Expected:

- `git diff --check` has no output.
- `apps/worker/src/tmp-audit.ts` remains untracked and is absent from every commit.
- No critic prompt, score threshold, one-flag penalty, or clip boundary logic changed.
- The feature remains off in `.env.example`; production arming is not part of this implementation.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/engine-notes.md
git commit -m "docs(worker): record standalone filter evidence"
```

- [ ] **Step 7: Review commits before integration**

```bash
git log --oneline --decorate -5
git status --short --branch
```

Expected: four implementation commits follow the approved design and plan commits, the branch is otherwise clean except for the protected untracked `apps/worker/src/tmp-audit.ts`, and nothing has been pushed or merged yet.

## Acceptance checklist

- [ ] Known feedback shape `0.67 - 0.15 < 0.60` is removed when a fully clean alternative exists.
- [ ] A standalone failure remains when there is no fully clean alternative.
- [ ] The stage cannot empty its input set.
- [ ] Missing flags are neither failures nor clean alternatives.
- [ ] Repaired-only audit history does not count as fully clean.
- [ ] Entry-only and exit-only failures are unchanged.
- [ ] Equality at the threshold survives because the comparison is strict `<`.
- [ ] Candidate order, object identity, and critic scores are preserved.
- [ ] `standaloneFilter` telemetry is exact when live and absent when dark.
- [ ] `droppedVerdicts` uses `stage: "standalone_filter"`, `reason: "not_self_contained"`, and the original score.
- [ ] `selectedForFinalizer` counts the exact array passed to `finalizeClips`.
- [ ] Eval fingerprint changes when `standaloneFilterEnabled` changes.
- [ ] Focused tests, full worker tests, and worker typecheck pass under Node.js 22.
- [ ] Production flag remains off until a separate rollout decision.
