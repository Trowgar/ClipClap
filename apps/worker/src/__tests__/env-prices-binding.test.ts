import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { audioPricePerMinute, loadModelPrices, tokenPrice } from "@clipclap/shared";
import { loadAnalyzeConfig } from "../analyze-v2/config";
import { transcriptionModel } from "../model-selection";

/**
 * Binds two files that otherwise have no reason to agree: the engine's default
 * models (analyze-v2/config.ts, model-selection.ts) and the price table shipped
 * in .env.example.
 *
 * The failure it exists to catch is a model change that forgets the price. That
 * used to be invisible, because cost-telemetry fell back to gpt-5.1's price for
 * anything unknown; now it produces a null cost, which is honest but silent.
 * This test is where it becomes loud.
 *
 * To verify this test is real, delete one model's entry from MODEL_PRICES_JSON
 * in .env.example by hand and watch it go red.
 */
const ENV_EXAMPLE = join(__dirname, "..", "..", "..", "..", ".env.example");

function readExampleEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_EXAMPLE, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

describe(".env.example price table", () => {
  const example = readExampleEnv();
  const prices = loadModelPrices(example, () => {});

  it("is present and parses", () => {
    expect(example.MODEL_PRICES_JSON).toBeDefined();
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
        `MODEL_PRICES_JSON in .env.example has no price for "${model}"`
      ).toBeDefined();
    }
  });

  it("prices the default transcription model", () => {
    const model = transcriptionModel({});
    expect(
      audioPricePerMinute(prices, model),
      `MODEL_PRICES_JSON in .env.example has no audio price for "${model}"`
    ).toBeDefined();
  });
});
