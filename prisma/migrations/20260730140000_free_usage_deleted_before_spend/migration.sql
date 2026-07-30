-- Deleting a job that has not started yet gives the allowance back, and the
-- ledger has to be able to say why. FAILED_JOB would claim we broke something
-- and ZERO_CLIPS is capped at one per account; this release is neither.
--
-- ADD VALUE inside a transaction is fine on PG16 as long as nothing uses the
-- new label before the commit, which nothing here does.
-- AlterEnum
ALTER TYPE "FreeUsageReason" ADD VALUE 'DELETED_BEFORE_SPEND';
