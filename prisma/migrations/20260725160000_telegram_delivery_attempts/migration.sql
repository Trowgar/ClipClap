-- A pre-send failure must not close the row (the job may still heal and the
-- clips are still owed), but leaving it PENDING for ever gave the poller no
-- drain at all: getPendingTelegramDeliveries takes 20 rows ordered createdAt
-- asc, so twenty rows that can never succeed - a bot the user blocked yields a
-- permanent 403 - fill the window on every poll and nobody else is ever
-- delivered. Count the pre-send failures instead and retire the row once the
-- count is spent.
--
-- DEFAULT 0 so every existing row is valid and starts with a full budget.
ALTER TABLE "telegram_deliveries" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
