import { prisma } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";

/**
 * Throws a friendly UI Error if the target workspace is the read-only demo workspace.
 * Used to protect Server Actions from mutating the demo data.
 */
export async function enforceDemoGuard(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true }
  });

  if (workspace?.slug === "jnj-demo") {
    throw new Error("This is a read-only demo environment. Modifications are disabled.");
  }
}

/**
 * Similar to enforceDemoGuard but for API routes returning AppError
 */
export async function checkApiDemoGuard(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true }
  });

  if (workspace?.slug === "jnj-demo") {
    throw new AppError(403, "DEMO_MODE", "This is a read-only demo environment. Modifications are disabled.");
  }
}
