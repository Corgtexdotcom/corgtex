"use client";

import { useMemo, useState } from "react";

import {
  buildAiWorkspaceSetupCards,
  capabilityLabel,
  enterpriseServiceHealthLabel,
  enterpriseServiceHealthTone,
  enterpriseServiceOwnershipLabel,
  enterpriseServiceProviderLabel,
  formatServiceTimestamp,
  groupAiWorkspaceProviders,
  type AiWorkspaceProviderView,
  type AiWorkspaceSetupAction,
  type EnterpriseServiceHealthTone,
  type EnterpriseServiceView,
} from "./ai-workspace-ui";

type ActionStatus = {
  key: string;
  message: string;
  tone: "success" | "warning";
  manualValue?: string;
};

type Props = {
  connectorUrl: string;
  workspaceId: string;
  origin: string;
  providers: AiWorkspaceProviderView[];
  enterpriseServices: EnterpriseServiceView[];
  managedServicesEnabled: boolean;
  canRequestManagedServices: boolean;
  requestManagedServiceAction: (formData: FormData) => void | Promise<void>;
  selectedProviderKey: string | null;
  selectedServiceKey: string | null;
};

async function writeClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  return window.open(url, "_blank", "noopener,noreferrer") !== null;
}

function groupTitle(group: "default" | "byo" | "advanced") {
  if (group === "default") return "Recommended default";
  if (group === "byo") return "Bring your own";
  return "Advanced clients";
}

function healthTagStyle(tone: EnterpriseServiceHealthTone) {
  if (tone === "success") return { background: "var(--accent-soft)" };
  if (tone === "warning") return { background: "rgba(255, 165, 0, 0.12)", border: "1px solid rgba(255, 165, 0, 0.35)" };
  if (tone === "danger") return { background: "rgba(180, 35, 24, 0.1)", border: "1px solid rgba(180, 35, 24, 0.28)" };
  if (tone === "info") return { background: "var(--surface-strong)" };
  return { background: "transparent" };
}

export function AiWorkspaceManager({
  connectorUrl,
  workspaceId,
  origin,
  providers,
  enterpriseServices,
  managedServicesEnabled,
  canRequestManagedServices,
  requestManagedServiceAction,
  selectedProviderKey,
  selectedServiceKey,
}: Props) {
  const cards = useMemo(() => buildAiWorkspaceSetupCards(providers, connectorUrl, origin), [connectorUrl, origin, providers]);
  const groups = useMemo(() => groupAiWorkspaceProviders(providers), [providers]);
  const [activeProviderKey, setActiveProviderKey] = useState(selectedProviderKey ?? cards[0]?.provider.key ?? null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const activeCard = cards.find((card) => card.provider.key === activeProviderKey) ?? cards[0] ?? null;

  const setCopyResult = (
    key: string,
    copied: boolean,
    copiedMessage: string,
    fallbackMessage: string,
    value: string,
  ) => {
    setStatus({
      key,
      message: copied ? copiedMessage : fallbackMessage,
      tone: copied ? "success" : "warning",
      manualValue: copied ? undefined : value,
    });
  };

  const copyValue = (key: string, value: string, copiedMessage: string, fallbackMessage: string) => {
    void writeClipboard(value).then((copied) => setCopyResult(key, copied, copiedMessage, fallbackMessage, value));
  };

  const copyAndOpen = (key: string, action: Extract<AiWorkspaceSetupAction, { kind: "copyAndOpen" }>) => {
    const opened = openExternalUrl(action.href);

    void writeClipboard(action.value).then((copied) => {
      if (copied && opened) {
        setStatus({
          key,
          message: `Copied the Corgtex MCP URL and opened ${action.productName}.`,
          tone: "success",
        });
        return;
      }

      if (copied) {
        setStatus({
          key,
          message: `Copied the Corgtex MCP URL. If ${action.productName} did not open, use the setup link.`,
          tone: "warning",
        });
        return;
      }

      setStatus({
        key,
        message: opened
          ? `${action.productName} opened, but clipboard access was blocked. Select and copy the MCP URL.`
          : `Could not open ${action.productName}, and clipboard access was blocked. Select and copy the MCP URL.`,
        tone: "warning",
        manualValue: action.value,
      });
    });
  };

  const renderAction = (action: AiWorkspaceSetupAction, providerKey: string) => {
    const key = `${providerKey}:${action.kind}:${action.label}`;

    if (action.kind === "open") {
      return (
        <a
          key={key}
          className={action.variant === "primary" ? "link-button small" : "link-button secondary small"}
          href={action.href}
          target={action.href.startsWith("/") ? undefined : "_blank"}
          rel="noreferrer"
        >
          {action.label}
        </a>
      );
    }

    if (action.kind === "copyAndOpen") {
      return (
        <button key={key} type="button" className="button secondary small" onClick={() => copyAndOpen(key, action)}>
          {action.label}
        </button>
      );
    }

    if (action.kind === "cursorInstall") {
      return (
        <span key={key} className="actions-inline" style={{ gap: 8 }}>
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              if (typeof window === "undefined") return;
              window.location.href = action.appHref;
              setStatus({
                key,
                message: "Opening Cursor's MCP installer. Use the browser fallback if Cursor does not open.",
                tone: "success",
              });
            }}
          >
            {action.label}
          </button>
          <a className="link-button secondary small" href={action.browserHref} target="_blank" rel="noreferrer">
            Browser fallback
          </a>
        </span>
      );
    }

    return (
      <button
        key={key}
        type="button"
        className="button secondary small"
        onClick={() => copyValue(key, action.value, action.copiedMessage, action.fallbackMessage)}
      >
        {action.label}
      </button>
    );
  };

  const renderStatus = (providerKey: string) => {
    if (!status || !status.key.startsWith(`${providerKey}:`)) return null;

    return (
      <div
        role="status"
        className="nr-item-meta"
        style={{
          background: status.tone === "success" ? "var(--accent-soft)" : "rgba(255, 165, 0, 0.12)",
          border: `1px solid ${status.tone === "success" ? "var(--line)" : "rgba(255, 165, 0, 0.35)"}`,
          borderRadius: 6,
          color: "var(--text)",
          fontSize: "0.82rem",
          marginTop: 10,
          padding: "8px 10px",
        }}
      >
        {status.message}
        {status.manualValue ? (
          <textarea
            readOnly
            aria-label="Manual copy value"
            value={status.manualValue}
            style={{ fontFamily: "monospace", fontSize: "0.82rem", marginTop: 8, minHeight: 52, resize: "vertical" }}
          />
        ) : null}
      </div>
    );
  };

  return (
    <section className="stack" style={{ gap: 28 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))",
          gap: 12,
        }}
      >
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{providers.filter((provider) => provider.recommendedDefault).length}</strong>
          <span>recommended default</span>
        </div>
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{groups.byo.length}</strong>
          <span>BYO workspaces</span>
        </div>
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{groups.advanced.length}</strong>
          <span>advanced clients</span>
        </div>
        <div className="ws-stat-card">
          <strong style={{ color: "var(--text)" }}>{managedServicesEnabled ? enterpriseServices.length : 0}</strong>
          <span>managed services</span>
        </div>
      </div>

      <div className="nr-filter-bar">
        {(["default", "byo", "advanced"] as const).map((group) => (
          groups[group].length > 0 ? (
            <span key={group} className="nr-filter-item" style={{ cursor: "default" }}>
              {groupTitle(group)} ({groups[group].length})
            </span>
          ) : null
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
          gap: 24,
        }}
      >
        <aside className="stack" style={{ gap: 12 }}>
          {cards.map((card) => (
            <button
              key={card.provider.key}
              type="button"
              onClick={() => setActiveProviderKey(card.provider.key)}
              style={{
                background: card.provider.key === activeCard?.provider.key ? "var(--surface-strong)" : "var(--surface)",
                border: `1px solid ${card.provider.key === activeCard?.provider.key ? "var(--accent)" : "var(--line)"}`,
                borderRadius: 8,
                color: "var(--text)",
                display: "grid",
                gap: 8,
                alignItems: "stretch",
                justifyContent: "stretch",
                justifyItems: "stretch",
                padding: 12,
                textAlign: "left",
                width: "100%",
              }}
            >
              <span
                style={{
                  alignItems: "center",
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <strong style={{ justifySelf: "start" }}>{card.provider.shortLabel}</strong>
                <span className="tag" style={{ background: card.provider.recommendedDefault ? "var(--accent-soft)" : "transparent" }}>
                  {card.statusLabel}
                </span>
              </span>
              <span className="nr-item-meta" style={{ fontSize: "0.82rem", justifySelf: "start", lineHeight: 1.35, textAlign: "left" }}>
                {card.provider.outcome}
              </span>
            </button>
          ))}
        </aside>

        {activeCard ? (
          <article
            className="panel stack"
            id={`ai-workspace-${activeCard.provider.key}`}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              gap: 18,
              padding: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div className="actions-inline" style={{ gap: 6, marginBottom: 8 }}>
                  <span className="tag">{groupTitle(activeCard.group)}</span>
                  <span className="tag info">{activeCard.setupLabel}</span>
                  {activeCard.provider.freeDefault ? <span className="tag success">Free default</span> : null}
                </div>
                <h2 style={{ fontSize: "1.25rem", margin: 0 }}>{activeCard.provider.label}</h2>
                <p className="nr-item-meta" style={{ fontSize: "0.9rem", lineHeight: 1.45, margin: "8px 0 0" }}>
                  {activeCard.provider.description}
                </p>
              </div>
              <span className="tag" style={{ background: activeCard.provider.recommendedDefault ? "var(--accent-soft)" : "transparent" }}>
                {activeCard.ownershipLabel}
              </span>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <span className="nr-item-meta" style={{ fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase" }}>
                Corgtex MCP URL
              </span>
              <code
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  display: "block",
                  fontFamily: "monospace",
                  fontSize: "0.82rem",
                  overflowWrap: "anywhere",
                  padding: "8px 10px",
                }}
              >
                {activeCard.connectorUrl}
              </code>
            </div>

            {activeCard.command ? (
              <div style={{ display: "grid", gap: 6 }}>
                <span className="nr-item-meta" style={{ fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase" }}>
                  Command
                </span>
                <code
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    display: "block",
                    fontFamily: "monospace",
                    fontSize: "0.82rem",
                    overflowWrap: "anywhere",
                    padding: "8px 10px",
                  }}
                >
                  {activeCard.command}
                </code>
              </div>
            ) : null}

            <div className="actions-inline" style={{ gap: 8 }}>
              {activeCard.actions.map((action) => renderAction(action, activeCard.provider.key))}
            </div>
            {renderStatus(activeCard.provider.key)}

            {activeCard.resources.length > 0 ? (
              <div className="stack" style={{ gap: 12 }}>
                <h3 style={{ fontSize: "0.95rem", margin: 0 }}>Setup resources</h3>
                {activeCard.resources.map((resource) => (
                  <div key={resource.title} style={{ display: "grid", gap: 6 }}>
                    <span className="nr-item-meta" style={{ fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase" }}>
                      {resource.label}
                    </span>
                    <pre
                      aria-label={resource.title}
                      style={{
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        fontFamily: "monospace",
                        fontSize: "0.78rem",
                        lineHeight: 1.45,
                        margin: 0,
                        maxHeight: 180,
                        overflow: "auto",
                        padding: "10px 12px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {resource.value}
                    </pre>
                  </div>
                ))}
              </div>
            ) : null}

            <ol className="stack" style={{ gap: 8, margin: 0, paddingLeft: 18 }}>
              {activeCard.steps.map((step) => (
                <li key={step} className="nr-item-meta" style={{ fontSize: "0.86rem" }}>
                  {step}
                </li>
              ))}
            </ol>

            {activeCard.verificationChecks.length > 0 ? (
              <div className="stack" style={{ gap: 8 }}>
                <h3 style={{ fontSize: "0.95rem", margin: 0 }}>Verification checklist</h3>
                <ul className="stack" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
                  {activeCard.verificationChecks.map((check) => (
                    <li key={check} className="nr-item-meta" style={{ fontSize: "0.84rem" }}>
                      {check}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="actions-inline" style={{ gap: 6 }}>
              {activeCard.provider.capabilities.map((capability) => (
                <span key={capability} className="tag">{capabilityLabel(capability)}</span>
              ))}
            </div>

            {activeCard.notes.length > 0 ? (
              <div className="stack" style={{ borderTop: "1px solid var(--line)", gap: 6, paddingTop: 12 }}>
                {activeCard.notes.map((note) => (
                  <p key={note} className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                    {note}
                  </p>
                ))}
              </div>
            ) : null}
          </article>
        ) : null}
      </div>

      {managedServicesEnabled ? (
        <section className="stack" style={{ gap: 14 }} id="managed-enterprise-services">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
            <h2 className="nr-section-header" style={{ margin: 0 }}>Enterprise services</h2>
            <span className="nr-item-meta">{enterpriseServices.length} services</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
            {enterpriseServices.map((service) => (
              (() => {
                const healthTone = enterpriseServiceHealthTone(service.healthStatus);
                const supportRequested = service.supportEscalationStatus === "REQUESTED";
                return (
                  <article
                    key={service.key}
                    id={`enterprise-service-${service.key}`}
                    style={{
                      border: `1px solid ${selectedServiceKey === service.key ? "var(--accent)" : "var(--line)"}`,
                      borderRadius: 8,
                      display: "grid",
                      gap: 12,
                      padding: 16,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                      <h3 style={{ fontSize: "1rem", margin: 0 }}>{service.label}</h3>
                      <span className="tag info">{enterpriseServiceOwnershipLabel(service.ownershipMode ?? service.defaultOwnershipMode)}</span>
                    </div>
                    <p className="nr-item-meta" style={{ fontSize: "0.86rem", lineHeight: 1.42, margin: 0 }}>
                      {service.outcome}
                    </p>
                    <div className="actions-inline" style={{ gap: 6 }}>
                      <span className="tag" style={healthTagStyle(healthTone)}>
                        {enterpriseServiceHealthLabel(service.healthStatus)}
                      </span>
                      <span className="tag">{enterpriseServiceProviderLabel(service.providerKey)}</span>
                      {supportRequested ? <span className="tag info">Support requested</span> : null}
                    </div>
                    <dl
                      style={{
                        display: "grid",
                        gap: 8,
                        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                        margin: 0,
                      }}
                    >
                      <div>
                        <dt className="nr-item-meta" style={{ fontSize: "0.72rem", textTransform: "uppercase" }}>Last check</dt>
                        <dd style={{ fontSize: "0.82rem", margin: 0 }}>{formatServiceTimestamp(service.lastHealthCheckAt)}</dd>
                      </div>
                      <div>
                        <dt className="nr-item-meta" style={{ fontSize: "0.72rem", textTransform: "uppercase" }}>Last sync</dt>
                        <dd style={{ fontSize: "0.82rem", margin: 0 }}>{formatServiceTimestamp(service.lastSuccessfulSyncAt)}</dd>
                      </div>
                      <div>
                        <dt className="nr-item-meta" style={{ fontSize: "0.72rem", textTransform: "uppercase" }}>Usage</dt>
                        <dd style={{ fontSize: "0.82rem", margin: 0 }}>{service.usageLabel ?? "Not recorded"}</dd>
                      </div>
                    </dl>
                    {service.usageDetail ? (
                      <p className="nr-item-meta" style={{ fontSize: "0.8rem", lineHeight: 1.4, margin: 0 }}>
                        {service.usageDetail}
                      </p>
                    ) : null}
                    {service.lastError ? (
                      <p className="form-message form-message-error" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {service.lastError}
                      </p>
                    ) : null}
                    {service.readinessChecks?.length ? (
                      <ul className="stack" style={{ gap: 5, margin: 0, paddingLeft: 18 }}>
                        {service.readinessChecks.map((check) => (
                          <li key={check.key} className="nr-item-meta" style={{ color: check.ok ? "var(--muted)" : "var(--text)", fontSize: "0.8rem" }}>
                            {check.label}: {check.detail}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="nr-item-meta" style={{ fontSize: "0.82rem", lineHeight: 1.42, margin: 0 }}>
                        {service.description}
                      </p>
                    )}
                    {canRequestManagedServices ? (
                      <form action={requestManagedServiceAction} className="stack" style={{ borderTop: "1px solid var(--line)", gap: 8, paddingTop: 10 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="serviceKey" value={service.key} />
                        <textarea
                          name="supportNotesMd"
                          defaultValue={service.supportNotesMd ?? ""}
                          placeholder="Rollout notes, support blocker, or managed-service request"
                          rows={2}
                          style={{ fontSize: "0.82rem", minHeight: 58 }}
                        />
                        <div className="actions-inline">
                          <button type="submit" className="button secondary small">
                            {supportRequested ? "Update escalation" : "Request CORGTEX-managed rollout"}
                          </button>
                          {service.supportEscalatedAt ? (
                            <span className="nr-item-meta" style={{ fontSize: "0.78rem" }}>
                              Requested {formatServiceTimestamp(service.supportEscalatedAt)}
                            </span>
                          ) : null}
                        </div>
                      </form>
                    ) : null}
                  </article>
                );
              })()
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
