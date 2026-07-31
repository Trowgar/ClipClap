import {
  audioPricePerMinute,
  loadModelPrices,
  tokenPrice,
  type ModelPrices,
} from "@clipclap/shared";
import { loadAnalyzeConfig } from "./analyze-v2/config";
import { highlightsModel, transcriptionModel } from "./model-selection";

type Env = Record<string, string | undefined>;

/**
 * Every model this deployment could send a request to, deduplicated.
 *
 * Exported so a test can assert the SET, not just the warning. The failure this
 * guards against is someone dropping an entry from the list: the check would
 * still pass, still look complete, and quietly stop covering one model. That is
 * the same shape of hole the price-table test was found to have.
 */
export function configuredModels(env: Env = process.env): {
  token: string[];
  audio: string[];
} {
  const cfg = loadAnalyzeConfig(env);
  return {
    token: [
      ...new Set([
        cfg.scanModel,
        cfg.criticModel,
        cfg.criticModelFallback,
        cfg.finalizerModel,
        highlightsModel(env),
      ]),
    ],
    audio: [transcriptionModel(env)],
  };
}

export interface UnpricedModel {
  model: string;
  kind: "tokensPerMillionUsd" | "audioPerMinuteUsd";
}

/**
 * Names any configured model the price table does not cover, tagged with
 * WHICH table it belongs in.
 *
 * The tag matters because a name alone is not enough to diagnose the one case
 * that looks broken otherwise: an ASR model sitting in the wrong table (e.g.
 * priced under tokensPerMillionUsd instead of audioPerMinuteUsd). An operator
 * who reads a bare name, finds it right there in the table, and has no kind to
 * check against will conclude the guard itself is wrong. A model missing from
 * BOTH tables appears twice, once per kind, because those are two different
 * fixes to make.
 *
 * A missing price is not fatal - jobs still run, they just record no cost - so
 * this line is the only thing standing between that and going unnoticed.
 *
 * It reads the REAL environment, which is what makes it different from the
 * price-table test: that test can only see shipped defaults, because no process
 * inside a container can read .env. An operator who points OPENAI_CRITIC_MODEL
 * at an unpriced model is caught here and nowhere else.
 */
export function unpricedModels(prices: ModelPrices, env: Env = process.env): UnpricedModel[] {
  const { token, audio } = configuredModels(env);
  const missing: UnpricedModel[] = [
    ...token
      .filter((m) => tokenPrice(prices, m) === undefined)
      .map((model) => ({ model, kind: "tokensPerMillionUsd" as const })),
    ...audio
      .filter((m) => audioPricePerMinute(prices, m) === undefined)
      .map((model) => ({ model, kind: "audioPerMinuteUsd" as const })),
  ];
  const seen = new Set<string>();
  return missing.filter(({ model, kind }) => {
    const key = `${kind}:${model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Emitted at boot rather than at the first job: the first job may be hours
 *  away and by then the log has scrolled. */
export function warnAboutMissingPrices(
  env: Env = process.env,
  warn: (message: string) => void = console.warn
): void {
  const missing = unpricedModels(loadModelPrices(env, warn), env);
  if (missing.length > 0) {
    const named = missing.map(({ model, kind }) => `${model} (${kind})`).join(", ");
    warn(
      `[cost] no price in MODEL_PRICES_JSON for: ${named}. ` +
        `Those jobs will record no cost figure. Add them to .env and restart.`
    );
  }
}
