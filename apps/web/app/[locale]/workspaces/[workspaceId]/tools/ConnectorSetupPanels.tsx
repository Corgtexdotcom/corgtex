import type { getFormatter } from "next-intl/server";
import { CorgtexConnectorManager } from "../settings/CorgtexConnectorManager";
import { DataSourcesManager } from "../settings/DataSourcesManager";
import { AiWorkspaceManager } from "../settings/AiWorkspaceManager";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";
import { GoogleDrivePicker } from "./GoogleDrivePicker";
import {
  connectMeetingTranscriptSourceAction,
  createWebhookEndpointAction,
  deleteOAuthConnectionAction,
  deleteWebhookEndpointAction,
  disconnectCommunicationInstallationAction,
  requestManagedEnterpriseServiceAction,
  retryMeetingTranscriptImportBatchAction,
  rotateWebhookSecretAction,
  runMeetingTranscriptSourceBackfillAction,
  runOAuthConnectionSyncAction,
  updateMeetingRecorderConfigAction,
  updateSlackAgendaSettingsAction,
  updateWebhookEndpointAction,
} from "../actions";

type Formatter = Awaited<ReturnType<typeof getFormatter>>;

type OAuthConnection = {
  id: string;
  providerAccountId: string;
  providerEmail: string | null;
  scopes: string[];
  status: string;
  syncSettings: unknown;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
};

type GooglePickerConfig = {
  clientId: string | null;
  developerKey: string | null;
  appId: string | null;
};

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
  intent?: string;
}) {
  if (!params.provider || !params.status) return null;
  if (params.status === "success") {
    if (params.success === "google_connected" && params.intent === "documents") return "Google Drive connected. Choose the files you want to sync.";
    if (params.success === "google_connected") return "Google Calendar connected. Calendar sync is queued.";
    if (params.success === "microsoft_connected") return "Microsoft Calendar connected. Calendar sync is queued.";
    if (params.success === "box_connected") return "Box connected. Corgtex can now save Box file references and summaries.";
    return "Integration connected.";
  }

  const messages: Record<string, string> = {
    google_not_configured: "Google is not configured in Corgtex yet. Add the Google OAuth client ID/secret and redirect URI before retrying.",
    microsoft_not_configured: "Microsoft is not configured in Corgtex yet. Add the Entra OAuth client ID/secret and redirect URI before retrying.",
    box_not_configured: "Box is not configured in Corgtex yet. Add the Box OAuth client ID/secret and redirect URI before retrying.",
    box_workspace_required: "Box must be connected from a workspace tool page.",
    box_access_denied: "Box access was denied before Corgtex received permission.",
    box_invalid_client: "Box rejected the OAuth client credentials. Check the Box Integration Credentials client ID and secret.",
    box_token_exchange_failed: "Box returned an error while exchanging the authorization code. Check the Box redirect URI and client secret.",
    box_profile_failed: "Box connected but Corgtex could not read the signed-in Box profile.",
    google_verification_or_tester_required: "Google blocked Calendar because this app is still in testing or not verified for this account. Add this email as an approved test user, or complete Google verification. Drive file picking can still work after Drive access is connected.",
    microsoft_tenant_access_denied: "Microsoft blocked this account for the selected tenant. Use an account in the app tenant, add the account as an external user, or switch the Entra app to the intended multitenant audience.",
    microsoft_admin_consent_required: "Microsoft requires tenant admin consent for this account or organization before Corgtex can connect.",
    microsoft_access_denied: "Microsoft access was denied before Corgtex received permission.",
    microsoft_invalid_client_secret: "Microsoft rejected the client secret. In Entra, create and copy the client secret Value, not the Secret ID, then update the production secret before retrying.",
    oauth_state_invalid: "The OAuth session expired or did not match this browser session. Start the connection again from this tool page.",
    oauth_code_missing: "The provider did not return an authorization code. Start the connection again from this tool page.",
    google_token_exchange_failed: "Google returned an error while exchanging the authorization code. Check the OAuth client secret and redirect URI.",
    microsoft_token_exchange_failed: "Microsoft returned an error while exchanging the authorization code. Check the client secret, redirect URI, and tenant consent.",
    google_profile_failed: "Google connected but Corgtex could not read the signed-in profile. Check the granted OpenID/profile scopes.",
    microsoft_profile_failed: "Microsoft connected but Corgtex could not read the User.Read profile.",
    google_unexpected_error: "Google connection failed inside Corgtex. Retry once; if it repeats, check server logs for the OAuth callback.",
    microsoft_unexpected_error: "Microsoft connection failed inside Corgtex. Retry once; if it repeats, check server logs for the OAuth callback.",
    box_unexpected_error: "Box connection failed inside Corgtex. Retry once; if it repeats, check server logs for the OAuth callback.",
  };
  return messages[params.error ?? ""] ?? "The integration could not be connected. Retry from this tool page.";
}

function hasProviderCalendarScope(provider: "google" | "microsoft", scopes: string) {
  return provider === "google"
    ? scopes.includes("https://www.googleapis.com/auth/calendar.readonly")
    : scopes.includes("calendars.read");
}

function hasProviderDocumentScope(provider: "google" | "microsoft", scopes: string) {
  return provider === "google"
    ? scopes.includes("drive.file") || scopes.includes("drive.readonly")
    : scopes.includes("files.read") || scopes.includes("sites.read");
}

function OAuthConnectionControls({ connection, provider, workspaceId, format, googlePickerConfig, autoOpenDrivePicker = false }: {
  connection: OAuthConnection;
  provider: "google" | "microsoft";
  workspaceId: string;
  format: Formatter;
  googlePickerConfig?: GooglePickerConfig;
  autoOpenDrivePicker?: boolean;
}) {
  const calendar = settingsSection(connection.syncSettings, "calendar");
  const documents = settingsSection(connection.syncSettings, "documents");
  const scopes = connection.scopes.join(" ").toLowerCase();
  const hasCalendarScope = hasProviderCalendarScope(provider, scopes);
  const hasDocumentScope = hasProviderDocumentScope(provider, scopes);
  const calendarConnected = hasCalendarScope && calendar.enabled !== false;
  const selectedDriveIds = settingsStringList(documents.selectedDriveIds ?? documents.selectedDocumentIds);

  return (
    <div key={connection.id} className="stack" style={{ gap: 12, marginTop: 8 }}>
      <div className="row" style={{ alignItems: "center" }}>
        <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
          {connection.providerEmail ?? connection.providerAccountId} · {connection.status.toLowerCase()}
          {connection.lastSyncAt ? ` · Last synced ${format.dateTime(connection.lastSyncAt, { dateStyle: "medium", timeStyle: "short" })}` : " · Not synced yet"}
        </span>
      </div>
      {connection.lastSyncError && (
        <p className="form-message form-message-error" style={{ marginTop: 8 }}>{connection.lastSyncError}</p>
      )}

      <section className="nr-item stack" style={{ gap: 8, padding: 12 }}>
        <div className="row">
          <div>
            <strong className="nr-item-title" style={{ fontSize: "0.95rem" }}>Calendar</strong>
            <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: "4px 0 0" }}>
              Read-only calendar context for meetings.
            </p>
          </div>
          <span className="tag" style={{ background: calendarConnected ? "var(--accent-soft)" : "transparent" }}>
            {calendarConnected ? "Connected" : "Not connected"}
          </span>
        </div>
        <div className="actions-inline">
          {calendarConnected ? (
            <form action={runOAuthConnectionSyncAction} className="actions-inline">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="connectionId" value={connection.id} />
              <input type="hidden" name="syncKind" value="calendar" />
              <button type="submit" className="button secondary small" disabled={connection.status !== "ACTIVE"}>
                Sync calendar now
              </button>
            </form>
          ) : provider === "google" ? (
            <a href={`/api/integrations/google/connect?workspaceId=${workspaceId}`} className="button secondary small">
              Connect Calendar
            </a>
          ) : (
            <a href={`/api/integrations/microsoft/connect?workspaceId=${workspaceId}`} className="button secondary small">
              Connect Calendar
            </a>
          )}
        </div>
      </section>

      {provider === "google" ? (
        <section className="nr-item stack" style={{ gap: 8, padding: 12 }}>
          <div className="row">
            <div>
              <strong className="nr-item-title" style={{ fontSize: "0.95rem" }}>Drive files</strong>
              <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: "4px 0 0" }}>
                Pick only the Docs, Sheets, or Slides Corgtex should sync.
              </p>
            </div>
            <span className="tag" style={{ background: hasDocumentScope ? "var(--accent-soft)" : "transparent" }}>
              {hasDocumentScope ? "Connected" : "Not connected"}
            </span>
          </div>
          {!hasDocumentScope ? (
            <a href={`/api/integrations/google/connect?workspaceId=${workspaceId}&intent=documents`} className="button secondary small">
              Choose Drive files
            </a>
          ) : googlePickerConfig ? (
            <GoogleDrivePicker
              workspaceId={workspaceId}
              clientId={googlePickerConfig.clientId}
              developerKey={googlePickerConfig.developerKey}
              appId={googlePickerConfig.appId}
              initialSelectedIds={selectedDriveIds}
              autoOpen={autoOpenDrivePicker}
            />
          ) : (
            <p className="form-message form-message-error">Google Picker is missing public configuration.</p>
          )}
        </section>
      ) : null}

      <form action={deleteOAuthConnectionAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="connectionId" value={connection.id} />
        <button type="submit" className="button ghost small">Disconnect {provider === "google" ? "Google" : "Microsoft"}</button>
      </form>
    </div>
  );
}

export function OAuthConnectorPanel({ provider, title, configured, connection, workspaceId, format, message, autoOpenDrivePicker = false }: {
  provider: "google" | "microsoft";
  title: string;
  configured: boolean;
  connection?: OAuthConnection;
  workspaceId: string;
  format: Formatter;
  message?: string | null;
  autoOpenDrivePicker?: boolean;
}) {
  const googlePickerConfig = provider === "google"
    ? {
      clientId: process.env.GOOGLE_CLIENT_ID ?? null,
      developerKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
      appId: process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? null,
    }
    : undefined;
  const setupNote = provider === "google"
    ? "Hidden beta requires the signed-in email to be added as a Google test user until Google verification is complete."
    : "External client tenants may need publisher verification or admin consent before Microsoft will allow access.";
  return (
    <section className="nr-item stack" style={{ gap: 12, padding: 18 }}>
      <div className="row">
        <strong className="nr-item-title">{title}</strong>
        {connection ? (
          <span className="tag" style={{ background: connection.status === "ACTIVE" ? "var(--accent-soft)" : "transparent" }}>
            {connection.status === "ACTIVE" ? "Connected" : connection.status}
          </span>
        ) : configured && provider === "google" ? (
          <div className="actions-inline">
            <a href={`/api/integrations/google/connect?workspaceId=${workspaceId}`} className="button secondary small">
              Connect Calendar
            </a>
            <a href={`/api/integrations/google/connect?workspaceId=${workspaceId}&intent=documents`} className="button secondary small">
              Connect Drive files
            </a>
          </div>
        ) : configured ? (
          <a href={`/api/integrations/${provider}/connect?workspaceId=${workspaceId}`} className="button secondary small">
            Connect {provider === "google" ? "Google" : "Microsoft"}
          </a>
        ) : (
          <span className="tag" style={{ border: "1px dashed var(--line)", background: "transparent" }}>Needs setup</span>
        )}
      </div>
      {message && (
        <p className={`form-message ${message.includes("connected") ? "form-message-success" : "form-message-error"}`}>
          {message}
        </p>
      )}
      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
        Calendar sync is read-only by default. Documents and email remain opt-in and source-filtered before ingestion.
      </p>
      <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
        {configured ? setupNote : "Corgtex OAuth credentials are missing in this environment."}
      </p>
      {connection ? (
        <OAuthConnectionControls
          connection={connection}
          provider={provider}
          workspaceId={workspaceId}
          format={format}
          googlePickerConfig={googlePickerConfig}
          autoOpenDrivePicker={autoOpenDrivePicker}
        />
      ) : null}
    </section>
  );
}

export function SlackConnectorPanel({ workspaceId, installation, canManage = true }: {
  workspaceId: string;
  installation?: any;
  canManage?: boolean;
}) {
  const slackSettings = installation?.settings && typeof installation.settings === "object" && !Array.isArray(installation.settings)
    ? installation.settings as Record<string, unknown>
    : {};
  return (
    <section className="nr-item stack" style={{ gap: 12, padding: 18 }}>
      <div className="row">
        <strong className="nr-item-title">Slack workspace</strong>
        {installation ? (
          <span className="tag" style={{ background: "var(--accent-soft)" }}>Connected</span>
        ) : !canManage ? (
          <span className="tag" style={{ border: "1px dashed var(--line)", background: "transparent" }}>Admin setup required</span>
        ) : (
          <a href={`/api/integrations/slack/install?workspaceId=${workspaceId}`} className="button secondary small">Connect Slack</a>
        )}
      </div>
      {installation ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
            {installation.externalTeamName || installation.externalWorkspaceId} · {installation._count.channels} channels · {installation._count.messages} captured messages
          </p>
          <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
            Public-channel messages are archived for aggregate briefings, work capture, and long-term context. Private channels and DMs are not ingested.
          </p>
          <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
            Granted scopes: {installation.scopes.length > 0 ? installation.scopes.join(", ") : "none recorded"}
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
            <input type="hidden" name="installationId" value={installation.id} />
            <button type="submit" className="danger small">Disconnect Slack</button>
          </form>
        </div>
      ) : !canManage ? (
        <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
          A workspace admin must connect Slack before public-channel context can feed Corgtex.
        </p>
      ) : (
        <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
          Slack can feed the daily Corgtex newspaper, App Home brief, commands, and message captures. Private channels and DMs are not ingested in the MVP.
        </p>
      )}
    </section>
  );
}

export function MeetingRecorderConnectorPanel({ workspaceId, origin, config, sources, format }: {
  workspaceId: string;
  origin: string;
  config: any;
  sources: any;
  format: Formatter;
}) {
  if (!config && !sources) {
    return (
      <section className="nr-item" style={{ padding: 18 }}>
        <p className="nr-item-meta" style={{ margin: 0 }}>Meeting transcript import is not enabled for this workspace yet.</p>
      </section>
    );
  }

  const providerOrder = ["READ_AI", "FATHOM", "FIREFLIES", "MANUAL_UPLOAD"];
  const v1Catalog = sources?.catalog
    ? sources.catalog
      .filter((entry: any) => providerOrder.includes(entry.provider))
      .sort((left: any, right: any) => providerOrder.indexOf(left.provider) - providerOrder.indexOf(right.provider))
    : [];
  const v1Connections = sources?.connections?.filter((connection: any) => providerOrder.includes(connection.provider)) ?? [];

  return (
    <section className="nr-item stack" style={{ gap: 16, padding: 18 }}>
      {sources ? (
        <div className="stack" style={{ gap: 12, padding: "12px 0" }}>
          <div className="row">
            <strong className="nr-item-title">Meeting transcript imports</strong>
            <span className="tag" style={{ background: v1Connections.length > 0 ? "var(--accent-soft)" : "transparent" }}>
              {v1Connections.length > 0 ? `${v1Connections.length} connected` : "Ready"}
            </span>
          </div>
          <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
            Bring in transcripts from the recorder your team already uses. Read.ai supports signed webhooks and manual exports in V1; Fathom and Fireflies support API-key backfill plus future-sync webhooks.
          </p>
          <details open>
            <summary className="nr-hide-marker settings-disclosure-summary" style={{ color: "var(--accent)", cursor: "pointer", marginTop: 8 }}>
              Connect providers or upload exports
            </summary>
            <div className="stack" style={{ gap: 20, marginTop: 12 }}>
              {v1Catalog.map((entry: any) => {
                const connection = sources.connections.find((item: any) => item.provider === entry.provider);
                const webhookUrl = `${origin}/api/integrations/meeting-transcripts/${entry.slug}/webhook?workspaceId=${workspaceId}`;
                const isManualUpload = entry.provider === "MANUAL_UPLOAD";
                const supportsProviderBackfill = entry.provider === "FATHOM" || entry.provider === "FIREFLIES";
                return (
                  <div key={entry.provider} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                    <div className="row">
                      <strong className="nr-item-title">{entry.label}</strong>
                      <span className="tag" style={{ background: connection?.status === "ACTIVE" ? "var(--accent-soft)" : "transparent" }}>
                        {connection?.status === "ACTIVE" ? "Connected" : isManualUpload ? "Upload" : entry.connectionStatus}
                      </span>
                    </div>
                    <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: "6px 0" }}>
                      {entry.firstPath}
                    </p>
                    <div className="stack" style={{ gap: 8 }}>
                      {!isManualUpload ? (
                        <form action={connectMeetingTranscriptSourceAction} className="stack nr-form-section">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="provider" value={entry.slug} />
                          <input type="hidden" name="webhookUrl" value={webhookUrl} />
                          {entry.provider !== "READ_AI" ? (
                            <label style={{ fontSize: "0.85rem" }}>
                              API key
                              <input name="apiKey" type="password" autoComplete="off" placeholder={connection?.hasApiKey ? "Stored" : "Provider API key"} />
                            </label>
                          ) : null}
                          <label style={{ fontSize: "0.85rem" }}>
                            Webhook secret
                            <input
                              name="webhookSecret"
                              type="password"
                              autoComplete="off"
                              placeholder={connection?.hasWebhookSecret ? "Stored" : entry.provider === "FATHOM" ? "Created automatically from API key" : "Provider webhook secret"}
                            />
                          </label>
                          <p className="nr-item-meta" style={{ fontSize: "0.78rem", margin: 0, wordBreak: "break-all" }}>
                            Webhook URL: {webhookUrl}
                          </p>
                          <div className="actions-inline">
                            <button type="submit" className="secondary small">
                              {entry.provider === "FATHOM" ? "Save and create webhook" : "Save connection"}
                            </button>
                          </div>
                        </form>
                      ) : null}
                      <form
                        action={`/api/workspaces/${workspaceId}/meeting-transcript-sources/${entry.slug}/import`}
                        method="post"
                        encType="multipart/form-data"
                        className="stack nr-form-section"
                      >
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="provider" value={entry.slug} />
                        <input type="hidden" name="sourceKind" value="tools-upload" />
                        <input type="hidden" name="redirectTo" value={`/workspaces/${workspaceId}/tools?type=TOOL&q=meeting%20transcripts`} />
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
                        <TimeZoneSelect />
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
                      {supportsProviderBackfill && connection?.hasApiKey ? (
                        <form action={runMeetingTranscriptSourceBackfillAction}>
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="provider" value={entry.slug} />
                          <button type="submit" className="ghost small">Backfill recent meetings</button>
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
          {sources.batches.length > 0 && (
            <div className="stack" style={{ gap: 8, marginTop: 14 }}>
              <strong className="nr-item-title">Recent import batches</strong>
              {sources.batches.slice(0, 5).map((batch: any) => (
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
          {sources.records.length > 0 && (
            <div className="stack" style={{ gap: 6, marginTop: 14 }}>
              <strong className="nr-item-title">Latest source records</strong>
              {sources.records.slice(0, 6).map((record: any) => (
                <div key={record.id} className="nr-item-meta" style={{ fontSize: "0.82rem" }} suppressHydrationWarning>
                  {record.provider} · {record.status} · {record.title || record.externalId} · {format.dateTime(new Date(record.recordedAt), { dateStyle: "medium" })}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {config ? (
        <details>
          <summary className="nr-hide-marker settings-disclosure-summary" style={{ color: "var(--accent)", cursor: "pointer" }}>
            Corgtex-managed recorder
          </summary>
          <div style={{ marginTop: 12 }}>
            <div className="row">
              <strong className="nr-item-title">Corgtex meeting recorder</strong>
              <span className="tag" style={{ background: config.config.enabled ? "var(--accent-soft)" : "transparent" }}>
                {config.config.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <p className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 8 }}>
              Uses Corgtex-managed Recall.ai and Meeting BaaS accounts. Calendar connections stay in Corgtex; vendor keys are never shown to customers.
            </p>
            <form action={updateMeetingRecorderConfigAction} className="stack" style={{ gap: 8, paddingTop: 8 }}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <label style={{ fontSize: "0.85rem" }}>
                Recorder
                <select name="enabled" defaultValue={config.config.enabled ? "true" : "false"}>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <label style={{ fontSize: "0.85rem" }}>
                Automatic calendar recording
                <select name="autoRecordEnabled" defaultValue={config.config.autoRecordEnabled ? "true" : "false"}>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <div className="actions-inline">
                <label style={{ flex: 1, fontSize: "0.85rem" }}>
                  Default provider
                  <select name="defaultProvider" defaultValue={config.config.defaultProvider}>
                    <option value="RECALL_AI">Recall.ai</option>
                    <option value="MEETING_BAAS">Meeting BaaS</option>
                  </select>
                </label>
                <label style={{ flex: 1, fontSize: "0.85rem" }}>
                  Fallback provider
                  <select name="fallbackProvider" defaultValue={config.config.fallbackProvider ?? ""}>
                    <option value="">None</option>
                    <option value="RECALL_AI">Recall.ai</option>
                    <option value="MEETING_BAAS">Meeting BaaS</option>
                  </select>
                </label>
              </div>
              <label style={{ fontSize: "0.85rem" }}>
                Bot name
                <input name="botName" defaultValue={config.config.botName} />
              </label>
              <label style={{ fontSize: "0.85rem" }}>
                Entry message
                <textarea name="entryMessage" defaultValue={config.config.entryMessage ?? ""} rows={3} />
              </label>
              <label style={{ fontSize: "0.85rem" }}>
                Monthly minute cap
                <input name="monthlyMinuteCap" type="number" min="0" defaultValue={config.config.monthlyMinuteCap} />
              </label>
              <p className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                Used this month: {config.usage.usedMinutes} minutes.
              </p>
              <button type="submit" className="secondary small">Save recorder settings</button>
            </form>
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function DataSourcesConnectorPanel({ workspaceId, dataSources, documents }: {
  workspaceId: string;
  dataSources: any[];
  documents: any[];
}) {
  return <DataSourcesManager workspaceId={workspaceId} dataSources={dataSources} documents={documents} />;
}

export function WebhooksConnectorPanel({ workspaceId, webhookEndpoints, inboundWebhooks, format }: {
  workspaceId: string;
  webhookEndpoints: any[];
  inboundWebhooks: any[];
  format: Formatter;
}) {
  return (
    <section className="stack" style={{ gap: 32 }}>
      <section>
        <h2 className="nr-section-header">Outbound webhooks</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Send signed workspace events to external systems from Tools.
        </p>

        <details>
          <summary className="nr-hide-marker nr-section-header" style={{ borderTop: "none", display: "inline-block", padding: 0, margin: 0, cursor: "pointer", color: "var(--accent)" }}>Add webhook</summary>
          <form action={createWebhookEndpointAction} className="stack nr-form-section" style={{ marginTop: 8 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label>
                Webhook URL
                <input name="url" type="url" required placeholder="https://example.com/webhook" />
              </label>
              <label>
                Label
                <input name="label" placeholder="Ops receiver" />
              </label>
            </div>
            <label>
              Event types
              <input name="eventTypes" placeholder="action.created,proposal.submitted" />
            </label>
            <button type="submit" className="small">Add webhook</button>
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
                  border: ep.status !== "ACTIVE" ? "1px dashed var(--muted)" : "inherit",
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
                Created on {format.dateTime(new Date(ep.createdAt))}
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
                  <button type="submit" className="secondary small">Rotate secret</button>
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

      <section>
        <h2 className="nr-section-header">Inbound webhook events</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Inbound events arrive at <code style={{ fontSize: "0.8rem", background: "transparent", border: "1px dashed var(--line)" }}>/api/webhooks/{workspaceId}/ingest?source=slack|calendar|generic</code>
        </p>
        <div>
          {inboundWebhooks.length === 0 && (
            <p className="nr-item-meta">No inbound webhook events yet.</p>
          )}
          {inboundWebhooks.map((wh) => (
            <div className="nr-item" key={wh.id} style={{ padding: "12px 0" }}>
              <div className="row">
                <span className="tag">{wh.source}</span>
                <span className="nr-item-meta" style={{ fontSize: "0.82rem" }} suppressHydrationWarning>
                  {format.dateTime(new Date(wh.createdAt), { dateStyle: "short", timeStyle: "short" })}
                </span>
                {wh.processedAt ? (
                  <span style={{ color: "var(--accent)", fontSize: "0.82rem" }}>Processed</span>
                ) : wh.error ? (
                  <span style={{ color: "var(--danger)", fontSize: "0.82rem" }}>Error</span>
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
                <div style={{ color: "var(--danger)", fontSize: "0.82rem", marginTop: 4 }}>
                  {wh.error}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

export function CorgtexMcpConnectorPanel({ connectorUrl, workspaceId }: {
  connectorUrl: string;
  workspaceId?: string;
}) {
  return (
    <section className="stack" style={{ gap: 16 }}>
      <CorgtexConnectorManager connectorUrl={connectorUrl} workspaceId={workspaceId} />
    </section>
  );
}

export function AiWorkspaceConnectorPanel(props: Parameters<typeof AiWorkspaceManager>[0]) {
  return <AiWorkspaceManager {...props} />;
}

export { integrationStatusMessage };
