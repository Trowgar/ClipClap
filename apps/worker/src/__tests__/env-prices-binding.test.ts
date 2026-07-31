import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { audioPricePerMinute, loadModelPrices, tokenPrice } from "@clipclap/shared";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { highlightsModel, transcriptionModel } from "../model-selection";

/**
 * Binds two things that otherwise have no reason to agree: the models the
 * deployment can select (analyze-v2/config.ts and model-selection.ts) and the
 * shipped price table.
 *
 * The failure it catches is a model change that forgets the price. That used to
 * be invisible because cost-telemetry fell back to gpt-5.1's price for anything
 * unknown; now it produces a null cost, which is honest but silent. This is
 * where it becomes loud.
 *
 * "Default engine config" below means `loadAnalyzeConfig({})`, whose `engine`
 * is `legacy` - so on a bare default env, the V2 models checked here (scan,
 * critic, critic fallback, finalizer) are not the ones that execute; the
 * legacy path's model is `highlightsModel`, checked separately. The V2 models
 * are still checked because production runs with ANALYZE_ENGINE=recall-critic,
 * where they are what executes. Neither list claims to cover every model this
 * file could ever be pointed at - only the ones the two code paths reach today.
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

  it("prices every model the default V2 config and the legacy analyzer can reach", () => {
    const cfg = loadAnalyzeConfig({});
    for (const model of [
      cfg.scanModel,
      cfg.criticModel,
      cfg.criticModelFallback,
      cfg.finalizerModel,
      highlightsModel({}),
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
