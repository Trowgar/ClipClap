-- Drop subtitle style presets: one default burned-in style, subtitles are on/off only
ALTER TABLE "jobs" DROP COLUMN "subtitlePreset";
ALTER TABLE "clips" DROP COLUMN "subtitlePreset";
