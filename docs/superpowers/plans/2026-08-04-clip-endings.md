# Clip Endings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping clips that end the instant the payoff line finishes, by adding a narrow, code-gated pass that can move a clip's end FORWARD to a stronger beat inside the same scene.

**Architecture:** A new stage between `selectAndOrder` and `finalizeClips`. It asks one focused model question per shipped clip - "does a stronger beat land in the next N seconds of this scene, and if so which node ends the clip" - and every answer goes back through `snapNodes`, so boundaries stay code-owned. Two new deterministic modules carry the mechanism: `scene-gaps.ts` finds where the source cuts to a different scene, and `end-extension.ts` holds the gates that decide whether a proposal is legal. The critic prompt is NOT touched, which is what keeps all four eval fixtures replayable.

**Tech Stack:** TypeScript, vitest, the existing `callJsonSchema` wrapper, the existing eval fixture harness (`eval-topup.ts`, `eval-bless.ts`).

---

## Why this shape - read before starting

Design source: [`docs/superpowers/specs/2026-08-04-clip-quality-programme-design.md`](../specs/2026-08-04-clip-quality-programme-design.md) §3.2 and §5 project 1.

Four measurements bound this work. They were taken on 2026-08-04 against the `sitcom-friends` fixture and none of them should be re-derived:

**The tail is not the problem, and raising the cap does nothing.** Shipped tail after the payoff is **0.3s on 9 of 12 clips** - that is exactly `tailHoldSec`. Median 0.3s, max 1.8s. `payoffMaxTailSec` is 4 and **0 of 12 clips reach it**. `snapNodes` only ever pulls an end BACK past that cap (`snap.ts:63-68`); it has no forward move. So the cap never fired, and changing it cannot help.

**The critic sets `end_node` to `payoff_node`.** The clip stops when the payoff line stops. That is snap behaving correctly on the input it was given.

**The real defect is that `payoff_node` is chosen early.** On the eyelash-curler clip the engine ends on *"Yes, that would have made more sense"* at 1433.3, and the line all three scouts named as the payoff - *"Were you, or were you not, on a gay cruise?"* - lands at 1446.7, **13 seconds later**. `prompts.ts:118-122` already instructs the critic to chase a sharper beat within ~10s. It does not fire, and it is buried in a prompt that also judges six candidates at once. `engine-notes.md` §5a measured a rule in that prompt firing **zero times** across both fixtures while the defect it names sat in the output. Do not attempt to fix this by editing that prompt.

**There is no laugh-track signal to lean on.** A probe was written and run: the longest word-free stretches follow lines like *"I don't know what to"* and *"Obviously"*, not punchlines. The hypothesis is dead - do not revive it. What the probe DID find is that long holes between nodes are **scene cuts** (verified: a 19s hole at 1367.9 separates *"Let's go"* from *"Damn Rolos. Hey, you're back, how was your conference?"*, an unrelated scene). That is the safety rail this plan uses.

**Why a new call rather than a prompt change.** Fixture replay is keyed on `sha256(model, system, user)`. Editing the critic prompt invalidates every recorded response in all four fixtures at once, destroying the regression net exactly when it is needed. A NEW call adds new keys and leaves existing ones untouched, and `eval-topup.ts` exists precisely to record only the absent keys while treating present ones as immutable.

**Why it runs after selection.** Only clips that will actually ship are worth an extra call, and `selectAndOrder` is the first point where that set is known.

**One deliberate departure from the spec.** §5 project 1 says "give FINALIZE a verb that extends". This plan builds a separate stage instead. The measurement above is the reason: FINALIZE receives a set and judges it as a set - dedup, veto, trim, title rewrite - and adding a fifth concern to a prompt already carrying four is the exact shape that produced a rule firing zero times (`engine-notes.md` §5a). A separate call asks one question about one clip. The spec's intent - that an end can move forward, gated by code - is met; the housing is different and better.

**Why extension cannot break copy.** Extending an end only ADDS nodes to the range. `titleEvidenceNodes` already inside `[finalStartNode, finalEndNode]` stay inside a widened range, so no `regroundCopy` re-run is needed. Shortening would break this - which is why this stage may only ever move an end forward.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/worker/src/analyze-v2/scene-gaps.ts` (create) | Where the source cuts to a different scene. Pure, no model. |
| `apps/worker/src/analyze-v2/end-extension.ts` (create) | The extension window, the legality gates, and the model call. |
| `apps/worker/src/analyze-v2/config.ts` (modify) | Three knobs + killswitch. |
| `apps/worker/src/analyze-v2/schemas.ts` (modify) | `END_EXTENSION_SCHEMA`. |
| `apps/worker/src/analyze-v2/index.ts` (modify) | Wire the stage between select and finalize; telemetry. |
| `apps/worker/src/__tests__/scene-gaps.test.ts` (create) | Boundary detection. |
| `apps/worker/src/__tests__/end-extension.test.ts` (create) | Gates: every illegal proposal is refused. |
| `apps/worker/src/scripts/eval-end-audit.ts` (exists) | Already committed. Re-run to measure the change. |

---

### Task 1: Scene boundaries

**Files:**
- Create: `apps/worker/src/analyze-v2/scene-gaps.ts`
- Test: `apps/worker/src/__tests__/scene-gaps.test.ts`
- Modify: `apps/worker/src/analyze-v2/config.ts`

- [ ] **Step 1: Measure the gap threshold before choosing it**

Do not hardcode a number from this plan. Run the existing probe on all four fixtures and read the distribution:

```bash
for f in sitcom-friends creator-challenge podcast-ecology podcast-answer-arc; do
  docker compose exec -T worker-analyze sh -c \
    "cd /app/apps/worker && npx tsx src/scripts/eval-laugh-probe.ts $f" | tail -20
done
```

On `sitcom-friends` the word-bearing gap distribution was median 0.76s, p90 4.16s, p99 12.30s, max 19.04s. Pick `sceneGapSec` so it sits above p99 of the podcast fixtures (which have no scene cuts and must produce **zero** boundaries) and below the compilation's obvious cuts. Record the number you picked and the numbers you picked it from in the commit message.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { sceneEndAfter } from "../analyze-v2/scene-gaps";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { SentenceNode } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8" });

/** Nodes 2s long, back to back, with an optional silent hole before one of them. */
function nodesWithHole(count: number, holeBefore?: number, holeSec = 12): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === holeBefore) t += holeSec;
    out.push({
      index: i,
      start: t,
      end: t + 2,
      text: `line ${i}`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += 2;
  }
  return out;
}

describe("sceneEndAfter", () => {
  it("returns the last node before the next hole", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6), 2, cfg)).toBe(5);
  });

  it("returns the last node when no hole follows", () => {
    expect(sceneEndAfter(nodesWithHole(10), 2, cfg)).toBe(9);
  });

  it("ignores a hole that is already behind the start index", () => {
    expect(sceneEndAfter(nodesWithHole(10, 3), 5, cfg)).toBe(9);
  });

  it("does not fire on a gap below the threshold", () => {
    expect(sceneEndAfter(nodesWithHole(10, 6, 4), 2, cfg)).toBe(9);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src/__tests__/scene-gaps.test.ts"`
Expected: FAIL - `Failed to resolve import "../analyze-v2/scene-gaps"`.

- [ ] **Step 4: Add the config knob**

In `apps/worker/src/analyze-v2/config.ts`, add to the `AnalyzeConfig` interface next to the other boundary knobs:

```typescript
  /** A silent hole this long or longer between consecutive nodes is a cut to a
   *  different scene. Measured, not guessed: see the plan's Task 1 step 1. */
  sceneGapSec: number;
```

and to `loadAnalyzeConfig`, next to `payoffMaxTailSec`:

```typescript
    sceneGapSec: num(env, "SCENE_GAP_SEC", 8),
```

Replace `8` with the number you measured in step 1.

- [ ] **Step 5: Implement**

```typescript
import type { AnalyzeConfig } from "./config";
import type { SentenceNode } from "./types";

/**
 * The last node before the source cuts to a different scene.
 *
 * A clip may never be extended across one of these. On a compilation reel - and
 * the first real one arrived on 2026-08-03 - the next scene is unrelated
 * material with different people in it, so an extension that crosses a cut does
 * not lengthen a moment, it staples two moments together.
 *
 * The signal is a silent hole in the timeline, which is what a hard cut leaves
 * behind: consecutive nodes normally abut (median gap 0.76s on the sitcom
 * fixture) while a cut leaves 12-19s of nothing. Podcasts have no such holes,
 * so this returns the end of the graph there and the guard is inert - which is
 * the correct behaviour, not a limitation.
 */
export function sceneEndAfter(
  nodes: SentenceNode[],
  fromIdx: number,
  cfg: AnalyzeConfig
): number {
  for (let i = fromIdx + 1; i < nodes.length; i++) {
    if (nodes[i].start - nodes[i - 1].end >= cfg.sceneGapSec) return i - 1;
  }
  return nodes.length - 1;
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src/__tests__/scene-gaps.test.ts"`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/analyze-v2/scene-gaps.ts apps/worker/src/analyze-v2/config.ts apps/worker/src/__tests__/scene-gaps.test.ts
git commit -m "feat(analyze): find where the source cuts to a different scene"
```

---

### Task 2: The extension gates

**Files:**
- Create: `apps/worker/src/analyze-v2/end-extension.ts`
- Test: `apps/worker/src/__tests__/end-extension.test.ts`
- Modify: `apps/worker/src/analyze-v2/config.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { applyExtension, extensionWindow } from "../analyze-v2/end-extension";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({ SCENE_GAP_SEC: "8", END_EXTENSION_WINDOW_SEC: "25" });

function nodes(count: number, holeBefore?: number): SentenceNode[] {
  const out: SentenceNode[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i === holeBefore) t += 12;
    out.push({
      index: i,
      start: t,
      end: t + 2,
      text: `line ${i}.`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
    t += 2;
  }
  return out;
}

function verdict(): CriticVerdict {
  return {
    id: "c0", keep: true, score: 0.8, grounded: true, selfContained: true,
    startNode: 2, payoffNode: 5, endNode: 5, hookStartNode: 3, hookEndNode: 5,
    title: "t", description: "d", titleEvidenceNodes: [4],
    descriptionEvidenceNodes: [4], language: "en",
  };
}

function clip(n: SentenceNode[]): SnappedClip {
  return {
    verdict: verdict(),
    startSec: n[2].start, endSec: n[5].end,
    finalStartNode: 2, finalEndNode: 5,
    hookStartSec: n[3].start, hookEndSec: n[5].end,
    payoffSec: n[5].end, shortMoment: false,
  };
}

describe("extensionWindow", () => {
  it("stops at the scene boundary even when the time window reaches further", () => {
    const n = nodes(20, 8);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(7);
  });

  it("stops at the time window when no scene boundary intervenes", () => {
    const n = nodes(40);
    const w = extensionWindow(clip(n), n, cfg);
    expect(n[w.lastNode].end - n[5].end).toBeLessThanOrEqual(25);
    expect(w.lastNode).toBeGreaterThan(5);
  });

  it("is empty when the clip already ends at the scene boundary", () => {
    const n = nodes(20, 6);
    expect(extensionWindow(clip(n), n, cfg).lastNode).toBe(5);
  });
});

describe("applyExtension", () => {
  it("accepts a legal forward move and returns the widened clip", () => {
    const n = nodes(40);
    const out = applyExtension(clip(n), n, 8, cfg);
    expect(out).not.toBeNull();
    expect(out!.finalEndNode).toBe(8);
    expect(out!.endSec).toBeGreaterThan(n[5].end);
  });

  it("refuses a move that shortens the clip", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 4, cfg)).toBeNull();
  });

  it("refuses a no-op", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 5, cfg)).toBeNull();
  });

  it("refuses a move across a scene boundary", () => {
    const n = nodes(20, 8);
    expect(applyExtension(clip(n), n, 10, cfg)).toBeNull();
  });

  it("refuses a move that would push the clip past maxSec", () => {
    const n = nodes(200);
    expect(applyExtension(clip(n), n, 120, cfg)).toBeNull();
  });

  it("refuses an index outside the graph", () => {
    const n = nodes(40);
    expect(applyExtension(clip(n), n, 999, cfg)).toBeNull();
  });

  it("keeps the payoff, hook and start untouched", () => {
    const n = nodes(40);
    const before = clip(n);
    const out = applyExtension(before, n, 8, cfg)!;
    expect(out.startSec).toBe(before.startSec);
    expect(out.payoffSec).toBe(before.payoffSec);
    expect(out.hookStartSec).toBe(before.hookStartSec);
    expect(out.finalStartNode).toBe(before.finalStartNode);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src/__tests__/end-extension.test.ts"`
Expected: FAIL - cannot resolve `../analyze-v2/end-extension`.

- [ ] **Step 3: Add the remaining config knobs**

In `apps/worker/src/analyze-v2/config.ts` interface:

```typescript
  /** Master switch for the end-extension stage. Off until measured. */
  endExtensionEnabled: boolean;
  /** How far past the current end the stage may look, in seconds. */
  endExtensionWindowSec: number;
```

In `loadAnalyzeConfig`:

```typescript
    // Exact literal "on", the same discipline as REFRAME_STREAM: a stage that
    // moves boundaries must not be switched on by a stray truthy value.
    endExtensionEnabled: env.END_EXTENSION === "on",
    endExtensionWindowSec: num(env, "END_EXTENSION_WINDOW_SEC", 25),
```

- [ ] **Step 4: Implement the pure half**

```typescript
import type { AnalyzeConfig } from "./config";
import { isCleanEnd } from "./sentence-graph";
import { sceneEndAfter } from "./scene-gaps";
import type { SentenceNode, SnappedClip } from "./types";

export interface ExtensionWindow {
  /** Highest node index this clip may legally be extended to. Equals the clip's
   *  own end when no extension is possible. */
  lastNode: number;
}

/**
 * How far this clip is allowed to reach. The tighter of two bounds:
 * the next scene cut, and endExtensionWindowSec of wall clock.
 */
export function extensionWindow(
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): ExtensionWindow {
  const from = clip.finalEndNode;
  const sceneEnd = sceneEndAfter(nodes, from, cfg);
  const deadline = nodes[from].end + cfg.endExtensionWindowSec;
  let last = from;
  for (let i = from + 1; i <= sceneEnd; i++) {
    if (nodes[i].end > deadline) break;
    last = i;
  }
  return { lastNode: last };
}

/**
 * Applies a proposed end node, or refuses it.
 *
 * Refusal is the default and returns null. This stage may only ever move an end
 * FORWARD: shortening is the finalizer's `trim`, which has its own gates, and
 * more importantly a shorter range can push titleEvidenceNodes outside the clip
 * and silently degrade copy (engine-notes 6, the `Плюсы` defect). Widening
 * cannot, which is the whole reason this stage is safe to run after copy has
 * been grounded.
 */
export function applyExtension(
  clip: SnappedClip,
  nodes: SentenceNode[],
  proposedEndNode: number,
  cfg: AnalyzeConfig
): SnappedClip | null {
  if (!Number.isInteger(proposedEndNode)) return null;
  if (proposedEndNode <= clip.finalEndNode) return null;
  if (proposedEndNode > nodes.length - 1) return null;

  const { lastNode } = extensionWindow(clip, nodes, cfg);
  if (proposedEndNode > lastNode) return null;

  const e = nodes[proposedEndNode];
  if (!e.hasWords) return null;
  if (!isCleanEnd(nodes, proposedEndNode)) return null;

  const next = proposedEndNode < nodes.length - 1 ? nodes[proposedEndNode + 1] : null;
  let endSec = Math.min(e.end + cfg.tailHoldSec, next ? next.start : Infinity);
  endSec = Math.max(endSec, e.end);
  if (endSec - clip.startSec > cfg.maxSec) return null;

  return { ...clip, endSec, finalEndNode: proposedEndNode };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src/__tests__/end-extension.test.ts"`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/analyze-v2/end-extension.ts apps/worker/src/analyze-v2/config.ts apps/worker/src/__tests__/end-extension.test.ts
git commit -m "feat(analyze): gates for moving a clip end forward"
```

---

### Task 3: The model call

**Files:**
- Modify: `apps/worker/src/analyze-v2/schemas.ts`
- Modify: `apps/worker/src/analyze-v2/end-extension.ts`
- Test: `apps/worker/src/__tests__/end-extension.test.ts`

- [ ] **Step 1: Add the schema**

Append to `apps/worker/src/analyze-v2/schemas.ts`:

```typescript
/** One row per clip offered to the end-extension pass. `end_node` is a PROPOSAL
 *  and changes nothing until applyExtension accepts it. */
export const END_EXTENSION_SCHEMA = {
  name: "end_extension",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "extend", "end_node", "reason"],
          properties: {
            id: { type: "string" },
            extend: { type: "boolean" },
            end_node: { type: "integer" },
            reason: { type: "string" },
          },
        },
      },
    },
  },
} as const;
```

- [ ] **Step 2: Write the failing test for the prompt builder**

Append to `apps/worker/src/__tests__/end-extension.test.ts`:

```typescript
import { buildExtensionUser } from "../analyze-v2/end-extension";

describe("buildExtensionUser", () => {
  it("shows the clip's own text and the candidate nodes with indices", () => {
    const n = nodes(40);
    const user = buildExtensionUser(clip(n), n, cfg);
    expect(user).toContain("CLIP c0");
    expect(user).toContain("#5");
    expect(user).toContain("#6");
    expect(user).toContain("line 6.");
  });

  it("never shows a node beyond the legal window", () => {
    const n = nodes(20, 8);
    const user = buildExtensionUser(clip(n), n, cfg);
    expect(user).toContain("#7");
    expect(user).not.toContain("#8");
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src/__tests__/end-extension.test.ts"`
Expected: FAIL - `buildExtensionUser` is not exported.

- [ ] **Step 4: Implement the prompt and the call**

First add these to the **imports at the top** of `apps/worker/src/analyze-v2/end-extension.ts`, alongside the ones Task 2 put there - `LlmUsage` lives in `./types`, not `./llm`:

```typescript
import OpenAI from "openai";
import { callJsonSchema, logModelFallback } from "./llm";
import { END_EXTENSION_SCHEMA } from "./schemas";
import type { LlmUsage } from "./types";
```

Then append the rest to the end of the file:

```typescript
export const EXTENSION_SYSTEM = `You decide where a short video clip should END.

You are given a clip that already works: its setup and its payoff are inside it.
Your only question is whether the moment KEEPS GOING - whether a stronger beat
lands in the lines immediately after the current end.

Extend when the lines after the end contain:
- the reaction to the payoff (the comeback, the shock, the escalation)
- a second, harder beat that tops the one the clip currently ends on
- the answer to a question the clip ends on

Do NOT extend when the lines after the end are:
- a new subject, a goodbye, or the conversation winding down
- more of the same with nothing added
- anything that would make a viewer check how much is left

Extending a good clip into a flat one is worse than leaving it short. When the
following lines add nothing, say extend: false. That is the common answer.

Answer with node indices only, chosen from the CANDIDATE list you are shown -
never a timestamp, never an index you were not offered.

For each clip: id, extend, end_node (the LAST node to include; echo the current
end when extend is false), and reason - one short clause naming the beat you are
reaching for, or why nothing was worth reaching for.

Output ONLY the JSON object described by the schema.`;

/** The clip's own speech, then the numbered lines it may reach into. */
export function buildExtensionUser(
  clip: SnappedClip,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): string {
  const { lastNode } = extensionWindow(clip, nodes, cfg);
  const own = nodes
    .slice(clip.finalStartNode, clip.finalEndNode + 1)
    .filter((n) => n.hasWords)
    .map((n) => n.text.trim())
    .join(" ");
  const lines = [
    `CLIP ${clip.verdict.id} - currently ends at node #${clip.finalEndNode}`,
    `WHAT IT CONTAINS: ${own}`,
    "",
    "CANDIDATE ENDINGS (you may choose any of these, or keep the current end):",
    `  #${clip.finalEndNode} <current end> ${nodes[clip.finalEndNode].text.trim()}`,
  ];
  for (let i = clip.finalEndNode + 1; i <= lastNode; i++) {
    lines.push(`  #${i} ${nodes[i].text.trim()}`);
  }
  if (lastNode === clip.finalEndNode) {
    lines.push("  (nothing follows inside this scene - answer extend: false)");
  }
  return lines.join("\n");
}

export interface ExtensionTelemetry {
  offered: number;
  proposed: number;
  applied: number;
  refused: number;
  secondsGained: number;
  fallbackModelUsed: boolean;
}

/**
 * NEVER throws. This stage improves clips that are already shippable, so any
 * failure - refusal, truncation, outage - ships the input set unchanged. The
 * same discipline as finalizeClips, and for the same reason (billing invariant,
 * engine-notes 6).
 */
export async function extendClipEnds(
  client: OpenAI,
  usage: LlmUsage,
  clips: SnappedClip[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig,
  options: { retryDelayMs?: number } = {}
): Promise<{ clips: SnappedClip[]; telemetry: ExtensionTelemetry }> {
  const telemetry: ExtensionTelemetry = {
    offered: 0, proposed: 0, applied: 0, refused: 0,
    secondsGained: 0, fallbackModelUsed: false,
  };
  if (!cfg.endExtensionEnabled || clips.length === 0) {
    return { clips, telemetry };
  }

  const offered = clips.filter(
    (c) => extensionWindow(c, nodes, cfg).lastNode > c.finalEndNode
  );
  telemetry.offered = offered.length;
  if (offered.length === 0) return { clips, telemetry };

  const user = offered.map((c) => buildExtensionUser(c, nodes, cfg)).join("\n\n---\n\n");

  let result = await callJsonSchema<{
    results?: Array<{ id?: string; extend?: boolean; end_node?: number }>;
  }>(client, usage, {
    model: cfg.criticModel,
    system: EXTENSION_SYSTEM,
    user,
    schema: END_EXTENSION_SCHEMA,
    reasoningEffort: cfg.reasoningEffort,
    maxOutputTokens: 400 + 200 * offered.length,
    retryDelayMs: options.retryDelayMs,
  });

  if (!result.ok && result.kind === "error") {
    logModelFallback("end-extension", cfg.criticModel, cfg.criticModelFallback);
    telemetry.fallbackModelUsed = true;
    result = await callJsonSchema(client, usage, {
      model: cfg.criticModelFallback,
      system: EXTENSION_SYSTEM,
      user,
      schema: END_EXTENSION_SCHEMA,
      reasoningEffort: cfg.reasoningEffort,
      maxOutputTokens: 400 + 200 * offered.length,
      retryDelayMs: options.retryDelayMs,
    });
  }
  if (!result.ok) return { clips, telemetry };

  const byId = new Map<string, number>();
  for (const row of result.data.results ?? []) {
    if (!row || typeof row.id !== "string") continue;
    if (row.extend !== true || typeof row.end_node !== "number") continue;
    byId.set(row.id, row.end_node);
  }
  telemetry.proposed = byId.size;

  const out = clips.map((c) => {
    const proposed = byId.get(c.verdict.id);
    if (proposed === undefined) return c;
    const extended = applyExtension(c, nodes, proposed, cfg);
    if (!extended) {
      telemetry.refused += 1;
      return c;
    }
    telemetry.applied += 1;
    telemetry.secondsGained += extended.endSec - c.endSec;
    return extended;
  });

  return { clips: out, telemetry };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src/__tests__/end-extension.test.ts"`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/analyze-v2/end-extension.ts apps/worker/src/analyze-v2/schemas.ts apps/worker/src/__tests__/end-extension.test.ts
git commit -m "feat(analyze): ask one focused question about where a clip should end"
```

---

### Task 4: Wire it in

**Files:**
- Modify: `apps/worker/src/analyze-v2/index.ts`

- [ ] **Step 1: Insert the stage between selection and finalize**

In `apps/worker/src/analyze-v2/index.ts`, immediately before the `const finalized = await finalizeClips(` call at line ~350, add:

```typescript
  // Ends move FORWARD here and nowhere else, and only for clips that will ship.
  // Before the finalizer on purpose: the finalizer is the stage that trims, and
  // it must get the last word on a boundary. Widening cannot invalidate copy -
  // evidence already inside the range stays inside a larger one - so this needs
  // no regroundCopy re-run, which is exactly why it is safe here and would not
  // be if it could shorten.
  const extension = await extendClipEnds(
    client,
    usage,
    selection.selected,
    nodes,
    cfg,
    { retryDelayMs: options.retryDelayMs }
  );
```

and change the `finalizeClips` argument from `selection.selected` to `extension.clips`.

- [ ] **Step 2: Import it**

Add near the other analyze-v2 imports at the top of `index.ts`:

```typescript
import { extendClipEnds } from "./end-extension";
```

- [ ] **Step 3: Publish the telemetry**

Find the object literal the function returns as `telemetry` and add:

```typescript
    endExtension: extension.telemetry,
```

- [ ] **Step 4: Run the whole worker suite**

Run: `docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src"`
Expected: PASS. The eval fixtures still replay because `endExtensionEnabled` is false by default, so the stage makes no call and no request key changes.

If any eval test fails here, STOP - the default-off path is leaking a call, and that must be fixed before going further.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/index.ts
git commit -m "feat(analyze): run end-extension between selection and finalize, default off"
```

---

### Task 5: Record and measure

**Files:**
- Modify: `apps/worker/src/__tests__/fixtures/eval/*/responses.json` (via the topup script)

- [ ] **Step 1: Record the new call on all four fixtures**

The stage is off by default, so it must be switched on for the recording:

```bash
docker compose exec -T -e END_EXTENSION=on worker-analyze sh -c \
  "cd /app/apps/worker && npx tsx src/scripts/eval-topup.ts sitcom-friends creator-challenge podcast-ecology podcast-answer-arc"
```

Existing recordings are immutable; only the absent keys are requested.

- [ ] **Step 2: Measure the change on the sitcom fixture**

```bash
docker compose exec -T -e END_EXTENSION=on worker-analyze sh -c \
  "cd /app/apps/worker && npx tsx src/scripts/eval-end-audit.ts sitcom-friends"
```

Compare against the recorded baseline of 2026-08-04: tail after payoff median 0.3s, max 1.8s, 0/12 at the cap.

**The acceptance criterion is the scout consensus, not the tail.** These five clips must move toward these ends on at least three of them:

| clip start | shipped end today | scout consensus end |
|---|---|---|
| 175.1 | 190.6 | 217.3 |
| 636.9 | 658.0 | 682.0 |
| 1413.3 | 1433.3 | 1450.7 |
| 2148.0 | 2167.2 | 2175.5 |
| 0.0 | 28.8 | 83.4 |

- [ ] **Step 3: Check the podcasts did not regress**

```bash
docker compose exec -T -e END_EXTENSION=on worker-analyze sh -c \
  "cd /app/apps/worker && ../../node_modules/.bin/vitest run --root ../.. apps/worker/src"
```

Then read the snapshot diff. A podcast has no scene cuts, so `sceneEndAfter` returns the end of the graph and the time window alone bounds the reach - the stage CAN fire there. Judge each moved podcast end on its own merits; do not accept "the snapshot moved" as either pass or fail without reading what moved.

- [ ] **Step 4: Bless the new snapshots once the diff has been read**

```bash
docker compose exec -T worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts"
```

- [ ] **Step 5: Re-render and re-judge**

```bash
docker compose exec -T worker-analyze sh -c \
  "cd /app/apps/worker && npx tsx src/scripts/eval-render-set.ts sitcom-friends cmscht6rp001xq41s5rhjx6q0 cmp1apxno0000eeug8to69vi0"
```

Then re-run the `clip-viewer` and `clip-editor` agents over the new render, exactly as on 2026-08-04, and compare against that baseline: **zero `publish`, four `publish after one fix`, eight `bin it`, mean viewer score 3.2/10.** The delta on identical material is the evidence; the absolute score is not.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/__tests__/fixtures/eval
git commit -m "test(analyze): record the end-extension call and re-bless the snapshots"
```

---

### Task 6: Write down what was measured

**Files:**
- Modify: `docs/engine-notes.md`

- [ ] **Step 1: Add a section to `docs/engine-notes.md`**

Add under §3, in the file's own voice - what IS true, with the numbers it was measured from. It must state: the pre-change tail distribution (0.3s median, 0/12 at the 4s cap), the `sceneGapSec` value and the distribution it came from, how many of the five acceptance clips moved, what the agents scored before and after, and whether the podcast fixtures moved.

If a claim in §6a about the punchline-outside case is now false, delete it - the file's own rule is that a stale note is worse than none.

- [ ] **Step 2: Commit**

```bash
git add docs/engine-notes.md
git commit -m "docs(engine): what end-extension changed, measured"
```

---

## Rollout

`END_EXTENSION=on` in `.env`, then `docker compose up -d` - **not** `restart`, which ignores `env_file`. Re-run `prisma generate` per container if compose recreated anything.

Kill switch: remove the line and `up -d` again.
