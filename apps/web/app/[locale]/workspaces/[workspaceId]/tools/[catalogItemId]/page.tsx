import Link from "next/link";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import {
  getCatalogItem,
  getAiWorkspaceSelectionState,
  getMeetingRecorderConfig,
  listAiWorkspaceToolProviders,
  listCommunicationInstallations,
  listDocuments,
  listExternalContentSources,
  listExternalMcpConnections,
  listInboundWebhooks,
  listMeetingTranscriptSourceState,
  listWebhookEndpoints,
  listWorkspaceEnterpriseServiceStates,
  requireWorkspaceMembership,
} from "@corgtex/domain";
import { env, prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { getFormatter } from "next-intl/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { normalizeSelectedProvider, normalizeSelectedService } from "../../settings/ai-workspace-ui";
import { connectorReadinessForItem } from "../catalog-ui";
import {
  AiWorkspaceConnectorPanel,
  CorgtexMcpConnectorPanel,
  DataSourcesConnectorPanel,
  MeetingRecorderConnectorPanel,
  OAuthConnectorPanel,
  SlackConnectorPanel,
  WebhooksConnectorPanel,
  integrationStatusMessage,
} from "../ConnectorSetupPanels";
import { requestManagedEnterpriseServiceAction } from "../../actions";
import { selectBoxExternalContentSourceAction, syncBoxExternalContentSourceAction } from "../actions";

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

function displayDateTime(value: Date | string | null | undefined) {
  if (!value) return "Not synced";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not synced";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

function ExternalConnectorReadinessPanel({ item, workspaceId, connection, sources = [], message }: {
  item: any;
  workspaceId: string;
  connection?: Awaited<ReturnType<typeof listExternalMcpConnections>>[number] | null;
  sources?: Awaited<ReturnType<typeof listExternalContentSources>>;
  message?: string | null;
}) {
  const readiness = connectorReadinessForItem(item);
  if (!readiness) return null;
  const isBox = readiness.key === "box";
  const boxConfigured = Boolean(process.env.BOX_CLIENT_ID && process.env.BOX_CLIENT_SECRET);
  const connected = connection?.status === "connected";
  const connectionId = connection?.connectionId ?? "";
  const returnTo = `/workspaces/${workspaceId}/tools/${item.id}`;
  const fieldStyle = { minWidth: 0, width: "100%" };

  return (
    <section className="nr-item stack" style={{ gap: 12, padding: 18 }}>
      <div className="row">
        <strong className="nr-item-title">{readiness.title} readiness</strong>
        {isBox && connected ? (
          <span className="tag success">Connected</span>
        ) : (
          <span className={`tag ${readiness.availability === "LIVE" ? "success" : "info"}`}>
            {displayEnum(readiness.availability)}
          </span>
        )}
      </div>
      {message && (
        <p className={`form-message ${message.includes("connected") ? "form-message-success" : "form-message-error"}`}>
          {message}
        </p>
      )}
      <p className="nr-item-meta" style={{ margin: 0 }}>
        {readiness.adminNotes}
      </p>
      {isBox && (
        <div className="actions-inline">
          {connected ? (
            <span className="nr-item-meta">
              {connection?.providerEmail ?? connection?.providerAccountId ?? "Box account"} · read/search/AI context enabled
            </span>
          ) : boxConfigured ? (
            <a href={`/api/integrations/box/connect?workspaceId=${workspaceId}&intent=external_mcp&returnTo=${encodeURIComponent(returnTo)}`} className="button secondary small">
              Connect Box
            </a>
          ) : (
            <span className="tag" style={{ border: "1px dashed var(--line)", background: "transparent" }}>Needs setup</span>
          )}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <p className="nr-item-meta" style={{ margin: 0 }}>
          <strong style={{ color: "var(--text)" }}>Who connects</strong><br />
          {readiness.connectedBy}
        </p>
        <p className="nr-item-meta" style={{ margin: 0 }}>
          <strong style={{ color: "var(--text)" }}>Access</strong><br />
          {readiness.supportedOperations.join(", ") || displayEnum(readiness.connectorRole)}
        </p>
        <p className="nr-item-meta" style={{ margin: 0 }}>
          <strong style={{ color: "var(--text)" }}>Storage</strong><br />
          {readiness.storagePolicy}
        </p>
      </div>
      {readiness.sourceUrl && (
        <a href={readiness.sourceUrl} target="_blank" rel="noreferrer">
          Provider documentation
        </a>
      )}
      {readiness.availability !== "LIVE" && !isBox && (
        <p className="nr-item-meta" style={{ margin: 0 }}>
          This provider is request-only in Corgtex. The catalog can track demand, but it should not present a one-click connection until admin enablement and OAuth setup are complete.
        </p>
      )}
      {isBox && (
        <p className="nr-item-meta" style={{ margin: 0 }}>
          Box remains the editing surface. Corgtex stores selected read-only snapshots, summaries, and citations for reliability; Box write operations stay disabled.
        </p>
      )}
      {isBox && connected && (
        <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 14, gap: 12 }}>
          <div className="row">
            <strong className="nr-item-title">Selected Box sources</strong>
            <span className="nr-item-meta">{sources.length} selected</span>
          </div>
          {sources.length === 0 ? (
            <p className="nr-item-meta" style={{ margin: 0 }}>
              No Box sources selected for Corgtex sync.
            </p>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {sources.map((source) => {
                const latestLog = source.syncLogs[0];
                const statusClass = source.status === "ACTIVE"
                  ? "success"
                  : source.status === "ERROR"
                    ? "error"
                    : "info";
                return (
                  <div key={source.id} className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 10, gap: 8 }}>
                    <div className="row">
                      <div>
                        <strong>{source.title}</strong>
                        <p className="nr-item-meta" style={{ margin: "4px 0 0", wordBreak: "break-word" }}>
                          {displayEnum(source.sourceKind)} · {source.externalId}
                        </p>
                      </div>
                      <span className={`tag ${statusClass}`}>{displayEnum(source.status)}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
                      <p className="nr-item-meta" style={{ margin: 0 }} suppressHydrationWarning>
                        <strong style={{ color: "var(--text)" }}>Last sync</strong><br />
                        {displayDateTime(source.lastSyncedAt)}
                      </p>
                      <p className="nr-item-meta" style={{ margin: 0 }}>
                        <strong style={{ color: "var(--text)" }}>Remote version</strong><br />
                        {source.lastRemoteVersion ?? latestLog?.remoteVersion ?? "Not captured"}
                      </p>
                      <p className="nr-item-meta" style={{ margin: 0 }}>
                        <strong style={{ color: "var(--text)" }}>Chunks</strong><br />
                        {latestLog?.chunksCreated ?? 0}
                      </p>
                    </div>
                    {source.lastSyncError && (
                      <p className="form-message form-message-error" style={{ margin: 0 }}>
                        {source.lastSyncError}
                      </p>
                    )}
                    <div className="actions-inline">
                      <form action={syncBoxExternalContentSourceAction}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="catalogItemId" value={item.id} />
                        <input type="hidden" name="sourceId" value={source.id} />
                        <button type="submit" className="button secondary small">
                          Sync now
                        </button>
                      </form>
                      {source.externalUrl && (
                        <a href={source.externalUrl} target="_blank" rel="noreferrer" className="button secondary small">
                          Open in Box
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <form action={selectBoxExternalContentSourceAction} className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 12, gap: 10 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="catalogItemId" value={item.id} />
            <input type="hidden" name="connectionId" value={connectionId} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              <label className="stack" style={{ gap: 4 }}>
                <span className="nr-item-meta">Source</span>
                <select name="sourceKind" defaultValue="HUB" style={fieldStyle}>
                  <option value="HUB">Hub</option>
                  <option value="FOLDER">Folder</option>
                  <option value="FILE">File</option>
                </select>
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="nr-item-meta">Box ID</span>
                <input name="externalId" required placeholder="123456789" style={fieldStyle} />
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="nr-item-meta">Title</span>
                <input name="title" placeholder="Client knowledge hub" style={fieldStyle} />
              </label>
            </div>
            <label className="stack" style={{ gap: 4 }}>
              <span className="nr-item-meta">Box URL</span>
              <input name="externalUrl" placeholder="https://app.box.com/..." style={fieldStyle} />
            </label>
            <div className="actions-inline">
              <button type="submit" className="button secondary small">
                Add selected source
              </button>
              <span className="nr-item-meta">Selected sources sync snapshots only; Corgtex does not crawl all Box content.</span>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

export default async function CatalogItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; catalogItemId: string }>;
  searchParams?: Promise<{
    integration?: string;
    integrationStatus?: string;
    integrationError?: string;
    integrationSuccess?: string;
    intent?: string;
    provider?: string | string[];
    service?: string | string[];
  }>;
}) {
  const { workspaceId, catalogItemId } = await params;
  const search = await searchParams;
  const actor = await requirePageActor();
  const membership = await requireWorkspaceMembership({ actor, workspaceId });
  await requireWorkspaceFeature(workspaceId, "TOOL_LINKS");
  const [detail, featureFlags, format, headersList] = await Promise.all([
    getCatalogItem(actor, { workspaceId, catalogItemId }),
    getWorkspaceFeatureFlags(workspaceId),
    getFormatter(),
    headers(),
  ]);
  const { item, usage, requests } = detail;
  const isWorkspaceAdmin = membership?.role === "ADMIN";
  const host = headersList.get("host") || "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const connectorUrl = env.MCP_PUBLIC_URL ?? `${origin}/mcp`;
  const integrationMessage = integrationStatusMessage({
    provider: search?.integration,
    status: search?.integrationStatus,
    error: search?.integrationError,
    success: search?.integrationSuccess,
    intent: search?.intent,
  });

  let setupPanel: ReactNode = null;

  if (item.sourceType === "OAUTH_CONNECTION" && actor.kind === "user") {
    const provider = item.sourceId === "microsoft" ? "microsoft" : "google";
    const providerEnum = provider === "microsoft" ? "MICROSOFT" : "GOOGLE";
    const connection = await prisma.oAuthConnection.findFirst({
      where: {
        userId: actor.user.id,
        provider: providerEnum,
        status: { not: "DISCONNECTED" },
        OR: [
          { workspaceId },
          { workspaceId: null },
        ],
      },
      orderBy: { updatedAt: "desc" },
    });
    setupPanel = (
      <OAuthConnectorPanel
        provider={provider}
        title={provider === "microsoft" ? "Microsoft" : "Google"}
        configured={provider === "microsoft"
          ? Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET)
          : Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
        connection={connection ?? undefined}
        workspaceId={workspaceId}
        format={format}
        message={integrationMessage}
        autoOpenDrivePicker={search?.integrationStatus === "success" && search?.integration === "google" && search?.intent === "documents"}
      />
    );
  } else if (item.sourceType === "COMMUNICATION_INSTALLATION" && item.sourceId === "slack") {
    const communicationInstallations = isWorkspaceAdmin
      ? await listCommunicationInstallations(actor, workspaceId).catch(() => [])
      : [];
    const slackInstallation = communicationInstallations.find((installation) => installation.provider === "SLACK" && installation.status === "ACTIVE");
    setupPanel = <SlackConnectorPanel workspaceId={workspaceId} installation={slackInstallation} canManage={isWorkspaceAdmin} />;
  } else if (item.sourceType === "MCP_CONNECTOR" && item.sourceId === "corgtex-mcp") {
    setupPanel = <CorgtexMcpConnectorPanel connectorUrl={connectorUrl} />;
  } else if (item.sourceType === "MCP_CONNECTOR") {
    let connections: Awaited<ReturnType<typeof listExternalMcpConnections>> = [];
    let sources: Awaited<ReturnType<typeof listExternalContentSources>> = [];
    if (actor.kind === "user") {
      [connections, sources] = await Promise.all([
        listExternalMcpConnections(actor, workspaceId).catch(() => []),
        item.sourceId === "box" ? listExternalContentSources(actor, { workspaceId, providerKey: "box" }).catch(() => []) : Promise.resolve([]),
      ]);
    }
    const connection = connections.find((entry) => entry.providerKey === item.sourceId) ?? null;
    setupPanel = <ExternalConnectorReadinessPanel item={item} workspaceId={workspaceId} connection={connection} sources={sources} message={integrationMessage} />;
  } else if (item.sourceType === "MEETING_RECORDER") {
    const transcriptSourcesEnabled = featureFlags.MEETING_TRANSCRIPT_SOURCES || featureFlags.MEETING_RECORDERS;
    const [recorderConfig, transcriptSources] = transcriptSourcesEnabled
      ? await Promise.all([
        featureFlags.MEETING_RECORDERS ? getMeetingRecorderConfig(actor, workspaceId).catch(() => null) : Promise.resolve(null),
        listMeetingTranscriptSourceState(actor, workspaceId).catch(() => null),
      ])
      : [null, null] as const;
    setupPanel = (
      <MeetingRecorderConnectorPanel
        workspaceId={workspaceId}
        origin={origin}
        config={recorderConfig}
        sources={transcriptSources}
        format={format}
      />
    );
  } else if (item.sourceType === "DATA_SOURCE") {
    const [dataSources, documents] = await Promise.all([
      prisma.externalDataSource.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
      }).catch(() => []),
      listDocuments(workspaceId).catch(() => []),
    ]);
    setupPanel = <DataSourcesConnectorPanel workspaceId={workspaceId} dataSources={dataSources} documents={documents} />;
  } else if (item.sourceType === "MANUAL" && item.sourceId === "webhooks") {
    const [webhookEndpoints, inboundWebhooks] = await Promise.all([
      listWebhookEndpoints(actor, workspaceId).catch(() => []),
      listInboundWebhooks(actor, workspaceId, { take: 20 }).catch(() => []),
    ]);
    setupPanel = (
      <WebhooksConnectorPanel
        workspaceId={workspaceId}
        webhookEndpoints={webhookEndpoints}
        inboundWebhooks={inboundWebhooks}
        format={format}
      />
    );
  } else if (item.sourceType === "AI_WORKSPACE" && featureFlags.AI_WORKSPACES) {
    const providers = listAiWorkspaceToolProviders().map((provider) => ({
      ...provider,
      capabilities: [...provider.capabilities],
      supportedOwnershipModes: [...provider.supportedOwnershipModes],
      setupVariants: provider.setupVariants.map((variant) => ({
        ...variant,
        manualSteps: [...variant.manualSteps],
        limitations: [...variant.limitations],
      })),
    }));
    const aiWorkspaceSelection = await getAiWorkspaceSelectionState(actor, workspaceId).catch(() => ({ activeProviderKey: null, providers: [], connections: [] }));
    setupPanel = (
      <AiWorkspaceConnectorPanel
        connectorUrl={connectorUrl}
        origin={origin}
        providers={providers}
        enterpriseServices={[]}
        managedServicesEnabled={false}
        canRequestManagedServices={false}
        requestManagedServiceAction={requestManagedEnterpriseServiceAction}
        workspaceId={workspaceId}
        selectedProviderKey={normalizeSelectedProvider(item.sourceId ?? search?.provider, providers) ?? aiWorkspaceSelection.activeProviderKey}
        selectedServiceKey={null}
      />
    );
  } else if (item.sourceType === "ENTERPRISE_SERVICE" && featureFlags.AI_WORKSPACES && featureFlags.MANAGED_ENTERPRISE_SERVICES) {
    const [providers, enterpriseServices, aiWorkspaceSelection] = await Promise.all([
      Promise.resolve(listAiWorkspaceToolProviders().map((provider) => ({
        ...provider,
        capabilities: [...provider.capabilities],
        supportedOwnershipModes: [...provider.supportedOwnershipModes],
        setupVariants: provider.setupVariants.map((variant) => ({
          ...variant,
          manualSteps: [...variant.manualSteps],
          limitations: [...variant.limitations],
        })),
      }))),
      listWorkspaceEnterpriseServiceStates(actor, workspaceId).then((services) => services.map((service) => ({
        key: service.key,
        label: service.label,
        outcome: service.outcome,
        description: service.description,
        defaultOwnershipMode: service.defaultOwnershipMode,
        persistedId: service.persistedId,
        ownershipMode: service.ownershipMode,
        healthStatus: service.healthStatus,
        providerKey: service.providerKey,
        lastHealthCheckAt: service.lastHealthCheckAt?.toISOString() ?? null,
        lastSuccessfulHealthCheckAt: service.lastSuccessfulHealthCheckAt?.toISOString() ?? null,
        lastSuccessfulSyncAt: service.lastSuccessfulSyncAt?.toISOString() ?? null,
        lastError: service.lastError,
        usageLabel: service.usageLabel,
        usageDetail: service.usageDetail,
        supportEscalationStatus: service.supportEscalationStatus,
        supportEscalatedAt: service.supportEscalatedAt?.toISOString() ?? null,
        supportNotesMd: service.supportNotesMd,
        readinessChecks: service.readinessChecks,
      }))),
      getAiWorkspaceSelectionState(actor, workspaceId).catch(() => ({ activeProviderKey: null, providers: [], connections: [] })),
    ]);
    setupPanel = (
      <AiWorkspaceConnectorPanel
        connectorUrl={connectorUrl}
        origin={origin}
        providers={providers}
        enterpriseServices={enterpriseServices}
        managedServicesEnabled={featureFlags.MANAGED_ENTERPRISE_SERVICES}
        canRequestManagedServices={isWorkspaceAdmin}
        requestManagedServiceAction={requestManagedEnterpriseServiceAction}
        workspaceId={workspaceId}
        selectedProviderKey={normalizeSelectedProvider(search?.provider, providers) ?? aiWorkspaceSelection.activeProviderKey}
        selectedServiceKey={normalizeSelectedService(item.sourceId ?? search?.service, enterpriseServices)}
      />
    );
  }

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
          {setupPanel}
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
                {item.requestedScopes.map((scope: string) => (
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
                {requests.map((request: { id: string; type: string; status: string; reasonMd: string; requester: { displayName: string | null; email: string } | null }) => (
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
