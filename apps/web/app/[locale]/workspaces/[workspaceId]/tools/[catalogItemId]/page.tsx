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
          {item.isFavorite && <span className="tag success">Favorite</span>}
        </div>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{item.title}</h1>
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
          </div>
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
