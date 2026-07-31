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
  readonly tokensPerMillionUsd: Readonly<Record<string, TokenPrice>>;
  /** Transcription models, USD per minute of audio, by exact model id. */
  readonly audioPerMinuteUsd: Readonly<Record<string, number>>;
}

export const EMPTY_MODEL_PRICES: ModelPrices = Object.freeze({
  tokensPerMillionUsd: Object.freeze({}),
  audioPerMinuteUsd: Object.freeze({}),
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
  if (!Object.hasOwn(prices.tokensPerMillionUsd, model)) return undefined;
  return prices.tokensPerMillionUsd[model];
}

export function audioPricePerMinute(prices: ModelPrices, model: string): number | undefined {
  if (!Object.hasOwn(prices.audioPerMinuteUsd, model)) return undefined;
  return prices.audioPerMinuteUsd[model];
}
