import Link from "next/link";
import { redirect } from "next/navigation";
import { AppError, getAction, getWorkspaceArchiveRecord, listHumanMembers, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { ActionEditorForm } from "@/lib/components/ActionEditorForm";
import { UnavailableItemStatus } from "@/lib/components/UnavailableItemStatus";
import { updateActionAction } from "../../../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function ActionEditPage({
  params,
}: {
  params: Promise<{ workspaceId: string; actionId: string }>;
}) {
  const { workspaceId, actionId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("actions");
  const tCommon = await getTranslations("common");
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  let action: Awaited<ReturnType<typeof getAction>>;
  try {
    action = await getAction(actor, { workspaceId, actionId, includeArchived: true });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      const archiveRecord = await getWorkspaceArchiveRecord(actor, {
        workspaceId,
        entityType: "Action",
        entityId: actionId,
        includePurged: true,
      });
      const canShowArchiveRecord = actor.kind === "agent" || membership?.role === "ADMIN";
      return (
        <UnavailableItemStatus
          workspaceId={workspaceId}
          entityType="Action"
          entityId={actionId}
          archiveRecord={canShowArchiveRecord ? archiveRecord : null}
          backHref={`/workspaces/${workspaceId}/actions`}
          backLabel={t("backToActions")}
        />
      );
    }
    throw error;
  }

  const isArchived = Boolean(action.archivedAt);
  const canManage = !isArchived && (actor.kind === "agent"
    || membership?.role === "ADMIN"
    || (actor.kind === "user" && action.authorUserId === actor.user.id));
  const canSubmittedEditorEdit = actor.kind === "user"
    && (action.authorUserId === actor.user.id || action.assigneeMemberId === membership?.id);
  const canEditContent = action.status === "DRAFT"
    ? canManage
    : !isArchived && (action.status === "OPEN" || action.status === "IN_PROGRESS") && canSubmittedEditorEdit;
  const detailHref = `/workspaces/${workspaceId}/actions/${action.id}`;
  const members = await listHumanMembers(workspaceId);
  const actionMembers = members.map((member) => ({
    id: member.id,
    label: member.user.displayName ?? member.user.email,
  }));

  async function updateActionAndReturn(formData: FormData) {
    "use server";
    await updateActionAction(formData);
    redirect(detailHref);
  }

  const labels = {
    title: t("formTitle"),
    notes: t("formNotes"),
    assignee: t("formAssignee"),
    assigneeNone: t("formAssigneeNone"),
    submit: action.status === "DRAFT" ? t("btnSaveDraft") : tCommon("save"),
    cancel: tCommon("cancel"),
    priority: {
      label: t("formPriority"),
      help: t("priorityHelp"),
      none: t("priorityNone"),
      low: t("priorityLow"),
      normal: t("priorityNormal"),
      high: t("priorityHigh"),
      urgent: t("priorityUrgent"),
      legacy: t("priorityLegacy", { priority: "{priority}" }),
    },
  };

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <Link href={detailHref} style={{ textDecoration: "none", color: "var(--muted)" }}>
            {t("backToAction")}
          </Link>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("editActionTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("editActionDescription")}</span>
        </div>
      </header>

      <section className="ws-section">
        {canEditContent ? (
          <ActionEditorForm
            action={updateActionAndReturn}
            workspaceId={workspaceId}
            actionId={action.id}
            title={action.title}
            bodyMd={action.bodyMd}
            priority={action.priority}
            assigneeMemberId={action.assigneeMemberId}
            members={actionMembers}
            labels={labels}
            cancelHref={detailHref}
          />
        ) : (
          <div className="nr-item">
            <p className="muted">{t("editUnavailable")}</p>
            <Link href={detailHref} className="secondary small">{t("backToAction")}</Link>
          </div>
        )}
      </section>
    </>
  );
}
