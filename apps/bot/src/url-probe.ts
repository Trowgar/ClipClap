// The implementation moved to @clipclap/shared so the web API can gate on the
// same probe. This file stays as the bot's import path.
export {
  extractVideoUrl,
  probeVideoUrl,
  probeLocalFile,
  type ProbeResult,
} from "@clipclap/shared";
