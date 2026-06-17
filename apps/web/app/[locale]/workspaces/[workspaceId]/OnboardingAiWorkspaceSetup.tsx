"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  aiWorkspaceConnectionForProvider,
  isAiWorkspaceConnected,
  type AiWorkspaceLaunchProvider,
  type AiWorkspaceLaunchState,
} from "@/lib/ai-workspace-launch";
import {
  buildAiWorkspaceSetupCards,
  primaryAiWorkspaceProviders,
  type AiWorkspaceProviderView,
  type AiWorkspaceSetupAction,
} from "./settings/ai-workspace-ui";

type Props = {
  workspaceId: string;
  initialState: AiWorkspaceLaunchState;
  connectorUrl: string;
  origin: string;
};

type ActionStatus = {
  message: string;
  tone: "success" | "warning";
  manualValue?: string;
};

function parseRouteError(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message;
  }
  return fallback;
}

function launchProviderToView(provider: AiWorkspaceLaunchProvider): AiWorkspaceProviderView {
  return {
    key: provider.key,
    label: provider.label,
    shortLabel: provider.shortLabel,
    outcome: provider.outcome,
    description: provider.description,
    category: provider.recommendedDefault ? "DEFAULT" : provider.key === "cursor" ? "ADVANCED" : "BYO",
    recommendedDefault: provider.recommendedDefault,
    freeDefault: provider.freeDefault,
    setupPath: provider.key === "openwork" ? "guided" : "recipe",
    capabilities: [],
    supportedOwnershipModes: provider.key === "openwork"
      ? ["USER_MANAGED", "WORKSPACE_MANAGED", "CORGTEX_MANAGED"]
      : ["USER_MANAGED", "WORKSPACE_MANAGED"],
    setupVariants: provider.setupVariants,
  };
}

function onboardingProviderViews(providers: AiWorkspaceLaunchProvider[]) {
  return primaryAiWorkspaceProviders(providers.map(launchProviderToView));
}

function primaryProviderKey(state: AiWorkspaceLaunchState) {
  const primaryProviders = onboardingProviderViews(state.providers);
  if (state.activeProviderKey && primaryProviders.some((provider) => provider.key === state.activeProviderKey)) {
    return state.activeProviderKey;
  }
  return primaryProviders.find((provider) => provider.recommendedDefault)?.key ?? primaryProviders[0]?.key ?? "";
}

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

function openNewTab(url: string) {
  if (typeof window === "undefined") return false;
  return window.open(url, "_blank", "noopener,noreferrer") !== null;
}

export function OnboardingAiWorkspaceSetup({
  workspaceId,
  initialState,
  connectorUrl,
  origin,
}: Props) {
  const t = useTranslations("onboarding.tour");
  const [selectionState, setSelectionState] = useState(initialState);
  const [activeProviderKey, setActiveProviderKey] = useState(primaryProviderKey(initialState));
  const [selecting, setSelecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [markingConnected, setMarkingConnected] = useState(false);
  const [status, setStatus] = useState<ActionStatus | null>(null);

  const providers = useMemo(() => onboardingProviderViews(selectionState.providers), [selectionState.providers]);
  const cards = useMemo(() => buildAiWorkspaceSetupCards(
    providers,
    connectorUrl,
    origin,
    workspaceId,
    {
      returnTo: `/workspaces/${workspaceId}?onboarding=setup`,
      includeClaudeAdvanced: false,
    },
  ), [connectorUrl, origin, providers, workspaceId]);
  const activeCard = cards.find((card) => card.provider.key === activeProviderKey) ?? cards[0] ?? null;
  const activeConnection = aiWorkspaceConnectionForProvider(selectionState, activeCard?.provider.key);
  const connected = isAiWorkspaceConnected(activeConnection);

  function applyState(value: unknown) {
    if (!value || typeof value !== "object") return;
    const nextState = value as AiWorkspaceLaunchState;
    if (!Array.isArray(nextState.providers) || !Array.isArray(nextState.connections)) return;
    setSelectionState(nextState);
  }

  async function chooseProvider(providerKey: string) {
    const provider = providers.find((entry) => entry.key === providerKey);
    if (!provider) return;

    setActiveProviderKey(providerKey);
    setSelecting(true);
    setStatus(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/ai-workspace-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data, t("connectClientErrorSelect")));
      }
      applyState(data);
      setStatus({
        message: t("connectClientSelected", { provider: provider.shortLabel }),
        tone: "success",
      });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : t("connectClientErrorSelect"),
        tone: "warning",
      });
    } finally {
      setSelecting(false);
    }
  }

  function setCopyResult(copied: boolean, copiedMessage: string, fallbackMessage: string, value: string) {
    setStatus({
      message: copied ? copiedMessage : fallbackMessage,
      tone: copied ? "success" : "warning",
      manualValue: copied ? undefined : value,
    });
  }

  function copyValue(action: Extract<AiWorkspaceSetupAction, { kind: "copy" }>) {
    void writeClipboard(action.value).then((copied) => {
      setCopyResult(copied, action.copiedMessage, action.fallbackMessage, action.value);
    });
  }

  function copyAndOpen(action: Extract<AiWorkspaceSetupAction, { kind: "copyAndOpen" }>) {
    const opened = openNewTab(action.href);
    void writeClipboard(action.value).then((copied) => {
      if (copied && opened) {
        setStatus({
          message: t("connectClientCopiedAndOpened", { product: action.productName }),
          tone: "success",
        });
        return;
      }

      if (copied) {
        setStatus({
          message: t("connectClientCopiedOnly", { product: action.productName }),
          tone: "warning",
        });
        return;
      }

      setStatus({
        message: opened
          ? t("connectClientOpenedCopyBlocked", { product: action.productName })
          : t("connectClientOpenCopyBlocked", { product: action.productName }),
        tone: "warning",
        manualValue: action.value,
      });
    });
  }

  function renderAction(action: AiWorkspaceSetupAction) {
    const key = `${activeCard?.provider.key ?? "provider"}:${action.kind}:${action.label}`;
    const className = action.variant === "primary" ? "button small" : "button secondary small";

    if (action.kind === "open") {
      return (
        <a key={key} className={action.variant === "primary" ? "link-button small" : "link-button secondary small"} href={action.href} target="_blank" rel="noreferrer">
          {action.label}
        </a>
      );
    }

    if (action.kind === "copyAndOpen") {
      return (
        <button key={key} type="button" className={className} onClick={() => copyAndOpen(action)}>
          {action.label}
        </button>
      );
    }

    if (action.kind === "cursorInstall") {
      return (
        <span key={key} className="actions-inline" style={{ gap: 8 }}>
          <button
            type="button"
            className={className}
            onClick={() => {
              const opened = openNewTab(action.appHref);
              setStatus({
                message: opened ? t("connectClientCursorOpening") : t("connectClientCursorFallback"),
                tone: opened ? "success" : "warning",
              });
            }}
          >
            {action.label}
          </button>
          <a className="link-button secondary small" href={action.browserHref} target="_blank" rel="noreferrer">
            {t("connectClientBrowserFallback")}
          </a>
        </span>
      );
    }

    return (
      <button key={key} type="button" className={className} onClick={() => copyValue(action)}>
        {action.label}
      </button>
    );
  }

  async function verifyConnection() {
    if (!activeCard || verifying) return;

    setVerifying(true);
    setStatus(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", providerKey: activeCard.provider.key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data, t("connectClientErrorVerify")));
      }
      applyState((data as { state?: unknown }).state);
      setStatus({
        message: typeof (data as { message?: unknown }).message === "string"
          ? (data as { message: string }).message
          : t("connectClientVerified", { provider: activeCard.provider.shortLabel }),
        tone: (data as { verified?: unknown }).verified === false ? "warning" : "success",
      });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : t("connectClientErrorVerify"),
        tone: "warning",
      });
    } finally {
      setVerifying(false);
    }
  }

  async function markConnected() {
    if (!activeCard || markingConnected) return;

    setMarkingConnected(true);
    setStatus(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_connected", providerKey: activeCard.provider.key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data, t("connectClientErrorMark")));
      }
      applyState((data as { state?: unknown }).state);
      setStatus({
        message: t("connectClientMarkedConnected", { provider: activeCard.provider.shortLabel }),
        tone: "success",
      });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : t("connectClientErrorMark"),
        tone: "warning",
      });
    } finally {
      setMarkingConnected(false);
    }
  }

  if (!activeCard || providers.length === 0) {
    return (
      <section className="onboarding-setup-panel stack">
        <div>
          <h3>{t("connectClientTitle")}</h3>
          <p className="nr-item-meta">{t("connectClientUnavailable")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="onboarding-setup-panel onboarding-ai-setup stack">
      <div>
        <h3>{t("connectClientTitle")}</h3>
        <p className="nr-item-meta">{t("connectClientDescription")}</p>
      </div>

      <label className="stack onboarding-ai-provider-picker">
        <span>{t("connectClientProviderLabel")}</span>
        <select
          value={activeCard.provider.key}
          onChange={(event) => void chooseProvider(event.target.value)}
          disabled={selecting}
        >
          {providers.map((provider) => (
            <option key={provider.key} value={provider.key}>
              {provider.shortLabel}
            </option>
          ))}
        </select>
      </label>

      <div className="nr-item onboarding-ai-card">
        <div className="row">
          <strong className="nr-item-title">{t("connectClientSetupTitle", { provider: activeCard.provider.shortLabel })}</strong>
          <span className="tag">{connected ? t("connectClientConnected") : t("connectClientSelectedStatus")}</span>
        </div>
        <p className="nr-item-meta">{activeCard.summary}</p>
      </div>

      <div className="actions-inline onboarding-ai-actions">
        {activeCard.actions.map(renderAction)}
        {activeCard.provider.key === "claude" && !connected ? (
          <button type="button" className="secondary small" disabled={verifying} onClick={() => void verifyConnection()}>
            {verifying ? t("connectClientVerifying") : t("connectClientVerifyClaude")}
          </button>
        ) : null}
        {!connected ? (
          <button type="button" className="secondary small" disabled={markingConnected} onClick={() => void markConnected()}>
            {markingConnected ? t("connectClientMarking") : t("connectClientMarkConnected")}
          </button>
        ) : null}
      </div>

      {status ? (
        <div
          role="status"
          className={`onboarding-ai-status ${status.tone === "success" ? "onboarding-ai-status-success" : "onboarding-ai-status-warning"}`}
        >
          {status.message}
          {status.manualValue ? (
            <textarea readOnly aria-label={t("connectClientManualValue")} value={status.manualValue} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
