-- CreateEnum
CREATE TYPE "SensitivityLabel" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PII');

-- AlterTable
ALTER TABLE "KnowledgeChunk" ADD COLUMN     "sensitivity" "SensitivityLabel" NOT NULL DEFAULT 'PUBLIC';
