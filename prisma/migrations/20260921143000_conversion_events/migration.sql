CREATE TABLE "conversion_events" (
  "id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "detail" JSONB,
  "eventKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversion_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "conversion_events_eventKey_key" ON "conversion_events"("eventKey");
CREATE INDEX "conversion_events_event_createdAt_idx" ON "conversion_events"("event", "createdAt");
CREATE INDEX "conversion_events_surface_subjectId_createdAt_idx" ON "conversion_events"("surface", "subjectId", "createdAt");
ALTER TABLE "jobs" ADD COLUMN "planAtSubmission" "Plan", ADD COLUMN "submissionSurface" TEXT;
