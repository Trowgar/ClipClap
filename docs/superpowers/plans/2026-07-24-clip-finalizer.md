# Clip Finalizer + Regression Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a replay-based regression harness for the ANALYZE engine, then add a teaser-montage filter, a question-title surcharge, and a FINALIZE step that dedups, salvages and vetoes clips as a set - per `docs/superpowers/specs/2026-07-24-clip-finalizer-design.md`.

**Architecture:** The engine's only non-determinism is two LLM calls. Record them keyed by request hash, replay them through a stub client, and every deterministic layer becomes exactly testable at zero cost. The harness lands FIRST and green, becoming the baseline. Each feature then lands TDD-style: its named regression test is written failing, then made to pass, and the Tier-2 snapshot diff is the review gate.

**Tech Stack:** TypeScript, vitest, OpenAI SDK (stubbed in tests), Prisma (read-only, for fixture recording).

**Environment notes (read first):**
- Host Node is v18 and cannot run vitest. ALL tests/typechecks run INSIDE containers.
- Tests: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/<file>"`
- Full suite: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"` (baseline at plan start: **207 passed**)
- Typecheck: `docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"`
- Commits: identity `Trowgar <trowgar@yahoo.com>`, NO attribution trailer, plain hyphens in messages.
- Do NOT touch `apps/web/lib/auth.ts` or `apps/web/lib/telegram-provider.ts` (owner's uncommitted WIP). Commit only files listed in your task.
- Fixtures contain real transcripts of the owner's own videos. They live in git (they are the regression net) but must never be logged or printed wholesale in test output.

---

### Task 1: Replay stub client

**Files:**
- Create: `apps/worker/src/__tests__/helpers/replay-client.ts`
- Test: `apps/worker/src/__tests__/replay-client.test.ts`

**Context:** `callJsonSchema` in `analyze-v2/llm.ts` calls `client.chat.completions.create(body)` and reads `choices[0].message.content` (a JSON string), `choices[0].finish_reason`, `choices[0].message.refusal`, and `usage`. The scanner runs windows through `mapWithConcurrency(limit 5)`, so responses arrive out of order - replay MUST key on the request, never on call order.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/replay-client.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { requestKey, createReplayClient } from "./helpers/replay-client";

describe("requestKey", () => {
  it("is stable for the same model/system/user and differs otherwise", () => {
    const a = requestKey({ model: "m", system: "s", user: "u" });
    expect(requestKey({ model: "m", system: "s", user: "u" })).toBe(a);
    expect(requestKey({ model: "m", system: "s", user: "u2" })).not.toBe(a);
    expect(requestKey({ model: "m2", system: "s", user: "u" })).not.toBe(a);
  });
});

describe("createReplayClient", () => {
  const key = requestKey({ model: "m", system: "s", user: "u" });
  const call = (client: ReturnType<typeof createReplayClient>) =>
    (client as unknown as {
      chat: { completions: { create: (b: unknown) => Promise<unknown> } };
    }).chat.completions.create({
      model: "m",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
    });

  it("returns the recorded response regardless of call order", async () => {
    const client = createReplayClient({ [key]: '{"hello":1}' });
    const res = (await call(client)) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(JSON.parse(res.choices[0].message.content)).toEqual({ hello: 1 });
    expect(res.choices[0].finish_reason).toBe("stop");
  });

  it("throws a diagnosable error on an unrecorded request", async () => {
    const client = createReplayClient({});
    await expect(call(client)).rejects.toThrow(/unrecorded request/i);
  });

  it("records every request it served", async () => {
    const client = createReplayClient({ [key]: "{}" });
    await call(client);
    expect(client.served).toEqual([key]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/replay-client.test.ts"`
Expected: FAIL - cannot resolve `./helpers/replay-client`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/__tests__/helpers/replay-client.ts`:

```typescript
import { createHash } from "crypto";
import type OpenAI from "openai";

export interface RequestShape {
  model: string;
  system: string;
  user: string;
}

/** Order-independent identity of an LLM request. The scanner runs windows
 *  concurrently, so replay can never rely on call order. A prompt edit changes
 *  the key on purpose: stale recordings must fail loudly, not silently pass. */
export function requestKey(req: RequestShape): string {
  return createHash("sha256")
    .update(`${req.model}\0${req.system}\0${req.user}`)
    .digest("hex")
    .slice(0, 16);
}

export interface ReplayClient {
  served: string[];
  missing: string[];
}

/** Minimal stand-in for the OpenAI client covering exactly what
 *  callJsonSchema uses. Responses are raw JSON strings, as the API returns. */
export function createReplayClient(
  responses: Record<string, string>,
  options: { onMissing?: (key: string, req: RequestShape) => string | undefined } = {}
): OpenAI & ReplayClient {
  const served: string[] = [];
  const missing: string[] = [];
  const create = async (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }) => {
    const req: RequestShape = {
      model: body.model,
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    };
    const key = requestKey(req);
    const recorded = responses[key] ?? options.onMissing?.(key, req);
    if (recorded === undefined) {
      missing.push(key);
      throw new Error(
        `replay: unrecorded request ${key} (model=${req.model}, user starts "${req.user.slice(0, 60)}")`
      );
    }
    served.push(key);
    return {
      choices: [{ message: { content: recorded, refusal: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
  };
  return {
    served,
    missing,
    chat: { completions: { create } },
  } as unknown as OpenAI & ReplayClient;
}
```

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/__tests__/helpers/replay-client.ts apps/worker/src/__tests__/replay-client.test.ts
git commit -m "test(analyze): replay client keyed by request hash"
```

---

### Task 2: Fixture loader and shape snapshot

**Files:**
- Create: `apps/worker/src/__tests__/helpers/eval-fixture.ts`
- Test: `apps/worker/src/__tests__/eval-fixture.test.ts`

**Context:** A fixture directory holds `transcript.json`, `responses.json` (the request-key map for ALL recorded calls), and `snapshot.json` (the Tier-2 shape). The loader reads a fixture, runs `analyzeHighlightsV2` against the replay client, and reduces the result to a comparable shape.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/eval-fixture.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { toShape } from "./helpers/eval-fixture";
import type { V2Result } from "../analyze-v2/types";

describe("toShape", () => {
  it("reduces a result to a stable comparable shape", () => {
    const result = {
      highlights: [
        {
          start: 12.34567,
          end: 45.6789,
          title: "T",
          description: "D",
          score: 0.83,
          hookStart: 13,
          hookEnd: 15,
          payoffAt: 44,
          language: "ru",
          lowQuality: false,
          shortMoment: false,
        },
      ],
      telemetry: { tier: "strong", gateDropReasons: { no_clean_end: 2 }, kept: 1 },
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    } as unknown as V2Result;
    expect(toShape(result)).toEqual({
      count: 1,
      tier: "strong",
      clips: [{ range: "12.3-45.7", score: 0.83, title: "T" }],
      dropReasons: { no_clean_end: 2 },
    });
  });

  it("reports an empty result without throwing", () => {
    const result = {
      highlights: [],
      noClipsReason: "NO_VIABLE_MOMENTS",
      telemetry: {},
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    } as unknown as V2Result;
    expect(toShape(result)).toEqual({
      count: 0,
      tier: null,
      clips: [],
      dropReasons: {},
      noClipsReason: "NO_VIABLE_MOMENTS",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/eval-fixture.test.ts"`
Expected: FAIL - cannot resolve `./helpers/eval-fixture`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/__tests__/helpers/eval-fixture.ts`:

```typescript
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { TranscriptionResult } from "@clipclap/shared";
import { analyzeHighlightsV2 } from "../../analyze-v2";
import { loadAnalyzeConfig, type AnalyzeConfig } from "../../analyze-v2/config";
import type { V2Result } from "../../analyze-v2/types";
import { createReplayClient } from "./replay-client";

export const FIXTURES_DIR = join(__dirname, "..", "fixtures", "eval");

export interface EvalShape {
  count: number;
  tier: string | null;
  clips: Array<{ range: string; score: number; title: string }>;
  dropReasons: Record<string, number>;
  noClipsReason?: string;
}

/** Stable, human-readable reduction of an engine run. Ranges are rounded to
 *  0.1s: below that, floating-point noise would make the snapshot flaky. */
export function toShape(result: V2Result): EvalShape {
  const t = result.telemetry as Record<string, unknown>;
  const shape: EvalShape = {
    count: result.highlights.length,
    tier: (t.tier as string) ?? null,
    clips: result.highlights.map((h) => ({
      range: `${h.start.toFixed(1)}-${h.end.toFixed(1)}`,
      // Highlight.score is optional in the shared types (V1 JSON compatibility),
      // so it must be defaulted: undefined would vanish from snapshot.json,
      // while 0 shows up as a visible diff if scoring ever breaks.
      score: h.score ?? 0,
      title: h.title,
    })),
    dropReasons: (t.gateDropReasons as Record<string, number>) ?? {},
  };
  if (result.noClipsReason) shape.noClipsReason = result.noClipsReason;
  return shape;
}

export interface Fixture {
  name: string;
  transcript: TranscriptionResult;
  responses: Record<string, string>;
  snapshot: EvalShape | null;
}

export function loadFixture(name: string): Fixture {
  const dir = join(FIXTURES_DIR, name);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf-8"));
  const snapshotPath = join(dir, "snapshot.json");
  return {
    name,
    transcript: read("transcript.json"),
    responses: read("responses.json"),
    snapshot: existsSync(snapshotPath) ? read("snapshot.json") : null,
  };
}

/**
 * Runs the real engine against recorded LLM responses. Every deterministic
 * layer executes for real; nothing touches the network.
 *
 * A missing recording MUST fail loudly here. callJsonSchema catches the stub's
 * throw, retries, and returns {ok:false}; scanner.ts then treats the dead
 * window as a recall loss rather than an error - so without this check a stale
 * fixture would silently produce degraded output instead of a red test.
 */
export async function runFixture(
  fixture: Fixture,
  overrides: Partial<AnalyzeConfig> = {},
  extraResponses: Record<string, string> = {}
): Promise<V2Result> {
  const client = createReplayClient({ ...fixture.responses, ...extraResponses });
  const result = await analyzeHighlightsV2(fixture.transcript, {
    client,
    cfg: { ...loadAnalyzeConfig({}), engine: "recall-critic", ...overrides },
    retryDelayMs: 1,
  });
  if (client.missing.length > 0) {
    // keys repeat because callJsonSchema retries once before giving up
    const unique = [...new Set(client.missing)];
    throw new Error(
      `fixture "${fixture.name}" is stale: ${unique.length} unrecorded request(s) [${unique.join(", ")}]. ` +
        `Re-record with eval-record.ts, or check whether a prompt changed.`
    );
  }
  return result;
}
```

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/__tests__/helpers/eval-fixture.ts apps/worker/src/__tests__/eval-fixture.test.ts
git commit -m "test(analyze): eval fixture loader and shape reduction"
```

---

### Task 3: Fixture recorder script

**Files:**
- Create: `apps/worker/src/scripts/eval-record.ts`

**Context:** Recording is a manual, occasional act run against the live API; replay is what the suite runs. The recorder pulls a real job's transcript from Postgres (reachable only inside the compose network), wraps the real OpenAI client to capture every request/response pair keyed by `requestKey`, and writes the fixture directory.

- [ ] **Step 1: Implement the recorder**

Create `apps/worker/src/scripts/eval-record.ts`:

```typescript
/**
 * Records an eval fixture from a real job.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts <jobId> <case-name>"
 *
 * Writes apps/worker/src/__tests__/fixtures/eval/<case-name>/{transcript,responses,snapshot}.json
 * Costs real API calls - run it deliberately, not in a loop.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { prisma } from "@clipclap/shared";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { requestKey } from "../__tests__/helpers/replay-client";
import { toShape } from "../__tests__/helpers/eval-fixture";

async function main() {
  const [jobId, caseName] = process.argv.slice(2);
  if (!jobId || !caseName) {
    console.error("usage: eval-record.ts <jobId> <case-name>");
    process.exit(1);
  }

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { transcriptJson: true, transcriptPartial: true },
  });
  const transcript = job.transcriptJson as never;

  const real = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const responses: Record<string, string> = {};
  const client = {
    chat: {
      completions: {
        create: async (body: {
          model: string;
          messages: Array<{ role: string; content: string }>;
        }) => {
          const response = await real.chat.completions.create(body as never);
          const completion = response as {
            choices: Array<{ message: { content: string | null } }>;
          };
          const content = completion.choices[0]?.message?.content;
          if (content) {
            responses[
              requestKey({
                model: body.model,
                system: body.messages.find((m) => m.role === "system")?.content ?? "",
                user: body.messages.find((m) => m.role === "user")?.content ?? "",
              })
            ] = content;
          }
          return response;
        },
      },
    },
  } as unknown as OpenAI;

  const result = await analyzeHighlightsV2(transcript, {
    client,
    cfg: { ...loadAnalyzeConfig(), engine: "recall-critic" },
    transcriptPartial: job.transcriptPartial ?? false,
  });

  const dir = join(__dirname, "..", "__tests__", "fixtures", "eval", caseName);
  mkdirSync(dir, { recursive: true });
  const write = (file: string, data: unknown) =>
    writeFileSync(join(dir, file), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  write("transcript.json", transcript);
  write("responses.json", responses);
  write("snapshot.json", toShape(result));

  console.log(
    `recorded ${caseName}: ${Object.keys(responses).length} responses, ${result.highlights.length} clips`
  );
  for (const h of result.highlights) {
    console.log(`  ${h.start.toFixed(1)}-${h.end.toFixed(1)} [${h.score}] ${h.title}`);
  }
  process.exit(0);
}

main();
```

- [ ] **Step 2: Typecheck**

Run: `docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scripts/eval-record.ts
git commit -m "test(analyze): eval fixture recorder script"
```

---

### Task 4: Record the two real fixtures

**Files:**
- Create: `apps/worker/src/__tests__/fixtures/eval/podcast-ecology/{transcript,responses,snapshot}.json`
- Create: `apps/worker/src/__tests__/fixtures/eval/podcast-answer-arc/{transcript,responses,snapshot}.json`

**Context:** Two real jobs. `cmrzcqhl6000138lkg41n8bs0` is the ecology podcast carrying the teaser, duplicate and meandering defects. Find the second: the earlier podcast whose clip "Самые ли мы страшные хищники и зло для планеты?" exercised answer-completeness. Query for it rather than guessing.

- [ ] **Step 1: Find the second job**

```bash
docker compose exec web sh -c "cd /app && npx tsx -e \"
import { prisma } from '@clipclap/shared';
async function main() {
  const jobs = await prisma.job.findMany({
    where: { status: 'DONE', clipsGenerated: { gt: 0 }, transcriptJson: { not: null } },
    orderBy: { createdAt: 'desc' }, take: 10,
    select: { id: true, createdAt: true, clipsGenerated: true, clips: { select: { title: true }, take: 8 } },
  });
  for (const j of jobs) console.log(j.id, j.createdAt.toISOString(), j.clipsGenerated, JSON.stringify(j.clips.map(c => c.title)));
  process.exit(0);
}
main();
\""
```

Pick the job whose titles include the "хищники / зло для планеты" question clip.

- [ ] **Step 2: Record both fixtures**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts cmrzcqhl6000138lkg41n8bs0 podcast-ecology"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts <SECOND_JOB_ID> podcast-answer-arc"
```

Each prints the recorded clip list. Save that output in your report - it is the baseline the reviewer checks.

- [ ] **Step 3: Verify replay reproduces the recording exactly**

Create a temporary check (do NOT commit it) confirming that `runFixture` on each fixture reproduces `snapshot.json` byte-for-byte. If it does not, replay is not faithful - report BLOCKED with the diff rather than blessing a wrong snapshot.

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx -e \"
import { loadFixture, runFixture, toShape } from '/app/apps/worker/src/__tests__/helpers/eval-fixture';
async function main() {
  for (const name of ['podcast-ecology', 'podcast-answer-arc']) {
    const f = loadFixture(name);
    const shape = toShape(await runFixture(f));
    const same = JSON.stringify(shape) === JSON.stringify(f.snapshot);
    console.log(name, same ? 'REPLAY_OK' : 'REPLAY_DIFF');
    if (!same) { console.log('recorded:', JSON.stringify(f.snapshot, null, 1)); console.log('replayed:', JSON.stringify(shape, null, 1)); }
  }
  process.exit(0);
}
main();
\""
```

Expected: `REPLAY_OK` for both.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/__tests__/fixtures/eval
git commit -m "test(analyze): record eval fixtures from two real podcast jobs"
```

---

### Task 5: Tier-2 snapshot test and bless script

**Files:**
- Create: `apps/worker/src/__tests__/eval-snapshot.test.ts`
- Create: `apps/worker/src/scripts/eval-bless.ts`

**Context:** The snapshot test is a change detector, not a correctness claim. It must fail with a readable diff so the reviewer can see exactly what a change did.

- [ ] **Step 1: Write the snapshot test**

Create `apps/worker/src/__tests__/eval-snapshot.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { loadFixture, runFixture, toShape } from "./helpers/eval-fixture";

const CASES = ["podcast-ecology", "podcast-answer-arc"];

describe("eval snapshots", () => {
  for (const name of CASES) {
    it(`${name} produces the blessed shape`, async () => {
      const fixture = loadFixture(name);
      expect(fixture.snapshot, `${name} has no blessed snapshot`).not.toBeNull();
      const shape = toShape(await runFixture(fixture));
      // A diff here means the engine's behavior changed. That is not
      // automatically wrong - read the diff, decide, and re-bless deliberately
      // with: npx tsx src/scripts/eval-bless.ts
      expect(shape).toEqual(fixture.snapshot);
    });
  }
});
```

- [ ] **Step 2: Run it - must pass on the current engine**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/eval-snapshot.test.ts"`
Expected: 2 passed. A failure here means replay is not faithful - fix that before continuing, do not re-bless.

- [ ] **Step 3: Write the bless script**

Create `apps/worker/src/scripts/eval-bless.ts`:

```typescript
/**
 * Re-blesses eval snapshots after a deliberate behavior change.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts [case-name ...]"
 *
 * Prints a diff of what changed and rewrites snapshot.json. Read the diff
 * before committing: that diff IS the review of the change.
 */
import { readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { FIXTURES_DIR, loadFixture, runFixture, toShape } from "../__tests__/helpers/eval-fixture";

async function main() {
  const names = process.argv.slice(2);
  const cases = names.length > 0 ? names : readdirSync(FIXTURES_DIR);
  for (const name of cases) {
    const fixture = loadFixture(name);
    const shape = toShape(await runFixture(fixture));
    const before = JSON.stringify(fixture.snapshot, null, 2);
    const after = JSON.stringify(shape, null, 2);
    if (before === after) {
      console.log(`${name}: unchanged`);
      continue;
    }
    console.log(`${name}: CHANGED`);
    console.log("--- blessed\n" + before);
    console.log("+++ current\n" + after);
    writeFileSync(join(FIXTURES_DIR, name, "snapshot.json"), `${after}\n`, "utf-8");
  }
  process.exit(0);
}

main();
```

- [ ] **Step 4: Verify the bless script reports "unchanged" right now**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts"
```

Expected: `unchanged` for both cases (and no file modified - confirm with `git status`).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/__tests__/eval-snapshot.test.ts apps/worker/src/scripts/eval-bless.ts
git commit -m "test(analyze): eval shape snapshots with deliberate bless step"
```

---

### Task 6: Tier-1 named regressions (already-fixed defects)

**Files:**
- Create: `apps/worker/src/__tests__/eval-regressions.test.ts`

**Context:** Four defects the owner found and the engine already fixes. These must pass NOW; they are the "never again" net. The three not-yet-fixed cases (teaser, duplicate, meandering) are written later, inside their own feature tasks, TDD-style.

- [ ] **Step 1: Inspect the fixtures to find the exact node text and times**

Before asserting, look at what each fixture actually produces:

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx -e \"
import { loadFixture, runFixture } from '/app/apps/worker/src/__tests__/helpers/eval-fixture';
async function main() {
  for (const name of ['podcast-ecology', 'podcast-answer-arc']) {
    const r = await runFixture(loadFixture(name));
    console.log('==', name);
    for (const h of r.highlights) console.log(\\\`  \\\${h.start.toFixed(1)}-\\\${h.end.toFixed(1)} [\\\${h.score}] \\\${h.title}\\\`);
  }
  process.exit(0);
}
main();
\""
```

Use the real numbers you see; do not invent them.

- [ ] **Step 2: Write the regression tests**

Create `apps/worker/src/__tests__/eval-regressions.test.ts`. Fill the constants from Step 1's output:

```typescript
import { describe, expect, it } from "vitest";
import { loadFixture, runFixture } from "./helpers/eval-fixture";

/**
 * Tier-1 "never again" regressions. Each case is a defect the owner found in a
 * real clip. A failure here names the exact defect that came back.
 */
describe("named regressions", () => {
  it("no clip opens mid-word or on a lowercase fragment", async () => {
    for (const name of ["podcast-ecology", "podcast-answer-arc"]) {
      const result = await runFixture(loadFixture(name));
      for (const h of result.highlights) {
        const first = firstSpokenWords(loadFixture(name), h.start);
        expect(
          /^[\p{Lu}\p{N}"«(\[]/u.test(first),
          `${name}: clip at ${h.start.toFixed(1)}s opens mid-sentence: "${first.slice(0, 60)}"`
        ).toBe(true);
      }
    }
  });

  it("no clip ends on a dangling comma clause", async () => {
    for (const name of ["podcast-ecology", "podcast-answer-arc"]) {
      const result = await runFixture(loadFixture(name));
      for (const h of result.highlights) {
        const tail = lastSpokenWords(loadFixture(name), h.end);
        expect(
          /[,;:]$/.test(tail.trim()),
          `${name}: clip ending ${h.end.toFixed(1)}s ends mid-clause: "...${tail.slice(-60)}"`
        ).toBe(false);
      }
    }
  });

  it("the answer-arc clip contains its own answer", async () => {
    const fixture = loadFixture("podcast-answer-arc");
    const result = await runFixture(fixture);
    const arc = result.highlights.find((h) => /хищник|зло для планеты/i.test(h.title));
    expect(arc, "the answer-arc clip is gone entirely").toBeDefined();
    // The question is asked early and answered late: the clip must span both,
    // not ship the question alone.
    expect(arc!.end - arc!.start).toBeGreaterThan(30);
    expect(arc!.payoffAt).toBeGreaterThan(arc!.hookEnd ?? arc!.start);
  });

  it("every shipped clip is at least the hard minimum long", async () => {
    for (const name of ["podcast-ecology", "podcast-answer-arc"]) {
      const result = await runFixture(loadFixture(name));
      for (const h of result.highlights) {
        expect(h.end - h.start, `${name}: clip at ${h.start.toFixed(1)}s is too short`).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

/** First spoken words at or after a clip start, from the fixture transcript. */
function firstSpokenWords(fixture: ReturnType<typeof loadFixture>, startSec: number): string {
  const seg = fixture.transcript.segments.find((s) => s.end > startSec + 0.05);
  return (seg?.text ?? "").trim();
}

/** Last spoken words at or before a clip end. */
function lastSpokenWords(fixture: ReturnType<typeof loadFixture>, endSec: number): string {
  const segs = fixture.transcript.segments.filter((s) => s.start < endSec - 0.05);
  return (segs[segs.length - 1]?.text ?? "").trim();
}
```

- [ ] **Step 3: Run**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/eval-regressions.test.ts"`
Expected: all pass. If one fails, that is a REAL regression already present in the engine - report it as DONE_WITH_CONCERNS with the failure text rather than weakening the assertion.

- [ ] **Step 4: Full suite + typecheck, then commit**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
git add apps/worker/src/__tests__/eval-regressions.test.ts
git commit -m "test(analyze): tier-1 named regressions for already-fixed defects"
```

**The harness is now the baseline. Every task below must keep it green or produce a diff the reviewer accepts.**

---

### Task 7: Teaser-montage filter

**Files:**
- Create: `apps/worker/src/analyze-v2/teaser.ts`
- Test: `apps/worker/src/__tests__/teaser.test.ts`
- Modify: `apps/worker/src/analyze-v2/config.ts`, `apps/worker/src/analyze-v2/index.ts`
- Modify: `apps/worker/src/__tests__/eval-regressions.test.ts` (add the failing case first)

- [ ] **Step 1: Add the failing Tier-1 case**

Append to `apps/worker/src/__tests__/eval-regressions.test.ts` inside the describe block:

```typescript
  it("no clip is cut from the intro teaser montage", async () => {
    const result = await runFixture(loadFixture("podcast-ecology"));
    const teasers = result.highlights.filter((h) => h.start < 120);
    expect(
      teasers.map((h) => `${h.start.toFixed(1)}-${h.end.toFixed(1)} ${h.title}`),
      "a montage fragment shipped as a clip"
    ).toEqual([]);
  });
```

- [ ] **Step 2: Run - it MUST fail**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/eval-regressions.test.ts"`
Expected: FAIL on the new case, listing the 0-7.2s teaser clip. This is the defect, reproduced by the harness.

- [ ] **Step 3: Write the unit tests**

Create `apps/worker/src/__tests__/teaser.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { recurrenceFraction, isTeaserCandidate } from "../analyze-v2/teaser";
import type { SentenceNode } from "../analyze-v2/types";

function nodes(texts: string[]): SentenceNode[] {
  return texts.map((text, i) => ({
    index: i,
    start: i * 5,
    end: i * 5 + 4.5,
    text,
    hasWords: true,
    trailingStrength: 1,
    leadingStrength: 1,
  }));
}

const cfg = { teaserWindowSec: 120, teaserRecurrenceFrac: 0.5 };

describe("recurrenceFraction", () => {
  it("is 1 when every phrase reappears later", () => {
    const graph = nodes([
      "человек это зло для планеты земля",
      "мусорная фраза посередине",
      "человек это зло для планеты земля",
    ]);
    expect(recurrenceFraction(graph, 0, 0)).toBe(1);
  });

  it("is 0 when nothing reappears", () => {
    const graph = nodes(["уникальная мысль про экологию", "совсем другая тема разговора"]);
    expect(recurrenceFraction(graph, 0, 0)).toBe(0);
  });

  it("ignores recurrence INSIDE the candidate itself", () => {
    const graph = nodes([
      "одна и та же фраза повторяется",
      "одна и та же фраза повторяется",
      "дальше идет совершенно другой текст",
    ]);
    // the repeat is inside [0,1], not after it
    expect(recurrenceFraction(graph, 0, 1)).toBe(0);
  });

  it("tolerates punctuation and case differences", () => {
    const graph = nodes([
      "Человек - это ЗЛО для планеты Земля!",
      "другое",
      "человек это зло для планеты земля",
    ]);
    expect(recurrenceFraction(graph, 0, 0)).toBe(1);
  });

  it("returns 0 for text too short to form an n-gram", () => {
    expect(recurrenceFraction(nodes(["да", "да"]), 0, 0)).toBe(0);
  });
});

describe("isTeaserCandidate", () => {
  const graph = nodes([
    "человек это зло для планеты земля",
    "заполнитель между ними",
    "человек это зло для планеты земля",
  ]);

  it("flags a montage copy inside the opening window", () => {
    expect(isTeaserCandidate(graph, { startNode: 0, endNode: 0 }, cfg)).toBe(true);
  });

  it("never flags a candidate that starts past the window", () => {
    const late = graph.map((n, i) => ({ ...n, start: 300 + i * 5, end: 304 + i * 5 }));
    expect(isTeaserCandidate(late, { startNode: 0, endNode: 0 }, cfg)).toBe(false);
  });

  it("does not flag an ordinary opening that merely shares vocabulary", () => {
    const ordinary = nodes([
      "сегодня мы обсуждаем экологию и климат",
      "экология это очень широкая тема",
      "климат меняется быстрее чем раньше",
    ]);
    expect(isTeaserCandidate(ordinary, { startNode: 0, endNode: 0 }, cfg)).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/teaser.test.ts"`
Expected: FAIL - cannot resolve `../analyze-v2/teaser`.

- [ ] **Step 5: Implement the filter**

Create `apps/worker/src/analyze-v2/teaser.ts`:

```typescript
import type { SentenceNode } from "./types";

const NGRAM = 5;

export interface TeaserConfig {
  teaserWindowSec: number;
  teaserRecurrenceFrac: number;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(words: string[]): string[] {
  if (words.length < NGRAM) return [];
  const out: string[] = [];
  for (let i = 0; i + NGRAM <= words.length; i++) {
    out.push(words.slice(i, i + NGRAM).join(" "));
  }
  return out;
}

/**
 * Share of the candidate's word 5-grams that reappear LATER in the transcript.
 *
 * An intro teaser montage is literally a copy of speech from further in, so its
 * n-grams occur twice; ordinary speech that merely shares vocabulary does not
 * repeat five words in a row. Recurrence is measured strictly after the
 * candidate's own end so internal repetition never counts.
 */
export function recurrenceFraction(
  nodes: SentenceNode[],
  startNode: number,
  endNode: number
): number {
  const candidate = ngrams(
    tokens(nodes.slice(startNode, endNode + 1).map((n) => n.text).join(" "))
  );
  if (candidate.length === 0) return 0;
  const later = new Set(
    ngrams(tokens(nodes.slice(endNode + 1).map((n) => n.text).join(" ")))
  );
  const hits = candidate.filter((g) => later.has(g)).length;
  return hits / candidate.length;
}

/** True when a candidate in the video's opening window is a montage copy. */
export function isTeaserCandidate(
  nodes: SentenceNode[],
  candidate: { startNode: number; endNode: number },
  cfg: TeaserConfig
): boolean {
  const node = nodes[candidate.startNode];
  if (!node || node.start > cfg.teaserWindowSec) return false;
  return (
    recurrenceFraction(nodes, candidate.startNode, candidate.endNode) >=
    cfg.teaserRecurrenceFrac
  );
}
```

- [ ] **Step 6: Add config knobs**

In `apps/worker/src/analyze-v2/config.ts`, add to the `AnalyzeConfig` interface after `payoffMaxTailSec`:

```typescript
  /** Intro teaser montages quote later speech verbatim; candidates starting
   *  inside this window are recurrence-tested (spec 2026-07-24 §4.1). */
  teaserWindowSec: number;
  teaserRecurrenceFrac: number;
```

and to the returned object in `loadAnalyzeConfig`:

```typescript
    teaserWindowSec: num(env, "TEASER_WINDOW_SEC", 120),
    teaserRecurrenceFrac: num(env, "TEASER_RECURRENCE_FRAC", 0.5),
```

- [ ] **Step 7: Wire into the pipeline**

In `apps/worker/src/analyze-v2/index.ts`, add the import:

```typescript
import { isTeaserCandidate, recurrenceFraction } from "./teaser";
```

Then, immediately AFTER the `mergeCandidates` call and BEFORE `selectCriticCandidates` (inside the `else` branch of the tiny-path check), filter merged candidates:

```typescript
    const merged = mergeCandidates(scan.candidates, nodes, cfg);
    // Intro montage fragments quote later speech verbatim and are truncated by
    // the source editor. Dropping them here (not after the critic) also frees
    // the first window's candidate quota for real moments.
    const teaserDrops: Array<{ id: string; recurrence: number }> = [];
    const withoutTeasers = merged.filter((c) => {
      if (!isTeaserCandidate(nodes, c, cfg)) return true;
      teaserDrops.push({
        id: c.id,
        recurrence: Math.round(recurrenceFraction(nodes, c.startNode, c.endNode) * 100) / 100,
      });
      return false;
    });
    const sourceMinutes = speechSec / 60;
    candidates = selectCriticCandidates(withoutTeasers, nodes, cfg, sourceMinutes);
    scannerTelemetry = {
      path: "full",
      ...scan.telemetry,
      rawCandidates: scan.candidates.length,
      mergedCandidates: merged.length,
      teaserDrops,
      criticCandidates: candidates.length,
    };
```

- [ ] **Step 8: Run everything**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/teaser.test.ts"
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/eval-regressions.test.ts"
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: teaser units pass; the teaser regression now PASSES; `eval-snapshot` FAILS with a diff showing the teaser clip removed from `podcast-ecology`.

**Important:** dropping a candidate before the critic changes which candidates the critic is asked about, so the recorded critic responses for the removed batch may go unused - that is fine. If replay throws `unrecorded request` (because batching re-shuffled candidates into different batches), STOP and report: the fixture must be re-recorded in this task, and the reviewer must see both the re-record and the diff.

- [ ] **Step 9: Review and bless the snapshot diff**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts podcast-ecology"
```

Paste the printed diff into your report. It must show ONLY the teaser clip disappearing (and, as a consequence, possibly one more clip taking its cap slot). Anything else is an unintended side effect - report it.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/analyze-v2/teaser.ts apps/worker/src/analyze-v2/config.ts apps/worker/src/analyze-v2/index.ts apps/worker/src/__tests__/teaser.test.ts apps/worker/src/__tests__/eval-regressions.test.ts apps/worker/src/__tests__/fixtures/eval/podcast-ecology/snapshot.json
git commit -m "feat(analyze): drop intro teaser montage candidates by recurrence"
```

---

### Task 8: Question-title surcharge

**Files:**
- Modify: `apps/worker/src/analyze-v2/select.ts`, `apps/worker/src/analyze-v2/config.ts`, `apps/worker/src/analyze-v2/types.ts`, `apps/worker/src/analyze-v2/snap.ts`
- Test: `apps/worker/src/__tests__/select.test.ts`

**Context:** `select.ts` already charges `shortClipScoreBonus` and `questionEndScoreBonus`. This adds a third surcharge for the teaser SHAPE: a question title whose hook spans the whole clip (`payoffSec <= hookEndSec + EPS`). `SnappedClip` already carries `hookEndSec` and `payoffSec`, so no new snap plumbing is needed - only the title test.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/__tests__/select.test.ts` inside the `describe("selectAndOrder")` block:

```typescript
  it("charges a question title whose hook spans the whole clip", () => {
    // the intro-teaser shape: title promises, payoff never arrives after the hook
    const teaser = clip(0, 7, 0.86);
    teaser.verdict.title = "Человек - зло для планеты… или всё не так однозначно?";
    teaser.payoffSec = teaser.hookEndSec; // payoff == hook end
    const r = selectAndOrder([teaser], cfg);
    expect(r.selected).toHaveLength(0);
  });

  it("leaves a question title alone when the payoff follows the hook", () => {
    const proper = clip(100, 160, 0.7);
    proper.verdict.title = "Что на самом деле убьёт человечество?";
    proper.payoffSec = proper.hookEndSec + 30;
    const r = selectAndOrder([proper], cfg);
    expect(r.selected).toHaveLength(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/select.test.ts"`
Expected: the first new test FAILS (the teaser currently ships).

- [ ] **Step 3: Add the config knob**

In `config.ts`, add to the interface after `questionEndScoreBonus`:

```typescript
  /** A question TITLE whose hook spans the whole clip is a teaser: the promise
   *  is never paid inside the clip (spec 2026-07-24 §4.5). */
  questionTitleScoreBonus: number;
```

and to the loader:

```typescript
    questionTitleScoreBonus: num(env, "QUESTION_TITLE_SCORE_BONUS", 0.15),
```

- [ ] **Step 4: Implement the surcharge**

In `apps/worker/src/analyze-v2/select.ts`, replace the `surcharge` definition:

```typescript
const EPS = 0.05;

/** A title that ASKS something - the promise a teaser never keeps. */
export function titleIsQuestion(title: string): boolean {
  return /[?？]["»')\]]*\s*$/u.test(title.trim());
}

/** Deterministic backstops for shapes the critic is told to reject but may
 *  still pass: lone fragments, dangling questions, and teaser titles. */
export function selectAndOrder(
  clips: SnappedClip[],
  cfg: AnalyzeConfig
): SelectionResult {
  const surcharge = (c: SnappedClip) =>
    (c.endSec - c.startSec < cfg.shortClipStrictSec ? cfg.shortClipScoreBonus : 0) +
    (c.endsOnQuestion ? cfg.questionEndScoreBonus : 0) +
    (titleIsQuestion(c.verdict.title) && c.payoffSec <= c.hookEndSec + EPS
      ? cfg.questionTitleScoreBonus
      : 0);
```

(keep the rest of the function unchanged).

- [ ] **Step 5: Run tests**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/select.test.ts"
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: select tests pass. If `eval-snapshot` changes, review and bless the diff as in Task 7 Step 9, and include it in your report.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/analyze-v2/select.ts apps/worker/src/analyze-v2/config.ts apps/worker/src/__tests__/select.test.ts
git commit -m "feat(analyze): surcharge question titles whose hook spans the clip"
```

---

### Task 9: Hook dedup and duplicate-graph resolution

**Files:**
- Create: `apps/worker/src/analyze-v2/dedup.ts`
- Test: `apps/worker/src/__tests__/dedup.test.ts`

**Context:** Pure functions only - no LLM, no I/O. `resolveDuplicates` is shared: the deterministic hook pass and the LLM's `duplicate_of` output both feed it, so cycles, chains and the drop cap are handled in exactly one place.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/dedup.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { normalizeHook, hookSimilarity, findHookDuplicates, resolveDuplicates } from "../analyze-v2/dedup";

describe("normalizeHook", () => {
  it("strips case, punctuation and extra whitespace", () => {
    expect(normalizeHook("Человек — это ЗЛО, для планеты  Земля!")).toBe(
      "человек это зло для планеты земля"
    );
  });
  it("handles an empty string", () => {
    expect(normalizeHook("   ")).toBe("");
  });
});

describe("hookSimilarity", () => {
  it("is 1 for identical openings ignoring punctuation and case", () => {
    expect(hookSimilarity("Человек - это зло для планеты Земля", "человек это зло для планеты земля!")).toBe(1);
  });
  it("is 0 for unrelated openings", () => {
    expect(hookSimilarity("бактерии едят пластик", "разумный вид строит корабли")).toBe(0);
  });
  it("is 0 when either side is empty", () => {
    expect(hookSimilarity("", "что угодно")).toBe(0);
  });
});

describe("findHookDuplicates", () => {
  const clips = [
    { id: "a", score: 0.9, hook: "Человек это зло для планеты Земля" },
    { id: "b", score: 0.86, hook: "Человек - это зло для планеты Земля!" },
    { id: "c", score: 0.7, hook: "Бактерии научились есть пластик" },
  ];

  it("marks the lower-scored twin, never the stronger one", () => {
    expect(findHookDuplicates(clips, 0.8)).toEqual([{ id: "b", duplicateOf: "a" }]);
  });

  it("finds nothing when openings differ", () => {
    expect(findHookDuplicates(clips.slice(1), 0.8)).toEqual([]);
  });
});

describe("resolveDuplicates", () => {
  const scores = { a: 0.9, b: 0.8, c: 0.7, d: 0.6 };

  it("keeps the highest-scored member of a chain", () => {
    const drops = resolveDuplicates(
      [
        { id: "b", duplicateOf: "a" },
        { id: "c", duplicateOf: "b" },
      ],
      scores,
      99
    );
    expect(drops.sort()).toEqual(["b", "c"]);
  });

  it("breaks a cycle instead of dropping everything", () => {
    const drops = resolveDuplicates(
      [
        { id: "a", duplicateOf: "b" },
        { id: "b", duplicateOf: "a" },
      ],
      scores,
      99
    );
    expect(drops).toEqual(["b"]); // a is stronger and survives
  });

  it("ignores self-reference and unknown ids", () => {
    expect(
      resolveDuplicates(
        [
          { id: "a", duplicateOf: "a" },
          { id: "zz", duplicateOf: "a" },
          { id: "b", duplicateOf: "nope" },
        ],
        scores,
        99
      )
    ).toEqual([]);
  });

  it("enforces the drop cap, dropping the weakest first", () => {
    const drops = resolveDuplicates(
      [
        { id: "b", duplicateOf: "a" },
        { id: "c", duplicateOf: "a" },
        { id: "d", duplicateOf: "a" },
      ],
      scores,
      2
    );
    expect(drops).toEqual(["d", "c"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/dedup.test.ts"`
Expected: FAIL - cannot resolve `../analyze-v2/dedup`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/analyze-v2/dedup.ts`:

```typescript
export interface DuplicateClaim {
  id: string;
  duplicateOf: string;
}

export function normalizeHook(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Token Jaccard over normalized opening lines. */
export function hookSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeHook(a).split(" ").filter(Boolean));
  const setB = new Set(normalizeHook(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

/** Deterministic pass: identical or near-identical opening lines. The teaser
 *  montage quotes the real moment verbatim, so this fires without an LLM. */
export function findHookDuplicates(
  clips: Array<{ id: string; score: number; hook: string }>,
  threshold: number
): DuplicateClaim[] {
  const byScore = [...clips].sort((a, b) => b.score - a.score);
  const claims: DuplicateClaim[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < byScore.length; i++) {
    if (taken.has(byScore[i].id)) continue;
    for (let j = i + 1; j < byScore.length; j++) {
      if (taken.has(byScore[j].id)) continue;
      if (hookSimilarity(byScore[i].hook, byScore[j].hook) >= threshold) {
        claims.push({ id: byScore[j].id, duplicateOf: byScore[i].id });
        taken.add(byScore[j].id);
      }
    }
  }
  return claims;
}

/**
 * Turns duplicate claims into a drop list. The strongest member of every
 * duplicate group always survives, chains collapse to one survivor, and cycles
 * cannot wipe a group out. At most maxDrops clips are dropped - weakest first -
 * so a confused judge can never empty the set.
 */
export function resolveDuplicates(
  claims: DuplicateClaim[],
  scores: Record<string, number>,
  maxDrops: number
): string[] {
  const valid = claims.filter(
    (c) =>
      c.id !== c.duplicateOf &&
      scores[c.id] !== undefined &&
      scores[c.duplicateOf] !== undefined
  );
  const candidates = new Set<string>();
  for (const claim of valid) {
    // Drop whichever side of the claim is weaker: a cycle then resolves to the
    // stronger clip surviving instead of both disappearing.
    const weaker =
      scores[claim.id] <= scores[claim.duplicateOf] ? claim.id : claim.duplicateOf;
    candidates.add(weaker);
  }
  return [...candidates]
    .sort((a, b) => scores[a] - scores[b])
    .slice(0, Math.max(0, maxDrops));
}
```

- [ ] **Step 4: Run to verify pass**

Same command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/dedup.ts apps/worker/src/__tests__/dedup.test.ts
git commit -m "feat(analyze): pure hook dedup and duplicate-graph resolution"
```

---

### Task 10: Finalizer prompt, schema and types

**Files:**
- Modify: `apps/worker/src/analyze-v2/prompts.ts`, `apps/worker/src/analyze-v2/schemas.ts`, `apps/worker/src/analyze-v2/types.ts`, `apps/worker/src/analyze-v2/config.ts`
- Test: `apps/worker/src/__tests__/finalizer-prompt.test.ts`

**Context:** Read `prompts.ts` and `schemas.ts` first and follow their existing shape exactly (strict `json_schema`, `additionalProperties: false`, every property required with nullable types where optional). The finalizer sees FULL clip speech with `¶` markers, exactly like the critic's candidate block.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/finalizer-prompt.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { finalizerSystemPrompt, finalizerUserPrompt } from "../analyze-v2/prompts";
import { FINALIZER_SCHEMA } from "../analyze-v2/schemas";
import type { SentenceNode, SnappedClip } from "../analyze-v2/types";

function node(i: number, text: string): SentenceNode {
  return {
    index: i, start: i * 5, end: i * 5 + 4.5, text,
    hasWords: true, trailingStrength: 1, leadingStrength: 1,
  };
}

const nodes = [node(0, "Первая фраза."), node(1, "Вторая фраза."), node(2, "Третья фраза.")];

const clip = {
  verdict: {
    id: "c1", keep: true, score: 0.8, grounded: true, selfContained: true,
    startNode: 0, payoffNode: 2, endNode: 2, hookStartNode: 0, hookEndNode: 1,
    title: "Заголовок", description: "Описание",
    titleEvidenceNodes: [1], descriptionEvidenceNodes: [1], language: "ru",
  },
  startSec: 0, endSec: 14.5, hookStartSec: 0, hookEndSec: 9.5, payoffSec: 14.5,
  shortMoment: false,
} as SnappedClip;

describe("finalizer prompt", () => {
  it("names the clip language and states every rule", () => {
    const p = finalizerSystemPrompt("ru", "Russian");
    expect(p).toContain("Russian");
    for (const rule of ["duplicate", "teaser", "redundant", "trim_start_node", "title_evidence_nodes"]) {
      expect(p, `rule missing: ${rule}`).toContain(rule);
    }
  });

  it("renders every clip with its full speech, indices and paragraph markers", () => {
    const user = finalizerUserPrompt([clip], nodes);
    expect(user).toContain("CLIP c1");
    expect(user).toContain("#0");
    expect(user).toContain("#2");
    expect(user).toContain("Третья фраза.");
    expect(user).toMatch(/¶/);
  });

  it("has a strict schema requiring a reason for every drop", () => {
    const props = FINALIZER_SCHEMA.schema as {
      properties: { clips: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    const item = props.properties.clips.items;
    for (const field of ["id", "verdict", "drop_reason", "duplicate_of", "shared_claim", "title", "title_evidence_nodes", "trim_start_node"]) {
      expect(item.required, `schema field missing: ${field}`).toContain(field);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/finalizer-prompt.test.ts"`
Expected: FAIL - the exports do not exist.

- [ ] **Step 3: Add the config knobs**

In `config.ts` interface, after `questionTitleScoreBonus`:

```typescript
  /** FINALIZE step: one judge over the whole shipped set (spec 2026-07-24 §4.3). */
  finalizerEnabled: boolean;
  finalizerModel: string;
  finalizerHeadroom: number;
  hookDedupSimilarity: number;
```

In the loader (note `finalizerModel` defaults to the critic model):

```typescript
    finalizerEnabled: env.ANALYZE_FINALIZER !== "off",
    finalizerModel: env.OPENAI_FINALIZER_MODEL || env.OPENAI_CRITIC_MODEL || "gpt-5.1",
    finalizerHeadroom: num(env, "FINALIZER_HEADROOM", 4),
    hookDedupSimilarity: num(env, "HOOK_DEDUP_SIMILARITY", 0.8),
```

- [ ] **Step 4: Add types**

In `apps/worker/src/analyze-v2/types.ts`, add:

```typescript
export type FinalizerDropReason =
  | "duplicate"
  | "unanswered_title"
  | "broken_opening"
  | "no_payoff"
  | "redundant"
  | "teaser_montage"
  | "incoherent";

export interface FinalizerEntry {
  id: string;
  verdict: "ship" | "drop";
  dropReason: FinalizerDropReason | null;
  duplicateOf: string | null;
  sharedClaim: string | null;
  title: string | null;
  titleEvidenceNodes: number[] | null;
  trimStartNode: number | null;
}
```

- [ ] **Step 5: Add the schema**

In `apps/worker/src/analyze-v2/schemas.ts`, following the file's existing style:

```typescript
export const FINALIZER_SCHEMA = {
  name: "clip_finalizer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["clips"],
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id", "verdict", "drop_reason", "duplicate_of",
            "shared_claim", "title", "title_evidence_nodes", "trim_start_node",
          ],
          properties: {
            id: { type: "string" },
            verdict: { type: "string", enum: ["ship", "drop"] },
            drop_reason: {
              type: ["string", "null"],
              enum: [
                "duplicate", "unanswered_title", "broken_opening",
                "no_payoff", "redundant", "teaser_montage", "incoherent", null,
              ],
            },
            duplicate_of: { type: ["string", "null"] },
            shared_claim: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            title_evidence_nodes: {
              type: ["array", "null"],
              items: { type: "integer" },
            },
            trim_start_node: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
} as const;
```

- [ ] **Step 6: Add the prompts**

In `apps/worker/src/analyze-v2/prompts.ts`, append:

```typescript
export const FINALIZER_PROMPT_TEMPLATE = `You are the final editor of a short-form clip set. Every clip below already
passed a strict per-clip judge. Your job is the judgment NO earlier stage could
make: you see the WHOLE SET at once, and you see each clip's FULL speech.

Each clip arrives as:
  CLIP <id> | score <s> | <duration>s
  title / description
  speech: lines of  ¶ #<index> [<start>s] <text>
A leading ¶ marks a line that is a legal clip START. Address everything by node
index. NEVER output a timestamp or an index you were not shown.

Judge in this order:

1. DUPLICATES. These clips ship together as one batch from one video. Would a
   viewer feel they watched the same thing twice? Judge the CLAIM, not the
   wording: two clips arguing the same point with different sentences ARE
   duplicates. Set duplicate_of to the id of the clip that says it best and give
   shared_claim - the one thing both assert. Clips about genuinely different
   points are NOT duplicates even when they share a topic.

2. TEASER MONTAGE. Interviews often open with a montage of bait phrases cut
   from later in the conversation, truncated by the editor: half-thoughts with
   no setup and no payoff. Drop them with drop_reason "teaser_montage" - the
   complete moment lives later in the video.

3. HONEST TITLE. A question title is valid ONLY when the answer is spoken
   inside the clip. Otherwise rewrite it as a truthful statement built from the
   clip's own words, and cite title_evidence_nodes - 1-3 node indices inside
   this clip whose words support the new title. If nothing in the clip can
   support an honest title, drop with "unanswered_title". Never promise what the
   clip does not deliver.

4. TOPICAL OPENING. The first sentence must state what the clip is about. When
   a tangent, a filler exchange, or crosstalk precedes the real topic, set
   trim_start_node to the ¶ line where the topic actually starts. It must lie
   before the payoff. The new opening must not point at anything the clip never
   shows ("this", "that", "они", "вот эта") - a clip that opens on a dangling
   pointer is worthless to a cold viewer.

5. NO REPETITION INSIDE A CLIP. If the clip states one thought and then restates
   it with no new information, it drags: prefer trimming the start to the
   sharpest formulation. Drop as "redundant" only when the whole clip circles
   one point. Natural emphasis, a rhetorical echo, or a restatement that ADDS a
   new angle is NOT repetition - do not punish it.

6. FINAL VERDICT. Judge each clip as a finished product a stranger will watch
   standalone: does the hook land, is the payoff delivered INSIDE the clip, is
   the title honest. Drop what does not work, with the closest drop_reason.

Be conservative: dropping a good clip costs more than keeping a mediocre one.
Copy stays in the clip's own language ({{LANGUAGE_NAME}}, {{LANGUAGE_ISO}}).
Return EVERY clip id, kept or dropped. Output ONLY the JSON object described by
the schema.`;

export function finalizerSystemPrompt(
  languageIso: string,
  languageName: string
): string {
  return FINALIZER_PROMPT_TEMPLATE
    .replaceAll("{{LANGUAGE_NAME}}", languageName)
    .replaceAll("{{LANGUAGE_ISO}}", languageIso);
}

/** One block per clip: full speech, node indices, ¶ start markers. */
export function finalizerUserPrompt(
  clips: SnappedClip[],
  nodes: SentenceNode[]
): string {
  return clips
    .map((c) => {
      const v = c.verdict;
      const lines = [
        `CLIP ${v.id} | score ${v.score} | ${Math.round(c.endSec - c.startSec)}s`,
        `title: ${v.title}`,
        `description: ${v.description}`,
        "speech:",
      ];
      for (let i = v.startNode; i <= v.endNode && i < nodes.length; i++) {
        const n = nodes[i];
        const marker = isCleanStart(nodes, i) ? "¶ " : "  ";
        lines.push(`${marker}#${n.index} [${n.start.toFixed(1)}s] ${n.text}`);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}
```

Add `SnappedClip` to the existing type import at the top of `prompts.ts`.

- [ ] **Step 7: Run tests, typecheck, commit**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/finalizer-prompt.test.ts"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
git add apps/worker/src/analyze-v2/prompts.ts apps/worker/src/analyze-v2/schemas.ts apps/worker/src/analyze-v2/types.ts apps/worker/src/analyze-v2/config.ts apps/worker/src/__tests__/finalizer-prompt.test.ts
git commit -m "feat(analyze): finalizer prompt, strict schema and config knobs"
```

---

### Task 11: Finalizer stage - call, validate, apply

**Files:**
- Create: `apps/worker/src/analyze-v2/finalize.ts`
- Test: `apps/worker/src/__tests__/finalize.test.ts`

**Context:** This is where every safety rule lives. Read `critic.ts` first for the established call/fallback pattern, and `snap.ts` for `snapNodes`. The stage must never throw.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/finalize.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { applyFinalizerEntries } from "../analyze-v2/finalize";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import type { FinalizerEntry, SentenceNode, SnappedClip } from "../analyze-v2/types";

const cfg = loadAnalyzeConfig({});

function nodes(): SentenceNode[] {
  return Array.from({ length: 20 }, (_, i) => ({
    index: i, start: i * 3, end: i * 3 + 2.8,
    text: `Предложение номер ${i}.`,
    hasWords: true, trailingStrength: 1, leadingStrength: 1,
  }));
}

function clip(id: string, score: number, startNode = 0, endNode = 6): SnappedClip {
  return {
    verdict: {
      id, keep: true, score, grounded: true, selfContained: true,
      startNode, payoffNode: endNode, endNode,
      hookStartNode: startNode, hookEndNode: startNode + 1,
      title: `Заголовок ${id}`, description: "Описание",
      titleEvidenceNodes: [startNode + 1], descriptionEvidenceNodes: [startNode + 1],
      language: "ru",
    },
    startSec: startNode * 3, endSec: endNode * 3 + 2.8,
    hookStartSec: startNode * 3, hookEndSec: (startNode + 1) * 3 + 2.8,
    payoffSec: endNode * 3 + 2.8, shortMoment: false,
  };
}

const entry = (p: Partial<FinalizerEntry> & { id: string }): FinalizerEntry => ({
  verdict: "ship", dropReason: null, duplicateOf: null, sharedClaim: null,
  title: null, titleEvidenceNodes: null, trimStartNode: null, ...p,
});

describe("applyFinalizerEntries", () => {
  it("ships everything when the finalizer approves", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(clips, [entry({ id: "a" }), entry({ id: "b" })], nodes(), cfg);
    expect(r.clips).toHaveLength(2);
    expect(r.telemetry.finalizerDrops).toEqual([]);
  });

  it("drops a clip with its reason recorded", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [entry({ id: "a" }), entry({ id: "b", verdict: "drop", dropReason: "no_payoff" })],
      nodes(),
      cfg
    );
    expect(r.clips.map((c) => c.verdict.id)).toEqual(["a"]);
    expect(r.telemetry.finalizerDrops).toEqual([{ id: "b", reason: "no_payoff" }]);
  });

  it("keeps the stronger clip of a duplicate pair", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [entry({ id: "a" }), entry({ id: "b", verdict: "drop", dropReason: "duplicate", duplicateOf: "a", sharedClaim: "одно и то же" })],
      nodes(),
      cfg
    );
    expect(r.clips.map((c) => c.verdict.id)).toEqual(["a"]);
  });

  it("never empties the set: the drop cap holds", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(
      clips,
      [
        entry({ id: "a", verdict: "drop", dropReason: "incoherent" }),
        entry({ id: "b", verdict: "drop", dropReason: "incoherent" }),
      ],
      nodes(),
      cfg
    );
    expect(r.clips).toHaveLength(1);
    expect(r.telemetry.dropCapHits).toBe(1);
  });

  it("applies a valid start trim and re-snaps the boundaries", () => {
    const r = applyFinalizerEntries([clip("a", 0.9)], [entry({ id: "a", trimStartNode: 2 })], nodes(), cfg);
    expect(r.clips[0].verdict.startNode).toBe(2);
    expect(r.clips[0].startSec).toBeGreaterThan(0);
    expect(r.telemetry.openingTrims).toBe(1);
  });

  it("rejects a trim at or past the payoff", () => {
    const r = applyFinalizerEntries([clip("a", 0.9)], [entry({ id: "a", trimStartNode: 6 })], nodes(), cfg);
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected).toBe(1);
  });

  it("rejects a trim that would make the clip too short", () => {
    const r = applyFinalizerEntries([clip("a", 0.9, 0, 2)], [entry({ id: "a", trimStartNode: 1 })], nodes(), cfg);
    expect(r.clips[0].verdict.startNode).toBe(0);
    expect(r.telemetry.trimRejected).toBe(1);
  });

  it("applies a grounded title rewrite", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "Честный заголовок", titleEvidenceNodes: [3] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Честный заголовок");
    expect(r.telemetry.titleRewrites).toBe(1);
  });

  it("rejects a rewrite whose evidence lies outside the clip", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "Заголовок из другого клипа", titleEvidenceNodes: [17] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toBe(1);
  });

  it("rejects a rewrite whose evidence falls outside only AFTER a trim", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", trimStartNode: 3, title: "Новый", titleEvidenceNodes: [1] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.startNode).toBe(3);
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toBe(1);
  });

  it("rejects an over-length title", () => {
    const r = applyFinalizerEntries(
      [clip("a", 0.9)],
      [entry({ id: "a", title: "х".repeat(90), titleEvidenceNodes: [3] })],
      nodes(),
      cfg
    );
    expect(r.clips[0].verdict.title).toBe("Заголовок a");
    expect(r.telemetry.rewriteRejected).toBe(1);
  });

  it("ignores entries for unknown ids and ships clips with no entry", () => {
    const clips = [clip("a", 0.9), clip("b", 0.8, 8, 14)];
    const r = applyFinalizerEntries(clips, [entry({ id: "zz", verdict: "drop", dropReason: "incoherent" })], nodes(), cfg);
    expect(r.clips).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/finalize.test.ts"`
Expected: FAIL - cannot resolve `../analyze-v2/finalize`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/analyze-v2/finalize.ts`. Model the LLM call on `critic.ts` (same `callJsonSchema` + fallback-model pattern):

```typescript
import type OpenAI from "openai";
import type { AnalyzeConfig } from "./config";
import { callJsonSchema } from "./llm";
import { FINALIZER_SCHEMA } from "./schemas";
import { finalizerSystemPrompt, finalizerUserPrompt } from "./prompts";
import { isCleanStart } from "./sentence-graph";
import { snapNodes } from "./snap";
import { scriptMismatch } from "./language";
import { findHookDuplicates, resolveDuplicates } from "./dedup";
import type {
  FinalizerEntry,
  LlmUsage,
  SentenceNode,
  SnappedClip,
} from "./types";

const MAX_TITLE_CHARS = 70;

export interface FinalizeTelemetry {
  hookDedupDrops: Array<{ id: string; duplicateOf: string }>;
  semanticDedupDrops: Array<{ id: string; duplicateOf: string; sharedClaim: string | null }>;
  finalizerDrops: Array<{ id: string; reason: string }>;
  titleRewrites: number;
  openingTrims: number;
  trimRejected: number;
  rewriteRejected: number;
  dropCapHits: number;
  finalizerSkipped?: string;
}

export interface FinalizeResult {
  clips: SnappedClip[];
  telemetry: FinalizeTelemetry;
}

function emptyTelemetry(): FinalizeTelemetry {
  return {
    hookDedupDrops: [], semanticDedupDrops: [], finalizerDrops: [],
    titleRewrites: 0, openingTrims: 0, trimRejected: 0,
    rewriteRejected: 0, dropCapHits: 0,
  };
}

/**
 * Deterministic application of finalizer output. Pure: no I/O, no LLM.
 * Every model instruction passes a code gate before it changes anything -
 * boundaries stay code-owned (spec 2026-07-24 §4.4).
 */
export function applyFinalizerEntries(
  clips: SnappedClip[],
  entries: FinalizerEntry[],
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): FinalizeResult {
  const telemetry = emptyTelemetry();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const scores: Record<string, number> = {};
  for (const c of clips) scores[c.verdict.id] = c.verdict.score;

  // 1. drops, resolved through the shared duplicate machinery so the cap,
  //    cycles and chains behave identically for both dedup sources
  const claims = [];
  const plainDrops: Array<{ id: string; reason: string }> = [];
  for (const c of clips) {
    const e = byId.get(c.verdict.id);
    if (!e || e.verdict !== "drop") continue;
    if (e.duplicateOf && scores[e.duplicateOf] !== undefined) {
      claims.push({ id: e.id, duplicateOf: e.duplicateOf });
    } else {
      plainDrops.push({ id: e.id, reason: e.dropReason ?? "incoherent" });
    }
  }
  const maxDrops = Math.floor(clips.length / 2);
  const dupDrops = resolveDuplicates(claims, scores, maxDrops);
  const remaining = maxDrops - dupDrops.length;
  const sortedPlain = plainDrops.sort((a, b) => scores[a.id] - scores[b.id]);
  const acceptedPlain = sortedPlain.slice(0, Math.max(0, remaining));
  telemetry.dropCapHits =
    claims.length + plainDrops.length - dupDrops.length - acceptedPlain.length;

  const dropped = new Set([...dupDrops, ...acceptedPlain.map((d) => d.id)]);
  for (const id of dupDrops) {
    const e = byId.get(id);
    telemetry.semanticDedupDrops.push({
      id, duplicateOf: e?.duplicateOf ?? "", sharedClaim: e?.sharedClaim ?? null,
    });
  }
  telemetry.finalizerDrops = acceptedPlain;

  // 2. trims and rewrites on survivors
  const out: SnappedClip[] = [];
  for (const clip of clips) {
    if (dropped.has(clip.verdict.id)) continue;
    const e = byId.get(clip.verdict.id);
    if (!e) {
      out.push(clip);
      continue;
    }
    let current = clip;

    if (e.trimStartNode !== null) {
      const trimmed = tryTrim(current, e.trimStartNode, nodes, cfg);
      if (trimmed) {
        current = trimmed;
        telemetry.openingTrims += 1;
      } else {
        telemetry.trimRejected += 1;
      }
    }

    if (e.title !== null) {
      const rewritten = tryRewrite(current, e, nodes);
      if (rewritten) {
        current = rewritten;
        telemetry.titleRewrites += 1;
      } else {
        telemetry.rewriteRejected += 1;
      }
    }

    out.push(current);
  }

  return { clips: out, telemetry };
}

/** A trim must be a legal clip start, sit before the payoff, and survive a
 *  full re-snap - otherwise the original boundaries stand. */
function tryTrim(
  clip: SnappedClip,
  target: number,
  nodes: SentenceNode[],
  cfg: AnalyzeConfig
): SnappedClip | null {
  const v = clip.verdict;
  if (!Number.isInteger(target)) return null;
  if (target <= v.startNode || target >= v.payoffNode) return null;
  if (!nodes[target] || !isCleanStart(nodes, target)) return null;
  const candidate = {
    ...v,
    startNode: target,
    hookStartNode: Math.max(v.hookStartNode, target),
    hookEndNode: Math.max(v.hookEndNode, target + 1),
  };
  const snapped = snapNodes(candidate, nodes, cfg);
  return snapped.ok ? snapped.clip : null;
}

/** A rewrite must be short enough, in the clip's language, and grounded in
 *  evidence nodes that lie inside the clip's FINAL range. */
function tryRewrite(
  clip: SnappedClip,
  entry: FinalizerEntry,
  nodes: SentenceNode[]
): SnappedClip | null {
  const title = (entry.title ?? "").trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) return null;
  const evidence = entry.titleEvidenceNodes;
  if (!Array.isArray(evidence) || evidence.length === 0) return null;
  const { startNode, endNode } = clip.verdict;
  for (const idx of evidence) {
    if (!Number.isInteger(idx) || idx < startNode || idx > endNode) return null;
  }
  const clipText = nodes
    .slice(startNode, endNode + 1)
    .filter((n) => n.hasWords)
    .map((n) => n.text)
    .join(" ");
  if (scriptMismatch(title, clipText)) return null;
  return {
    ...clip,
    verdict: { ...clip.verdict, title, titleEvidenceNodes: evidence },
  };
}

/**
 * Full FINALIZE stage: deterministic hook dedup, then one LLM pass.
 * NEVER throws - any failure ships the input set with a recorded reason.
 */
export async function finalizeClips(
  client: OpenAI,
  usage: LlmUsage,
  clips: SnappedClip[],
  nodes: SentenceNode[],
  languageIso: string,
  languageName: string,
  cfg: AnalyzeConfig,
  options: { retryDelayMs?: number } = {}
): Promise<FinalizeResult> {
  if (clips.length === 0) return { clips, telemetry: emptyTelemetry() };

  // deterministic layer first - it survives an LLM outage
  const hookClaims = findHookDuplicates(
    clips.map((c) => ({
      id: c.verdict.id,
      score: c.verdict.score,
      hook: nodes[c.verdict.startNode]?.text ?? "",
    })),
    cfg.hookDedupSimilarity
  );
  const scores: Record<string, number> = {};
  for (const c of clips) scores[c.verdict.id] = c.verdict.score;
  const hookDrops = new Set(
    resolveDuplicates(hookClaims, scores, Math.floor(clips.length / 2))
  );
  const survivors = clips.filter((c) => !hookDrops.has(c.verdict.id));
  const hookDedupDrops = hookClaims
    .filter((c) => hookDrops.has(c.id))
    .map((c) => ({ id: c.id, duplicateOf: c.duplicateOf }));

  if (!cfg.finalizerEnabled || survivors.length === 0) {
    return {
      clips: survivors,
      telemetry: { ...emptyTelemetry(), hookDedupDrops, finalizerSkipped: "disabled" },
    };
  }

  const call = await callJsonSchema<{ clips: Array<Record<string, unknown>> }>(
    client,
    usage,
    {
      model: cfg.finalizerModel,
      system: finalizerSystemPrompt(languageIso, languageName),
      user: finalizerUserPrompt(survivors, nodes),
      schema: FINALIZER_SCHEMA as never,
      reasoningEffort: cfg.reasoningEffort,
      retryDelayMs: options.retryDelayMs,
    }
  );

  if (!call.ok) {
    return {
      clips: survivors,
      telemetry: { ...emptyTelemetry(), hookDedupDrops, finalizerSkipped: call.kind },
    };
  }

  const entries: FinalizerEntry[] = (call.data.clips ?? []).map((raw) => ({
    id: String(raw.id ?? ""),
    verdict: raw.verdict === "drop" ? "drop" : "ship",
    dropReason: (raw.drop_reason as FinalizerEntry["dropReason"]) ?? null,
    duplicateOf: (raw.duplicate_of as string | null) ?? null,
    sharedClaim: (raw.shared_claim as string | null) ?? null,
    title: (raw.title as string | null) ?? null,
    titleEvidenceNodes: (raw.title_evidence_nodes as number[] | null) ?? null,
    trimStartNode: (raw.trim_start_node as number | null) ?? null,
  }));

  const applied = applyFinalizerEntries(survivors, entries, nodes, cfg);
  return {
    clips: applied.clips,
    telemetry: { ...applied.telemetry, hookDedupDrops },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src/__tests__/finalize.test.ts"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/finalize.ts apps/worker/src/__tests__/finalize.test.ts
git commit -m "feat(analyze): finalize stage with code-gated trims, rewrites and drops"
```

---

### Task 12: Wire FINALIZE into the pipeline

**Files:**
- Modify: `apps/worker/src/analyze-v2/index.ts`, `apps/worker/src/analyze-v2/select.ts`
- Test: `apps/worker/src/__tests__/select.test.ts`

**Context:** Selection must hand the finalizer more clips than it ships, so drops are absorbed without a second LLM round. `selectAndOrder` currently slices to `cfg.softCap`; it gains an optional limit.

- [ ] **Step 1: Add the limit parameter (test first)**

Add to `apps/worker/src/__tests__/select.test.ts`:

```typescript
  it("honors an explicit limit above the soft cap", () => {
    const clips = Array.from({ length: 20 }, (_, i) => clip(i * 100, i * 100 + 30, 0.9));
    expect(selectAndOrder(clips, cfg).selected).toHaveLength(cfg.softCap);
    expect(selectAndOrder(clips, cfg, cfg.softCap + 4).selected).toHaveLength(cfg.softCap + 4);
  });
```

Run it - FAILS (third argument ignored).

- [ ] **Step 2: Implement**

In `select.ts`, change the signature and the final slice:

```typescript
export function selectAndOrder(
  clips: SnappedClip[],
  cfg: AnalyzeConfig,
  limit: number = cfg.softCap
): SelectionResult {
```

```typescript
  return { selected: kept.slice(0, limit), tier, droppedByNms };
```

- [ ] **Step 3: Wire the stage in `index.ts`**

Add imports:

```typescript
import { finalizeClips } from "./finalize";
```

and extend the existing `./language` import to include `isoToLanguageName` (it sits beside `dominantScript` and `scriptMismatch`, both already imported there).

Replace the selection block:

```typescript
  const selection = selectAndOrder(eligible, cfg, cfg.softCap + cfg.finalizerHeadroom);
  const finalized = await finalizeClips(
    client,
    usage,
    selection.selected,
    nodes,
    languageIso,
    isoToLanguageName(languageIso),
    cfg,
    { retryDelayMs: options.retryDelayMs }
  );
  const highlights = finalized.clips.slice(0, cfg.softCap).map(toHighlight);
```

And extend the telemetry object with `...finalized.telemetry` right after `droppedByNms`.

- [ ] **Step 4: Full suite and typecheck**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: unit tests pass. `eval-snapshot` WILL fail with `runFixture`'s "fixture is stale: N unrecorded request(s)" error - the finalizer call is new and has no recording. That is expected and is handled in Task 13.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/analyze-v2/index.ts apps/worker/src/analyze-v2/select.ts apps/worker/src/__tests__/select.test.ts
git commit -m "feat(analyze): wire FINALIZE between selection and the cap"
```

---

### Task 13: Re-record fixtures, review diffs, close the regression net

**Files:**
- Modify: `apps/worker/src/__tests__/fixtures/eval/*/{responses,snapshot}.json`
- Modify: `apps/worker/src/__tests__/eval-regressions.test.ts`

- [ ] **Step 1: Re-record both fixtures with the finalizer live**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts cmrzcqhl6000138lkg41n8bs0 podcast-ecology"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-record.ts <SECOND_JOB_ID> podcast-answer-arc"
```

- [ ] **Step 2: Diff the new snapshots against the committed ones**

```bash
git diff apps/worker/src/__tests__/fixtures/eval/*/snapshot.json
```

Paste this diff into your report. Expected on `podcast-ecology`: the teaser clip is gone, one of the duplicate pair is gone, the meandering clip starts later. Anything else - a clip disappearing for no stated reason, boundaries moving on untouched clips - is a defect to report, not to bless.

- [ ] **Step 3: Add the remaining Tier-1 regressions**

Append to `apps/worker/src/__tests__/eval-regressions.test.ts`:

```typescript
  it("ships only one clip per opening line", async () => {
    const result = await runFixture(loadFixture("podcast-ecology"));
    const hooks = result.highlights.map((h) => h.title.toLowerCase().slice(0, 40));
    expect(new Set(hooks).size, "two clips share an opening").toBe(hooks.length);
  });

  it("the bacteria clip opens on its topic, not on the tangent", async () => {
    const result = await runFixture(loadFixture("podcast-ecology"));
    const clip = result.highlights.find((h) => /бактери|пластик/i.test(h.title));
    if (!clip) return; // dropped entirely is an acceptable outcome
    expect(clip.start).toBeGreaterThan(557);
  });
```

- [ ] **Step 4: Full verification**

```bash
docker compose exec worker-analyze sh -c "cd /app && npx vitest run --root /app apps/worker/src"
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc -p tsconfig.typecheck.json --noEmit"
```

Expected: everything green, including `eval-snapshot` against the freshly recorded snapshots.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/__tests__/fixtures/eval apps/worker/src/__tests__/eval-regressions.test.ts
git commit -m "test(analyze): re-record fixtures with finalizer, close remaining regressions"
```

---

### Task 14: Env documentation and rollout

**Files:**
- Modify: `.env.example`
- Modify: `.env` (LIVE, not committed - only if the owner approves enabling)

- [ ] **Step 1: Document the knobs**

In `.env.example`, after the `QUESTION_END_SCORE_BONUS` line:

```bash
QUESTION_TITLE_SCORE_BONUS=0.15  # question title whose hook spans the whole clip
ANALYZE_FINALIZER=on             # on | off - final cross-clip judge
OPENAI_FINALIZER_MODEL=          # defaults to OPENAI_CRITIC_MODEL
FINALIZER_HEADROOM=4             # clips passed to the finalizer above the soft cap
HOOK_DEDUP_SIMILARITY=0.8        # Jaccard floor for identical-opening dedup
TEASER_WINDOW_SEC=120            # intro window checked for montage recurrence
TEASER_RECURRENCE_FRAC=0.5       # share of 5-grams recurring later = montage
```

- [ ] **Step 2: Restart the analyze worker**

```bash
docker compose restart worker-analyze
docker compose logs worker-analyze --tail 5
```

Expected: clean start, no crash loop. The finalizer defaults to `on` in code, so no `.env` change is required to enable it.

- [ ] **Step 3: Add the production telemetry summary (spec §5.5)**

Create `apps/worker/src/scripts/eval-telemetry.ts`:

```typescript
/**
 * Summarizes ANALYZE telemetry across recent jobs - the only view here that
 * sees real traffic rather than frozen fixtures.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/eval-telemetry.ts [limit]"
 */
import { prisma } from "@clipclap/shared";

async function main() {
  const limit = Number(process.argv[2]) || 20;
  const jobs = await prisma.job.findMany({
    where: { status: "DONE", highlightsVersion: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, createdAt: true, clipsGenerated: true, highlights: true },
  });

  const reasons: Record<string, number> = {};
  let clips = 0;
  for (const job of jobs) {
    clips += job.clipsGenerated ?? 0;
    const meta = (job.highlights as { telemetry?: Record<string, unknown> } | null)?.telemetry;
    for (const key of ["gateDropReasons"] as const) {
      const hist = (meta?.[key] ?? {}) as Record<string, number>;
      for (const [reason, n] of Object.entries(hist)) reasons[reason] = (reasons[reason] ?? 0) + n;
    }
    for (const key of ["finalizerDrops", "semanticDedupDrops", "hookDedupDrops", "teaserDrops"] as const) {
      const list = (meta?.[key] ?? []) as unknown[];
      if (list.length > 0) reasons[key] = (reasons[key] ?? 0) + list.length;
    }
  }

  console.log(`jobs=${jobs.length} meanClips=${(clips / Math.max(1, jobs.length)).toFixed(1)}`);
  console.log("drop reasons:", JSON.stringify(reasons, null, 1));
  process.exit(0);
}

main();
```

Run it once to confirm it works against real data (`highlights` may store telemetry differently - if the telemetry is not on `Job.highlights`, find where `analyzeHighlightsV2`'s telemetry is persisted and read it from there; do not invent a column).

- [ ] **Step 4: Report to the owner**

Summarize: the snapshot diffs from Task 13 (what changed on the two real jobs), the telemetry fields now available, and the kill switches (`ANALYZE_FINALIZER=off`, `TEASER_RECURRENCE_FRAC=2`). The owner then re-uploads the podcast and judges with cold eyes.

- [ ] **Step 5: Commit**

```bash
git add .env.example apps/worker/src/scripts/eval-telemetry.ts
git commit -m "docs: document finalizer and teaser env knobs, add telemetry summary"
```
