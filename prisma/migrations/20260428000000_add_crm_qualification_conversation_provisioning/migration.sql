-- AlterTable: DemoLead - add Phase 1 tracking fields
ALTER TABLE "DemoLead" ADD COLUMN "qualifyToken" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "companyHint" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "ipCountry" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "referrerUrl" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "utmSource" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "utmCampaign" TEXT;
ALTER TABLE "DemoLead" ADD COLUMN "welcomeEmailSentAt" TIMESTAMP(3);
ALTER TABLE "DemoLead" ADD COLUMN "convertedAt" TIMESTAMP(3);
ALTER TABLE "DemoLead" ADD COLUMN "convertedContactId" TEXT;

-- CreateIndex: DemoLead.qualifyToken unique
CREATE UNIQUE INDEX "DemoLead_qualifyToken_key" ON "DemoLead"("qualifyToken");

-- CreateTable: CrmQualification
CREATE TABLE "CrmQualification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "demoLeadId" TEXT NOT NULL,
    "responseChannel" TEXT NOT NULL,
    "companyName" TEXT,
    "website" TEXT,
    "roleTitle" TEXT,
    "aiExperience" TEXT,
    "helpNeeded" TEXT,
    "rawEmailReply" TEXT,
    "rawEmailSubject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewNote" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "schedulingEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmQualification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmQualification_workspaceId_status_idx" ON "CrmQualification"("workspaceId", "status");
CREATE INDEX "CrmQualification_demoLeadId_idx" ON "CrmQualification"("demoLeadId");

-- AddForeignKey: CrmQualification
ALTER TABLE "CrmQualification" ADD CONSTRAINT "CrmQualification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmQualification" ADD CONSTRAINT "CrmQualification_demoLeadId_fkey" FOREIGN KEY ("demoLeadId") REFERENCES "DemoLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmQualification" ADD CONSTRAINT "CrmQualification_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: CrmConversation
CREATE TABLE "CrmConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "demoLeadId" TEXT,
    "contactId" TEXT,
    "dealId" TEXT,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmConversation_workspaceId_status_idx" ON "CrmConversation"("workspaceId", "status");
CREATE INDEX "CrmConversation_demoLeadId_idx" ON "CrmConversation"("demoLeadId");
CREATE INDEX "CrmConversation_contactId_idx" ON "CrmConversation"("contactId");

-- AddForeignKey: CrmConversation
ALTER TABLE "CrmConversation" ADD CONSTRAINT "CrmConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmConversation" ADD CONSTRAINT "CrmConversation_demoLeadId_fkey" FOREIGN KEY ("demoLeadId") REFERENCES "DemoLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CrmConversation" ADD CONSTRAINT "CrmConversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CrmConversation" ADD CONSTRAINT "CrmConversation_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: CrmConversationMessage
CREATE TABLE "CrmConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderUserId" TEXT,
    "senderEmail" TEXT,
    "bodyMd" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmConversationMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmConversationMessage_conversationId_createdAt_idx" ON "CrmConversationMessage"("conversationId", "createdAt");

-- AddForeignKey: CrmConversationMessage
ALTER TABLE "CrmConversationMessage" ADD CONSTRAINT "CrmConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CrmConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmConversationMessage" ADD CONSTRAINT "CrmConversationMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: CrmProspectWorkspace
CREATE TABLE "CrmProspectWorkspace" (
    "id" TEXT NOT NULL,
    "crmWorkspaceId" TEXT NOT NULL,
    "demoLeadId" TEXT NOT NULL,
    "targetWorkspaceId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
    "provisionedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmProspectWorkspace_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmProspectWorkspace_crmWorkspaceId_status_idx" ON "CrmProspectWorkspace"("crmWorkspaceId", "status");
CREATE INDEX "CrmProspectWorkspace_demoLeadId_idx" ON "CrmProspectWorkspace"("demoLeadId");
CREATE INDEX "CrmProspectWorkspace_targetWorkspaceId_idx" ON "CrmProspectWorkspace"("targetWorkspaceId");

-- AddForeignKey: CrmProspectWorkspace
ALTER TABLE "CrmProspectWorkspace" ADD CONSTRAINT "CrmProspectWorkspace_crmWorkspaceId_fkey" FOREIGN KEY ("crmWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProspectWorkspace" ADD CONSTRAINT "CrmProspectWorkspace_targetWorkspaceId_fkey" FOREIGN KEY ("targetWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmProspectWorkspace" ADD CONSTRAINT "CrmProspectWorkspace_demoLeadId_fkey" FOREIGN KEY ("demoLeadId") REFERENCES "DemoLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
