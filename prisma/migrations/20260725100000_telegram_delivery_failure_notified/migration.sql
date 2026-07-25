-- "we told the user the job failed" is not the same event as "our own send
-- threw": the first can still turn into clips when a BullMQ retry heals the
-- job, the second is terminal. Split it out so the poller can re-pick one and
-- never the other.
ALTER TYPE "TelegramDeliveryStatus" ADD VALUE 'FAILURE_NOTIFIED' BEFORE 'FAILED';
