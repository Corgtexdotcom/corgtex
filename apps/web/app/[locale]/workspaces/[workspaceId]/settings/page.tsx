import {
  AppError,
  getMemberInvitePolicy,
  getModelUsageBudget,
  getSsoConfigByWorkspace,
  listAgentConfigs,
  listCommunicationInstallations,
  listDocuments,
  listInboundWebhooks,
  listMemberInviteRequests,
  listMembersEnriched,
  listWebhookEndpoints,
  requireWorkspaceMembership,
  getUserProfile,
  listUserSessions,
  getUserNotificationPreferences
} from "@corgtex/domain";
import { env, prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { headers } from "next/headers";
import {
  createWebhookEndpointAction,
  updateWebhookEndpointAction,
  deleteWebhookEndpointAction,
  rotateWebhookSecretAction,
  disconnectCommunicationInstallationAction,
} from "../actions";
import { CorgtexConnectorManager } from "./CorgtexConnectorManager";
import { MembersTable } from "./MembersTable";
import { AgentSettingsClient } from "./agents/AgentSettingsClient";
import { AgentBudgetManager } from "./agents/AgentBudgetManager";
import { SsoConfigManager } from "./SsoConfigManager";
import { DataSourcesManager } from "./DataSourcesManager";
import { UserSettingsPanel } from "./UserSettingsPanel";
import { getTranslations, getFormatter } from "next-intl/server";
import { notFound } from "next/navigation";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";

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
  const featureFlags = await getWorkspaceFeatureFlags(workspaceId);
  const tab = search.tab ?? (featureFlags.SETTINGS_GENERAL ? "general" : "members");
  if (!featureFlags.AGENT_GOVERNANCE && tab === "agents") {
    notFound();
  }
  if (!featureFlags.SETTINGS_GENERAL && search.tab === "general") {
    notFound();
  }

  // Load core user constraints that apply to both tabs
  const [webhookEndpoints, inboundWebhooks, userConnections, ssoConfigs, communicationInstallations] = await Promise.all([
    listWebhookEndpoints(actor, workspaceId).catch(() => []),
    listInboundWebhooks(actor, workspaceId, { take: 20 }).catch(() => []),
    actor.kind === "user" ? prisma.oAuthConnection.findMany({ where: { userId: actor.user.id } }).catch(() => []) : Promise.resolve([]),
    getSsoConfigByWorkspace(actor, workspaceId).catch(() => []),
    listCommunicationInstallations(actor, workspaceId).catch(() => []),
  ]);
  const slackInstallation = communicationInstallations.find((installation) => installation.provider === "SLACK" && installation.status === "ACTIVE");

  // Lazy-load members only for the members tab to avoid N+1 and failure propagation
  let members: Awaited<ReturnType<typeof listMembersEnriched>> = [];
  let isAdmin = false;
  let invitePolicy: Awaited<ReturnType<typeof getMemberInvitePolicy>> = "ADMINS_ONLY";
  let inviteRequests: Awaited<ReturnType<typeof listMemberInviteRequests>> = [];
  if (tab === "members") {
    let membership: Awaited<ReturnType<typeof requireWorkspaceMembership>>;
    try {
      membership = await requireWorkspaceMembership({ actor, workspaceId });
    } catch (error) {
      if (error instanceof AppError && error.status === 403) {
        notFound();
      }
      throw error;
    }
    isAdmin = membership?.role === "ADMIN";
    try {
      members = await listMembersEnriched(workspaceId, { includeInactive: true });
      invitePolicy = await getMemberInvitePolicy(workspaceId);
      if (isAdmin) {
        inviteRequests = await listMemberInviteRequests(actor, { workspaceId, status: "PENDING" });
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

  let userProfile: any = null;
  let userSessions: any[] = [];
  let userPrefs: any[] = [];
  if (tab === "user") {
    try {
      const { sha256, sessionCookieName } = await import("@corgtex/shared");
      const cookieStore = await import("next/headers").then(m => m.cookies());
      const token = cookieStore.get(sessionCookieName())?.value;
      const tokenHash = token ? sha256(token) : undefined;
      
      [userProfile, userSessions, userPrefs] = await Promise.all([
        getUserProfile(actor, workspaceId),
        listUserSessions(actor, tokenHash),
        getUserNotificationPreferences(actor)
      ]);
    } catch (err) {
      console.error("[SettingsPage] Failed to fetch user profile data:", err);
    }
  }

  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const connectorUrl = env.MCP_PUBLIC_URL ?? `${origin}/mcp`;
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
        {featureFlags.SETTINGS_GENERAL && (
          <a
            href={`/workspaces/${workspaceId}/settings?tab=general`}
            className={`nr-tab ${tab === "general" ? "nr-tab-active" : ""}`}
          >
            {t("tabGeneral")}
          </a>
        )}
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
        <a
          href={`/workspaces/${workspaceId}/settings?tab=user`}
          className={`nr-tab ${tab === "user" ? "nr-tab-active" : ""}`}
        >
          {t("tabUser")}
        </a>
      </div>

      {tab === "user" && userProfile && (
        <UserSettingsPanel 
          workspaceId={workspaceId} 
          profile={userProfile} 
          sessions={userSessions} 
          preferences={userPrefs} 
        />
      )}

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
                <div className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">Slack workspace</strong>
                    {slackInstallation ? (
                      <span className="tag" style={{ background: "var(--accent-soft)" }}>Connected</span>
                    ) : (
                      <a href={`/api/integrations/slack/install?workspaceId=${workspaceId}`} className="button secondary small">Connect Slack</a>
                    )}
                  </div>
                  {slackInstallation ? (
                    <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                        {slackInstallation.externalTeamName || slackInstallation.externalWorkspaceId} · {slackInstallation._count.channels} channels · {slackInstallation._count.messages} captured messages
                      </p>
                      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                        Public-channel messages are used for aggregate briefings and work capture. Raw Slack message text is deleted after 30 days; source metadata, generated summaries, and Corgtex links are preserved.
                      </p>
                      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                        Granted scopes: {slackInstallation.scopes.length > 0 ? slackInstallation.scopes.join(", ") : "none recorded"}
                      </p>
                      <form action={disconnectCommunicationInstallationAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="installationId" value={slackInstallation.id} />
                        <button type="submit" className="danger small">Disconnect Slack</button>
                      </form>
                    </div>
                  ) : (
                    <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                      Slack can feed the daily Corgtex newspaper, App Home brief, commands, and message captures. Private channels and DMs are not ingested in the MVP.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <SsoConfigManager workspaceId={workspaceId} configs={ssoConfigs} />

            <section className="stack" style={{ gap: 40 }}>
                 <h2 className="nr-section-header">{t("sectionCorgtexConnector")}</h2>
                 <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                   {t("descCorgtexConnector")}
                 </p>
                 <CorgtexConnectorManager connectorUrl={connectorUrl} />
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
        <MembersTable
          workspaceId={workspaceId}
          members={members}
          isAdmin={isAdmin}
          invitePolicy={invitePolicy}
          inviteRequests={inviteRequests}
        />
      )}

      {tab === "data-sources" && (
        <DataSourcesManager workspaceId={workspaceId} dataSources={dataSources} documents={documents} />
      )}
    </>
  );
}
