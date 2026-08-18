-- CreateTable
CREATE TABLE "upload_refusals" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "detail" JSONB,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_refusals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_refusals_code_createdAt_idx" ON "upload_refusals"("code", "createdAt");

-- CreateIndex
CREATE INDEX "upload_refusals_subjectId_createdAt_idx" ON "upload_refusals"("subjectId", "createdAt");
