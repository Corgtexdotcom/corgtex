-- CreateEnum
CREATE TYPE "CommunicationProvider" AS ENUM ('SLACK', 'TEAMS', 'GOOGLE_CHAT');

-- CreateEnum
CREATE TYPE "CommunicationInstallationStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "CommunicationEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommunicationChannelKind" AS ENUM ('PUBLIC', 'PRIVATE', 'DIRECT', 'GROUP', 'UNKNOWN');

-- CreateTable
CREATE TABLE "CommunicationInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "externalWorkspaceId" TEXT NOT NULL,
    "externalOrgId" TEXT,
    "externalTeamName" TEXT,
    "appId" TEXT,
    "botUserId" TEXT,
    "botTokenEnc" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "optionalScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB,
    "status" "CommunicationInstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "installedByUserId" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationExternalUser" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "userId" TEXT,
    "memberId" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "rawProfile" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationExternalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationChannel" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "externalChannelId" TEXT NOT NULL,
    "name" TEXT,
    "kind" "CommunicationChannelKind" NOT NULL DEFAULT 'UNKNOWN',
    "isIngestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationMessage" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "externalChannelId" TEXT NOT NULL,
    "externalUserId" TEXT,
    "threadExternalId" TEXT,
    "text" TEXT,
    "textRedactedAt" TIMESTAMP(3),
    "messageTs" TIMESTAMP(3),
    "permalink" TEXT,
    "raw" JSONB,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresRawAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationInboundEvent" (
    "id" TEXT NOT NULL,
    "installationId" TEXT,
    "workspaceId" TEXT,
    "provider" "CommunicationProvider" NOT NULL,
    "externalEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommunicationEventStatus" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationEntityLink" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "CommunicationProvider" NOT NULL,
    "messageId" TEXT,
    "externalUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationEntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationInstallation_provider_externalWorkspaceId_key" ON "CommunicationInstallation"("provider", "externalWorkspaceId");

-- CreateIndex
CREATE INDEX "CommunicationInstallation_workspaceId_provider_status_idx" ON "CommunicationInstallation"("workspaceId", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationExternalUser_installationId_externalUserId_key" ON "CommunicationExternalUser"("installationId", "externalUserId");

-- CreateIndex
CREATE INDEX "CommunicationExternalUser_workspaceId_provider_idx" ON "CommunicationExternalUser"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "CommunicationExternalUser_workspaceId_userId_idx" ON "CommunicationExternalUser"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationChannel_installationId_externalChannelId_key" ON "CommunicationChannel"("installationId", "externalChannelId");

-- CreateIndex
CREATE INDEX "CommunicationChannel_workspaceId_provider_isIngestEnabled_idx" ON "CommunicationChannel"("workspaceId", "provider", "isIngestEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationMessage_installation_channel_message_key" ON "CommunicationMessage"("installationId", "externalChannelId", "externalMessageId");

-- CreateIndex
CREATE INDEX "CommunicationMessage_workspaceId_provider_receivedAt_idx" ON "CommunicationMessage"("workspaceId", "provider", "receivedAt");

-- CreateIndex
CREATE INDEX "CommunicationMessage_workspaceId_expiresRawAt_idx" ON "CommunicationMessage"("workspaceId", "expiresRawAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationInboundEvent_dedupeKey_key" ON "CommunicationInboundEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "CommunicationInboundEvent_workspaceId_provider_status_idx" ON "CommunicationInboundEvent"("workspaceId", "provider", "status");

-- CreateIndex
CREATE INDEX "CommunicationInboundEvent_provider_externalEventId_idx" ON "CommunicationInboundEvent"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "CommunicationEntityLink_workspaceId_entityType_entityId_idx" ON "CommunicationEntityLink"("workspaceId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "CommunicationEntityLink_installationId_action_idx" ON "CommunicationEntityLink"("installationId", "action");

-- AddForeignKey
ALTER TABLE "CommunicationInstallation" ADD CONSTRAINT "CommunicationInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationExternalUser" ADD CONSTRAINT "CommunicationExternalUser_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationExternalUser" ADD CONSTRAINT "CommunicationExternalUser_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationChannel" ADD CONSTRAINT "CommunicationChannel_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationChannel" ADD CONSTRAINT "CommunicationChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationMessage" ADD CONSTRAINT "CommunicationMessage_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationMessage" ADD CONSTRAINT "CommunicationMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationInboundEvent" ADD CONSTRAINT "CommunicationInboundEvent_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationInboundEvent" ADD CONSTRAINT "CommunicationInboundEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationEntityLink" ADD CONSTRAINT "CommunicationEntityLink_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommunicationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationEntityLink" ADD CONSTRAINT "CommunicationEntityLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationEntityLink" ADD CONSTRAINT "CommunicationEntityLink_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "CommunicationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
