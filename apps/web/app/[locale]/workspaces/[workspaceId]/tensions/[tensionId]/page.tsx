import { getTension, listDeliberationEntries } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { DeliberationThread } from "@/lib/components/DeliberationThread";
import { DeliberationComposer } from "@/lib/components/DeliberationComposer";
import { getDeliberationTargets } from "@/lib/deliberation-targets";
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
  const deliberationTargets = await getDeliberationTargets({ actor, workspaceId, parentCircleId: tension.circleId });
  const targetOptions = deliberationTargets.options.map((option) => ({
    ...option,
    label: option.value.startsWith("circle:")
      ? t("targetCircle", { name: option.label.replace(/^Circle: /, "") })
      : option.value.startsWith("member:")
        ? t("targetPerson", { name: option.label.replace(/^Person: /, "") })
        : option.label,
  }));
  const mappedEntries = entries.map((e: any) => ({
    ...e,
    authorName: e.author?.displayName || e.author?.email || t("authorUnknown"),
    authorInitials: (e.author?.displayName || e.author?.email || t("authorInitialsUnknown")).substring(0, 2).toUpperCase(),
    targetLabel: e.targetCircle
      ? t("targetCircle", { name: e.targetCircle.name })
      : e.targetMember
        ? t("targetPerson", { name: e.targetMember.user.displayName || e.targetMember.user.email })
        : null,
  }));

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      DRAFT: t("statusDraft"),
      OPEN: t("statusOpen"),
      RESOLVED: t("statusResolved"),
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
          <span className={`tag ${tension.status === "DRAFT" ? "info" : tension.status === "OPEN" ? "warning" : "success"}`}>
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
        {tension.status === "OPEN" && (
        <div style={{ marginTop: 24 }}>
          <DeliberationComposer
            postAction={postTensionDeliberationAction}
            hiddenFields={{ workspaceId, parentId: tensionId }}
            targetOptions={targetOptions}
            defaultTargetValue={deliberationTargets.defaultValue}
            entryTypes={[
              { value: "REACTION", label: t("entryReaction"), variant: "secondary" },
              { value: "OBJECTION", label: t("entryObjection"), variant: "danger" },
            ]}
          />
        </div>
        )}
      </section>
    </>
  );
}
