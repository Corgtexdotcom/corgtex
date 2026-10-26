CREATE TABLE "CrmQualificationFormInput" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "demoLeadId" TEXT NOT NULL,
  "qualificationId" TEXT NOT NULL, "companyName" TEXT NOT NULL, "website" TEXT NOT NULL,
  "roleTitle" TEXT, "aiExperience" TEXT NOT NULL, "helpNeeded" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmQualificationFormInput_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CrmQualificationFormInput_workspaceId_qualificationId_key" ON "CrmQualificationFormInput"("workspaceId", "qualificationId");
CREATE INDEX "CrmQualificationFormInput_workspaceId_demoLeadId_idx" ON "CrmQualificationFormInput"("workspaceId", "demoLeadId");
ALTER TABLE "CrmQualificationFormInput" ADD CONSTRAINT "CrmQualificationFormInput_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
