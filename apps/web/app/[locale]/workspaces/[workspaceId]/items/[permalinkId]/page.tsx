import { notFound, redirect } from "next/navigation";
import { AppError, resolveWorkspacePermalink } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";

export const dynamic = "force-dynamic";

export default async function WorkspacePermanentItemPage({
  params,
}: {
  params: Promise<{ workspaceId: string; permalinkId: string }>;
}) {
  const { workspaceId, permalinkId } = await params;
  const actor = await requirePageActor();
  let resolved: Awaited<ReturnType<typeof resolveWorkspacePermalink>>;
  try {
    resolved = await resolveWorkspacePermalink(actor, { workspaceId, permalinkId });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  if (resolved.status === "ACTIVE" || resolved.status === "ARCHIVED") {
    redirect(resolved.canonicalPath);
  }

  return (
    <UnavailableItemStatus
      workspaceId={workspaceId}
      entityType={resolved.permalink.entityType}
      entityId={resolved.permalink.entityId}
      archiveRecord={resolved.archiveRecord}
      backHref={`/workspaces/${workspaceId}/audit?tab=archive`}
      backLabel="Back to archive"
    />
  );
}
