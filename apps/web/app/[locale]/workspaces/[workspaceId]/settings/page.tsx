import { DEFAULT_SCOPES, SCOPE_REGISTRY, listMembersEnriched, listAgentCredentials, listWebhookEndpoints, listInboundWebhooks, listAgentConfigs, listOAuthApps, getSsoConfigByWorkspace, getModelUsageBudget, listDocuments } from "@corgtex/domain";
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
import { getTranslations, getFormatter } from "next-intl/server";

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
  let documents: any[] = [];
  if (tab === "data-sources") {
    try {
      const [sources, docs] = await Promise.all([
        prisma.externalDataSource.findMany({
          where: { workspaceId },
          orderBy: { createdAt: "desc" },
        }),
        listDocuments(workspaceId)
      ]);
      dataSources = sources;
      documents = docs;
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch data/knowledge sources:", err);
    }
  }

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const mcpUrl = `${origin}/api/mcp`;
  const t = await getTranslations("settings");
  const format = await getFormatter();

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
          href={`/workspaces/${workspaceId}/settings?tab=general`}
          className={`nr-tab ${tab === "general" ? "nr-tab-active" : ""}`}
        >
          {t("tabGeneral")}
        </a>
        <a
          href={`/workspaces/${workspaceId}/settings?tab=members`}
          className={`nr-tab ${tab === "members" ? "nr-tab-active" : ""}`}
        >
          {t("tabMembers")}
        </a>
        <a
          href={`/workspaces/${workspaceId}/settings?tab=data-sources`}
          className={`nr-tab ${tab === "data-sources" ? "nr-tab-active" : ""}`}
        >
          {t("tabKnowledgeSources")}
        </a>
      </div>

      {tab === "general" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "40px", marginBottom: 48 }}>
            <section>
              <h2 className="nr-section-header">{t("sectionMyIntegrations")}</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                {t("descMyIntegrations")}
              </p>
              <div>
                <div className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">{t("integrationGoogle")}</strong>
                    {userConnections.find((c) => c.provider === "GOOGLE") ? (
                      <span className="tag" style={{ background: "var(--accent-soft)" }}>{t("statusConnected")}</span>
                    ) : (
                      <a href={`/api/integrations/google/connect?workspaceId=${workspaceId}`} className="button secondary small">{t("btnConnectGoogle")}</a>
                    )}
                  </div>
                </div>
                <div className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">{t("integrationMicrosoft")}</strong>
                    {userConnections.find((c) => c.provider === "MICROSOFT") ? (
                      <span className="tag" style={{ background: "var(--accent-soft)" }}>{t("statusConnected")}</span>
                    ) : (
                      <a href={`/api/integrations/microsoft/connect?workspaceId=${workspaceId}`} className="button secondary small">{t("btnConnectMicrosoft")}</a>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <SsoConfigManager workspaceId={workspaceId} configs={ssoConfigs} />

            <section className="stack" style={{ gap: 40 }}>
                 <h2 className="nr-section-header">{t("sectionCustomGpts")}</h2>
                 <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                   {t("descCustomGpts")}
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
            </section>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "40px" }}>
            {/* Outbound Webhooks */}
            <section>
              <h2 className="nr-section-header">{t("sectionOutboundWebhooks")}</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                {t("descOutboundWebhooks")}
              </p>

              <details>
                <summary className="nr-hide-marker nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0, cursor: "pointer", color: "var(--accent)" }}>{t("btnAddWebhook")}</summary>
                <form action={createWebhookEndpointAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <label>
                      {t("labelWebhookUrl")}
                      <input name="url" type="url" required placeholder={t("placeholderWebhookUrl")} />
                    </label>
                    <label>
                      {t("labelWebhookLabel")}
                      <input name="label" placeholder={t("placeholderWebhookLabel")} />
                    </label>
                  </div>
                  <label>
                    {t("labelEventTypes")}
                    <input name="eventTypes" placeholder={t("placeholderEventTypes")} />
                  </label>
                  <button type="submit" className="small">{t("btnSubmitAddWebhook")}</button>
                </form>
              </details>

              <div>
                {webhookEndpoints.length === 0 && (
                  <p className="nr-item-meta">{t("noOutboundWebhooks")}</p>
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
                    <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 2 }} suppressHydrationWarning>
                      {"_count" in ep ? t("webhookDeliveries", { count: ((ep as Record<string, unknown>)._count && typeof (ep as Record<string, unknown>)._count === "object" ? ((ep as Record<string, unknown>)._count as Record<string, number>).deliveries ?? 0 : 0) }) : ""}
                      {" · "}{t("createdOn")} {format.dateTime(new Date(ep.createdAt))}
                    </div>
                    <div className="actions-inline" style={{ marginTop: 8 }}>
                      {ep.status === "ACTIVE" ? (
                        <form action={updateWebhookEndpointAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="endpointId" value={ep.id} />
                          <input type="hidden" name="status" value="PAUSED" />
                          <button type="submit" className="secondary small">{t("btnPause")}</button>
                        </form>
                      ) : (
                        <form action={updateWebhookEndpointAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="endpointId" value={ep.id} />
                          <input type="hidden" name="status" value="ACTIVE" />
                          <button type="submit" className="secondary small">{t("btnActivate")}</button>
                        </form>
                      )}
                      <form action={rotateWebhookSecretAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="endpointId" value={ep.id} />
                        <button type="submit" className="secondary small">{t("btnRotateSecret")}</button>
                      </form>
                      <form action={deleteWebhookEndpointAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="endpointId" value={ep.id} />
                        <button type="submit" className="danger small">{t("btnDelete")}</button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Inbound Webhooks */}
            <section>
              <h2 className="nr-section-header">{t("sectionInboundWebhooks")}</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                {t("descInboundWebhooks")} <code style={{ fontSize: "0.8rem", background: "transparent", border: "1px dashed var(--line)" }}>/api/webhooks/{workspaceId}/ingest?source=slack|calendar|generic</code>
              </p>
              <div>
                {inboundWebhooks.length === 0 && (
                  <p className="nr-item-meta">{t("noInboundWebhooks")}</p>
                )}
                {inboundWebhooks.map((wh) => (
                  <div className="nr-item" key={wh.id} style={{ padding: "12px 0" }}>
                    <div className="row">
                      <span className="tag">{wh.source}</span>
                      <span className="nr-item-meta" style={{ fontSize: "0.82rem" }} suppressHydrationWarning>
                        {format.dateTime(new Date(wh.createdAt), { dateStyle: "short", timeStyle: "short" })}
                      </span>
                      {wh.processedAt ? (
                        <span style={{ color: "var(--accent)", fontSize: "0.82rem" }}>{t("statusProcessed")}</span>
                      ) : wh.error ? (
                        <span style={{ color: "#842029", fontSize: "0.82rem" }}>{t("statusError")}</span>
                      ) : (
                        <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>{t("statusPending")}</span>
                      )}
                    </div>
                    {wh.externalId && (
                      <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                        {t("externalId", { id: wh.externalId })}
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

      {tab === "data-sources" && (
        <DataSourcesManager workspaceId={workspaceId} dataSources={dataSources} documents={documents} />
      )}
    </>
  );
}
