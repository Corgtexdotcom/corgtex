-- Link hosted customer records to an in-deployment managed workspace when available.
-- The link lets Control Plane use local workspace data for same-deployment customers
-- while preserving support-connector access for remote hosted instances.

ALTER TABLE "InstanceRegistry"
ADD COLUMN "managedWorkspaceId" TEXT;

UPDATE "InstanceRegistry"
SET "managedWorkspaceId" = "Workspace"."id"
FROM "Workspace"
WHERE "InstanceRegistry"."managedWorkspaceId" IS NULL
  AND "InstanceRegistry"."customerSlug" = "Workspace"."slug";

CREATE UNIQUE INDEX "InstanceRegistry_managedWorkspaceId_key"
ON "InstanceRegistry"("managedWorkspaceId");

ALTER TABLE "InstanceRegistry"
ADD CONSTRAINT "InstanceRegistry_managedWorkspaceId_fkey"
FOREIGN KEY ("managedWorkspaceId") REFERENCES "Workspace"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
