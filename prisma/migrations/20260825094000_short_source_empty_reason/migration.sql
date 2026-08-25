-- A refund reason for a zero-clip run on a source we had already warned was too
-- short to work. Uncapped, and separate from ZERO_CLIPS so it can neither consume
-- nor be consumed by the once-per-account forgiveness.
ALTER TYPE "FreeUsageReason" ADD VALUE IF NOT EXISTS 'SHORT_SOURCE_EMPTY';
