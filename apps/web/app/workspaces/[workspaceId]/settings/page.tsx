import { DEFAULT_SCOPES, SCOPE_REGISTRY, listMembersEnriched, listAgentCredentials, listWebhookEndpoints, listInboundWebhooks, listAgentConfigs, listOAuthApps, getSsoConfigByWorkspace, getModelUsageBudget } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { headers } from "next/headers";
import {
  createWebhookEndpointAction,
  updateWebhookEndpointAction,
  deleteWebhookEndpointAction,
  rotateWebhookSecretAction,
} from "../actions";
import { AgentConnectionManager } from "./AgentConnectionManager";
import { CustomGptConnectionManager } from "./CustomGptConnectionManager";
import { MembersTable } from "./MembersTable";
import { AgentSettingsClient } from "./agents/AgentSettingsClient";
import { AgentBudgetManager } from "./agents/AgentBudgetManager";
import { SsoConfigManager } from "./SsoConfigManager";
import { DataSourcesManager } from "./DataSourcesManager";

export const dynamic = "force-dynamic";


export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspaceId } = await params;
  const search = await searchParams;
  const actor = await requirePageActor();
  const tab = search.tab ?? "general";

  // Load core user constraints that apply to both tabs
  const [credentials, webhookEndpoints, inboundWebhooks, userConnections, oauthApps, ssoConfigs] = await Promise.all([
    listAgentCredentials(actor, workspaceId).catch(() => []),
    listWebhookEndpoints(actor, workspaceId).catch(() => []),
    listInboundWebhooks(actor, workspaceId, { take: 20 }).catch(() => []),
    actor.kind === "user" ? prisma.oAuthConnection.findMany({ where: { userId: actor.user.id } }).catch(() => []) : Promise.resolve([]),
    listOAuthApps(actor, workspaceId).catch(() => []),
    getSsoConfigByWorkspace(actor, workspaceId).catch(() => []),
  ]);

  // Lazy-load members only for the members tab to avoid N+1 and failure propagation
  let members: Awaited<ReturnType<typeof listMembersEnriched>> = [];
  let isAdmin = false;
  if (tab === "members") {
    try {
      members = await listMembersEnriched(workspaceId, { includeInactive: true });
      if (actor.kind === "agent") {
        isAdmin = true;
      } else {
        isAdmin = members.find((m) => m.user.id === actor.user.id)?.role === "ADMIN";
      }
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch enriched members:", err);
    }
  }

  let agents: Awaited<ReturnType<typeof listAgentConfigs>> = [];
  let budget = null;
  if (tab === "agents") {
    try {
      [agents, budget] = await Promise.all([
        listAgentConfigs(actor, workspaceId),
        getModelUsageBudget(actor, workspaceId)
      ]);
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch agent configs/budget:", err);
    }
  }

  let dataSources: any[] = [];
  if (tab === "data-sources") {
    try {
      dataSources = await prisma.externalDataSource.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
      });
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch data sources:", err);
    }
  }

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const mcpUrl = `${origin}/api/mcp`;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Settings</h1>
        <div className="nr-masthead-meta">
          <span>Workspace members, approval policies, and agent credentials.</span>
        </div>
      </header>

      {/* Tab navigation */}
      <div className="nr-tab-bar" style={{ marginBottom: 32 }}>
        <a
          href={`/workspaces/${workspaceId}/settings?tab=general`}
          className={`nr-tab ${tab === "general" ? "nr-tab-active" : ""}`}
        >
          General
        </a>
        <a
          href={`/workspaces/${workspaceId}/settings?tab=members`}
          className={`nr-tab ${tab === "members" ? "nr-tab-active" : ""}`}
        >
          Members
        </a>
        <a
          href={`/workspaces/${workspaceId}/settings?tab=agents`}
          className={`nr-tab ${tab === "agents" ? "nr-tab-active" : ""}`}
        >
          Agents
        </a>
        <a
          href={`/workspaces/${workspaceId}/settings?tab=data-sources`}
          className={`nr-tab ${tab === "data-sources" ? "nr-tab-active" : ""}`}
        >
          Data Sources
        </a>
      </div>

      {tab === "general" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "40px", marginBottom: 48 }}>
            <section>
              <h2 className="nr-section-header">My Integrations</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                Connect your personal accounts to give the agent access to your calendar and context.
              </p>
              <div>
                <div className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">Google Calendar</strong>
                    {userConnections.find((c) => c.provider === "GOOGLE") ? (
                      <span className="tag" style={{ background: "var(--accent-soft)" }}>Connected</span>
                    ) : (
                      <a href={`/api/integrations/google/connect?workspaceId=${workspaceId}`} className="button secondary small">Connect Google</a>
                    )}
                  </div>
                </div>
                <div className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">Microsoft Outlook</strong>
                    {userConnections.find((c) => c.provider === "MICROSOFT") ? (
                      <span className="tag" style={{ background: "var(--accent-soft)" }}>Connected</span>
                    ) : (
                      <a href={`/api/integrations/microsoft/connect?workspaceId=${workspaceId}`} className="button secondary small">Connect Microsoft</a>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <SsoConfigManager workspaceId={workspaceId} configs={ssoConfigs} />

            <section className="stack" style={{ gap: 40 }}>
              <div>
                <h2 className="nr-section-header">Agent credentials (MCP)</h2>
                <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                  Create credentials to connect external AI clients (like Claude or Cursor) to your workspace via the Model Context Protocol (MCP).
                </p>

                <AgentConnectionManager
                  workspaceId={workspaceId}
                  mcpUrl={mcpUrl}
                  initialCredentials={credentials}
                  defaultScopes={DEFAULT_SCOPES}
                  scopeRegistry={SCOPE_REGISTRY}
                />
              </div>

              <div>
                 <h2 className="nr-section-header">Custom GPTs</h2>
                 <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                   Set up a dedicated Custom GPT for your organization inside ChatGPT.
                 </p>
                 <CustomGptConnectionManager
                   workspaceId={workspaceId}
                   mcpUrl={mcpUrl}
                   oauthApps={oauthApps.map(app => ({
                     id: app.id,
                     clientId: app.clientId,
                     name: app.name,
                     redirectUris: app.redirectUris,
                     isActive: app.isActive,
                     createdAt: app.createdAt
                   }))}
                 />
              </div>
            </section>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "40px" }}>
            {/* Outbound Webhooks */}
            <section>
              <h2 className="nr-section-header">Outbound Webhooks</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                Receive HTTP POST notifications when events occur in your workspace.
              </p>

              <details>
                <summary className="nr-hide-marker nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0, cursor: "pointer", color: "var(--accent)" }}>+ Add Webhook</summary>
                <form action={createWebhookEndpointAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <label>
                      URL (HTTPS)
                      <input name="url" type="url" required placeholder="https://example.com/webhook" />
                    </label>
                    <label>
                      Label
                      <input name="label" placeholder="My integration" />
                    </label>
                  </div>
                  <label>
                    Event types (comma-separated, leave empty for all)
                    <input name="eventTypes" placeholder="proposal.submitted, meeting.created, action.created" />
                  </label>
                  <button type="submit" className="small">Add Webhook</button>
                </form>
              </details>

              <div>
                {webhookEndpoints.length === 0 && (
                  <p className="nr-item-meta">No outbound webhooks configured.</p>
                )}
                {webhookEndpoints.map((ep) => (
                  <div className="nr-item" key={ep.id} style={{ padding: "12px 0" }}>
                    <div className="row">
                      <strong className="nr-item-title">{ep.label || ep.url}</strong>
                      <span className="tag" style={{
                        background: ep.status === "ACTIVE" ? "var(--accent-soft)" : "transparent",
                        color: ep.status === "ACTIVE" ? "inherit" : "var(--muted)",
                        border: ep.status !== "ACTIVE" ? "1px dashed var(--muted)" : "inherit"
                      }}>
                        {ep.status}
                      </span>
                    </div>
                    <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      {ep.url}
                    </div>
                    {ep.eventTypes.length > 0 && (
                      <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 2 }}>
                        Events: {ep.eventTypes.join(", ")}
                      </div>
                    )}
                    <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 2 }}>
                      {"_count" in ep ? `${(ep as Record<string, unknown>)._count && typeof (ep as Record<string, unknown>)._count === "object" ? ((ep as Record<string, unknown>)._count as Record<string, number>).deliveries ?? 0 : 0} deliveries` : ""}
                      {" · "}Created {new Date(ep.createdAt).toLocaleDateString()}
                    </div>
                    <div className="actions-inline" style={{ marginTop: 8 }}>
                      {ep.status === "ACTIVE" ? (
                        <form action={updateWebhookEndpointAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="endpointId" value={ep.id} />
                          <input type="hidden" name="status" value="PAUSED" />
                          <button type="submit" className="secondary small">Pause</button>
                        </form>
                      ) : (
                        <form action={updateWebhookEndpointAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="endpointId" value={ep.id} />
                          <input type="hidden" name="status" value="ACTIVE" />
                          <button type="submit" className="secondary small">Activate</button>
                        </form>
                      )}
                      <form action={rotateWebhookSecretAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="endpointId" value={ep.id} />
                        <button type="submit" className="secondary small">Rotate Secret</button>
                      </form>
                      <form action={deleteWebhookEndpointAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="endpointId" value={ep.id} />
                        <button type="submit" className="danger small">Delete</button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Inbound Webhooks */}
            <section>
              <h2 className="nr-section-header">Inbound Webhooks</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                External systems can send events to <code style={{ fontSize: "0.8rem", background: "transparent", border: "1px dashed var(--line)" }}>/api/webhooks/{workspaceId}/ingest?source=slack|calendar|generic</code>
              </p>
              <div>
                {inboundWebhooks.length === 0 && (
                  <p className="nr-item-meta">No inbound webhooks received yet.</p>
                )}
                {inboundWebhooks.map((wh) => (
                  <div className="nr-item" key={wh.id} style={{ padding: "12px 0" }}>
                    <div className="row">
                      <span className="tag">{wh.source}</span>
                      <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                        {new Date(wh.createdAt).toLocaleString()}
                      </span>
                      {wh.processedAt ? (
                        <span style={{ color: "var(--accent)", fontSize: "0.82rem" }}>Processed</span>
                      ) : wh.error ? (
                        <span style={{ color: "#842029", fontSize: "0.82rem" }}>Error</span>
                      ) : (
                        <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>Pending</span>
                      )}
                    </div>
                    {wh.externalId && (
                      <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                        External ID: {wh.externalId}
                      </div>
                    )}
                    {wh.error && (
                      <div style={{ color: "#842029", fontSize: "0.82rem", marginTop: 4 }}>
                        {wh.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      {tab === "members" && (
        <MembersTable workspaceId={workspaceId} members={members} isAdmin={isAdmin} />
      )}

      {tab === "agents" && (
        <>
          <AgentBudgetManager workspaceId={workspaceId} budget={budget ? { monthlyCostCapUsd: Number(budget.monthlyCostCapUsd), alertThresholdPct: budget.alertThresholdPct, periodStartDay: budget.periodStartDay } : null} />
          <AgentSettingsClient workspaceId={workspaceId} agents={agents} />
        </>
      )}

      {tab === "data-sources" && (
        <DataSourcesManager workspaceId={workspaceId} dataSources={dataSources} />
      )}
    </>
  );
}
