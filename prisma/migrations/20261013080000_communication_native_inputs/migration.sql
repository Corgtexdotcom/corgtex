-- AlterTable
ALTER TABLE "CommunicationInboundEvent" ADD COLUMN     "ingressInputId" TEXT;

-- CreateTable
CREATE TABLE "CommunicationIngressInput" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalWorkspaceId" TEXT NOT NULL,
    "appId" TEXT,
    "ingressKind" TEXT NOT NULL,
    "externalEventId" TEXT,
    "requestTimestamp" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signingBindingHash" VARCHAR(64) NOT NULL,
    "installationGrantHash" VARCHAR(64) NOT NULL,
    "encryptedRawBody" TEXT NOT NULL,
    "bodyHash" VARCHAR(64) NOT NULL,
    "permissionEpochsJson" JSONB NOT NULL,
    "epochProofVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresRawAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationIngressInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationMessageNativeInput" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "communicationMessageId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalWorkspaceId" TEXT NOT NULL,
    "appId" TEXT,
    "providerPrincipalId" TEXT NOT NULL,
    "externalChannelId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "externalUserId" TEXT,
    "threadExternalId" TEXT,
    "mode" TEXT NOT NULL,
    "ingressInputId" TEXT,
    "requestJson" JSONB NOT NULL,
    "encryptedPayloadJson" TEXT NOT NULL,
    "projectedContentJson" JSONB NOT NULL,
    "projectionHash" VARCHAR(64) NOT NULL,
    "installationGrantHash" VARCHAR(64) NOT NULL,
    "channelGrantHash" VARCHAR(64) NOT NULL,
    "permissionEpochsJson" JSONB NOT NULL,
    "epochProofVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresRawAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationMessageNativeInput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunicationIngressInput_workspaceId_installationId_idx" ON "CommunicationIngressInput"("workspaceId", "installationId");

-- CreateIndex
CREATE INDEX "CommunicationMessageNativeInput_workspaceId_communicationMe_idx" ON "CommunicationMessageNativeInput"("workspaceId", "communicationMessageId");

-- CreateIndex
CREATE INDEX "CommunicationMessageNativeInput_workspaceId_installationId__idx" ON "CommunicationMessageNativeInput"("workspaceId", "installationId", "externalChannelId");

-- AddForeignKey
ALTER TABLE "CommunicationInboundEvent" ADD CONSTRAINT "CommunicationInboundEvent_ingressInputId_fkey" FOREIGN KEY ("ingressInputId") REFERENCES "CommunicationIngressInput"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationIngressInput" ADD CONSTRAINT "CommunicationIngressInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationMessageNativeInput" ADD CONSTRAINT "CommunicationMessageNativeInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TRIGGER "pun68_permission_CommunicationIngressInput" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationIngressInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationIngressInput', '["installationId","workspaceId"]');
CREATE TRIGGER "pun68_permission_CommunicationMessageNativeInput" AFTER INSERT OR DELETE OR UPDATE ON "CommunicationMessageNativeInput" FOR EACH ROW EXECUTE FUNCTION pun68_source_permission_transition('CommunicationMessageNativeInput', '["externalChannelId","installationId","workspaceId"]');
