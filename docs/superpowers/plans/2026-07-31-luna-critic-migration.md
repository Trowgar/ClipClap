# Luna Critic Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the critic, copy repair and finalizer from `gpt-5.1` to `gpt-5.6-luna` (-87% analysis cost), and make cost telemetry honest enough that the next model change cannot silently write wrong numbers.

**Architecture:** Three phases in strict order. Phase A fixes cost telemetry (prices out of code into env, one model default instead of two, model recorded on the job row) - it must land first, because otherwise the migration itself writes wrong data from the first job. Phase B teaches the eval harness to hold two models' recorded responses in one fixture, so the migration diff isolates the judge's decision from scanner sampling noise. Phase C performs the migration against that harness.

**Tech Stack:** TypeScript, vitest, Prisma, Docker Compose, OpenAI SDK.

**Spec:** `docs/superpowers/specs/2026-07-31-luna-critic-migration-design.md`

---

## Environment notes (read before Task 1)

- **All tests run inside a container.** The host has Node v18 and vitest will not start. Use `worker-analyze`; it bind-mounts both `./apps/worker` and `./packages`, so worker tests and shared tests both run there.
- **Worker test command shape:**
  `docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/NAME.test.ts"`
- **Shared test command shape:**
  `docker compose exec worker-analyze sh -c "cd /app/packages/shared && npx vitest run --root /app packages/shared/src/config/__tests__/NAME.test.ts"`
- **A change to `.env` needs `docker compose up -d <service>`, never `docker compose restart`.**
  `restart` reuses the existing container's configuration and does not re-read `env_file`, so the
  variable appears set on disk while the process still sees the old value. This was observed on
  2026-07-31: `MODEL_PRICES_JSON` was in `.env` and the worker kept logging it as unset until the
  container was recreated. `up -d` recreates it, which then requires re-running `prisma generate`
  in each recreated service.
- **After ANY change under `packages/shared`:** run
  `docker compose exec worker-analyze sh -c "cd /app && npm run build -w @clipclap/shared"` and then
  `docker compose restart web`. The web app imports shared from `dist` and Next caches it; skipping this ships a stale module.
- **Commit identity:** `git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit`. No Claude attribution trailer.
- **Punctuation in code comments and docs:** plain hyphens only. No em-dashes or en-dashes.

---

## File Structure

**Phase A - telemetry**

| File | Responsibility |
|---|---|
| `packages/shared/src/config/model-prices.ts` (new) | Parse and validate `MODEL_PRICES_JSON`; look up a token price or an audio price. Knows nothing about jobs. |
| `packages/shared/src/config/__tests__/model-prices.test.ts` (new) | Parsing, validation, and the loud-failure behaviour. |
| `packages/shared/src/config/index.ts` (modify) | Export the new module. |
| `apps/worker/src/model-selection.ts` (new) | Single source of truth for "which critic model" and "which transcription model". Removes the duplicated literals. |
| `apps/worker/src/__tests__/model-selection.test.ts` (new) | Ties `criticModel()` to `loadAnalyzeConfig()` so the two cannot drift. |
| `apps/worker/src/cost-telemetry.ts` (modify) | Compute costs from injected prices; return `null` when a price is unknown. No fabricated constants. |
| `apps/worker/src/__tests__/cost-telemetry.test.ts` (modify) | Updated for the new signature and the null-on-unknown rule. |
| `packages/shared/src/config/model-prices.example.json` (new) | The canonical shipped price table. Lives under `packages/` because that is bind-mounted into the containers - see Task 4 for why `.env.example` cannot hold it. |
| `apps/worker/src/__tests__/env-prices-binding.test.ts` (new) | Asserts the shipped table prices every model the default config can reach. This is the "changed model, forgot price" catcher. |
| `apps/worker/src/stages/finalize.ts` (modify) | Use `model-selection.ts` and pass prices in; write the two new model columns. |
| `apps/worker/src/processors/transcribe.ts` (modify) | Use `model-selection.ts` for the transcription model. |
| `apps/worker/src/index.ts` (modify) | Warn at boot when a configured model has no price. |
| `prisma/schema.prisma` (modify) | Two nullable columns on `Job`. |
| `apps/worker/src/scripts/backfill-job-models.ts` (new) | One-off backfill of the two columns for existing rows. |
| `.env.example` (modify) | Document `MODEL_PRICES_JSON` and `COMPUTE_COST_PER_MINUTE_USD`, and point at the canonical table rather than duplicating it. |

**Phase B - fixture variants**

| File | Responsibility |
|---|---|
| `apps/worker/src/__tests__/fixtures/eval/variants.json` (new) | Declares what a named variant IS: a set of config overrides. One definition, four consumers. |
| `apps/worker/src/__tests__/helpers/eval-fixture.ts` (modify) | Load variant definitions, per-variant snapshots and fingerprints; run a fixture under a variant. |
| `apps/worker/src/__tests__/eval-snapshot.test.ts` (modify) | Iterate fixtures x variants instead of fixtures. |
| `apps/worker/src/scripts/eval-topup.ts` (modify) | `--variant NAME` records only the calls the variant adds, reusing every scanner response byte for byte. |
| `apps/worker/src/scripts/eval-bless.ts` (modify) | `--variant NAME` diffs and blesses that variant's snapshot. |

**Phase C - the migration**

| File | Responsibility |
|---|---|
| `apps/worker/src/scripts/measure-critic-budget.ts` (new) | Measures Luna's reasoning-token demand per batch size. Replaces the projection with a measurement. |
| `apps/worker/src/analyze-v2/config.ts` (modify) | Default critic and finalizer model become `gpt-5.6-luna`. |
| `apps/worker/src/analyze-v2/critic.ts` (modify) | Token budget constants, if the measurement says they must move. |
| `apps/worker/src/analyze-v2/finalize.ts` (modify) | Same. |
| `docs/engine-notes.md` (modify) | Record the measured numbers. |

---

# Phase A - Telemetry correctness

## Task 1: Price source module in shared

Prices leave the source tree. A price compiled into code goes stale silently; the 80% Luna cut on 2026-07-31 happened inside a single day.

**Files:**
- Create: `packages/shared/src/config/model-prices.ts`
- Create: `packages/shared/src/config/__tests__/model-prices.test.ts`
- Modify: `packages/shared/src/config/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/config/__tests__/model-prices.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  audioPricePerMinute,
  EMPTY_MODEL_PRICES,
  loadModelPrices,
  tokenPrice,
} from "../model-prices";

const VALID = JSON.stringify({
  tokensPerMillionUsd: {
    "gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "gpt-5.1": { input: 1.25, output: 10 },
  },
  audioPerMinuteUsd: { "whisper-1": 0.006 },
});

describe("loadModelPrices", () => {
  it("parses both price kinds from MODEL_PRICES_JSON", () => {
    const prices = loadModelPrices({ MODEL_PRICES_JSON: VALID }, () => {});
    expect(tokenPrice(prices, "gpt-5.6-luna")).toEqual({ input: 0.2, output: 1.2 });
    expect(audioPricePerMinute(prices, "whisper-1")).toBe(0.006);
  });

  it("returns no prices and warns when the variable is unset", () => {
    const warn = vi.fn();
    expect(loadModelPrices({}, warn)).toEqual(EMPTY_MODEL_PRICES);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns no prices and warns on malformed JSON, never a partial parse", () => {
    const warn = vi.fn();
    const prices = loadModelPrices({ MODEL_PRICES_JSON: '{"tokensPerMillionUsd":' }, warn);
    expect(prices).toEqual(EMPTY_MODEL_PRICES);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns no prices when the payload is not an object", () => {
    const warn = vi.fn();
    expect(loadModelPrices({ MODEL_PRICES_JSON: "[1,2]" }, warn)).toEqual(EMPTY_MODEL_PRICES);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops individual malformed entries and keeps the good ones", () => {
    const warn = vi.fn();
    const prices = loadModelPrices(
      {
        MODEL_PRICES_JSON: JSON.stringify({
          tokensPerMillionUsd: {
            good: { input: 1, output: 2 },
            missingOutput: { input: 1 },
            negative: { input: -1, output: 2 },
            notAnObject: 5,
          },
          audioPerMinuteUsd: { good: 0.006, bad: "cheap" },
        }),
      },
      warn
    );
    expect(Object.keys(prices.tokensPerMillionUsd)).toEqual(["good"]);
    expect(Object.keys(prices.audioPerMinuteUsd)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("accepts a free model priced at zero", () => {
    const prices = loadModelPrices(
      { MODEL_PRICES_JSON: JSON.stringify({ tokensPerMillionUsd: { free: { input: 0, output: 0 } } }) },
      () => {}
    );
    expect(tokenPrice(prices, "free")).toEqual({ input: 0, output: 0 });
  });
});

describe("lookups", () => {
  it("returns undefined for an unknown model rather than a fallback price", () => {
    const prices = loadModelPrices({ MODEL_PRICES_JSON: VALID }, () => {});
    expect(tokenPrice(prices, "some-model-we-never-priced")).toBeUndefined();
    expect(audioPricePerMinute(prices, "some-asr-we-never-priced")).toBeUndefined();
  });

  it("treats an empty model name as unknown", () => {
    const prices = loadModelPrices({ MODEL_PRICES_JSON: VALID }, () => {});
    expect(tokenPrice(prices, "")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker compose exec worker-analyze sh -c "cd /app/packages/shared && npx vitest run --root /app packages/shared/src/config/__tests__/model-prices.test.ts"
```

Expected: FAIL, `Cannot find module '../model-prices'`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/config/model-prices.ts`:

```ts
/**
 * Model prices, read from the environment and never from this file.
 *
 * A price compiled into source goes stale silently. On 2026-07-31 OpenAI cut
 * GPT-5.6 Luna by 80% in a single day; a table in the repo would have kept
 * reporting the old figure until someone happened to notice. So there is no
 * table here - only a parser, a validator and two lookups.
 *
 * The load-bearing rule is that an unknown model yields `undefined`, never a
 * default price. A plausible wrong number reaches reports and free-tier
 * settlement and is believed; an empty cell is honest and gets investigated.
 */

export interface TokenPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface ModelPrices {
  /** Chat/completion models, by exact model id. */
  tokensPerMillionUsd: Record<string, TokenPrice>;
  /** Transcription models, USD per minute of audio, by exact model id. */
  audioPerMinuteUsd: Record<string, number>;
}

export const EMPTY_MODEL_PRICES: ModelPrices = Object.freeze({
  tokensPerMillionUsd: {},
  audioPerMinuteUsd: {},
});

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

/** Zero is a legitimate price - free tiers exist - so the floor is >= 0. */
function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readTokenPrices(raw: unknown, warn: Warn): Record<string, TokenPrice> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warn("[model-prices] tokensPerMillionUsd is not an object - ignoring it.");
    return {};
  }
  const out: Record<string, TokenPrice> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      warn(`[model-prices] tokensPerMillionUsd["${model}"] is not an object - dropped.`);
      continue;
    }
    const { input, output } = value as { input?: unknown; output?: unknown };
    if (!isPrice(input) || !isPrice(output)) {
      warn(
        `[model-prices] tokensPerMillionUsd["${model}"] needs finite non-negative ` +
          `input and output - dropped.`
      );
      continue;
    }
    out[model] = { input, output };
  }
  return out;
}

function readAudioPrices(raw: unknown, warn: Warn): Record<string, number> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warn("[model-prices] audioPerMinuteUsd is not an object - ignoring it.");
    return {};
  }
  const out: Record<string, number> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPrice(value)) {
      warn(
        `[model-prices] audioPerMinuteUsd["${model}"] needs a finite non-negative ` +
          `number - dropped.`
      );
      continue;
    }
    out[model] = value;
  }
  return out;
}

/**
 * Parses MODEL_PRICES_JSON. Any failure to understand the payload as a whole
 * yields NO prices rather than a partial reading: a half-applied price table is
 * the same plausible-wrong-number failure this module exists to remove.
 * Individual malformed entries are dropped and named, because there the rest of
 * the table is still trustworthy.
 */
export function loadModelPrices(
  env: Env = process.env,
  warn: Warn = console.warn
): ModelPrices {
  const raw = env.MODEL_PRICES_JSON;
  if (raw === undefined || raw.trim() === "") {
    warn("[model-prices] MODEL_PRICES_JSON is unset - no cost figures will be recorded.");
    return EMPTY_MODEL_PRICES;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("[model-prices] MODEL_PRICES_JSON is not valid JSON - no cost figures will be recorded.");
    return EMPTY_MODEL_PRICES;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn("[model-prices] MODEL_PRICES_JSON is not an object - no cost figures will be recorded.");
    return EMPTY_MODEL_PRICES;
  }
  const root = parsed as Record<string, unknown>;
  return {
    tokensPerMillionUsd: readTokenPrices(root.tokensPerMillionUsd, warn),
    audioPerMinuteUsd: readAudioPrices(root.audioPerMinuteUsd, warn),
  };
}

export function tokenPrice(prices: ModelPrices, model: string): TokenPrice | undefined {
  if (!model) return undefined;
  return prices.tokensPerMillionUsd[model];
}

export function audioPricePerMinute(prices: ModelPrices, model: string): number | undefined {
  if (!model) return undefined;
  return prices.audioPerMinuteUsd[model];
}
```

- [ ] **Step 4: Export from the config barrel**

In `packages/shared/src/config/index.ts`, add after the `plans` exports:

```ts
export {
  loadModelPrices,
  tokenPrice,
  audioPricePerMinute,
  EMPTY_MODEL_PRICES,
} from "./model-prices";
export type { ModelPrices, TokenPrice } from "./model-prices";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
docker compose exec worker-analyze sh -c "cd /app/packages/shared && npx vitest run --root /app packages/shared/src/config/__tests__/model-prices.test.ts"
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Rebuild shared and restart web**

```bash
docker compose exec worker-analyze sh -c "cd /app && npm run build -w @clipclap/shared"
docker compose restart web
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/config/model-prices.ts \
        packages/shared/src/config/__tests__/model-prices.test.ts \
        packages/shared/src/config/index.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(shared): read model prices from the environment

An unknown model yields undefined rather than a default price. A plausible
wrong number reaches reports and free-tier settlement and gets believed; an
empty cell gets investigated."
```

---

## Task 2: One model default, not two

`stages/finalize.ts` carries `process.env.OPENAI_CRITIC_MODEL || "gpt-5.1"`, independent of the default in `analyze-v2/config.ts`. Change the model in config alone and the engine uses one model while pricing uses another. `transcribe.ts` and `finalize.ts` duplicate the transcription model literal the same way.

**Files:**
- Create: `apps/worker/src/model-selection.ts`
- Create: `apps/worker/src/__tests__/model-selection.test.ts`
- Modify: `apps/worker/src/processors/transcribe.ts:153`
- Modify: `apps/worker/src/stages/finalize.ts:31-35`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/model-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { criticModel, transcriptionModel } from "../model-selection";
import { loadAnalyzeConfig } from "../analyze-v2/config";

describe("criticModel", () => {
  it("is the same value the engine config resolves, on default env", () => {
    // The whole point: pricing and the engine must never read different
    // defaults. A second literal anywhere reds this test.
    expect(criticModel({})).toBe(loadAnalyzeConfig({}).criticModel);
  });

  it("is the same value the engine config resolves, on overridden env", () => {
    const env = { OPENAI_CRITIC_MODEL: "some-other-model" };
    expect(criticModel(env)).toBe(loadAnalyzeConfig(env).criticModel);
    expect(criticModel(env)).toBe("some-other-model");
  });
});

describe("transcriptionModel", () => {
  it("defaults to whisper-1", () => {
    expect(transcriptionModel({})).toBe("whisper-1");
  });

  it("honours OPENAI_TRANSCRIPTION_MODEL", () => {
    expect(transcriptionModel({ OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe" })).toBe(
      "gpt-4o-mini-transcribe"
    );
  });

  it("treats an empty value as unset rather than as a model named empty string", () => {
    expect(transcriptionModel({ OPENAI_TRANSCRIPTION_MODEL: "" })).toBe("whisper-1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/model-selection.test.ts"
```

Expected: FAIL, `Cannot find module '../models'`.

- [ ] **Step 3: Write the implementation**

Create `apps/worker/src/model-selection.ts`:

```ts
import { loadAnalyzeConfig } from "./analyze-v2/config";

type Env = Record<string, string | undefined>;

/**
 * Which model the ANALYZE stage's critic actually used.
 *
 * Read through loadAnalyzeConfig on purpose rather than from the env var
 * directly. The cost telemetry must price the model the engine really ran, and
 * a second copy of the default is exactly how those two drift: finalize.ts used
 * to carry its own "gpt-5.1" literal, so changing the default in config.ts
 * would have moved the engine while leaving pricing behind by roughly 8x.
 */
export function criticModel(env: Env = process.env): string {
  return loadAnalyzeConfig(env).criticModel;
}

/** Which model the TRANSCRIBE stage used. Same argument, same failure mode. */
export function transcriptionModel(env: Env = process.env): string {
  return env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/model-selection.test.ts"
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in transcribe.ts**

In `apps/worker/src/processors/transcribe.ts`, add to the imports at the top:

```ts
import { transcriptionModel } from "../model-selection";
```

Replace line 153:

```ts
    model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
```

with:

```ts
    model: transcriptionModel(),
```

- [ ] **Step 6: Use it in stages/finalize.ts**

In `apps/worker/src/stages/finalize.ts`, add to the imports at the top:

```ts
import { criticModel, transcriptionModel } from "../model-selection";
```

Replace these two lines inside the `buildJobCostTelemetry({ ... })` call:

```ts
          transcriptionModel:
            process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
```
```ts
          criticModel: process.env.OPENAI_CRITIC_MODEL || "gpt-5.1",
```

with:

```ts
          transcriptionModel: transcriptionModel(),
```
```ts
          criticModel: criticModel(),
```

- [ ] **Step 7: Verify no literal survives**

```bash
grep -rn '"gpt-5.1"\|"whisper-1"' apps/worker/src --include=*.ts \
  | grep -v __tests__ | grep -v analyze-v2/config.ts | grep -v model-selection.ts | grep -v cost-telemetry.ts
```

Expected: no output.

`cost-telemetry.ts` is excluded on purpose and is NOT a leftover: it still holds the old `TRANSCRIPTION_COST_PER_MINUTE` and `MODEL_TOKEN_PRICES` tables, whose keys are model names. Those tables are deleted in Task 3, and the grep line above drops the exclusion at that point. The only remaining *defaults* after this task are in `analyze-v2/config.ts` and `model-selection.ts`.

- [ ] **Step 8: Run the worker suite to check nothing regressed**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/model-selection.ts apps/worker/src/__tests__/model-selection.test.ts \
        apps/worker/src/processors/transcribe.ts apps/worker/src/stages/finalize.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "fix(worker): one source of truth for which model ran

stages/finalize.ts carried its own gpt-5.1 literal beside the default in
analyze-v2/config.ts. Changing the model in config alone would have run Luna
and priced gpt-5.1 - an 8x overstatement that also flows into free settlement."
```

---

## Task 3: Cost telemetry computes from injected prices

**Files:**
- Modify: `apps/worker/src/cost-telemetry.ts` (full rewrite of the constants and the builder)
- Modify: `apps/worker/src/__tests__/cost-telemetry.test.ts` (full rewrite)
- Modify: `apps/worker/src/stages/finalize.ts` (pass prices in)

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `apps/worker/src/__tests__/cost-telemetry.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { loadModelPrices } from "@clipclap/shared";
import { buildJobCostTelemetry } from "../cost-telemetry";

const PRICES = loadModelPrices(
  {
    MODEL_PRICES_JSON: JSON.stringify({
      tokensPerMillionUsd: { "gpt-5.1": { input: 1.25, output: 10 } },
      audioPerMinuteUsd: { "whisper-1": 0.006, "gpt-4o-mini-transcribe": 0.003 },
    }),
  },
  () => {}
);

const BASE = {
  processingStartedAt: new Date("2026-07-31T10:00:00Z"),
  processingEndedAt: new Date("2026-07-31T10:12:30Z"),
  transcribeMs: 90_000,
  analyzeMs: 8_000,
  renderMs: 420_000,
  clipsGenerated: 4,
};

describe("buildJobCostTelemetry", () => {
  it("prices transcription per audio minute and analysis per token", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });

    // 60 min * 0.006 = 0.36
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.36);
    // 46000/1M * 1.25 + 11500/1M * 10 = 0.0575 + 0.115 = 0.1725 -> 0.173
    expect(telemetry.estimatedAnalysisCostUsd).toBe(0.173);
    expect(telemetry.estimatedTotalCostUsd).toBe(0.533);
  });

  it("uses the transcription model's own rate", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 600,
      transcriptionModel: "gpt-4o-mini-transcribe",
      criticModel: "gpt-5.1",
      analysisInputTokens: 1_000_000,
      analysisOutputTokens: 0,
      prices: PRICES,
    });
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.03);
    expect(telemetry.estimatedAnalysisCostUsd).toBe(1.25);
  });

  it("writes null, not a fallback, when the critic model has no price", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "a-model-nobody-priced",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBeNull();
    // and the total refuses to be a partial sum that reads like a whole one
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
    // the part we DO know is still reported
    expect(telemetry.estimatedTranscriptionCostUsd).toBe(0.36);
  });

  it("writes null when the transcription model has no price", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "an-asr-nobody-priced",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });
    expect(telemetry.estimatedTranscriptionCostUsd).toBeNull();
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
  });

  it("writes null analysis cost when no tokens were recorded, with no per-minute invention", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      prices: PRICES,
    });
    expect(telemetry.estimatedAnalysisCostUsd).toBeNull();
    expect(telemetry.estimatedTotalCostUsd).toBeNull();
  });

  it("omits compute cost unless a rate is configured", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
    });
    expect(telemetry.estimatedComputeCostUsd).toBeNull();
    // total is cash only, so it does not carry the compute line
    expect(telemetry.estimatedTotalCostUsd).toBe(0.533);
  });

  it("includes compute cost when a rate is configured, without changing the cash total", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      analysisInputTokens: 46_000,
      analysisOutputTokens: 11_500,
      prices: PRICES,
      computeCostPerMinuteUsd: 0.006,
    });
    expect(telemetry.estimatedComputeCostUsd).toBe(0.36);
    expect(telemetry.estimatedTotalCostUsd).toBe(0.533);
  });

  it("passes timing fields through untouched", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      prices: PRICES,
    });
    expect(telemetry.processingMs).toBe(750_000);
    expect(telemetry.transcribeMs).toBe(90_000);
    expect(telemetry.analyzeMs).toBe(8_000);
    expect(telemetry.renderMs).toBe(420_000);
    expect(telemetry.clipsGenerated).toBe(4);
  });

  it("records the models that produced the figures", () => {
    const telemetry = buildJobCostTelemetry({
      ...BASE,
      sourceDurationSec: 3600,
      transcriptionModel: "whisper-1",
      criticModel: "gpt-5.1",
      prices: PRICES,
    });
    expect(telemetry.criticModel).toBe("gpt-5.1");
    expect(telemetry.transcriptionModel).toBe("whisper-1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/cost-telemetry.test.ts"
```

Expected: FAIL. The current builder takes no `prices`, returns numbers rather than `null`, and returns no model fields.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `apps/worker/src/cost-telemetry.ts` with:

```ts
import {
  audioPricePerMinute,
  tokenPrice,
  type ModelPrices,
} from "@clipclap/shared";

/**
 * What a job cost, computed from facts.
 *
 * There is no price table in this file, and there must never be one again. The
 * old table went stale the moment a provider moved a price, and its
 * DEFAULT_TOKEN_PRICE fallback meant an unpriced model got gpt-5.1's price -
 * a confident wrong number rather than no number. Prices now arrive from the
 * environment (see @clipclap/shared model-prices) and an unknown model yields
 * null.
 *
 * Two fabricated constants were removed with it:
 *   - COMPUTE_COST_PER_MINUTE = 0.006, a hand-entered guess that happened to
 *     equal whisper's rate, which is why the compute column mirrored the
 *     transcription column in every row ever written. It is now an env rate,
 *     unset by default.
 *   - ANALYSIS_COST_PER_MINUTE = 0.00005, the no-token-usage fallback.
 *
 * estimatedTotalCostUsd is CASH ONLY (transcription + analysis) and is null
 * unless both parts are known. It deliberately excludes compute: the server is
 * rented whether a job runs or not, so compute is not money leaving the account
 * because of this job. free-settlement.ts sums the two cash lines directly and
 * documents the same rule - if a third cash line is ever added, add it here and
 * there; if a second non-cash line is added, add it only here.
 */

export interface JobCostTelemetryInput {
  sourceDurationSec: number | null | undefined;
  processingStartedAt: Date;
  processingEndedAt: Date;
  transcribeMs: number;
  analyzeMs: number;
  renderMs: number;
  clipsGenerated: number;
  transcriptionModel: string;
  /** Model whose price dominates analysis cost (the critic). */
  criticModel: string;
  analysisInputTokens?: number | null;
  analysisOutputTokens?: number | null;
  prices: ModelPrices;
  /** USD per source minute of rented capacity. Unset means "do not report it". */
  computeCostPerMinuteUsd?: number | null;
}

export function buildJobCostTelemetry(input: JobCostTelemetryInput) {
  const sourceMinutes = Math.max(0, (input.sourceDurationSec ?? 0) / 60);

  const audioRate = audioPricePerMinute(input.prices, input.transcriptionModel);
  const estimatedTranscriptionCostUsd =
    audioRate === undefined ? null : roundUsd(sourceMinutes * audioRate);

  const inputTokens = input.analysisInputTokens ?? 0;
  const outputTokens = input.analysisOutputTokens ?? 0;
  const hasTokenUsage = inputTokens > 0 || outputTokens > 0;
  const critic = tokenPrice(input.prices, input.criticModel);
  const estimatedAnalysisCostUsd =
    hasTokenUsage && critic !== undefined
      ? roundUsd(
          (inputTokens / 1_000_000) * critic.input +
            (outputTokens / 1_000_000) * critic.output
        )
      : null;

  const computeRate = input.computeCostPerMinuteUsd;
  const estimatedComputeCostUsd =
    computeRate === undefined || computeRate === null
      ? null
      : roundUsd(sourceMinutes * computeRate);

  // A partial sum would read exactly like a whole one. Refuse instead.
  const estimatedTotalCostUsd =
    estimatedTranscriptionCostUsd === null || estimatedAnalysisCostUsd === null
      ? null
      : roundUsd(estimatedTranscriptionCostUsd + estimatedAnalysisCostUsd);

  return {
    processingStartedAt: input.processingStartedAt,
    processingEndedAt: input.processingEndedAt,
    processingMs:
      input.processingEndedAt.getTime() - input.processingStartedAt.getTime(),
    transcribeMs: input.transcribeMs,
    analyzeMs: input.analyzeMs,
    renderMs: input.renderMs,
    clipsGenerated: input.clipsGenerated,
    criticModel: input.criticModel,
    transcriptionModel: input.transcriptionModel,
    estimatedTranscriptionCostUsd,
    estimatedAnalysisCostUsd,
    estimatedComputeCostUsd,
    estimatedTotalCostUsd,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/cost-telemetry.test.ts"
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Feed prices in from the finalize stage**

In `apps/worker/src/stages/finalize.ts`, add to the imports at the top:

```ts
import { loadModelPrices } from "@clipclap/shared";
```

Add this module-level constant just below the imports (parsed once per process, not per job):

```ts
/** Parsed once at module load: the price table does not change under a running
 *  worker, and re-parsing per job would multiply the warning noise by traffic. */
const MODEL_PRICES = loadModelPrices();

/** Optional. Unset means compute is not reported - see cost-telemetry.ts. */
const COMPUTE_COST_PER_MINUTE_USD = readOptionalRate(
  process.env.COMPUTE_COST_PER_MINUTE_USD
);

function readOptionalRate(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[cost] COMPUTE_COST_PER_MINUTE_USD=${JSON.stringify(raw)} is not a ` +
        `non-negative number - compute cost will not be reported.`
    );
    return null;
  }
  return parsed;
}
```

Then add these two lines inside the existing `buildJobCostTelemetry({ ... })` call, after `criticModel: criticModel(),`:

```ts
          prices: MODEL_PRICES,
          computeCostPerMinuteUsd: COMPUTE_COST_PER_MINUTE_USD,
```

- [ ] **Step 6: Run the whole worker suite**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src"
```

Expected: PASS. If `free-settlement.test.ts` fails, read it: it must keep passing unchanged, because it already treats a null cost as "telemetry never got computed" and leaves the reservation in place, which is exactly the behaviour this task relies on.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/cost-telemetry.ts \
        apps/worker/src/__tests__/cost-telemetry.test.ts \
        apps/worker/src/stages/finalize.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "fix(worker): price jobs from env, write null when the price is unknown

Removes DEFAULT_TOKEN_PRICE, which gave an unpriced model gpt-5.1's price, and
the two fabricated per-minute constants. estimatedTotalCostUsd is now cash only
and is null unless both cash lines are known."
```

---

## Task 4: A canonical price table the tests can actually read

The failure this guards: someone changes the default critic model and forgets its price. Cost then goes silently blank, because Task 3 removed the fallback on purpose.

**Where the table lives, and why not `.env.example`.** The obvious home is `.env.example`, and the first attempt put it there. It does not work: the containers bind-mount only `apps/worker`, `packages` and `prisma`, so a test running inside `worker-analyze` reads the `.env.example` baked into the image by `COPY . .`, not the one in the repo. Editing the table on the host and re-running the test silently checks a stale copy - a green run proving nothing, which is exactly what this test exists to prevent.

Bind-mounting the single file was tried and rejected: it works until any tool that writes by atomic replace touches it (`sed -i`, most editors), at which point the mount still points at the orphaned inode and the container silently sees a frozen version. A guard whose own integrity depends on nobody using `sed -i` is not a guard.

So the canonical table lives under `packages/`, which IS mounted, and `.env.example` points at it. One source, always live.

**Files:**
- Create: `packages/shared/src/config/model-prices.example.json`
- Modify: `.env.example`
- Create: `apps/worker/src/__tests__/env-prices-binding.test.ts`

- [ ] **Step 1: Create the canonical table**

`packages/shared/src/config/model-prices.example.json`:

```json
{
  "tokensPerMillionUsd": {
    "gpt-5.1": { "input": 1.25, "output": 10.0 },
    "gpt-5-mini": { "input": 0.25, "output": 2.0 },
    "gpt-5.6-luna": { "input": 0.20, "output": 1.20 },
    "gpt-4o-mini": { "input": 0.15, "output": 0.6 }
  },
  "audioPerMinuteUsd": {
    "whisper-1": 0.006,
    "gpt-4o-mini-transcribe": 0.003
  }
}
```

Pretty-printed on purpose: this file is read by a test and by humans, never by the env parser, so it does not need to be one line.

- [ ] **Step 2: Point `.env.example` at it**

After the line `CRITIC_MODEL_FALLBACK=gpt-5-mini`, add:

```
# Model prices, USD. There is deliberately no price table in the source tree -
# a compiled-in price goes stale silently (GPT-5.6 Luna was cut 80% in one day
# on 2026-07-31). Every model the engine can be pointed at needs an entry, or
# its cost is simply not recorded; the boot warning names any that are missing.
#
# The canonical table is packages/shared/src/config/model-prices.example.json,
# which is where the test reads it from. Paste its contents here as ONE line -
# this is JSON inside an env file, so a wrapped value will not parse:
#
#   node -e "console.log(JSON.stringify(require('./packages/shared/src/config/model-prices.example.json')))"
#
# The value is left empty here rather than duplicated, because a copy in a file
# no test can read is a copy that silently goes stale.
MODEL_PRICES_JSON=

# USD per source minute of rented capacity, for reporting only. Unset means
# compute is not reported at all, which is the honest default: the server is
# rented whether a job runs or not, so this is never money leaving the account
# because of a particular job. It is excluded from estimatedTotalCostUsd either
# way.
COMPUTE_COST_PER_MINUTE_USD=
```

- [ ] **Step 3: Write the test**

`apps/worker/src/__tests__/env-prices-binding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { audioPricePerMinute, loadModelPrices, tokenPrice } from "@clipclap/shared";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { transcriptionModel } from "../model-selection";

/**
 * Binds two things that otherwise have no reason to agree: the engine's default
 * models (analyze-v2/config.ts, model-selection.ts) and the shipped price table.
 *
 * The failure it catches is a model change that forgets the price. That used to
 * be invisible because cost-telemetry fell back to gpt-5.1's price for anything
 * unknown; now it produces a null cost, which is honest but silent. This is
 * where it becomes loud.
 *
 * It reads packages/shared/... rather than .env.example ON PURPOSE - see the
 * note in the plan. `packages` is bind-mounted into the container, `.env.example`
 * is not, so a test reading the latter would check whatever was baked into the
 * image and pass while the real table was wrong.
 *
 * To verify this test is real, delete one model's entry from the JSON by hand
 * and watch it go red.
 */
const PRICES_FILE = join(
  __dirname,
  "..", "..", "..", "..",
  "packages", "shared", "src", "config", "model-prices.example.json"
);

describe("shipped price table", () => {
  const prices = loadModelPrices(
    { MODEL_PRICES_JSON: readFileSync(PRICES_FILE, "utf-8") },
    () => {}
  );

  it("parses, and is not empty", () => {
    expect(Object.keys(prices.tokensPerMillionUsd).length).toBeGreaterThan(0);
    expect(Object.keys(prices.audioPerMinuteUsd).length).toBeGreaterThan(0);
  });

  it("prices every model the default engine config can reach", () => {
    const cfg = loadAnalyzeConfig({});
    for (const model of [
      cfg.scanModel,
      cfg.criticModel,
      cfg.criticModelFallback,
      cfg.finalizerModel,
    ]) {
      expect(
        tokenPrice(prices, model),
        `model-prices.example.json has no price for "${model}"`
      ).toBeDefined();
    }
  });

  it("prices the default transcription model", () => {
    const model = transcriptionModel({});
    expect(
      audioPricePerMinute(prices, model),
      `model-prices.example.json has no audio price for "${model}"`
    ).toBeDefined();
  });
});
```

- [ ] **Step 4: Run it**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/env-prices-binding.test.ts"
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the test is not fake, and that it reads the LIVE file**

This step is doing double duty: it proves the assertion has teeth AND that the mount actually reaches the test. Both failed silently on the first attempt at this task.

```bash
cp packages/shared/src/config/model-prices.example.json /tmp/prices.bak
md5sum packages/shared/src/config/model-prices.example.json
```

Now edit the JSON **by hand** and delete the `"gpt-4o-mini"` entry from `tokensPerMillionUsd`. Confirm the container sees your edit before running anything:

```bash
docker compose exec -T worker-analyze sh -c "grep -c 'gpt-4o-mini\"' /app/packages/shared/src/config/model-prices.example.json"
```

Expected: `1` - only the transcribe model remains. If it still reports 2, the container is not seeing your edit and every result below is meaningless. Stop and report that.

Then:

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/env-prices-binding.test.ts"
```

Expected: FAIL with `model-prices.example.json has no price for "gpt-4o-mini"`.

Restore and verify byte-identical:

```bash
cp /tmp/prices.bak packages/shared/src/config/model-prices.example.json
md5sum packages/shared/src/config/model-prices.example.json
```

The two md5 values must match. Re-run; expected PASS.

- [ ] **Step 6: The real `.env` - COORDINATOR ONLY**

`.env` holds production secrets and is not edited by task implementers. The coordinator pastes the one-line table into it and restarts the workers.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/config/model-prices.example.json .env.example \
        apps/worker/src/__tests__/env-prices-binding.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(worker): bind the default models to the shipped price table

The table lives under packages/ because that is bind-mounted into the
containers and .env.example is not - a test reading .env.example checks the
copy baked into the image and passes while the real table is wrong."
```

---

## Task 5: Warn at boot, not at the first job

**Files:**
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Add the check**

In `apps/worker/src/index.ts`, add to the imports:

```ts
import { audioPricePerMinute, loadModelPrices, tokenPrice } from "@clipclap/shared";
import { loadAnalyzeConfig } from "./analyze-v2/config";
import { highlightsModel, transcriptionModel } from "./model-selection";
```

**Why this checks more than the Task 4 guard does.** The guard asserts the shipped
DEFAULTS are priced; it reads `loadAnalyzeConfig({})` with an empty env because no test
process can read `.env` (see Task 4 for the three-different-md5 finding). This warning is
the other half: it reads the REAL environment, so it is the only thing that catches an
operator who points `OPENAI_CRITIC_MODEL` at a model nobody priced. Keep both - they cover
different failures, and neither subsumes the other.

Add this function and its call immediately after the existing
`console.log(\`ClipClap worker starting with role=${role ?? "(empty)"}\`);` line:

```ts
/**
 * A missing price is not fatal - jobs still run, they just record no cost - so
 * the only thing standing between it and going unnoticed is this line. Emitted
 * at boot rather than at the first job, because the first job may be hours away
 * and by then the log has scrolled.
 */
function warnAboutMissingPrices(): void {
  const prices = loadModelPrices();
  const cfg = loadAnalyzeConfig();
  const missing: string[] = [];
  for (const model of [
    cfg.scanModel,
    cfg.criticModel,
    cfg.criticModelFallback,
    cfg.finalizerModel,
    highlightsModel(),
  ]) {
    if (tokenPrice(prices, model) === undefined) missing.push(model);
  }
  const asr = transcriptionModel();
  if (audioPricePerMinute(prices, asr) === undefined) missing.push(asr);
  if (missing.length > 0) {
    console.warn(
      `[cost] no price in MODEL_PRICES_JSON for: ${[...new Set(missing)].join(", ")}. ` +
        `Those jobs will record no cost figure. Add them to .env and restart.`
    );
  }
}

warnAboutMissingPrices();
```

- [ ] **Step 2: Verify the warning fires**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && MODEL_PRICES_JSON='{}' npx tsx -e \"process.env.WORKER_ROLE='analyze'; require('./src/index.ts')\"" 2>&1 | grep "\[cost\]"
```

Expected: a line naming `gpt-4o-mini`, the critic model, the fallback and `whisper-1`.

If that one-liner is awkward in your shell, the equivalent check is to temporarily blank `MODEL_PRICES_JSON` in `.env`, run `docker compose up -d worker-analyze` (NOT `restart` - it does not re-read `env_file`), then `docker compose logs --tail 20 worker-analyze` - and restore `.env` afterwards.

- [ ] **Step 3: Verify it stays silent with the real config**

```bash
docker compose restart worker-analyze
docker compose logs --tail 30 worker-analyze | grep "\[cost\]" || echo "silent - good"
```

Expected: `silent - good`.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/index.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(worker): warn at boot when a configured model has no price"
```

---

## Task 6: Record which model produced the figures

Tokens are stored, dollars are stored, the multiplier between them is not. The ten historical rows cannot be re-priced.

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `apps/worker/src/stages/finalize.ts` - **required, not a no-op.** See Step 4a.

- [ ] **Step 1: Add the columns**

In `prisma/schema.prisma`, in the `Job` model, immediately after the line
`analysisOutputTokens  Int?`, add:

```prisma
  /// Which models produced the token counts and the cost figures above. Stored
  /// because dollars are DERIVED and prices move: without the multiplier, a row
  /// can never be re-priced. The ten rows that predate this column had to be
  /// backfilled from analyzeEngine and date, which only worked because the
  /// engine changed at the same time the model did - not a repeatable trick.
  criticModel           String?
  transcriptionModel    String?
```

- [ ] **Step 2: Create and apply the migration**

```bash
docker compose exec worker-analyze sh -c "cd /app && /app/node_modules/.bin/prisma migrate dev --name job_model_columns --schema prisma/schema.prisma"
```

Expected: a new directory under `prisma/migrations/` and `The following migration(s) have been applied`.

- [ ] **Step 3: Regenerate the client in every container that uses it**

```bash
for s in web worker-analyze worker-download worker-finalize worker-render worker-transcribe bot; do
  docker compose exec -T $s sh -c "cd /app && /app/node_modules/.bin/prisma generate --schema prisma/schema.prisma" >/dev/null && echo "$s ok"
done
```

Expected: `ok` for each service.

- [ ] **Step 4: Verify the columns exist**

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c "\d jobs" | grep -E "criticModel|transcriptionModel"
```

Expected: both columns listed as `text`.

- [ ] **Step 4a: Remove the guard Task 3 had to add, and let the models through**

**This plan originally said this step was a no-op. That was wrong, and it would have taken production down.**

Task 3 made `buildJobCostTelemetry` return `criticModel` and `transcriptionModel`, and `finalize.ts` spreads the builder's result into `prisma.job.update({ data: ... })`. The columns did not exist yet, and **Prisma rejects unknown arguments rather than ignoring them** - `PrismaClientValidationError: Unknown argument \`criticModel\``. That throw lands inside `runFinalizeStage`'s `try`, so every successfully rendered job would have been marked FAILED and then REFUNDED by `settleFreeLedger(jobId, "FAILED")`. Neither guard could catch it: spreading a non-literal object skips TypeScript's excess-property check, and the worker tests mock Prisma.

So Task 3 destructures the two fields back out before the update, with a comment naming this step as the trigger to delete it. Now that the columns exist, delete it.

In `apps/worker/src/stages/finalize.ts`, remove the destructuring line and its explanatory comment, and pass `telemetry` straight through:

```ts
    const { criticModel: _critic, transcriptionModel: _asr, ...costColumns } =
      telemetry;
```

The `data:` payload should spread `...telemetry` again instead of `...costColumns`. Delete the comment block above the destructuring at the same time - it describes a condition that no longer holds, and a stale comment is worse than none.

Verify against the REAL database, not a mock, because a mock is what hid this in the first place:

```bash
docker compose restart worker-finalize
docker compose logs --tail 20 worker-finalize | grep -i "unknown argument" || echo "no validation error - good"
```

- [ ] **Step 4b: Prove the columns are actually written end to end**

The unit suite cannot prove this - it mocks Prisma. Run one real job through the pipeline (a short video is fine) and check the row:

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c "
SELECT id, \"criticModel\", \"transcriptionModel\", \"estimatedAnalysisCostUsd\"
  FROM jobs ORDER BY \"createdAt\" DESC LIMIT 1;"
```

Expected: both model columns populated, not NULL. If they are NULL, Step 4a was not completed and the columns are dead weight.

- [ ] **Step 5: Close the coverage hole this plan opened in Task 2**

Carried forward from the Task 2 code review, which found it and could not close it there. The reviewer re-inlined the original defect - reverted the critic model in `stages/finalize.ts` back to `process.env.OPENAI_CRITIC_MODEL || "gpt-5.1"` - and the full worker suite still passed 516/516. So the 8x mispricing defect can walk back in silently, and until this step the only guard is a manual grep. The Task 5 boot warning is **not** a backstop: it reads `cfg.criticModel`, so a stale copy inside `finalize.ts` leaves it silent.

It could not be written before now, because `criticModel` did not reach any persisted payload. The two columns from this task are what make it assertable.

`apps/worker/src/__tests__/stage-flow.test.ts` already captures the `prisma.job.update` payload via `mocks.jobUpdate` - see the existing assertion around line 392 for the shape. Add:

```ts
    // Pins the seam Task 2 created: the model finalize PRICES must be the model
    // the engine RAN. Reverting either call site to its own env-var literal
    // used to leave the whole suite green - see the Task 2 review.
    expect(mocks.jobUpdate).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        criticModel: loadAnalyzeConfig({}).criticModel,
        transcriptionModel: transcriptionModel({}),
      }),
    });
```

Import `loadAnalyzeConfig` from `../analyze-v2/config` and `transcriptionModel` from `../model-selection`. Adjust the `where` clause and job id to match whatever the surrounding test in that file already uses - do not invent one.

The codebase already pins model selection this way: `finalize.test.ts:1041` asserts `body.model` equals `cfg.finalizerModel`.

Then prove it is real, per the discipline in `docs/engine-notes.md` section 4. Copy `apps/worker/src/stages/finalize.ts` to `/tmp`, `md5sum` it, edit it in place to read `process.env.OPENAI_CRITIC_MODEL || "gpt-5.1"` again, run the suite and confirm this new assertion RED. Restore from `/tmp` and confirm the `md5sum` matches. Never restore with git.

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/stage-flow.test.ts"
```

- [ ] **Step 6: Typecheck**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc --noEmit -p tsconfig.json"
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/worker/src/__tests__/stage-flow.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(db): record the models that produced each job's cost figures

Dollars are derived and prices move. Without the multiplier a row can never be
re-priced, which is why the ten existing rows needed a backfill."
```

---

## Task 7: Backfill the ten existing rows

**Files:**
- Create: `apps/worker/src/scripts/backfill-job-models.ts`

- [ ] **Step 1: Write the script**

Create `apps/worker/src/scripts/backfill-job-models.ts`:

```ts
/**
 * One-off backfill of Job.criticModel / Job.transcriptionModel.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/backfill-job-models.ts [--apply]"
 *
 * Without --apply it prints what it would do and changes nothing.
 *
 * The critic model is derivable for the existing rows only because the engine
 * changed at the same time the model did: analyzeEngine RECALL_CRITIC rows ran
 * gpt-5.1, everything earlier ran the legacy single-pass analyzer on
 * gpt-4o-mini. That coincidence is why this script can exist, and the new
 * column is why the next model change will not need one.
 *
 * Rows that already carry a model are left alone: this is a backfill, not a
 * rewrite, and a later run must never overwrite something finalize wrote.
 */
import { prisma } from "@clipclap/shared";

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.job.findMany({
    where: { criticModel: null, estimatedTotalCostUsd: { not: null } },
    select: { id: true, analyzeEngine: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (rows.length === 0) {
    console.log("nothing to backfill");
    return;
  }

  let updated = 0;
  for (const row of rows) {
    const critic = row.analyzeEngine === "RECALL_CRITIC" ? "gpt-5.1" : "gpt-4o-mini";
    console.log(
      `${row.id}  ${row.createdAt.toISOString().slice(0, 10)}  ` +
        `engine=${row.analyzeEngine ?? "null"}  -> critic=${critic}, asr=whisper-1`
    );
    if (apply) {
      await prisma.job.update({
        where: { id: row.id },
        data: { criticModel: critic, transcriptionModel: "whisper-1" },
      });
      updated++;
    }
  }

  console.log(
    apply
      ? `backfilled ${updated} row(s)`
      : `${rows.length} row(s) would be backfilled - re-run with --apply`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Check the enum value first**

The script depends on the exact `AnalyzeEngine` enum member name.

```bash
grep -n "enum AnalyzeEngine" -A 6 prisma/schema.prisma
```

If the recall-critic member is not spelled `RECALL_CRITIC`, correct the string in the script before running it.

- [ ] **Step 3: Dry run**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/backfill-job-models.ts"
```

Expected: 10 rows listed. The four 52.3-minute rows and the two from 2026-07-14 and 2026-07-21 should show `critic=gpt-5.1`; the four oldest (2026-05-21 x2, 2026-05-24, 2026-07-13) should show `critic=gpt-4o-mini`. If the split does not match that, stop and investigate before applying.

- [ ] **Step 4: Apply**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/backfill-job-models.ts --apply"
```

Expected: `backfilled 10 row(s)`.

- [ ] **Step 5: Verify**

```bash
docker compose exec -T postgres psql -U clipclap -d clipclap -c "
SELECT \"criticModel\", \"transcriptionModel\", count(*)
  FROM jobs WHERE \"estimatedTotalCostUsd\" IS NOT NULL
 GROUP BY 1,2 ORDER BY 3 DESC;"
```

Expected: two groups, `gpt-5.1`/`whisper-1` and `gpt-4o-mini`/`whisper-1`, summing to 10, with no NULLs.

- [ ] **Step 6: Verify idempotency**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/backfill-job-models.ts"
```

Expected: `nothing to backfill`.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/scripts/backfill-job-models.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "chore(worker): backfill the model columns on existing job rows"
```

**PHASE A CHECKPOINT.** Telemetry is now honest and the migration cannot write wrong numbers. Stop here and confirm before continuing.

---

# Phase B - Fixture variants

## Task 8: Declare variants and teach the fixture loader about them

A variant is a named set of config overrides. One definition, four consumers (the loader, the snapshot test, the recorder, the blesser).

**Files:**
- Create: `apps/worker/src/__tests__/fixtures/eval/variants.json`
- Modify: `apps/worker/src/__tests__/helpers/eval-fixture.ts`
- Create: `apps/worker/src/__tests__/eval-variants.test.ts`

- [ ] **Step 1: Declare the variant**

Create `apps/worker/src/__tests__/fixtures/eval/variants.json`:

```json
{
  "luna": {
    "criticModel": "gpt-5.6-luna",
    "finalizerModel": "gpt-5.6-luna"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/worker/src/__tests__/eval-variants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BASE_VARIANT,
  loadFixture,
  loadVariantDefs,
  snapshotFileName,
  variantConfig,
  variantNames,
} from "./helpers/eval-fixture";
import { loadAnalyzeConfig } from "../analyze-v2/config";

describe("variant definitions", () => {
  it("always offers the base variant first", () => {
    expect(variantNames()[0]).toBe(BASE_VARIANT);
  });

  it("reads declared variants from variants.json", () => {
    expect(loadVariantDefs().luna).toEqual({
      criticModel: "gpt-5.6-luna",
      finalizerModel: "gpt-5.6-luna",
    });
    expect(variantNames()).toContain("luna");
  });

  it("maps the base variant to snapshot.json and others to a suffixed file", () => {
    expect(snapshotFileName(BASE_VARIANT)).toBe("snapshot.json");
    expect(snapshotFileName("luna")).toBe("snapshot.luna.json");
  });

  it("builds the base config from the engine defaults, unchanged", () => {
    const base = variantConfig(BASE_VARIANT);
    const defaults = loadAnalyzeConfig({});
    expect(base.criticModel).toBe(defaults.criticModel);
    expect(base.finalizerModel).toBe(defaults.finalizerModel);
    expect(base.engine).toBe("recall-critic");
  });

  it("applies overrides on top of the defaults for a named variant", () => {
    const luna = variantConfig("luna");
    const defaults = loadAnalyzeConfig({});
    expect(luna.criticModel).toBe("gpt-5.6-luna");
    expect(luna.finalizerModel).toBe("gpt-5.6-luna");
    // everything not overridden must be identical, or the diff stops isolating
    // the model and starts mixing in a second changed knob
    expect(luna.scanModel).toBe(defaults.scanModel);
    expect(luna.reasoningEffort).toBe(defaults.reasoningEffort);
    expect(luna.criticBatchSize).toBe(defaults.criticBatchSize);
  });

  it("throws on an unknown variant rather than silently running the base", () => {
    expect(() => variantConfig("no-such-variant")).toThrow(/unknown variant/i);
  });
});

describe("fixture variant surface", () => {
  it("exposes the base snapshot and fingerprint under the base variant name", () => {
    const fixture = loadFixture("podcast-ecology");
    expect(fixture.snapshots[BASE_VARIANT]).toEqual(fixture.snapshot);
    expect(fixture.fingerprints[BASE_VARIANT]).toEqual(fixture.fingerprint);
  });

  it("reports a variant that has not been recorded yet as absent, not as empty", () => {
    const fixture = loadFixture("podcast-ecology");
    // luna is declared but not yet recorded at this point in the plan
    expect(fixture.snapshots.luna ?? null).toBeNull();
    expect(fixture.fingerprints.luna ?? null).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/eval-variants.test.ts"
```

Expected: FAIL, no export named `BASE_VARIANT`.

- [ ] **Step 4: Extend the fixture helper**

In `apps/worker/src/__tests__/helpers/eval-fixture.ts`:

Replace the `FIXTURES_DIR` line and everything up to the `Fixture` interface with the block below, keeping the existing imports and adding `readFileSync` usage as needed. Concretely, after the existing `export const FIXTURES_DIR = ...` line, add:

```ts
/** The variant that IS the current engine default. Its snapshot is snapshot.json. */
export const BASE_VARIANT = "base";

/**
 * Which config knobs a variant is allowed to move.
 *
 * Deliberately narrow. A variant exists to answer "does a different judge
 * decide differently on the SAME candidates" - so it may change who answers,
 * and nothing about what is asked. Widening this to windowing or batching would
 * change the prompts, change every request key, and turn the diff back into the
 * mixed signal this whole mechanism exists to avoid.
 */
export type VariantOverrides = Partial<
  Pick<AnalyzeConfig, "criticModel" | "finalizerModel" | "criticModelFallback">
>;

export function loadVariantDefs(): Record<string, VariantOverrides> {
  const path = join(FIXTURES_DIR, "variants.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, VariantOverrides>;
}

/** Base first, then declared variants in a stable order. */
export function variantNames(): string[] {
  return [BASE_VARIANT, ...Object.keys(loadVariantDefs()).sort()];
}

export function snapshotFileName(variant: string): string {
  return variant === BASE_VARIANT ? "snapshot.json" : `snapshot.${variant}.json`;
}

/** Effective engine config for a variant: the env-blind defaults plus overrides. */
export function variantConfig(variant: string): AnalyzeConfig {
  const base: AnalyzeConfig = {
    ...loadAnalyzeConfig({}),
    engine: "recall-critic",
  };
  if (variant === BASE_VARIANT) return base;
  const defs = loadVariantDefs();
  const overrides = defs[variant];
  if (!overrides) {
    throw new Error(
      `unknown variant "${variant}" - declare it in ${join(FIXTURES_DIR, "variants.json")}`
    );
  }
  return { ...base, ...overrides };
}
```

Add `readFileSync` and `existsSync` to the existing `fs` import if not already present (both are already imported in this file).

Now extend the `Fixture` interface - add these two fields to it:

```ts
  /** Snapshots by variant name; base lives under BASE_VARIANT. */
  snapshots: Record<string, EvalShape | null>;
  /** Recorded fingerprints by variant name. */
  fingerprints: Record<string, Partial<EngineFingerprint> | null>;
```

Replace the body of `loadFixture` with:

```ts
export function loadFixture(name: string): Fixture {
  const dir = join(FIXTURES_DIR, name);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf-8"));
  const readIfPresent = (file: string) =>
    existsSync(join(dir, file)) ? read(file) : null;

  const meta = readIfPresent("meta.json") as
    | { engine?: Partial<EngineFingerprint>; variants?: Record<string, { engine?: Partial<EngineFingerprint> }> }
    | null;

  const snapshots: Record<string, EvalShape | null> = {};
  const fingerprints: Record<string, Partial<EngineFingerprint> | null> = {};
  for (const variant of variantNames()) {
    snapshots[variant] = readIfPresent(snapshotFileName(variant));
    fingerprints[variant] =
      variant === BASE_VARIANT
        ? (meta?.engine ?? null)
        : (meta?.variants?.[variant]?.engine ?? null);
  }

  return {
    name,
    transcript: read("transcript.json"),
    responses: read("responses.json"),
    // Kept as aliases so every existing caller keeps working unchanged.
    snapshot: snapshots[BASE_VARIANT],
    fingerprint: fingerprints[BASE_VARIANT],
    snapshots,
    fingerprints,
  };
}
```

Finally add the variant runner below `runFixture`:

```ts
/**
 * Replays a fixture under a named variant.
 *
 * The scanner's request keys are identical across variants, so its recorded
 * answers are reused byte for byte and the candidate set entering the critic is
 * the same one the base run judged. Only the critic and finalizer keys differ,
 * because the model is part of the request hash. That is what makes the diff
 * between two variants a statement about the judge and nothing else.
 */
export async function runFixtureVariant(
  fixture: Fixture,
  variant: string,
  extraResponses: Record<string, string> = {}
): Promise<V2Result> {
  const cfg = variantConfig(variant);
  assertFingerprintMatches(
    `${fixture.name}[${variant}]`,
    fixture.fingerprints[variant] ?? null,
    computeFingerprint(cfg)
  );
  const client = createReplayClient({ ...fixture.responses, ...extraResponses });
  const result = await analyzeHighlightsV2(fixture.transcript, {
    client,
    cfg,
    retryDelayMs: 1,
  });
  if (client.missing.length > 0) {
    const unique = [...new Set(client.missing)];
    throw new Error(
      `fixture "${fixture.name}" variant "${variant}" is stale: ${unique.length} ` +
        `unrecorded request(s) [${unique.join(", ")}]. Record them with:\n` +
        `  docker compose exec worker-analyze sh -c "cd /app/apps/worker && ` +
        `npx tsx src/scripts/eval-topup.ts --variant ${variant} ${fixture.name}"`
    );
  }
  return result;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/eval-variants.test.ts"
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Verify the existing harness still passes unchanged**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/eval-snapshot.test.ts apps/worker/src/__tests__/eval-fixture.test.ts apps/worker/src/__tests__/eval-regressions.test.ts"
```

Expected: PASS. The `snapshot` and `fingerprint` aliases exist precisely so these do not move.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/__tests__/fixtures/eval/variants.json \
        apps/worker/src/__tests__/helpers/eval-fixture.ts \
        apps/worker/src/__tests__/eval-variants.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(eval): fixtures can hold more than one model's recorded answers

The model is already part of the request key, so a second model's critic and
finalizer responses cannot collide with the first's while the scanner's are
shared byte for byte. That is what makes a two-model diff a statement about the
judge rather than about scanner sampling noise."
```

---

## Task 9: The snapshot test covers every recorded variant

Without this, the Luna variant is unprotected at exactly the moment it becomes production.

**Files:**
- Modify: `apps/worker/src/__tests__/eval-snapshot.test.ts`

- [ ] **Step 1: Rewrite the test file**

Replace the contents of `apps/worker/src/__tests__/eval-snapshot.test.ts` below the existing doc comment (keep the comment, it is still accurate) with:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  runFixtureVariant,
  snapshotFileName,
  toShape,
  variantConfig,
  variantNames,
} from "./helpers/eval-fixture";
import { computeFingerprint } from "./helpers/eval-fingerprint";

const FIXTURES = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(FIXTURES_DIR, e.name, "snapshot.json")))
  .map((e) => e.name)
  .sort();

/** Every (fixture, variant) pair that has actually been recorded. A declared
 *  but unrecorded variant is skipped rather than failed: declaring it is how a
 *  recording gets started, and reddening the suite for that would make adding a
 *  candidate model a broken-build event. */
const CASES: Array<[string, string]> = FIXTURES.flatMap((name) =>
  variantNames()
    .filter((variant) => existsSync(join(FIXTURES_DIR, name, snapshotFileName(variant))))
    .map((variant) => [name, variant] as [string, string])
);

describe("eval fixtures", () => {
  it("finds the recorded fixtures on disk", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(2);
    expect(FIXTURES).toContain("podcast-answer-arc");
    expect(FIXTURES).toContain("podcast-ecology");
  });

  it("finds at least the base variant of every fixture", () => {
    // guards the guard: an empty CASES list would make every it.each below
    // vanish while the suite still reported green
    expect(CASES.length).toBeGreaterThanOrEqual(FIXTURES.length);
    for (const name of FIXTURES) {
      expect(CASES).toContainEqual([name, BASE_VARIANT]);
    }
  });

  it.each(CASES)("%s[%s] was recorded on the config that variant describes", (name, variant) => {
    const fixture = loadFixture(name);
    expect(fixture.fingerprints[variant]).not.toBeNull();
    expect(fixture.fingerprints[variant]).toEqual(computeFingerprint(variantConfig(variant)));
  });

  it.each(CASES)("%s[%s] replays to its recorded snapshot", async (name, variant) => {
    const fixture = loadFixture(name);
    expect(fixture.snapshots[variant]).not.toBeNull();
    const shape = toShape(await runFixtureVariant(fixture, variant));
    expect(shape).toEqual(fixture.snapshots[variant]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/eval-snapshot.test.ts"
```

Expected: PASS. `CASES` currently holds two entries (`podcast-answer-arc[base]`, `podcast-ecology[base]`) because no variant has been recorded yet.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/__tests__/eval-snapshot.test.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(eval): replay every recorded variant, not just the base"
```

---

## Task 10: `eval-topup --variant` records only what a variant adds

**Files:**
- Modify: `apps/worker/src/scripts/eval-topup.ts`

- [ ] **Step 1: Add variant support**

In `apps/worker/src/scripts/eval-topup.ts`:

Extend the imports from the fixture helper:

```ts
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  variantConfig,
} from "../__tests__/helpers/eval-fixture";
```

Replace the argument parsing and config lines at the top of `main()`:

```ts
  const cases = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (cases.length === 0) {
    console.error("usage: eval-topup.ts <case-name> [case-name ...]");
    process.exit(1);
  }

  const cfg = { ...loadAnalyzeConfig({}), engine: "recall-critic" as const };
  const current = computeFingerprint(cfg);
```

with:

```ts
  const argv = process.argv.slice(2);
  const variantFlag = argv.indexOf("--variant");
  const variant = variantFlag === -1 ? BASE_VARIANT : argv[variantFlag + 1];
  // `flagAt === -1` must be handled explicitly: without it, variantFlag + 1 is 0
  // and the filter silently drops the FIRST case name, so `eval-topup.ts
  // podcast-ecology` prints the usage line instead of running. Found by the
  // Task 10 implementer against this exact snippet.
  const cases = argv.filter(
    (a, i) => !a.startsWith("-") && (variantFlag === -1 || i !== variantFlag + 1)
  );
  if (cases.length === 0 || !variant) {
    console.error("usage: eval-topup.ts [--variant NAME] <case-name> [case-name ...]");
    process.exit(1);
  }

  // Throws on an unknown variant, which is the right moment to find out - before
  // any paid call has been made.
  const cfg = variantConfig(variant);
  const current = computeFingerprint(cfg);
  console.log(`variant: ${variant} (critic=${cfg.criticModel}, finalizer=${cfg.finalizerModel})`);
```

Replace the fingerprint refusal block:

```ts
    const fixture = loadFixture(name);
    if (fixture.fingerprint) {
      const { mismatches } = compareFingerprints(fixture.fingerprint, current);
```

with:

```ts
    const fixture = loadFixture(name);
    // Compare against THIS variant's recording, not the base one. A mismatch
    // against the base is expected and is the whole point; a mismatch against
    // the variant's own previous recording means that recording is stale.
    const recorded = fixture.fingerprints[variant] ?? null;
    if (recorded) {
      const { mismatches } = compareFingerprints(recorded, current);
```

- [ ] **Step 2: Write the variant fingerprint into meta.json**

Replace the block that writes `responses.json` at the end of the per-case loop:

```ts
    const path = join(FIXTURES_DIR, name, "responses.json");
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    writeFileSync(path, `${JSON.stringify({ ...onDisk, ...added }, null, 2)}\n`, "utf-8");
```

with:

```ts
    const path = join(FIXTURES_DIR, name, "responses.json");
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    writeFileSync(path, `${JSON.stringify({ ...onDisk, ...added }, null, 2)}\n`, "utf-8");

    // A non-base variant needs its own provenance in meta.json, or the snapshot
    // test cannot tell "recorded under this config" from "never recorded".
    if (variant !== BASE_VARIANT) {
      const metaPath = join(FIXTURES_DIR, name, "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        variants?: Record<string, unknown>;
      };
      meta.variants = {
        ...(meta.variants ?? {}),
        [variant]: { recordedAt: new Date().toISOString(), engine: current },
      };
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
      console.log(`  wrote variant fingerprint to ${metaPath}`);
    }
```

- [ ] **Step 3: Verify the base path still works and costs nothing**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-topup.ts podcast-ecology"
```

Expected: `podcast-ecology: complete already - nothing to record`. If it reports recording anything, stop: the base fixture should be complete, and a live call here means something upstream changed.

- [ ] **Step 4: Verify an unknown variant fails before spending money**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-topup.ts --variant nope podcast-ecology"
```

Expected: throws `unknown variant "nope"` and makes no API call.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scripts/eval-topup.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(eval): eval-topup --variant records only the calls a variant adds"
```

---

## Task 11: `eval-bless --variant` diffs and blesses a variant snapshot

**Files:**
- Modify: `apps/worker/src/scripts/eval-bless.ts`

- [ ] **Step 1: Add variant support**

In `apps/worker/src/scripts/eval-bless.ts`:

Extend the fixture-helper imports:

```ts
import {
  BASE_VARIANT,
  FIXTURES_DIR,
  loadFixture,
  runFixtureVariant,
  snapshotFileName,
  toShape,
  variantConfig,
  type EvalShape,
} from "../__tests__/helpers/eval-fixture";
```

Replace the argument parsing and `current` line at the top of `main()`:

```ts
  const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
```

with:

```ts
  const argv = process.argv.slice(2);
  const variantFlag = argv.indexOf("--variant");
  const variant = variantFlag === -1 ? BASE_VARIANT : argv[variantFlag + 1];
  // See the note in Task 10: the `=== -1` arm is required or the first case name
  // is dropped when no flag is given.
  const names = argv.filter(
    (a, i) => !a.startsWith("-") && (variantFlag === -1 || i !== variantFlag + 1)
  );
  if (!variant) {
    console.error("usage: eval-bless.ts [--variant NAME] [case-name ...]");
    process.exit(1);
  }
```

Replace:

```ts
  const current = computeFingerprint({ ...loadAnalyzeConfig({}), engine: "recall-critic" });
```

with:

```ts
  const current = computeFingerprint(variantConfig(variant));
  console.log(`variant: ${variant}`);
```

Replace the fingerprint check inside the loop:

```ts
    if (fixture.fingerprint) {
      const { mismatches } = compareFingerprints(fixture.fingerprint, current);
```

with:

```ts
    const recorded = fixture.fingerprints[variant] ?? null;
    if (recorded) {
      const { mismatches } = compareFingerprints(recorded, current);
```

and the `else` branch's message stays as-is, except change `no meta.json fingerprint` to
`no recorded fingerprint for variant "${variant}"`.

Replace the run and diff lines:

```ts
      shape = toShape(await runFixture(fixture));
```

with:

```ts
      shape = toShape(await runFixtureVariant(fixture, variant));
```

and:

```ts
    const lines = diffShapes(fixture.snapshot, shape);
```

with:

```ts
    const lines = diffShapes(fixture.snapshots[variant] ?? null, shape);
```

Finally replace both references to the snapshot path in the write block:

```ts
    writeFileSync(
      join(FIXTURES_DIR, name, "snapshot.json"),
      `${JSON.stringify(shape, null, 2)}\n`,
      "utf-8"
    );
    console.log(`  -> rewrote ${join(FIXTURES_DIR, name, "snapshot.json")}`);
```

with:

```ts
    const snapshotPath = join(FIXTURES_DIR, name, snapshotFileName(variant));
    writeFileSync(snapshotPath, `${JSON.stringify(shape, null, 2)}\n`, "utf-8");
    console.log(`  -> rewrote ${snapshotPath}`);
```

- [ ] **Step 2: Remove the now-unused import if the compiler complains**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsc --noEmit -p tsconfig.json"
```

If `runFixture` or `loadAnalyzeConfig` is now unused in this file, delete it from the imports and re-run until clean.

- [ ] **Step 3: Verify the base path is a no-op**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts"
```

Expected: `variant: base`, then `podcast-answer-arc: unchanged` and `podcast-ecology: unchanged`, then `2 fixture(s): 2 unchanged, 0 re-blessed, 0 refused, 0 errored`. Confirm `git status` is clean.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/scripts/eval-bless.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(eval): eval-bless --variant diffs and blesses a variant snapshot"
```

**PHASE B CHECKPOINT.** The harness can now hold two models. Nothing has changed about what the engine does. Stop here and confirm before continuing.

---

# Phase C - The migration

## Task 12: Measure Luna's token budget

The budgets in `critic.ts` (2000 / 3600 / 6000 for batches of 1 / 3 / 6) were measured on gpt-5.1 at `reasoning_effort: low`. They are properties of that model's reasoning profile and do not transfer. Failure here is silent: an undersized cap truncates mid-reasoning, the critic splits the batch, the split inherits the same starvation, and candidates disappear without an error.

**Files:**
- Create: `apps/worker/src/scripts/measure-critic-budget.ts`

- [ ] **Step 1: Write the measurement script**

Create `apps/worker/src/scripts/measure-critic-budget.ts`:

```ts
/**
 * Measures how many output tokens a critic batch really needs on a given model.
 *
 *   docker compose exec worker-analyze sh -c \
 *     "cd /app/apps/worker && npx tsx src/scripts/measure-critic-budget.ts gpt-5.6-luna"
 *
 * Reproduces the method behind the table in critic.ts: take real critic prompts
 * from a fixture, run each batch size against a ladder of caps, and record
 * completion / reasoning / verdict counts. The budget for a batch size is then
 * the smallest round number ABOVE a cap that was OBSERVED TO COMPLETE at that
 * size - not a number derived from an average, because the model expands its
 * reasoning into whatever room it is given.
 *
 * Costs real API calls. On Luna the whole ladder is a few cents; on gpt-5.1 it
 * was not. Run it deliberately.
 */
import OpenAI from "openai";
import { analyzeHighlightsV2 } from "../analyze-v2";
import { CRITIC_SCHEMA } from "../analyze-v2/schemas";
import { loadFixture, variantConfig } from "../__tests__/helpers/eval-fixture";
import { requestKey } from "../__tests__/helpers/replay-client";

const CAPS_BY_SIZE: Record<number, number[]> = {
  1: [400, 1200, 2000, 3000],
  3: [1200, 3000, 3600, 6000],
  6: [2400, 5000, 6000, 9000, 14000],
};

interface RecordedPrompt {
  system: string;
  user: string;
  batchSize: number;
}

/**
 * Recovers the critic prompts from a fixture's recordings by replaying the
 * engine against them and capturing what it asks. The prompts are the honest
 * input: a hand-written one would measure a different workload than production.
 */
async function collectCriticPrompts(fixtureName: string): Promise<RecordedPrompt[]> {
  const fixture = loadFixture(fixtureName);
  const prompts: RecordedPrompt[] = [];
  const cfg = variantConfig("base");
  const client = {
    chat: {
      completions: {
        create: async (body: {
          model: string;
          messages: Array<{ role: string; content: string }>;
        }) => {
          const system = body.messages.find((m) => m.role === "system")?.content ?? "";
          const user = body.messages.find((m) => m.role === "user")?.content ?? "";
          // Critic prompts are the ones whose recorded answer holds "results";
          // the scanner's hold "candidates" and the finalizer's hold "clips".
          const recorded = fixture.responses[requestKey({ model: body.model, system, user })];
          if (recorded && recorded.includes('"results"')) {
            const batchSize = (recorded.match(/"id"\s*:/g) ?? []).length;
            if (batchSize > 0) prompts.push({ system, user, batchSize });
          }
          const outcome = recorded?.includes("__outcome") ?? false;
          return {
            choices: [
              {
                message: { content: outcome ? null : (recorded ?? "{}"), refusal: null },
                finish_reason: outcome ? "length" : "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          };
        },
      },
    },
  } as unknown as OpenAI;
  await analyzeHighlightsV2(fixture.transcript, { client, cfg, retryDelayMs: 1 });
  return prompts;
}

async function main() {
  const model = process.argv[2];
  const fixtureName = process.argv[3] ?? "podcast-ecology";
  if (!model) {
    console.error("usage: measure-critic-budget.ts <model> [fixture-name]");
    process.exit(1);
  }

  const prompts = await collectCriticPrompts(fixtureName);
  if (prompts.length === 0) {
    console.error(`no critic prompts recovered from fixture "${fixtureName}"`);
    process.exit(1);
  }
  console.log(`recovered ${prompts.length} critic prompt(s) from ${fixtureName}`);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`\nmodel: ${model}`);
  console.log("batch /    cap -> completion / reasoning / verdicts");

  for (const [sizeRaw, caps] of Object.entries(CAPS_BY_SIZE)) {
    const size = Number(sizeRaw);
    const prompt = prompts.find((p) => p.batchSize === size) ?? prompts[0];
    for (const cap of caps) {
      const response = (await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response_format: { type: "json_schema", json_schema: CRITIC_SCHEMA as never },
        max_completion_tokens: cap,
        reasoning_effort: "low",
      } as never)) as {
        usage?: {
          completion_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
        choices: Array<{ message: { content: string | null }; finish_reason?: string }>;
      };
      const completion = response.usage?.completion_tokens ?? 0;
      const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const content = response.choices[0]?.message?.content;
      let verdicts = 0;
      if (content) {
        try {
          verdicts = (JSON.parse(content) as { results?: unknown[] }).results?.length ?? 0;
        } catch {
          verdicts = 0;
        }
      }
      const truncated = response.choices[0]?.finish_reason === "length" || !content;
      console.log(
        `  ${String(size).padStart(2)} / ${String(cap).padStart(6)} -> ` +
          `${String(completion).padStart(5)} / ${String(reasoning).padStart(5)} / ${verdicts}` +
          (truncated ? "   (truncated)" : "")
      );
    }
  }
  process.exit(0);
}

main();
```

- [ ] **Step 2: Run it against gpt-5.1 first, as a control**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/measure-critic-budget.ts gpt-5.1"
```

Expected: numbers in the same neighbourhood as the table in `critic.ts:20-28` - roughly 330-450 reasoning tokens per candidate, truncation at 6/2400 and 3/1200 and 1/400. If they are wildly different, the script is measuring the wrong thing and must be fixed before it is trusted on Luna. This control run costs real money on gpt-5.1; it is worth it, because an unvalidated measurement tool is how a wrong budget gets shipped.

- [ ] **Step 3: Run it against Luna**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/measure-critic-budget.ts gpt-5.6-luna"
```

Record the full output. You will need it in Task 15.

- [ ] **Step 4: Decide the budgets**

For each batch size, take the smallest round number strictly above a cap that was observed to COMPLETE (non-zero verdicts, no truncation) at that size. That is the rule the existing constants follow and the reason they are what they are.

Then solve for the two constants so that `CRITIC_BASE_TOKENS + size * CRITIC_TOKENS_PER_CANDIDATE` clears every chosen value:
- current: `CRITIC_BASE_TOKENS = 1200`, `CRITIC_TOKENS_PER_CANDIDATE = 800`
- if Luna's per-candidate reasoning is lower, both may come down; if higher, both go up

Record the chosen numbers. Do not edit `critic.ts` yet - that happens in Task 14, together with the model default, so the fingerprint moves exactly once.

- [ ] **Step 5: Commit the script**

```bash
git add apps/worker/src/scripts/measure-critic-budget.ts
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "chore(eval): script to measure a model's critic token budget

Reproduces the method behind the table in critic.ts so the next model change
measures rather than guesses."
```

---

## Task 13: Record the Luna variant and read the diff

**Files:**
- Modify: `apps/worker/src/__tests__/fixtures/eval/podcast-ecology/{responses,meta}.json` (written by the script)
- Modify: `apps/worker/src/__tests__/fixtures/eval/podcast-answer-arc/{responses,meta}.json` (written by the script)
- Create: `apps/worker/src/__tests__/fixtures/eval/*/snapshot.luna.json` (written by the script)

- [ ] **Step 1: Record**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-topup.ts --variant luna podcast-ecology podcast-answer-arc"
```

Expected: `variant: luna (critic=gpt-5.6-luna, finalizer=gpt-5.6-luna)`, then a run of `+ recorded <key> (gpt-5.6-luna, N chars)` lines, then `wrote variant fingerprint to .../meta.json` for each fixture. Roughly 6 new responses per fixture. Cost: order of $0.05 total.

If any line reports a `__outcome` of `truncated`, stop. That is the token-budget failure from Task 12 showing up for real, and the budget must be fixed before the recording means anything.

- [ ] **Step 2: Bless the variant snapshots**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx src/scripts/eval-bless.ts --variant luna"
```

Expected: `variant: luna`, then `CHANGED` for both fixtures (there is no prior snapshot, so everything is new), then `-> rewrote .../snapshot.luna.json`.

- [ ] **Step 3: READ THE DIFF - this is the gate**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx -e \"
const { readFileSync } = require('fs');
for (const name of ['podcast-ecology','podcast-answer-arc']) {
  const dir = 'src/__tests__/fixtures/eval/' + name + '/';
  const base = JSON.parse(readFileSync(dir + 'snapshot.json','utf-8'));
  const luna = JSON.parse(readFileSync(dir + 'snapshot.luna.json','utf-8'));
  console.log('=== ' + name + ' ===');
  console.log('clips: ' + base.count + ' (gpt-5.1) vs ' + luna.count + ' (luna)');
  console.log('-- gpt-5.1');
  for (const c of base.clips) console.log('   ' + c.range + ' [' + c.score + '] ' + c.title);
  console.log('-- luna');
  for (const c of luna.clips) console.log('   ' + c.range + ' [' + c.score + '] ' + c.title);
  console.log('dropReasons base: ' + JSON.stringify(base.dropReasons));
  console.log('dropReasons luna: ' + JSON.stringify(luna.dropReasons));
}
\""
```

Record for each fixture: clip count on each side, how many clips overlap in time, how many are unique to each side.

**Technical gate - blocking.** Check the analyze telemetry for the recorded run: zero truncations, zero refusals, zero batch splits, and verdicts equal to candidates submitted. If the recording produced any `__outcome` marker, this gate has failed - return to Task 12.

**Mechanical gate - read, do not block.** A near-identical clip set means Luna judges like gpt-5.1. Half the set moving is a different conversation and is worth pausing on before Task 14.

- [ ] **Step 4: Verify the harness now protects both variants**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/eval-snapshot.test.ts"
```

Expected: PASS with four replay cases - both fixtures x `base` and `luna`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/__tests__/fixtures/eval
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "test(eval): record the gpt-5.6-luna variant on both fixtures

Scanner answers are reused byte for byte, so the diff against the gpt-5.1
snapshots is a statement about the judge and nothing else."
```

---

## Task 14: Flip the default

Only after the gates in Task 13 pass.

**Files:**
- Modify: `apps/worker/src/analyze-v2/config.ts:85,115`
- Modify: `apps/worker/src/analyze-v2/critic.ts:65-66` (only if Task 12 said so)
- Modify: `apps/worker/src/analyze-v2/finalize.ts` (only if Task 12 said so)
- Modify: `apps/worker/src/__tests__/analyze-config.test.ts`
- Modify: `apps/worker/src/__tests__/fixtures/eval/variants.json`
- Rename: `snapshot.luna.json` -> `snapshot.json`, and the old base snapshot -> `snapshot.gpt51.json`

- [ ] **Step 1: First prove `reasoning_effort` still reaches the new model**

`llm.ts:43` gates the parameter on `opts.model.startsWith("gpt-5")`. `gpt-5.6-luna` matches, so nothing needs changing - but nothing currently asserts it either, and the whole token-budget measurement in Task 12 was taken WITH the parameter set. If the gate silently stopped matching, every budget number would describe a request the engine no longer makes.

Add this case to `apps/worker/src/__tests__/llm.test.ts`, beside the existing `"passes reasoning_effort only to gpt-5 models"` test:

```ts
  it("still passes reasoning_effort to gpt-5.6-luna", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "{}", refusal: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const client = { chat: { completions: { create } } } as never;
    await callJsonSchema(client, newUsage(), {
      model: "gpt-5.6-luna",
      system: "s",
      user: "u",
      schema: { name: "t", strict: true, schema: {} },
      reasoningEffort: "low",
    });
    expect(create.mock.calls[0][0]).toMatchObject({ reasoning_effort: "low" });
  });
```

Match the imports and mock style already used in that file - it imports `callJsonSchema` and `newUsage` from `../analyze-v2/llm` and uses `vi` from vitest. Run it:

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src/__tests__/llm.test.ts"
```

Expected: PASS. If it fails, the gate does not match `gpt-5.6-luna` and `llm.ts:43` must be widened before anything else in this task proceeds.

- [ ] **Step 2: Change the defaults**

`criticModelFallback` stays `gpt-5-mini`, deliberately: the fallback exists for 429s and hard failures, and falling from one cheap model to another cheap model is the right shape. Do not change it unless the Task 12 measurement gave a reason to.

**Recorded during the Task 5 review, because it bears on this step.** The finalizer's hard-error path falls back to `cfg.criticModelFallback`, not to a finalizer-specific variable. That is why the price guard's model set is complete today with exactly six env vars, verified by tracing every model name to its OpenAI call site. If anyone ever adds a `FINALIZER_MODEL_FALLBACK`, `configuredModels()` in `apps/worker/src/price-check.ts` must gain it - and nothing would catch the omission except a fresh audit, because both guards enumerate rather than discover.

In `apps/worker/src/analyze-v2/config.ts`, replace:

```ts
    criticModel: env.OPENAI_CRITIC_MODEL || "gpt-5.1",
```

with:

```ts
    criticModel: env.OPENAI_CRITIC_MODEL || "gpt-5.6-luna",
```

and replace:

```ts
      env.OPENAI_FINALIZER_MODEL || env.OPENAI_CRITIC_MODEL || "gpt-5.1",
```

with:

```ts
      env.OPENAI_FINALIZER_MODEL || env.OPENAI_CRITIC_MODEL || "gpt-5.6-luna",
```

- [ ] **Step 3: Apply the measured token budgets, if they moved**

**MEASURED 2026-07-31. They do not move - keep `CRITIC_BASE_TOKENS = 1200` and
`CRITIC_TOKENS_PER_CANDIDATE = 800` exactly as they are.**

The control run on gpt-5.1 validated the instrument first: all three truncation cells
reproduced (1/400, 3/1200, 6/2400, each burning the full cap on reasoning for zero verdicts)
and every completing cell matched `critic.ts`'s recorded table within a few percent.

Luna's ladder, `reasoning_effort: low`, prompts pooled from both fixtures because neither
carries all three batch sizes on its own:

    batch /    cap ->  input / completion / reasoning / verdicts
       1 /    400 ->   3122 /        400 /       400 / 0   (truncated)
       1 /   1200 ->   3122 /        310 /       160 / 1
       1 /   2000 ->   3122 /        389 /       225 / 1
       1 /   3000 ->   3122 /        390 /       239 / 1
       3 /   1200 ->   5092 /       1200 /      1200 / 0   (truncated)
       3 /   3000 ->   5092 /        831 /       384 / 3
       3 /   3600 ->   5092 /        865 /       421 / 3
       3 /   6000 ->   5092 /        959 /       512 / 3
       6 /   2400 ->   9100 /       1424 /       558 / 6
       6 /   5000 ->   9100 /       1212 /       410 / 6
       6 /   6000 ->   9100 /       1513 /       701 / 6
       6 /   9000 ->   9100 /       1815 /       988 / 6
       6 /  14000 ->   9100 /       1531 /       717 / 6

Luna spends **68-171 reasoning tokens per candidate** against gpt-5.1's 207-620. So on Luna
the visible JSON is the dominant term, not the reasoning - the opposite of the assumption
`critic.ts`'s header is written around. Note 6/2400 does NOT truncate on Luna where it always
did on gpt-5.1.

By the existing rule - smallest round number strictly above a cap observed to complete - the
requirements are 2000 / 3600 / 3000. The current constants yield 2000 / 3600 / 6000 and clear
all three.

**Why not tighten to the measured fit.** A 1800/600 pair was proposed and is a closer fit. It
is rejected: it would shrink the size-6 budget from 6000 to 5400 on the strength of ONE sample
per cell, when per-call variance is demonstrably the same order as the headroom (Luna measured
410 reasoning tokens at cap 5000 and 988 at cap 9000 for the same batch). Tightening a budget
toward its measured minimum is the exact direction that produced the original starvation
cascade. The error direction here is also asymmetric and currently safe: Luna is leaner, so
the unchanged budget is MORE generous relative to need than it was for gpt-5.1.

**What to do in this step: nothing to `critic.ts`.** Rewrite only its header comment so it
states the numbers are gpt-5.1's, that Luna was measured against them on 2026-07-31 and needed
no change, and that Luna's dominant term is the JSON rather than the reasoning. Say "measured,
unchanged" explicitly - a reader who finds gpt-5.1 numbers above a Luna default must not
conclude they were simply never revisited.

The finalizer's `FINALIZER_BASE_TOKENS` / `FINALIZER_TOKENS_PER_CLIP` were NOT measured - they
are marked ESTIMATED in `finalize.ts` and remain so. The finalizer cannot split a batch, so
starvation there costs the whole stage; Task 13's recording is the first real evidence about
it, and a truncated finalizer response in that run is the signal to measure it properly.



If Task 12 step 4 produced different numbers, edit `apps/worker/src/analyze-v2/critic.ts`:

```ts
const CRITIC_BASE_TOKENS = 1200; // shared rubric/JSON-scaffold pass + flat headroom
const CRITIC_TOKENS_PER_CANDIDATE = 800; // ~450 reasoning + ~150 JSON + ~200 headroom
```

Replace the numbers with the measured ones and rewrite the trailing comments to describe Luna's profile rather than gpt-5.1's. Do the same for `FINALIZER_BASE_TOKENS` and `FINALIZER_TOKENS_PER_CLIP` in `finalize.ts` if the finalizer measurement moved.

If the numbers did not move, change nothing here and say so explicitly in the commit message - "measured, unchanged" is a result.

- [ ] **Step 4: Swap the variant definitions**

`base` is now Luna, so the alternative on offer becomes the old model. Replace the contents of `apps/worker/src/__tests__/fixtures/eval/variants.json` with:

```json
{
  "gpt51": {
    "criticModel": "gpt-5.1",
    "finalizerModel": "gpt-5.1"
  }
}
```

- [ ] **Step 5: Re-designate the snapshot files**

For each of `podcast-ecology` and `podcast-answer-arc`:

```bash
cd apps/worker/src/__tests__/fixtures/eval
for f in podcast-ecology podcast-answer-arc; do
  git mv $f/snapshot.json $f/snapshot.gpt51.json
  git mv $f/snapshot.luna.json $f/snapshot.json
done
cd -
```

- [ ] **Step 6: Re-designate the fingerprints in meta.json**

For each fixture, edit `meta.json` by hand so that the top-level `engine` holds what was under `variants.luna.engine`, and `variants` holds a `gpt51` entry with the old top-level `engine`. The result should look like:

```json
{
  "recordedAt": "<the luna recordedAt>",
  "engine": { "...": "the fingerprint recorded for luna" },
  "variants": {
    "gpt51": {
      "recordedAt": "<the original recordedAt>",
      "engine": { "...": "the original gpt-5.1 fingerprint" }
    }
  }
}
```

- [ ] **Step 7: Update the config test**

In `apps/worker/src/__tests__/analyze-config.test.ts`, replace:

```ts
    expect(cfg.criticModel).toBe("gpt-5.1");
```

with:

```ts
    expect(cfg.criticModel).toBe("gpt-5.6-luna");
```

- [ ] **Step 8: Run the full worker suite**

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx vitest run --root /app apps/worker/src"
```

Expected: PASS, including four replay cases (both fixtures x `base` and `gpt51`) and the `env-prices-binding` test, which now checks that `gpt-5.6-luna` has a price - it does, because Task 4 added it.

If `eval-snapshot.test.ts` fails on a fingerprint mismatch, the meta.json re-designation in step 5 is wrong. The error message names the exact knob.

- [ ] **Step 9: Update `.env.example`**

Change line 24 from `OPENAI_CRITIC_MODEL=gpt-5.1` to:

```
OPENAI_CRITIC_MODEL=gpt-5.6-luna
```

- [ ] **Step 10: Deploy and verify the rollback path**

```bash
docker compose up -d worker-analyze worker-finalize   # up -d, not restart: env_file
docker compose logs --tail 20 worker-analyze | grep "\[cost\]" || echo "no missing prices - good"
```

Then confirm the rollback works without a code change: add `OPENAI_CRITIC_MODEL=gpt-5.1` and `OPENAI_FINALIZER_MODEL=gpt-5.1` to `.env`, restart `worker-analyze`, and check the config resolves to gpt-5.1:

```bash
docker compose exec worker-analyze sh -c "cd /app/apps/worker && npx tsx -e \"
const { loadAnalyzeConfig } = require('./src/analyze-v2/config');
const c = loadAnalyzeConfig();
console.log('critic=' + c.criticModel + ' finalizer=' + c.finalizerModel);
\""
```

Expected: `critic=gpt-5.1 finalizer=gpt-5.1`. Then remove those two lines from `.env` again and restart, and re-run the same command expecting `gpt-5.6-luna`.

- [ ] **Step 11: Commit**

```bash
git add apps/worker/src/analyze-v2/config.ts apps/worker/src/analyze-v2/critic.ts \
        apps/worker/src/analyze-v2/finalize.ts \
        apps/worker/src/__tests__/analyze-config.test.ts \
        apps/worker/src/__tests__/fixtures/eval .env.example
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "feat(engine): critic and finalizer default to gpt-5.6-luna

-87% on analysis cost. The gpt-5.1 answers stay in the fixtures as the gpt51
variant, so the comparison remains reproducible offline and free. Rollback is
OPENAI_CRITIC_MODEL / OPENAI_FINALIZER_MODEL in .env plus a restart - no code
revert, no deploy."
```

---

## Task 15: Record what was measured, and get the blind verdict

**Files:**
- Modify: `docs/engine-notes.md`

- [ ] **Step 1: Add the entry**

In `docs/engine-notes.md` section 3 ("Measured facts about the engine"), add a new subsection after the critic token budget paragraph. Fill every number from the Task 12 output and the Task 13 diff - this file's own rule is that every number in it came from a measurement:

```markdown
**Luna's critic token budget** (migrated 2026-07-31, spec
`2026-07-31-luna-critic-migration-design.md`). Measured with
`scripts/measure-critic-budget.ts` on the `podcast-ecology` critic prompts,
live `gpt-5.6-luna`, `reasoning_effort: low`, same ladder as the gpt-5.1 table
above (batch / cap -> completion / reasoning / verdicts):

    <paste the measured ladder here>

Reasoning is ~<N> tokens per candidate against gpt-5.1's 330-450. Budgets
chosen by the same rule - smallest round number above a cap observed to
complete at that size: <sizes and values>.

**What the model change did to the shipped set.** Both fixtures replayed with
IDENTICAL scanner answers (the scanner's request keys do not contain the critic
model, so the candidate set entering the critic is the same one gpt-5.1
judged). podcast-ecology: <N> clips -> <M>. podcast-answer-arc: <N> -> <M>.
<X> of them overlap in time; <Y> are unique to Luna; <Z> were lost.

**Cost.** Analysis per 52-minute job went <measured before> -> <measured after>.
The projection in the spec was $0.210 -> $0.027; record here what it actually
came to, because the projection rested on an inferred token split
(output ~0.425x input, from a billing screenshot) and this is the measurement
that replaces it.
```

- [ ] **Step 2: Run a real video for the blind comparison**

Submit one new video through the product. When it finishes, produce the clips from both configurations on the SAME transcript - the `gpt51` variant is already recorded for the fixtures, but a fresh video needs both runs made live. The cheapest route is to run the job once on the default (Luna), then set `OPENAI_CRITIC_MODEL=gpt-5.1` and `OPENAI_FINALIZER_MODEL=gpt-5.1` in `.env`, restart `worker-analyze`, and re-run analysis on the same job.

Present the two clip sets to the owner **interleaved and unlabelled**. The verdict per clip is "would post / would not". Knowing which run is which would decide the question before the clips do, and the only real-world scoreboard this engine has is 2 postable out of 8.

Remove the override from `.env` and restart afterwards.

- [ ] **Step 3: Commit**

```bash
git add docs/engine-notes.md
git -c user.name=Trowgar -c user.email=trowgar@yahoo.com commit -m "docs: record Luna's measured token budget and what it did to the clip set"
```

---

## Measured during Task 7: six rows became repriceable, not ten

The backfill filled `criticModel` on all ten rows carrying cost telemetry, and the six
`RECALL_CRITIC` rows now recompute from their stored token counts to within 5e-4 of the stored
dollar figure - pure three-decimal rounding. Those six are genuinely repriceable, which is what
the column was added for.

The four older rows are not, and `criticModel` was never the blocker for them. They carry ZERO
analysis tokens, and their stored analysis dollars came from the fabricated
`sourceMinutes * 0.00005` fallback that Task 3 deleted. No backfill can recover a token count
that was never recorded. So the accurate claim is six, and anyone reporting "all ten rows are
repriceable" is wrong.

Also worth recording, because it nearly bit: those four rows carry `analyzeEngine = NULL`, not
`LEGACY`. The script branches on `!== "RECALL_CRITIC"`, which caught them; an equality test
against `LEGACY` would have silently missed all four and left them NULL.

---

## Follow-up raised during Task 6, recorded rather than fixed

**A FAILED job records nothing about which model burned its tokens.** The failure path in
`stages/finalize.ts` writes only `status` and `error`, so a run that spent real money on
analysis and then failed leaves no trace of what it spent it on. Raised by the Task 6
implementer, and correct: the spend is as real as a successful run's.

Not fixed there because it is not a migration detail - it changes what a failed job reports,
which touches billing visibility and the free-tier ledger's refund path, and those deserve
their own decision. Note the interaction: `settleFreeLedger` refunds failed jobs uncapped on
purpose ("a failure here is our breakage, and our breakage must never spend a stranger's only
look at the product"), so recording the cost of a failed run must not become a reason to
charge for it.

---

## Follow-ups this plan deliberately does NOT do

Both are in the spec; neither belongs in this change.

1. **`FREE_TIER` recalibration.** `estimatedUsdPerSourceMinute = 0.012` and `estimatedUsdPerRun = 0.03` will be roughly 10x too high after this migration. Over-reservation is safe by design and the constants are inert today (`FREE_TIER_MONTHLY_BUDGET_USD` is unset). `plans.ts:143` requires re-running the fitting query against prod before either number moves. **Trigger:** five jobs on Luna with recorded cost telemetry, then the SQL at `plans.ts:147-155`, then the edit. **Until then, do not open the trial** - a free run would consume about ten times its true cost from the ceiling and most of this migration's saving would never reach users.

2. **Groq ASR.** After this migration transcription is ~93% of a job's cost. `whisper-large-v3-turbo` at $0.04/hour against OpenAI's $0.36/hour is the single largest remaining lever. It needs its own spec: ASR perturbs the engine harder than the critic does - engine-notes records 6 versus 10 shipped clips from two runs of the same audio through the same whisper.
