import { describe, expect, it } from "vitest";
import { criticModel, highlightsModel, transcriptionModel } from "../model-selection";
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

describe("highlightsModel", () => {
  it("defaults to gpt-4o-mini", () => {
    expect(highlightsModel({})).toBe("gpt-4o-mini");
  });

  it("honours OPENAI_HIGHLIGHTS_MODEL", () => {
    expect(highlightsModel({ OPENAI_HIGHLIGHTS_MODEL: "gpt-5.1" })).toBe("gpt-5.1");
  });

  it("treats an empty value as unset rather than as a model named empty string", () => {
    expect(highlightsModel({ OPENAI_HIGHLIGHTS_MODEL: "" })).toBe("gpt-4o-mini");
  });
});
