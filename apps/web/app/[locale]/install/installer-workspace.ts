import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
import { notFound } from "next/navigation";
import { requirePageActor } from "@/lib/auth";

export async function requireInstallerWorkspace(workspaceId: string) {
  const actor = await requirePageActor();
  try {
    await requireWorkspaceMembership({ actor, workspaceId });
  } catch (error) {
    if (error instanceof AppError && (error.status === 403 || error.status === 404)) notFound();
    throw error;
  }
}
