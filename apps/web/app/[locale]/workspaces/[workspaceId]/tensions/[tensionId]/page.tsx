import { getTension, listDeliberationEntries } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { postTensionDeliberationAction, resolveTensionDeliberationAction } from "../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function TensionDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; tensionId: string }>;
}) {
  const { workspaceId, tensionId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("tensions");
  const tension = await getTension(actor, { workspaceId, tensionId });
  const entries = await listDeliberationEntries(actor, { workspaceId, parentType: "TENSION", parentId: tensionId });
  const mappedEntries = entries.map((e: any) => ({
    ...e,
    authorName: e.author?.displayName || e.author?.email || t("authorUnknown"),
    authorInitials: (e.author?.displayName || e.author?.email || t("authorInitialsUnknown")).substring(0, 2).toUpperCase()
  }));

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      OPEN: t("statusOpen"),
      IN_PROGRESS: t("statusInProgress"),
      COMPLETED: t("statusCompleted"),
    };
    return labels[status] ?? status;
  };

  const priorityText = tension.priority > 0 ? t("priorityN", { priority: tension.priority }) : t("noPriority");

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ marginBottom: 16 }}>
          <a href={`/workspaces/${workspaceId}/tensions`} style={{ textDecoration: "none", color: "var(--muted)" }}>
            {t("backToTensions")}
          </a>
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>
          {tension.isPrivate && <span title={t("privateInboxTooltip")} style={{ marginRight: 6 }}>◆</span>}
          {tension.title}
        </h1>
        <div className="nr-masthead-meta" style={{ marginTop: 12 }}>
          <span className={`tag ${tension.status === "OPEN" ? "warning" : tension.status === "IN_PROGRESS" ? "info" : "success"}`}>
            {statusLabel(tension.status)}
          </span>
          <span>{t("detailAuthorMeta", { author: tension.author.displayName || tension.author.email || t("authorUnknown") })}</span>
          <span>{t("detailPriorityMeta", { priority: priorityText })}</span>
          <span>{t("detailCreatedMeta", { date: new Date(tension.createdAt).toLocaleDateString() })}</span>
        </div>
      </header>

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDescription")}</h2>
        <div className="nr-item">
          {tension.bodyMd ? (
            <div style={{ whiteSpace: "pre-wrap" }}>{tension.bodyMd}</div>
          ) : (
            <em className="muted">{t("noDescription")}</em>
          )}
        </div>
      </section>

      <section className="ws-section" style={{ marginBottom: 48 }}>
        <h2 className="nr-section-header">{t("sectionDiscussion")}</h2>
        <DeliberationThread entries={mappedEntries} canResolve={true} resolveAction={resolveTensionDeliberationAction} hiddenFields={{ workspaceId, parentId: tensionId }} />
        <div style={{ marginTop: 24 }}>
          <DeliberationComposer
            postAction={postTensionDeliberationAction}
            hiddenFields={{ workspaceId, parentId: tensionId }}
            entryTypes={[
              { value: "SUPPORT", label: t("entrySupport"), variant: "success" },
              { value: "QUESTION", label: t("entryQuestion"), variant: "info" },
              { value: "CONCERN", label: t("entryConcern"), variant: "warning" },
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" }
            ]}
          />
        </div>
      </section>
    </>
  );
}
