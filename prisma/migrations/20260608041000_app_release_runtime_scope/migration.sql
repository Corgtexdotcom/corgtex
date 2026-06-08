-- DropIndex
DROP INDEX "AppRelease_appDefinitionId_version_key";

-- CreateIndex
CREATE INDEX "AppRelease_appDefinitionId_version_idx" ON "AppRelease"("appDefinitionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AppRelease_appDefinitionId_runtimeId_version_key" ON "AppRelease"("appDefinitionId", "runtimeId", "version");
