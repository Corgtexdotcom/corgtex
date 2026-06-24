import { redirect } from "next/navigation";
import { resolveWorkspacePermalink } from "@corgtex/domain";
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
  const resolved = await resolveWorkspacePermalink(actor, { workspaceId, permalinkId });

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
