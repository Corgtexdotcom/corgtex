-- CreateEnum
CREATE TYPE "NewspaperCadence" AS ENUM ('DAILY', 'WEEKLY');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "newspaperCadence" "NewspaperCadence";
