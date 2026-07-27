CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "country" TEXT,
    "path" TEXT NOT NULL,
    "referrerHost" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "site_visits_day_visitorHash_path_key"
  ON "site_visits"("day", "visitorHash", "path");
CREATE INDEX "site_visits_day_country_idx" ON "site_visits"("day", "country");
CREATE INDEX "site_visits_day_isBot_idx" ON "site_visits"("day", "isBot");
