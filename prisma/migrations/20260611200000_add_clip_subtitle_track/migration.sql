-- Editable per-clip subtitle track (cues relative to the clip file)
ALTER TABLE "clips" ADD COLUMN "subtitleTrack" JSONB;
