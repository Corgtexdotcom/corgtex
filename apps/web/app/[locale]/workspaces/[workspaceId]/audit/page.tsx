import { listAuditLogs, getModelUsageSummary, listAgentRuns, getAgentRunTrace, getStorageUsageSummary, listArchivedWorkspaceArtifacts } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import { purgeArchivedArtifactAction, restoreArchivedArtifactAction } from "./actions";

export const dynamic = "force-dynamic";


function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "N/A";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
}

function actionLabel(action: string): string {
  return action.replace(/\./g, " ").replace(/([A-Z])/g, " $1").trim();
}

function statusColor(status: string): string {
  if (status === "COMPLETED" || status === "DELIVERED") return "var(--accent)";
  if (status === "FAILED") return "#842029";
  if (status === "RUNNING" || status === "PENDING") return "var(--warning)";
  if (status === "WAITING_APPROVAL") return "#b45309";
  return "inherit";
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{
    entityType?: string;
    entityId?: string;
    agentRunId?: string;
    tab?: string;
    archiveEntityType?: string;
    archiveActor?: string;
    archiveReason?: string;
    archiveDateFrom?: string;
  }>;
}) {
  const { workspaceId } = await params;
  const search = await searchParams;
  const actor = await requirePageActor();
  const t = await getTranslations("audit");
  const tab = search.tab ?? "audit";

  const auditLogs = await listAuditLogs(actor, workspaceId, {
    take: 50,
    entityType: search.entityType,
    entityId: search.entityId,
  });

  const usageSummary = await getModelUsageSummary(actor, workspaceId, { periodDays: 30 });
  const storageSummary = await getStorageUsageSummary(actor, workspaceId);

  const agentRuns = await listAgentRuns(actor, workspaceId, { take: 10 });
  const archivedArtifacts = await listArchivedWorkspaceArtifacts(actor, {
    workspaceId,
    entityType: search.archiveEntityType,
    take: 100,
  });
  const archiveActorQuery = search.archiveActor?.trim().toLowerCase() ?? "";
  const archiveReasonQuery = search.archiveReason?.trim().toLowerCase() ?? "";
  const archiveDateFrom = search.archiveDateFrom ? new Date(search.archiveDateFrom) : null;
  const filteredArchivedArtifacts = archivedArtifacts.filter((item) => {
    if (archiveActorQuery && !(item.archivedByLabel ?? item.archivedByUserId ?? "").toLowerCase().includes(archiveActorQuery)) {
      return false;
    }
    if (archiveReasonQuery && !(item.archiveReason ?? "").toLowerCase().includes(archiveReasonQuery)) {
      return false;
    }
    if (archiveDateFrom && !Number.isNaN(archiveDateFrom.getTime()) && new Date(item.archivedAt) < archiveDateFrom) {
      return false;
    }
    return true;
  });

  // If a specific agent run is selected, get its trace
  const selectedRunTrace = search.agentRunId
    ? await getAgentRunTrace(actor, workspaceId, search.agentRunId)
    : null;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      {/* Tab navigation */}
      <div className="nr-tab-bar" style={{ marginBottom: 32 }}>
        <a
          href={`/workspaces/${workspaceId}/audit?tab=audit`}
          className={`nr-tab ${tab === "audit" ? "nr-tab-active" : ""}`}
        >
          {t("tabAudit")}
        </a>
        <a
          href={`/workspaces/${workspaceId}/audit?tab=archive`}
          className={`nr-tab ${tab === "archive" ? "nr-tab-active" : ""}`}
        >
          {t("tabArchive")}
        </a>
      </div>

      {/* Audit Trail Tab */}
      {tab === "audit" && (
        <section>
          <h2 className="nr-section-header">{t("sectionDecisionTrail")}</h2>
          <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
            {t("decisionTrailDesc")}
            {search.entityType && search.entityId && (
              <span>
                {" "}{t("filteredTo", { type: search.entityType, id: search.entityId })}{" "}
                <a href={`/workspaces/${workspaceId}/audit?tab=audit`}>{t("clearFilter")}</a>
              </span>
            )}
          </p>
          <div>
            {auditLogs.length === 0 && <p className="nr-item-meta">{t("noAuditEntries")}</p>}
            {auditLogs.map((log) => (
              <div className="nr-item" key={log.id} style={{ padding: "12px 0" }}>
                <div className="row">
                  <strong className="nr-item-title" style={{ textTransform: "capitalize" }}>{actionLabel(log.action)}</strong>
                  <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                    {formatDateTime(log.createdAt)}
                  </span>
                </div>
                <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                  {log.entityType} &middot; {log.entityId.slice(0, 12)}...
                  {log.actorUserId && (
                    <span> &middot; {t("actor", { id: `${log.actorUserId.slice(0, 8)}...` })}</span>
                  )}
                </div>
                {log.meta && typeof log.meta === "object" && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.78rem" }}>
                      {t("metadata")}
                    </summary>
                    <pre style={{
                      fontSize: "0.75rem",
                      background: "transparent",
                      border: "1px dashed var(--line)",
                      padding: 12,
                      borderRadius: 8,
                      overflow: "auto",
                      maxHeight: 200,
                      marginTop: 8,
                    }}>
                      {JSON.stringify(log.meta, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "archive" && (
        <section>
          <h2 className="nr-section-header">{t("sectionArchivedRecords")}</h2>
          <form className="nr-filter-bar" action={`/workspaces/${workspaceId}/audit`} style={{ alignItems: "flex-end" }}>
            <input type="hidden" name="tab" value="archive" />
            <label style={{ display: "grid", gap: 4 }}>
              <span className="nr-item-meta">{t("archiveFilterEntity")}</span>
              <input name="archiveEntityType" defaultValue={search.archiveEntityType ?? ""} placeholder={t("archiveFilterEntityPlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="nr-item-meta">{t("archiveFilterActor")}</span>
              <input name="archiveActor" defaultValue={search.archiveActor ?? ""} placeholder={t("archiveFilterActorPlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="nr-item-meta">{t("archiveFilterReason")}</span>
              <input name="archiveReason" defaultValue={search.archiveReason ?? ""} placeholder={t("archiveFilterReasonPlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="nr-item-meta">{t("archiveFilterArchivedAfter")}</span>
              <input name="archiveDateFrom" type="date" defaultValue={search.archiveDateFrom ?? ""} />
            </label>
            <button type="submit" className="button secondary">{t("btnFilter")}</button>
            <a className="button secondary" href={`/workspaces/${workspaceId}/audit?tab=archive`}>{t("btnClear")}</a>
          </form>

          {filteredArchivedArtifacts.length === 0 && (
            <p className="nr-item-meta" style={{ marginTop: 16 }}>{t("noArchivedRecords")}</p>
          )}

          {filteredArchivedArtifacts.map((item) => (
            <div className="nr-item" key={item.id} style={{ padding: "16px 0" }}>
              <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <strong className="nr-item-title">{item.entityLabel ?? item.entityId}</strong>
                  <div className="nr-item-meta" style={{ marginTop: 4 }}>
                    {item.entityType} &middot; {item.entityId.slice(0, 12)}... &middot; {t("archivedAt", { date: formatDateTime(item.archivedAt) })}
                  </div>
                  <div className="nr-item-meta" style={{ marginTop: 4 }}>
                    {t("archivedBy", { actor: item.archivedByLabel ?? item.archivedByUserId ?? t("unknownActor") })}
                    {item.archiveReason ? ` · ${t("archiveReason", { reason: item.archiveReason })}` : ""}
                  </div>
                </div>
                <div className="actions-inline" style={{ alignItems: "flex-start" }}>
                  <form action={restoreArchivedArtifactAction}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="entityType" value={item.entityType} />
                    <input type="hidden" name="entityId" value={item.entityId} />
                    <button type="submit" className="button secondary">{t("btnRestore")}</button>
                  </form>
                  <details style={{ position: "relative" }}>
                    <summary className="button danger" style={{ cursor: "pointer", listStyle: "none" }}>{t("btnPurge")}</summary>
                    <div className="fin-dropdown" style={{ right: 0, width: 320, padding: 16 }}>
                      <form action={purgeArchivedArtifactAction} className="stack">
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="entityType" value={item.entityType} />
                        <input type="hidden" name="entityId" value={item.entityId} />
                        <label>
                          {t("labelRequiredReason")}
                          <textarea name="reason" required placeholder={t("placeholderPurgeReason")} />
                        </label>
                        <button type="submit" className="danger">{t("btnPermanentlyPurge")}</button>
                      </form>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Agent Traces Tab Removed */}
      {(tab === "agents" || tab === "costs") && (
        <section>
          <div className="nr-item" style={{ padding: "40px", textAlign: "center", background: "var(--accent-soft)" }}>
            <h2 style={{ marginBottom: 16 }}>{t("movedTitle")}</h2>
            <p className="nr-item-meta" style={{ marginBottom: 24 }}>
              {t("movedDesc")}
            </p>
            <a href={`/workspaces/${workspaceId}/agents?tab=observability`} className="button secondary">
              {t("btnGoToAgents")}
            </a>
          </div>
        </section>
      )}
    </>
  );
}
