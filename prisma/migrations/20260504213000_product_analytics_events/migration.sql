-- CreateTable
CREATE TABLE "ProductAnalyticsEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "eventName" VARCHAR(64) NOT NULL,
    "surface" VARCHAR(64) NOT NULL,
    "mode" VARCHAR(24),
    "previousMode" VARCHAR(24),
    "source" VARCHAR(64),
    "route" TEXT,
    "viewportWidth" INTEGER,
    "coarsePointer" BOOLEAN,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_workspaceId_eventName_createdAt_idx" ON "ProductAnalyticsEvent"("workspaceId", "eventName", "createdAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_workspaceId_mode_createdAt_idx" ON "ProductAnalyticsEvent"("workspaceId", "mode", "createdAt");

-- CreateIndex
CREATE INDEX "ProductAnalyticsEvent_actorUserId_createdAt_idx" ON "ProductAnalyticsEvent"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductAnalyticsEvent" ADD CONSTRAINT "ProductAnalyticsEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAnalyticsEvent" ADD CONSTRAINT "ProductAnalyticsEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
