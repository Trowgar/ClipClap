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
