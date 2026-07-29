-- Records when a verification mail was last accepted by the provider.
--
-- NULL is the honest answer for every row that predates this column: we do not
-- know whether a link ever went out. The dashboard reads it that way rather
-- than asserting a send it cannot see.
ALTER TABLE "users" ADD COLUMN "verificationSentAt" TIMESTAMP(3);
