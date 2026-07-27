-- Two pieces of drift between the production database and prisma/schema.prisma,
-- both inherited from the `db push` era and both harmless in themselves - but
-- while they exist `prisma migrate diff` is never empty, so it cannot be used
-- to answer "is the database what the schema says", which is the question it
-- exists for.
--
-- 1. 20260726120000_funnel_events_generalize renamed the table and the columns
--    but not the primary key constraint, which is still called
--    bot_funnel_events_pkey.
-- 2. tribute_webhook_events."updatedAt" carries a DEFAULT CURRENT_TIMESTAMP
--    that the datamodel does not declare. The field is @updatedAt, which Prisma
--    maintains from the application on every write, so the database default is
--    never the value that ends up stored. Dropping it changes no behaviour for
--    any code path that goes through Prisma.

ALTER TABLE "funnel_events"
    RENAME CONSTRAINT "bot_funnel_events_pkey" TO "funnel_events_pkey";

ALTER TABLE "tribute_webhook_events" ALTER COLUMN "updatedAt" DROP DEFAULT;
