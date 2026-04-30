-- AlterTable
ALTER TABLE "DemoLead" ADD COLUMN     "followUpCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFollowUpAt" TIMESTAMP(3);
