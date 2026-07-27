-- Rename the table and the subject column
ALTER TABLE "bot_funnel_events" RENAME TO "funnel_events";
ALTER TABLE "funnel_events" RENAME COLUMN "telegramId" TO "subjectId";

-- Add the surface, backfilling every existing row as bot traffic
ALTER TABLE "funnel_events" ADD COLUMN "surface" TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE "funnel_events" ALTER COLUMN "surface" DROP DEFAULT;

-- The unique key gains the surface, so it must be recreated rather than renamed
DROP INDEX "bot_funnel_events_telegramId_event_key";
CREATE UNIQUE INDEX "funnel_events_surface_subjectId_event_key"
  ON "funnel_events"("surface", "subjectId", "event");

ALTER INDEX "bot_funnel_events_event_firstSeenAt_idx"
  RENAME TO "funnel_events_event_firstSeenAt_idx";
