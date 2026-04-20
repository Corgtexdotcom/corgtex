-- CreateTable
CREATE TABLE "DemoLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'demo_gate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visitCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DemoLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoLead_workspaceId_createdAt_idx" ON "DemoLead"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DemoLead_workspaceId_email_key" ON "DemoLead"("workspaceId", "email");

-- AddForeignKey
ALTER TABLE "DemoLead" ADD CONSTRAINT "DemoLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
