-- The Telegram bot showed its two-button first screen and returned without
-- writing anything, so a User row only appeared once someone pressed a button.
-- That made the top of the funnel unmeasurable: 95 accounts and 3 people who
-- ever ran a job, out of an unknown number who opened the bot at all.
--
-- One row per (person, step), not one per press: the operator's question is
-- "how many people reached the first screen and how many went past it", so
-- count(*) answers it directly and the table grows with the audience instead
-- of with the traffic. Repeat presses bump `occurrences` in place.
--
-- No foreign key to users on purpose - the rows that matter most are the ones
-- with no user behind them. Join on "telegramId" when you want the converts.
CREATE TABLE "bot_funnel_events" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "locale" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_funnel_events_pkey" PRIMARY KEY ("id")
);

-- The upsert target: makes "one row per person per step" a database rule
-- rather than an application convention.
CREATE UNIQUE INDEX "bot_funnel_events_telegramId_event_key" ON "bot_funnel_events"("telegramId", "event");

-- Serves the only read this table has: count a step over a date range.
CREATE INDEX "bot_funnel_events_event_firstSeenAt_idx" ON "bot_funnel_events"("event", "firstSeenAt");
