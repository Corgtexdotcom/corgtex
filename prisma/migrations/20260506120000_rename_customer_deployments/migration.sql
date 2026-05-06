-- Rename the physical customer deployment tables in place.
-- This migration intentionally preserves all rows, IDs, foreign keys, and payload data.

ALTER TYPE "ControlPlaneInstanceRole" RENAME TO "CustomerDeploymentAccessRole";

ALTER TABLE "InstanceRegistry" RENAME TO "CustomerDeployment";
ALTER TABLE "HostedInstanceEvent" RENAME TO "CustomerDeploymentEvent";
ALTER TABLE "ControlPlaneInstanceAccess" RENAME TO "CustomerDeploymentAccess";
ALTER TABLE "InstanceBootstrapRun" RENAME TO "CustomerDeploymentBootstrapRun";

ALTER TABLE "CustomerDeploymentEvent" RENAME COLUMN "instanceId" TO "deploymentId";
ALTER TABLE "CustomerDeploymentAccess" RENAME COLUMN "instanceId" TO "deploymentId";
ALTER TABLE "SupportOperation" RENAME COLUMN "instanceId" TO "deploymentId";

ALTER INDEX "InstanceRegistry_url_key" RENAME TO "CustomerDeployment_url_key";
ALTER INDEX "InstanceRegistry_customerSlug_key" RENAME TO "CustomerDeployment_customerSlug_key";
ALTER INDEX "InstanceRegistry_customerAccountId_idx" RENAME TO "CustomerDeployment_customerAccountId_idx";
ALTER INDEX "InstanceRegistry_deploymentKind_idx" RENAME TO "CustomerDeployment_deploymentKind_idx";
ALTER INDEX "InstanceRegistry_deploymentStatus_idx" RENAME TO "CustomerDeployment_deploymentStatus_idx";
ALTER INDEX "InstanceRegistry_provisioningStatus_idx" RENAME TO "CustomerDeployment_provisioningStatus_idx";
ALTER INDEX "InstanceRegistry_bootstrapStatus_idx" RENAME TO "CustomerDeployment_bootstrapStatus_idx";
ALTER INDEX "InstanceRegistry_region_idx" RENAME TO "CustomerDeployment_region_idx";
ALTER INDEX "InstanceRegistry_lastHealthStatus_idx" RENAME TO "CustomerDeployment_lastHealthStatus_idx";
ALTER INDEX "InstanceRegistry_supportConnectorStatus_idx" RENAME TO "CustomerDeployment_supportConnectorStatus_idx";
ALTER INDEX "InstanceRegistry_managedWorkspaceId_key" RENAME TO "CustomerDeployment_managedWorkspaceId_key";

ALTER INDEX "HostedInstanceEvent_instanceId_createdAt_idx" RENAME TO "CustomerDeploymentEvent_deploymentId_createdAt_idx";
ALTER INDEX "HostedInstanceEvent_action_createdAt_idx" RENAME TO "CustomerDeploymentEvent_action_createdAt_idx";

ALTER INDEX "ControlPlaneInstanceAccess_instanceId_userId_key" RENAME TO "CustomerDeploymentAccess_deploymentId_userId_key";
ALTER INDEX "ControlPlaneInstanceAccess_userId_isActive_idx" RENAME TO "CustomerDeploymentAccess_userId_isActive_idx";
ALTER INDEX "ControlPlaneInstanceAccess_instanceId_isActive_idx" RENAME TO "CustomerDeploymentAccess_deploymentId_isActive_idx";

ALTER INDEX "SupportOperation_instanceId_createdAt_idx" RENAME TO "SupportOperation_deploymentId_createdAt_idx";

ALTER INDEX "InstanceBootstrapRun_bootstrapTokenHash_key" RENAME TO "CustomerDeploymentBootstrapRun_bootstrapTokenHash_key";
ALTER INDEX "InstanceBootstrapRun_customerSlug_bundleChecksum_key" RENAME TO "CustomerDeploymentBootstrapRun_customerSlug_bundleChecksum_key";
ALTER INDEX "InstanceBootstrapRun_customerSlug_status_idx" RENAME TO "CustomerDeploymentBootstrapRun_customerSlug_status_idx";

ALTER TABLE "CustomerDeployment" RENAME CONSTRAINT "InstanceRegistry_pkey" TO "CustomerDeployment_pkey";
ALTER TABLE "CustomerDeployment" RENAME CONSTRAINT "InstanceRegistry_customerAccountId_fkey" TO "CustomerDeployment_customerAccountId_fkey";
ALTER TABLE "CustomerDeployment" RENAME CONSTRAINT "InstanceRegistry_managedWorkspaceId_fkey" TO "CustomerDeployment_managedWorkspaceId_fkey";

ALTER TABLE "CustomerDeploymentEvent" RENAME CONSTRAINT "HostedInstanceEvent_pkey" TO "CustomerDeploymentEvent_pkey";
ALTER TABLE "CustomerDeploymentEvent" RENAME CONSTRAINT "HostedInstanceEvent_instanceId_fkey" TO "CustomerDeploymentEvent_deploymentId_fkey";

ALTER TABLE "CustomerDeploymentAccess" RENAME CONSTRAINT "ControlPlaneInstanceAccess_pkey" TO "CustomerDeploymentAccess_pkey";
ALTER TABLE "CustomerDeploymentAccess" RENAME CONSTRAINT "ControlPlaneInstanceAccess_instanceId_fkey" TO "CustomerDeploymentAccess_deploymentId_fkey";
ALTER TABLE "CustomerDeploymentAccess" RENAME CONSTRAINT "ControlPlaneInstanceAccess_userId_fkey" TO "CustomerDeploymentAccess_userId_fkey";

ALTER TABLE "SupportOperation" RENAME CONSTRAINT "SupportOperation_instanceId_fkey" TO "SupportOperation_deploymentId_fkey";

ALTER TABLE "CustomerDeploymentBootstrapRun" RENAME CONSTRAINT "InstanceBootstrapRun_pkey" TO "CustomerDeploymentBootstrapRun_pkey";

UPDATE "CustomerDeploymentEvent"
SET "action" = REPLACE("action", 'hosted_instance.', 'customer_deployment.')
WHERE "action" LIKE 'hosted_instance.%';

UPDATE "WorkflowJob"
SET "payload" = ("payload" - 'instanceId') || jsonb_build_object('deploymentId', "payload"->'instanceId')
WHERE "type" = 'control-plane.fleet-snapshot'
  AND "payload" ? 'instanceId'
  AND NOT ("payload" ? 'deploymentId');
