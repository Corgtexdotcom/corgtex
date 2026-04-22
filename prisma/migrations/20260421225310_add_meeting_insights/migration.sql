-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "aiProcessedAt" TIMESTAMP(3),
ADD COLUMN     "decisionsJson" JSONB;
