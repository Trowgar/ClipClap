-- Per-clip face-aware crop plan (JSON) produced by the smart-reframe engine
ALTER TABLE "clips" ADD COLUMN "cropPlan" JSONB;
