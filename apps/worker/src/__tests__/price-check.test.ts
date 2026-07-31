import { describe, expect, it, vi } from "vitest";
import { loadModelPrices } from "@clipclap/shared";
import { configuredModels, unpricedModels, warnAboutMissingPrices } from "../price-check";

/**
 * Covers the boot-time price guard in price-check.ts.
 *
 * The thing worth pinning here is not the happy path - it is that the model
 * list stays complete. A check that silently stops covering one knob (someone
 * drops `cfg.finalizerModel` from the loop, or swaps the audio lookup for the
 * token one) still runs green forever; nothing else in the suite would notice.
 * Test 1 and test 5 exist specifically to red on those two mutations - see the
 * task record for the mutation-test proof.
 */

const DISTINCT_ENV = {
  OPENAI_SCAN_MODEL: "scan-model-x",
  OPENAI_CRITIC_MODEL: "critic-model-x",
  CRITIC_MODEL_FALLBACK: "critic-fallback-x",
  OPENAI_FINALIZER_MODEL: "finalizer-model-x",
  OPENAI_HIGHLIGHTS_MODEL: "highlights-model-x",
  OPENAI_TRANSCRIPTION_MODEL: "transcription-model-x",
};

describe("configuredModels", () => {
  it("includes every model the engine can select, given distinct values for each knob", () => {
    const models = configuredModels(DISTINCT_ENV);
    expect(models.token).toEqual(
      expect.arrayContaining([
        "scan-model-x",
        "critic-model-x",
        "critic-fallback-x",
        "finalizer-model-x",
        "highlights-model-x",
      ])
    );
    expect(models.token).toHaveLength(5);
    expect(models.audio).toEqual(["transcription-model-x"]);
  });

  it("deduplicates when two knobs resolve to the same model", () => {
    const models = configuredModels({
      ...DISTINCT_ENV,
      // Finalizer defaults to the critic model when unset - so omitting it
      // collapses the two into one entry.
      OPENAI_FINALIZER_MODEL: undefined,
      OPENAI_CRITIC_MODEL: "shared-model",
    });
    expect(models.token.filter((m) => m === "shared-model")).toHaveLength(1);
  });
});

describe("unpricedModels", () => {
  it("returns empty when the table covers every configured model", () => {
    const prices = loadModelPrices(
      {
        MODEL_PRICES_JSON: JSON.stringify({
          tokensPerMillionUsd: {
            "scan-model-x": { input: 1, output: 2 },
            "critic-model-x": { input: 1, output: 2 },
            "critic-fallback-x": { input: 1, output: 2 },
            "finalizer-model-x": { input: 1, output: 2 },
            "highlights-model-x": { input: 1, output: 2 },
          },
          audioPerMinuteUsd: { "transcription-model-x": 0.006 },
        }),
      },
      () => {}
    );
    expect(unpricedModels(prices, DISTINCT_ENV)).toEqual([]);
  });

  it("names exactly the missing models, not the priced ones", () => {
    const prices = loadModelPrices(
      {
        MODEL_PRICES_JSON: JSON.stringify({
          tokensPerMillionUsd: {
            "scan-model-x": { input: 1, output: 2 },
            "critic-model-x": { input: 1, output: 2 },
            // critic-fallback-x and finalizer-model-x and highlights-model-x left unpriced
          },
          audioPerMinuteUsd: { "transcription-model-x": 0.006 },
        }),
      },
      () => {}
    );
    const missing = unpricedModels(prices, DISTINCT_ENV);
    expect(missing.sort()).toEqual(
      ["critic-fallback-x", "finalizer-model-x", "highlights-model-x"].sort()
    );
  });

  it("looks up the transcription model under audioPerMinuteUsd, not tokensPerMillionUsd", () => {
    // The ASR model is priced, but only under the wrong table. If the audio
    // lookup were accidentally swapped for the token one, this would (wrongly)
    // read as priced.
    const prices = loadModelPrices(
      {
        MODEL_PRICES_JSON: JSON.stringify({
          tokensPerMillionUsd: {
            "transcription-model-x": { input: 1, output: 2 },
            "scan-model-x": { input: 1, output: 2 },
            "critic-model-x": { input: 1, output: 2 },
            "critic-fallback-x": { input: 1, output: 2 },
            "finalizer-model-x": { input: 1, output: 2 },
            "highlights-model-x": { input: 1, output: 2 },
          },
          audioPerMinuteUsd: {},
        }),
      },
      () => {}
    );
    expect(unpricedModels(prices, DISTINCT_ENV)).toEqual(["transcription-model-x"]);
  });
});

describe("warnAboutMissingPrices", () => {
  it("stays silent when nothing is missing", () => {
    const warn = vi.fn();
    const env = {
      ...DISTINCT_ENV,
      MODEL_PRICES_JSON: JSON.stringify({
        tokensPerMillionUsd: {
          "scan-model-x": { input: 1, output: 2 },
          "critic-model-x": { input: 1, output: 2 },
          "critic-fallback-x": { input: 1, output: 2 },
          "finalizer-model-x": { input: 1, output: 2 },
          "highlights-model-x": { input: 1, output: 2 },
        },
        audioPerMinuteUsd: { "transcription-model-x": 0.006 },
      }),
    };
    warnAboutMissingPrices(env, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits one message naming all missing models when the table is present but empty", () => {
    const warn = vi.fn();
    const env = {
      ...DISTINCT_ENV,
      MODEL_PRICES_JSON: JSON.stringify({
        tokensPerMillionUsd: {},
        audioPerMinuteUsd: {},
      }),
    };
    warnAboutMissingPrices(env, warn);
    expect(warn).toHaveBeenCalledOnce();
    const message = warn.mock.calls[0][0];
    expect(message).toContain("scan-model-x");
    expect(message).toContain("critic-model-x");
    expect(message).toContain("critic-fallback-x");
    expect(message).toContain("finalizer-model-x");
    expect(message).toContain("highlights-model-x");
    expect(message).toContain("transcription-model-x");
  });

  it("emits both the loader's warning and its own when MODEL_PRICES_JSON is unset", () => {
    const warn = vi.fn();
    warnAboutMissingPrices({ OPENAI_CRITIC_MODEL: "unpriced-model" }, warn);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("MODEL_PRICES_JSON is unset");
    expect(warn.mock.calls[1][0]).toContain("[cost] no price");
    expect(warn.mock.calls[1][0]).toContain("unpriced-model");
  });
});
