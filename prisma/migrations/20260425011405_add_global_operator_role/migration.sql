-- CreateEnum
CREATE TYPE "GlobalRole" AS ENUM ('USER', 'OPERATOR');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "globalRole" "GlobalRole" NOT NULL DEFAULT 'USER';
