import { listAuditLogs, getModelUsageSummary, listAgentRuns, getAgentRunTrace, getStorageUsageSummary } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { getTranslations } from "next-intl/server";

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
  searchParams: Promise<{ entityType?: string; entityId?: string; agentRunId?: string; tab?: string }>;
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
          Audit Trail
        </a>
        <a
          href={`/workspaces/${workspaceId}/audit?tab=audit`}
          className={`nr-tab ${tab === "audit" ? "nr-tab-active" : ""}`}
        >
          Audit Trail
        </a>
      </div>

      {/* Audit Trail Tab */}
      {tab === "audit" && (
        <section>
          <h2 className="nr-section-header">Decision Trail</h2>
          <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
            Every action taken in this workspace, by humans and agents.
            {search.entityType && search.entityId && (
              <span>
                {" "}Filtered to <strong>{search.entityType}</strong>: {search.entityId}.{" "}
                <a href={`/workspaces/${workspaceId}/audit?tab=audit`}>{t("clearFilter")}</a>
              </span>
            )}
          </p>
          <div>
            {auditLogs.length === 0 && <p className="nr-item-meta">No audit entries found.</p>}
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
                    <span> &middot; Actor: {log.actorUserId.slice(0, 8)}...</span>
                  )}
                </div>
                {log.meta && typeof log.meta === "object" && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.78rem" }}>
                      Metadata
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

      {/* Agent Traces Tab Removed */}
      {(tab === "agents" || tab === "costs") && (
        <section>
          <div className="nr-item" style={{ padding: "40px", textAlign: "center", background: "var(--accent-soft)" }}>
            <h2 style={{ marginBottom: 16 }}>Moved to Agent Governance</h2>
            <p className="nr-item-meta" style={{ marginBottom: 24 }}>
              Agent traces and cost analytics have moved to the dedicated Agent Governance center.
            </p>
            <a href={`/workspaces/${workspaceId}/agents?tab=observability`} className="button secondary">
              Go to Agent Governance
            </a>
          </div>
        </section>
      )}
    </>
  );
}
