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
  getUserNotificationPreferences,
  getMeetingRecorderConfig,
  listMeetingTranscriptSourceState,
  getWorkspacePlanState,
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
  updateMeetingRecorderConfigAction,
  connectMeetingTranscriptSourceAction,
  importMeetingTranscriptSourceAction,
  retryMeetingTranscriptImportBatchAction,
  runMeetingTranscriptSourceBackfillAction,
  updateSlackAgendaSettingsAction,
  deleteOAuthConnectionAction,
  runOAuthConnectionSyncAction,
  updateOAuthConnectionSettingsAction,
} from "../actions";
import { CorgtexConnectorManager } from "./CorgtexConnectorManager";
import { MembersTable } from "./MembersTable";
import { AgentSettingsClient } from "./agents/AgentSettingsClient";
import { AgentBudgetManager } from "./agents/AgentBudgetManager";
import { SsoConfigManager } from "./SsoConfigManager";
import { DataSourcesManager } from "./DataSourcesManager";
import { UserSettingsPanel } from "./UserSettingsPanel";
import { OnboardingRestartButton } from "./OnboardingRestartButton";
import { getTranslations, getFormatter } from "next-intl/server";
import { notFound } from "next/navigation";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

function settingsRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function settingsSection(settings: unknown, key: "calendar" | "documents" | "email") {
  return settingsRecord(settingsRecord(settings)[key]);
}

function settingsStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function integrationStatusMessage(params: {
  provider?: string;
  status?: string;
  error?: string;
  success?: string;
}) {
  if (!params.provider || !params.status) return null;
  if (params.status === "success") {
    if (params.success === "google_connected") return "Google Calendar connected. Calendar sync is queued.";
    if (params.success === "microsoft_connected") return "Microsoft Calendar connected. Calendar sync is queued.";
    return "Integration connected.";
  }

  const messages: Record<string, string> = {
    google_not_configured: "Google is not configured in Corgtex yet. Add the Google OAuth client ID/secret and redirect URI before retrying.",
    microsoft_not_configured: "Microsoft is not configured in Corgtex yet. Add the Entra OAuth client ID/secret and redirect URI before retrying.",
    google_verification_or_tester_required: "Google blocked access because this app is still in testing or not verified. Add this email as an approved test user, or complete Google verification before public use.",
    microsoft_tenant_access_denied: "Microsoft blocked this account for the selected tenant. Use an account in the app tenant, add the account as an external user, or switch the Entra app to the intended multitenant audience.",
    microsoft_admin_consent_required: "Microsoft requires tenant admin consent for this account or organization before Corgtex can connect.",
    microsoft_access_denied: "Microsoft access was denied before Corgtex received permission.",
    microsoft_invalid_client_secret: "Microsoft rejected the client secret. In Entra, create and copy the client secret Value, not the Secret ID, then update the production secret before retrying.",
    oauth_state_invalid: "The OAuth session expired or did not match this browser session. Start the connection again from this settings page.",
    oauth_code_missing: "The provider did not return an authorization code. Start the connection again from this settings page.",
    google_token_exchange_failed: "Google returned an error while exchanging the authorization code. Check the OAuth client secret and redirect URI.",
    microsoft_token_exchange_failed: "Microsoft returned an error while exchanging the authorization code. Check the client secret, redirect URI, and tenant consent.",
    google_profile_failed: "Google connected but Corgtex could not read the signed-in profile. Check the granted OpenID/profile scopes.",
    microsoft_profile_failed: "Microsoft connected but Corgtex could not read the signed-in profile. Check the User.Read permission.",
    google_unexpected_error: "Google connection failed inside Corgtex. Retry once; if it repeats, check server logs for the OAuth callback.",
    microsoft_unexpected_error: "Microsoft connection failed inside Corgtex. Retry once; if it repeats, check server logs for the OAuth callback.",
  };
  return messages[params.error ?? ""] ?? "The integration could not be connected. Retry from this settings page.";
}

function OAuthProviderCard({ provider, title, configured, connection, workspaceId, format }: {
  provider: "google" | "microsoft";
  title: string;
  configured: boolean;
  connection?: {
    id: string;
    providerAccountId: string;
    providerEmail: string | null;
    scopes: string[];
    status: string;
    syncSettings: unknown;
    lastSyncAt: Date | null;
    lastSyncError: string | null;
  };
  workspaceId: string;
  format: Awaited<ReturnType<typeof getFormatter>>;
}) {
  const setupNote = provider === "google"
    ? "Hidden beta requires the signed-in email to be added as a Google test user until Google verification is complete."
    : "External client tenants may need publisher verification or admin consent before Microsoft will allow access.";
  return (
    <div className="nr-item" style={{ padding: "12px 0" }}>
      <div className="row">
        <strong className="nr-item-title">{title}</strong>
        {connection ? (
          <span className="tag" style={{ background: connection.status === "ACTIVE" ? "var(--accent-soft)" : "transparent" }}>
            {connection.status === "ACTIVE" ? "Connected" : connection.status}
          </span>
        ) : configured ? (
          <a href={`/api/integrations/${provider}/connect?workspaceId=${workspaceId}`} className="button secondary small">
            Connect {provider === "google" ? "Google" : "Microsoft"}
          </a>
        ) : (
          <span className="tag" style={{ border: "1px dashed var(--line)", background: "transparent" }}>Needs setup</span>
        )}
      </div>
      <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
        Calendar sync is read-only by default. Documents and email remain opt-in and source-filtered before ingestion.
      </p>
      <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
        {configured ? setupNote : "Corgtex OAuth credentials are missing in this environment."}
      </p>
      {connection ? (
        <OAuthConnectionControls connection={connection} workspaceId={workspaceId} format={format} />
      ) : null}
    </div>
  );
}

function OAuthConnectionControls({ connection, workspaceId, format }: {
  connection: {
    id: string;
    providerAccountId: string;
    providerEmail: string | null;
    scopes: string[];
    status: string;
    syncSettings: unknown;
    lastSyncAt: Date | null;
    lastSyncError: string | null;
  };
  workspaceId: string;
  format: Awaited<ReturnType<typeof getFormatter>>;
}) {
  const calendar = settingsSection(connection.syncSettings, "calendar");
  const documents = settingsSection(connection.syncSettings, "documents");
  const email = settingsSection(connection.syncSettings, "email");
  const documentIds = settingsStringList(documents.selectedDriveIds ?? documents.selectedDocumentIds).join("\n");
  const emailFilters = settingsStringList(email.filters ?? email.queries).join("\n");
  const scopes = connection.scopes.join(" ").toLowerCase();
  const hasDocumentScope = scopes.includes("drive.readonly") || scopes.includes("files.read") || scopes.includes("sites.read");
  const hasEmailScope = scopes.includes("gmail.readonly") || scopes.includes("mail.read");

  return (
    <div key={connection.id} className="nr-item" style={{ marginTop: 8, padding: "12px 0" }}>
      <div className="row" style={{ alignItems: "center" }}>
        <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
          {connection.providerEmail ?? connection.providerAccountId} · {connection.status.toLowerCase()} · {connection.lastSyncAt ? format.dateTime(connection.lastSyncAt, { dateStyle: "medium", timeStyle: "short" }) : "Not synced yet"}
        </span>
      </div>
      <p className="nr-item-meta" style={{ fontSize: "0.78rem", marginTop: 6 }}>
        Scopes: {connection.scopes.length > 0 ? connection.scopes.join(", ") : "none recorded"}
      </p>
      {connection.lastSyncError && (
        <p className="form-message form-message-error" style={{ marginTop: 8 }}>{connection.lastSyncError}</p>
      )}
      <form action={updateOAuthConnectionSettingsAction} className="stack" style={{ gap: 8, marginTop: 10 }}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="connectionId" value={connection.id} />
        <label style={{ fontSize: "0.82rem" }}>
          Connection status
          <select name="status" defaultValue={connection.status === "PAUSED" ? "PAUSED" : "ACTIVE"}>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
          </select>
        </label>
        <div className="grid-2">
          <label style={{ fontSize: "0.82rem" }}>
            Calendar sync
            <select name="calendarEnabled" defaultValue={calendar.enabled === false ? "false" : "true"}>
              <option value="true">Enabled</option>
              <option value="false">Paused</option>
            </select>
          </label>
          <label style={{ fontSize: "0.82rem" }}>
            Calendar relevance
            <select name="includeAllEvents" defaultValue={calendar.includeAllEvents === true ? "true" : "false"}>
              <option value="false">Relevant events only</option>
              <option value="true">All events</option>
            </select>
          </label>
        </div>
        <label style={{ fontSize: "0.82rem" }}>
          Documents
          <select name="documentsEnabled" defaultValue={documents.enabled === true && hasDocumentScope ? "true" : "false"} disabled={!hasDocumentScope}>
            <option value="false">Disabled</option>
            <option value="true">Selected documents only</option>
          </select>
        </label>
        <textarea name="documentIds" rows={3} defaultValue={documentIds} placeholder="One Google Drive, OneDrive, or driveId:itemId file reference per line" disabled={!hasDocumentScope} />
        {!hasDocumentScope && (
          <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0 }}>
            Document ingestion needs an additional approved document scope and stays off for this calendar-only connection.
          </p>
        )}
        <label style={{ fontSize: "0.82rem" }}>
          Email
          <select name="emailEnabled" defaultValue={email.enabled === true && hasEmailScope ? "true" : "false"} disabled={!hasEmailScope}>
            <option value="false">Disabled</option>
            <option value="true">Filtered messages only</option>
          </select>
        </label>
        <textarea name="emailFilters" rows={3} defaultValue={emailFilters} placeholder="One Gmail/Outlook search filter per line" disabled={!hasEmailScope} />
        {!hasEmailScope && (
          <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0 }}>
            Email ingestion needs an additional approved email scope and stays off until explicit source filters are ready.
          </p>
        )}
        <div className="actions-inline">
          <button type="submit" className="button secondary small">Save connector settings</button>
        </div>
      </form>
      <div className="actions-inline" style={{ marginTop: 10 }}>
        {connection.status === "ACTIVE" ? (
          <form action={runOAuthConnectionSyncAction} className="actions-inline">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="connectionId" value={connection.id} />
            {calendar.enabled !== false && <input type="hidden" name="syncKind" value="calendar" />}
            {documents.enabled === true && hasDocumentScope && <input type="hidden" name="syncKind" value="documents" />}
            {email.enabled === true && hasEmailScope && <input type="hidden" name="syncKind" value="email" />}
            <button type="submit" className="button secondary small">Run sync</button>
          </form>
        ) : null}
        <form action={deleteOAuthConnectionAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="connectionId" value={connection.id} />
          <button type="submit" className="button ghost small">Delete connection</button>
        </form>
      </div>
    </div>
  );
}


export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string; integration?: string; integrationStatus?: string; integrationError?: string; integrationSuccess?: string }>;
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
  const [webhookEndpoints, inboundWebhooks, userConnections, ssoConfigs, communicationInstallations, meetingRecorderConfig, meetingTranscriptSources, planState] = await Promise.all([
    listWebhookEndpoints(actor, workspaceId).catch(() => []),
    listInboundWebhooks(actor, workspaceId, { take: 20 }).catch(() => []),
    actor.kind === "user" ? prisma.oAuthConnection.findMany({
      where: {
        userId: actor.user.id,
        OR: [
          { workspaceId },
          { workspaceId: null },
        ],
      },
      orderBy: { updatedAt: "desc" },
    }).catch(() => []) : Promise.resolve([]),
    getSsoConfigByWorkspace(actor, workspaceId).catch(() => []),
    listCommunicationInstallations(actor, workspaceId).catch(() => []),
    featureFlags.MEETING_RECORDERS ? getMeetingRecorderConfig(actor, workspaceId).catch(() => null) : Promise.resolve(null),
    featureFlags.MEETING_RECORDERS ? listMeetingTranscriptSourceState(actor, workspaceId).catch(() => null) : Promise.resolve(null),
    getWorkspacePlanState(actor, workspaceId).catch(() => null),
  ]);
  const slackInstallation = communicationInstallations.find((installation) => installation.provider === "SLACK" && installation.status === "ACTIVE");
  const slackSettings = slackInstallation?.settings && typeof slackInstallation.settings === "object" && !Array.isArray(slackInstallation.settings)
    ? slackInstallation.settings as Record<string, unknown>
    : {};

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
  const integrationMessage = integrationStatusMessage({
    provider: search.integration,
    status: search.integrationStatus,
    error: search.integrationError,
    success: search.integrationSuccess,
  });
  const googleConnection = userConnections.find((c) => c.provider === "GOOGLE" && c.status !== "DISCONNECTED");
  const microsoftConnection = userConnections.find((c) => c.provider === "MICROSOFT" && c.status !== "DISCONNECTED");
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const microsoftConfigured = Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2rem" }}>{t("pageTitle")}</h1>
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
        {featureFlags.AGENT_GOVERNANCE && (
          <a
            href={`/workspaces/${workspaceId}/settings?tab=agents`}
            className={`nr-tab ${tab === "agents" ? "nr-tab-active" : ""}`}
          >
            {t("tabAgents")}
          </a>
        )}
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
            {planState && (
              <section>
                <h2 className="nr-section-header">Plan and AI usage</h2>
                <div className="nr-item" style={{ padding: "14px 0" }}>
                  <div className="row">
                    <strong className="nr-item-title">{planState.plan.replace(/_/g, " ")}</strong>
                    <span className="tag" style={{ background: planState.aiBudget.enabled ? "var(--accent-soft)" : "transparent" }}>
                      {planState.aiBudget.enabled ? "AI enabled" : "Core only"}
                    </span>
                  </div>
                  <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                    {planState.trialEndsAt
                      ? `Trial ends ${format.dateTime(planState.trialEndsAt, { dateStyle: "medium" })}. `
                      : ""}
                    AI spend this period: ${planState.aiBudget.usedUsd.toFixed(2)}
                    {planState.aiBudget.capUsd != null && planState.aiBudget.capUsd >= 0 ? ` of $${planState.aiBudget.capUsd.toFixed(2)}` : ""}.
                  </p>
                  <div className="actions-inline" style={{ marginTop: 12 }}>
                    {planState.plan !== "PAYG_AI" && (
                      <a className="button primary small" href={`/api/billing/checkout?workspaceId=${workspaceId}`}>
                        Enable pay-as-you-go AI
                      </a>
                    )}
                    {planState.billing?.stripeCustomerId && (
                      <a className="button secondary small" href={`/api/billing/portal?workspaceId=${workspaceId}`}>
                        Billing portal
                      </a>
                    )}
                    <OnboardingRestartButton />
                  </div>
                </div>
              </section>
            )}
            <section>
              <h2 className="nr-section-header">{t("sectionMyIntegrations")}</h2>
              <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
                {t("descMyIntegrations")}
              </p>
              {integrationMessage && (
                <p
                  className={`form-message ${search.integrationStatus === "success" ? "form-message-success" : "form-message-error"}`}
                  style={{ marginBottom: 12 }}
                >
                  {integrationMessage}
                </p>
              )}
              <div>
                <OAuthProviderCard
                  provider="google"
                  title={t("integrationGoogle")}
                  configured={googleConfigured}
                  connection={googleConnection}
                  workspaceId={workspaceId}
                  format={format}
                />
                <OAuthProviderCard
                  provider="microsoft"
                  title={t("integrationMicrosoft")}
                  configured={microsoftConfigured}
                  connection={microsoftConnection}
                  workspaceId={workspaceId}
                  format={format}
                />
                {featureFlags.MEETING_RECORDERS && meetingRecorderConfig ? (
                  <div className="nr-item" style={{ padding: "12px 0" }}>
                    <div className="row">
                      <strong className="nr-item-title">Corgtex meeting recorder</strong>
                      <span className="tag" style={{ background: meetingRecorderConfig.config.enabled ? "var(--accent-soft)" : "transparent" }}>
                        {meetingRecorderConfig.config.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                      Uses Corgtex-managed Recall.ai and Meeting BaaS accounts. Calendar connections stay in Corgtex; vendor keys are never shown to customers.
                    </p>
                    <form action={updateMeetingRecorderConfigAction} className="stack" style={{ gap: 8, paddingTop: 8 }}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <label style={{ fontSize: "0.85rem" }}>
                        Recorder
                        <select name="enabled" defaultValue={meetingRecorderConfig.config.enabled ? "true" : "false"}>
                          <option value="true">Enabled</option>
                          <option value="false">Disabled</option>
                        </select>
                      </label>
                      <label style={{ fontSize: "0.85rem" }}>
                        Automatic calendar recording
                        <select name="autoRecordEnabled" defaultValue={meetingRecorderConfig.config.autoRecordEnabled ? "true" : "false"}>
                          <option value="true">Enabled</option>
                          <option value="false">Disabled</option>
                        </select>
                      </label>
                      <div className="actions-inline">
                        <label style={{ flex: 1, fontSize: "0.85rem" }}>
                          Default provider
                          <select name="defaultProvider" defaultValue={meetingRecorderConfig.config.defaultProvider}>
                            <option value="RECALL_AI">Recall.ai</option>
                            <option value="MEETING_BAAS">Meeting BaaS</option>
                          </select>
                        </label>
                        <label style={{ flex: 1, fontSize: "0.85rem" }}>
                          Fallback provider
                          <select name="fallbackProvider" defaultValue={meetingRecorderConfig.config.fallbackProvider ?? ""}>
                            <option value="">None</option>
                            <option value="RECALL_AI">Recall.ai</option>
                            <option value="MEETING_BAAS">Meeting BaaS</option>
                          </select>
                        </label>
                      </div>
                      <label style={{ fontSize: "0.85rem" }}>
                        Bot name
                        <input name="botName" defaultValue={meetingRecorderConfig.config.botName} />
                      </label>
                      <label style={{ fontSize: "0.85rem" }}>
                        Entry message
                        <textarea name="entryMessage" defaultValue={meetingRecorderConfig.config.entryMessage ?? ""} rows={3} />
                      </label>
                      <label style={{ fontSize: "0.85rem" }}>
                        Monthly minute cap
                        <input name="monthlyMinuteCap" type="number" min="0" defaultValue={meetingRecorderConfig.config.monthlyMinuteCap} />
                      </label>
                      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                        Used this month: {meetingRecorderConfig.usage.usedMinutes} minutes.
                      </p>
                      <button type="submit" className="secondary small">Save recorder settings</button>
                    </form>
                  </div>
                ) : null}
                {featureFlags.MEETING_RECORDERS && meetingTranscriptSources ? (
                  <div className="nr-item" style={{ padding: "12px 0" }}>
                    <div className="row">
                      <strong className="nr-item-title">Meeting records</strong>
                      <span className="tag" style={{ background: meetingTranscriptSources.connections.length > 0 ? "var(--accent-soft)" : "transparent" }}>
                        {meetingTranscriptSources.connections.length > 0 ? `${meetingTranscriptSources.connections.length} connected` : "Ready"}
                      </span>
                    </div>
                    <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
                      Bring in recorder transcripts as the first onboarding source. Batches are processed oldest to newest, and newer source revisions replace stale active transcripts while keeping the older evidence.
                    </p>
                    <details>
                      <summary className="nr-hide-marker settings-disclosure-summary" style={{ color: "var(--accent)", cursor: "pointer", marginTop: 8 }}>
                        Connect providers and upload exports
                      </summary>
                      <div className="stack" style={{ gap: 20, marginTop: 12 }}>
                        {meetingTranscriptSources.catalog.slice(0, 8).map((entry) => {
                          const connection = meetingTranscriptSources.connections.find((item) => item.provider === entry.provider);
                          const webhookUrl = `${origin}/api/integrations/meeting-transcripts/${entry.slug}/webhook?workspaceId=${workspaceId}`;
                          return (
                            <div key={entry.provider} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                              <div className="row">
                                <strong className="nr-item-title">{entry.label}</strong>
                                <span className="tag" style={{ background: connection?.status === "ACTIVE" ? "var(--accent-soft)" : "transparent" }}>
                                  {connection?.status === "ACTIVE" ? "Connected" : entry.connectionStatus}
                                </span>
                              </div>
                              <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: "6px 0" }}>
                                {entry.firstPath}
                              </p>
                              <div className="stack" style={{ gap: 8 }}>
                                <form action={connectMeetingTranscriptSourceAction} className="stack nr-form-section">
                                  <input type="hidden" name="workspaceId" value={workspaceId} />
                                  <input type="hidden" name="provider" value={entry.slug} />
                                  <label style={{ fontSize: "0.85rem" }}>
                                    API key
                                    <input name="apiKey" type="password" autoComplete="off" placeholder={connection?.hasApiKey ? "Stored" : "Provider API key"} />
                                  </label>
                                  <label style={{ fontSize: "0.85rem" }}>
                                    Webhook secret
                                    <input name="webhookSecret" type="password" autoComplete="off" placeholder={connection?.hasWebhookSecret ? "Stored" : "Provider webhook secret"} />
                                  </label>
                                  <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0, wordBreak: "break-all" }}>
                                    Webhook URL: {webhookUrl}
                                  </p>
                                  <div className="actions-inline">
                                    <button type="submit" className="secondary small">Save connection</button>
                                  </div>
                                </form>
                                <form action={importMeetingTranscriptSourceAction} className="stack nr-form-section" encType="multipart/form-data">
                                  <input type="hidden" name="workspaceId" value={workspaceId} />
                                  <input type="hidden" name="provider" value={entry.slug} />
                                  <input type="hidden" name="sourceKind" value="settings-upload" />
                                  <label style={{ fontSize: "0.85rem" }}>
                                    Transcript export or ZIP
                                    <input name="file" type="file" multiple accept=".zip,.json,.txt,.vtt,.srt,.docx,.pdf,.md,.csv,text/*,application/json,application/pdf,application/zip" />
                                  </label>
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                    <label style={{ fontSize: "0.85rem" }}>
                                      Title fallback
                                      <input name="title" placeholder="Weekly tactical" />
                                    </label>
                                    <label style={{ fontSize: "0.85rem" }}>
                                      Recorded at fallback
                                      <input name="recordedAt" type="datetime-local" />
                                    </label>
                                  </div>
                                  <label style={{ fontSize: "0.85rem" }}>
                                    Participant emails
                                    <input name="participantEmails" placeholder="name@example.com, name2@example.com" />
                                  </label>
                                  <label style={{ fontSize: "0.85rem" }}>
                                    Paste transcript
                                    <textarea name="transcript" rows={3} placeholder="Optional when uploading files" />
                                  </label>
                                  <div className="actions-inline">
                                    <button type="submit" className="secondary small">Import batch</button>
                                  </div>
                                </form>
                                {connection ? (
                                  <form action={runMeetingTranscriptSourceBackfillAction}>
                                    <input type="hidden" name="workspaceId" value={workspaceId} />
                                    <input type="hidden" name="provider" value={entry.slug} />
                                    <button type="submit" className="ghost small">Run backfill</button>
                                  </form>
                                ) : null}
                                <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0 }}>
                                  Manual path: {entry.manualExportInstructions.join(" ")}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                    {meetingTranscriptSources.batches.length > 0 && (
                      <div className="stack" style={{ gap: 8, marginTop: 14 }}>
                        <strong className="nr-item-title">Recent import batches</strong>
                        {meetingTranscriptSources.batches.slice(0, 5).map((batch) => (
                          <div key={batch.id} className="row" style={{ alignItems: "center" }}>
                            <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                              {batch.provider} · {batch.status} · {batch.importedCount} imported · {batch.skippedCount} skipped · {batch.failedCount} failed
                            </span>
                            {batch.failedCount > 0 ? (
                              <form action={retryMeetingTranscriptImportBatchAction}>
                                <input type="hidden" name="workspaceId" value={workspaceId} />
                                <input type="hidden" name="batchId" value={batch.id} />
                                <button type="submit" className="ghost small">Retry</button>
                              </form>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                    {meetingTranscriptSources.records.length > 0 && (
                      <div className="stack" style={{ gap: 6, marginTop: 14 }}>
                        <strong className="nr-item-title">Latest source records</strong>
                        {meetingTranscriptSources.records.slice(0, 6).map((record) => (
                          <div key={record.id} className="nr-item-meta" style={{ fontSize: "0.82rem" }} suppressHydrationWarning>
                            {record.provider} · {record.status} · {record.title || record.externalId} · {format.dateTime(new Date(record.recordedAt), { dateStyle: "medium" })}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
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
                        Public-channel messages are archived for aggregate briefings, work capture, and long-term context. Private channels and DMs are not ingested.
                      </p>
                      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                        Granted scopes: {slackInstallation.scopes.length > 0 ? slackInstallation.scopes.join(", ") : "none recorded"}
                      </p>
                      <form action={updateSlackAgendaSettingsAction} className="stack" style={{ gap: 8, paddingTop: 8 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <label style={{ fontSize: "0.85rem" }}>
                          Default agenda channel ID
                          <input
                            name="defaultAgendaChannelId"
                            placeholder="C0123456789"
                            defaultValue={typeof slackSettings.defaultAgendaChannelId === "string" ? slackSettings.defaultAgendaChannelId : ""}
                          />
                        </label>
                        <label style={{ fontSize: "0.85rem" }}>
                          Agenda timezone
                          <input
                            name="agendaTimezone"
                            placeholder="UTC"
                            defaultValue={typeof slackSettings.agendaTimezone === "string" ? slackSettings.agendaTimezone : "UTC"}
                          />
                        </label>
                        <button type="submit" className="secondary small">Save agenda posting</button>
                      </form>
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

      {tab === "agents" && (
        <AgentSettingsClient workspaceId={workspaceId} agents={agents} />
      )}
    </>
  );
}
