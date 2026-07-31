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
