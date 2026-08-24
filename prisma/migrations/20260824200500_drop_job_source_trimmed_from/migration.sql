-- Undoes 20260824193000. The partial-processing change that column was added for
-- was reverted the same evening, and it never held a value: zero rows were ever
-- written to it, so dropping it loses nothing.
--
-- Dropped forward rather than by deleting the earlier migration, which is
-- already recorded in _prisma_migrations on every environment that has run it.
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "sourceTrimmedFromSec";
