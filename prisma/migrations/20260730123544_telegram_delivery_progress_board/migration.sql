-- AlterTable
ALTER TABLE "telegram_deliveries" ADD COLUMN     "progressMessageId" INTEGER,
ADD COLUMN     "progressStatus" "JobStatus";
