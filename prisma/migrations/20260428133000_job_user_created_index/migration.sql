-- Composite index for the daily-jobs-count query in /api/jobs POST:
--   WHERE userId = ? AND createdAt >= startOfDay
-- Without this, the query falls back to the (userId)-only index and
-- post-filters by createdAt — fine for MVP scale, painful at growth.
CREATE INDEX "jobs_userId_createdAt_idx" ON "jobs"("userId", "createdAt");
