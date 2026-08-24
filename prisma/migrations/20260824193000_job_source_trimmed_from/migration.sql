-- The pre-trim duration of a source, in seconds. NULL on every job that was not
-- trimmed, which is every paid job and most free ones.
--
-- Nullable and with no default on purpose: "was not trimmed" and "we do not
-- know" are the same answer here, and a 0 default would make every historical
-- row claim it was trimmed to nothing.
ALTER TABLE "jobs" ADD COLUMN "sourceTrimmedFromSec" INTEGER;
