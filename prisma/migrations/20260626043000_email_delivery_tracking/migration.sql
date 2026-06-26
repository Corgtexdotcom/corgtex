-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "providerMessageId" TEXT NOT NULL,
    "emailType" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toDomain" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "lastEventType" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "complainedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT,
    "metadata" JSONB,
    "rawLastEvent" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDeliveryEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "providerMessageId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_providerMessageId_key" ON "EmailDelivery"("providerMessageId");

-- CreateIndex
CREATE INDEX "EmailDelivery_toEmail_createdAt_idx" ON "EmailDelivery"("toEmail", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_toDomain_createdAt_idx" ON "EmailDelivery"("toDomain", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_emailType_createdAt_idx" ON "EmailDelivery"("emailType", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_createdAt_idx" ON "EmailDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_workspaceId_createdAt_idx" ON "EmailDelivery"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_userId_createdAt_idx" ON "EmailDelivery"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryEvent_dedupeKey_key" ON "EmailDeliveryEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_providerMessageId_occurredAt_idx" ON "EmailDeliveryEvent"("providerMessageId", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_eventType_receivedAt_idx" ON "EmailDeliveryEvent"("eventType", "receivedAt");
