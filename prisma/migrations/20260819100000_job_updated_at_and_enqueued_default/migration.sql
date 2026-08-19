-- Job.updatedAt: the liveness column the queue stall guard reads. The DB
-- default (not just the backfill) matters: code that predates the column
-- INSERTs without it during the deploy window and must not hit NOT NULL.
ALTER TABLE "jobs" ADD COLUMN "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "jobs" SET "updatedAt" = "createdAt";
ALTER TABLE "jobs" ALTER COLUMN "updatedAt" SET NOT NULL;

-- enqueuedAt gains a DB default for the same deploy window: old code both
-- INSERTs without the column AND enqueues to BullMQ at creation, so the safe
-- reading of such a row is "enqueued now", never "waiting" - a false waiting
-- row would be re-added under a different BullMQ id and downloaded twice.
ALTER TABLE "jobs" ALTER COLUMN "enqueuedAt" SET DEFAULT CURRENT_TIMESTAMP;
