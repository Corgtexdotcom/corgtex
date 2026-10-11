import { getWorkspaceArchiveRecord, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { requirePageActor } from "@/lib/auth";
import { RoleDirectorySurface } from "./RoleDirectorySurface";
import { loadRoleDirectoryData } from "./role-directory";

export const dynamic = "force-dynamic";

export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const actor = await requirePageActor();
  const t = await getTranslations("roles");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  const currentUserId = actor.kind === "user" ? actor.user.id : null;
  const [currentWorkspace, directoryData] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    loadRoleDirectoryData(workspaceId),
  ]);
  const isDemo = currentWorkspace?.slug === "jnj-demo";
  const currentMemberId = membership?.id && membership.id !== "global-operator" ? membership.id : null;
  const canManageStructure = !isDemo && (membership?.role === "ADMIN" || membership?.role === "FACILITATOR");
  const archivedRoleId = typeof resolvedSearch.archivedRole === "string" ? resolvedSearch.archivedRole : null;
  const archivedRole = canManageStructure && archivedRoleId
    ? await getWorkspaceArchiveRecord(actor, { workspaceId, entityType: "Role", entityId: archivedRoleId })
    : null;

  return (
    <>
      <header className="nr-masthead nr-masthead-left">
        <h1 className="nr-masthead-title">{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      {archivedRole && (
        <div role="status" className="nr-item" style={{ marginBottom: 24 }}>
          <strong>{t("archiveSuccess")}</strong>
          {membership?.role === "ADMIN" && (
            <Link href={`/workspaces/${workspaceId}/audit?tab=archive&archiveEntityType=Role`} style={{ display: "block", marginTop: 8 }}>
              {t("viewArchivedRecords")}
            </Link>
          )}
        </div>
      )}

      <section className="ws-section">
        <RoleDirectorySurface
          workspaceId={workspaceId}
          baseHref={`/workspaces/${workspaceId}/roles`}
          searchParams={resolvedSearch}
          currentMemberId={currentMemberId}
          currentUserId={currentUserId}
          canManageStructure={canManageStructure}
          isDemo={isDemo}
          {...directoryData}
        />
      </section>
    </>
  );
}
