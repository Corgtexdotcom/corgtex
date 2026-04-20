CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

CREATE TABLE "WebhookEndpoint" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "label" TEXT,
  "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "endpointId" TEXT NOT NULL,
  "eventId" TEXT,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "httpStatus" INTEGER,
  "responseBody" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptedAt" TIMESTAMP(3),
  "nextRetryAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboundWebhook" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "externalId" TEXT,
  "payload" JSONB NOT NULL,
  "processedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InboundWebhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookEndpoint_workspaceId_status_idx"
ON "WebhookEndpoint"("workspaceId", "status");

CREATE INDEX "WebhookDelivery_endpointId_status_idx"
ON "WebhookDelivery"("endpointId", "status");

CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx"
ON "WebhookDelivery"("status", "nextRetryAt");

CREATE INDEX "InboundWebhook_workspaceId_source_idx"
ON "InboundWebhook"("workspaceId", "source");

CREATE INDEX "InboundWebhook_source_externalId_idx"
ON "InboundWebhook"("source", "externalId");

ALTER TABLE "WebhookEndpoint"
ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery"
ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InboundWebhook"
ADD CONSTRAINT "InboundWebhook_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
