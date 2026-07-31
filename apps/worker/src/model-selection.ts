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

/**
 * Which model the TRANSCRIBE stage used. Same argument, same failure mode.
 *
 * The default lives HERE rather than being delegated, unlike criticModel: the
 * transcription model has no config module to defer to (loadAnalyzeConfig is
 * the ANALYZE engine's, and this is not an analyze setting). This is the only
 * copy of the default in the tree, which is the property that matters.
 */
export function transcriptionModel(env: Env = process.env): string {
  return env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
}
