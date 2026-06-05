import Link from "next/link";
import { getCatalogItem, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

function formatCents(cents: number | null) {
  if (cents == null) return "No cap";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
}

function personName(person: { displayName: string | null; email: string } | null) {
  return person?.displayName ?? person?.email ?? "Workspace";
}

function displayEnum(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Not set";
}

function capabilityKeys(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => {
        const record = entry && typeof entry === "object" && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : null;
        return typeof record?.key === "string" ? record.key : null;
      }).filter((key): key is string => Boolean(key))
    : [];
}

export default async function CatalogItemPage({
  params,
}: {
  params: Promise<{ workspaceId: string; catalogItemId: string }>;
}) {
  const { workspaceId, catalogItemId } = await params;
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  await requireWorkspaceFeature(workspaceId, "TOOL_LINKS");
  const detail = await getCatalogItem(actor, { workspaceId, catalogItemId });
  const { item, usage, requests } = detail;

  return (
    <section className="ws-section stack" style={{ gap: 28 }}>
      <div>
        <Link className="link-button secondary small" href={`/workspaces/${workspaceId}/tools`}>
          Back to Tools
        </Link>
      </div>

      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 0 }}>
        <div className="actions-inline" style={{ gap: 6, marginBottom: 10 }}>
          <span className="tag">{item.type.replace("_", " ")}</span>
          <span className="tag info">{item.accessMode.replace("_", " ")}</span>
          <span className="tag">{item.status.replace("_", " ")}</span>
          {item.type === "APP" && <span className="tag info">{displayEnum(item.installationStatus)}</span>}
          {item.isFavorite && <span className="tag success">Favorite</span>}
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{item.title}</h1>
        <div className="nr-masthead-meta">
          <span>{item.outcome ?? "Shared workspace capability."}</span>
        </div>
      </header>

      <div className="ws-stat-row">
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{formatCents(item.monthlyBudgetCents)}</strong>
          <span>Monthly budget</span>
        </div>
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{item.dailyCallLimit ?? "No cap"}</strong>
          <span>Daily calls</span>
        </div>
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{usage.activeCredentialCount}</strong>
          <span>Active API keys</span>
        </div>
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{formatUsd(usage.totalCostUsd)}</strong>
          <span>30-day AI spend</span>
        </div>
        {item.type === "APP" && (
          <div className="ws-stat-card">
            <strong style={{ color: "var(--text)" }}>{displayEnum(item.integrationDepth)}</strong>
            <span>Integration depth</span>
          </div>
        )}
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
        gap: 24,
      }}>
        <section className="stack" style={{ gap: 18 }}>
          {item.descriptionMd && (
            <div className="nr-item" style={{ padding: 18 }}>
              <h2 className="nr-section-header" style={{ marginTop: 0 }}>What it does</h2>
              <MarkdownRenderer markdown={item.descriptionMd} />
            </div>
          )}
          {item.accessNotesMd && (
            <div className="nr-item" style={{ padding: 18 }}>
              <h2 className="nr-section-header" style={{ marginTop: 0 }}>Access notes</h2>
              <MarkdownRenderer markdown={item.accessNotesMd} />
            </div>
          )}
          {item.url && (
            <div className="actions-inline">
              <a className="link-button small" href={item.url} target={item.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer">
                Open
              </a>
            </div>
          )}
          {item.type === "APP" && (
            <div className="nr-item" style={{ padding: 18 }}>
              <h2 className="nr-section-header" style={{ marginTop: 0 }}>Agent routing</h2>
              <p className="nr-item-meta" style={{ marginTop: 0 }}>
                Corgtex MCP tells agents this app is available and what it handles. Structured app writes should go to the app MCP/runtime, not through Corgtex as a generic proxy.
              </p>
              {item.appMcpUrl ? (
                <p className="nr-item-meta">App MCP: <a href={item.appMcpUrl} target="_blank" rel="noreferrer">{item.appMcpUrl}</a></p>
              ) : (
                <p className="nr-item-meta">No app MCP URL is configured yet.</p>
              )}
              {capabilityKeys(item.capabilitiesJson).length > 0 && (
                <div className="actions-inline" style={{ gap: 6 }}>
                  {capabilityKeys(item.capabilitiesJson).map((capability) => (
                    <span className="tag" key={capability}>{capability}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="stack" style={{ gap: 14 }}>
          <div className="nr-item" style={{ padding: 16 }}>
            <h2 className="nr-section-header" style={{ marginTop: 0 }}>Ownership</h2>
            <p className="nr-item-meta" style={{ margin: 0 }}>
              Owner: {personName(item.owner ?? item.createdBy)}
            </p>
            <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
              Category: {item.category}
            </p>
            <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
              Source: {item.sourceType}
            </p>
            {item.type === "APP" && (
              <>
                <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                  App category: {displayEnum(item.appCategory)}
                </p>
                <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                  Visibility: {displayEnum(item.appVisibility)}
                </p>
                <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                  Hosting: {displayEnum(item.hostingMode)}
                </p>
                <p className="nr-item-meta" style={{ margin: "8px 0 0" }}>
                  Data: {item.dataClassification ?? "INTERNAL"}
                </p>
              </>
            )}
          </div>
          {item.type === "APP" && (item.supportUrl || item.proofUrl || item.reviewUrl) && (
            <div className="nr-item" style={{ padding: 16 }}>
              <h2 className="nr-section-header" style={{ marginTop: 0 }}>Review links</h2>
              <div className="stack" style={{ gap: 8 }}>
                {item.supportUrl && <a href={item.supportUrl} target="_blank" rel="noreferrer">Support</a>}
                {item.proofUrl && <a href={item.proofUrl} target="_blank" rel="noreferrer">Proof</a>}
                {item.reviewUrl && <a href={item.reviewUrl} target="_blank" rel="noreferrer">Review</a>}
              </div>
            </div>
          )}
          <div className="nr-item" style={{ padding: 16 }}>
            <h2 className="nr-section-header" style={{ marginTop: 0 }}>Data scopes</h2>
            {item.requestedScopes.length === 0 ? (
              <p className="nr-item-meta">No API scopes requested.</p>
            ) : (
              <div className="actions-inline" style={{ gap: 6 }}>
                {item.requestedScopes.map((scope) => (
                  <span className="tag" key={scope}>{scope}</span>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      <section>
        <h2 className="nr-section-header">Recent requests</h2>
        {requests.length === 0 ? (
          <p className="muted">No requests yet.</p>
        ) : (
          <div className="nr-table-wrap">
            <table className="nr-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Requester</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td>{request.type}</td>
                    <td>{request.status}</td>
                    <td><MarkdownRenderer markdown={request.reasonMd} variant="compact" /></td>
                    <td>{personName(request.requester)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
