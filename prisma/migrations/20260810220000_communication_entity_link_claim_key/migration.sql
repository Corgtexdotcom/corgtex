-- AlterTable
ALTER TABLE "CommunicationEntityLink" ADD COLUMN     "claimKey" VARCHAR(191);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationEntityLink_workspaceId_claimKey_key" ON "CommunicationEntityLink"("workspaceId", "claimKey");
