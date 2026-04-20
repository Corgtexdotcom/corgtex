import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";

/**
 * Provides current storage utilization and estimated monthly cost for a workspace's blob storage.
 * Calculations align with Cloudflare R2 default pricing:
 * 10 GB free per month, $0.015 per GB thereafter.
 */
export async function getStorageUsageSummary(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  // Count blob-backed document uploads, including files that could not be parsed into Brain sources.
  const uploads = await prisma.document.findMany({
    where: {
      workspaceId,
      storageKey: {
        startsWith: `workspaces/${workspaceId}/uploads/`,
      },
    },
    select: {
      metadata: true,
    },
  });

  const totalBytes = uploads.reduce((sum, upload) => {
    const metadata = upload.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return sum;
    }

    const size = (metadata as Record<string, unknown>).size;
    return typeof size === "number" && Number.isFinite(size) ? sum + size : sum;
  }, 0);

  // Convert to GB (binary gigabytes - GiB)
  const totalGb = totalBytes / (1024 * 1024 * 1024);

  // R2 Pricing: 10GB free, $0.015 per subsequent GB
  const FREE_TIER_GB = 10;
  const PRICE_PER_GB = 0.015;

  const billableGb = Math.max(0, totalGb - FREE_TIER_GB);
  const estimatedOverageUsd = billableGb * PRICE_PER_GB;

  return {
    totalBytes,
    totalGb,
    billableGb,
    estimatedOverageUsd,
    limitGb: FREE_TIER_GB, // Denoting our hard ceiling and free limit
    isOverLimit: totalGb >= FREE_TIER_GB,
  };
}
