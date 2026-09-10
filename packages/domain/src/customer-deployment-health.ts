import type { CustomerDeployment, CustomerDeploymentStatus } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { invariant } from "./errors";

type DeploymentIdentity = Pick<CustomerDeployment, "id" | "url" | "customerAccountId" | "deploymentKind" | "cloudProvider">;
type LockedDeployment = DeploymentIdentity & Pick<CustomerDeployment, "deploymentStatus" | "provisioningStatus">;

export async function persistCustomerDeploymentHealth(params: {
  deployment: DeploymentIdentity;
  health: {
    lastHealthCheck: Date;
    lastHealthStatus: string;
    lastHealthError: string | null;
    lastReleaseCheck: Date | null;
  };
  lifecycle: { provisioningStatus: string; deploymentStatus?: CustomerDeploymentStatus };
}) {
  const { deployment, health, lifecycle } = params;
  if (deployment.cloudProvider !== "AZURE" || deployment.deploymentKind !== "REMOTE_MANAGED") {
    await prisma.customerDeployment.update({ where: { id: deployment.id }, data: { ...health, ...lifecycle } });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const [current] = await tx.$queryRaw<LockedDeployment[]>`
      SELECT "id", "url", "customerAccountId", "deploymentKind", "cloudProvider", "deploymentStatus", "provisioningStatus"
      FROM "CustomerDeployment" WHERE "id" = ${deployment.id} FOR UPDATE
    `;
    invariant(current && current.deploymentKind === "REMOTE_MANAGED" && current.cloudProvider === "AZURE"
      && current.customerAccountId === deployment.customerAccountId && current.url === deployment.url,
    409, "MANAGED_AZURE_TARGET_DRIFT", "Managed Azure target changed during the health probe.");
    // Both admin and control-plane probes must retain explicit lifecycle intent,
    // including a suspension or retirement committed during the network request.
    const operational = ["ACTIVE", "DEGRADED"].includes(current.deploymentStatus)
      && ["active", "degraded"].includes(current.provisioningStatus);
    await tx.customerDeployment.update({
      where: { id: deployment.id },
      data: { ...health, ...(operational ? lifecycle : {}) },
    });
  });
}
