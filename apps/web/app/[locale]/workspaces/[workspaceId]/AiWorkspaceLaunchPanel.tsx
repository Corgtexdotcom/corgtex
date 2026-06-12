"use client";

import { useState } from "react";

import {
  activeAiWorkspaceConnection,
  aiWorkspaceProviderByKey,
  aiWorkspaceSettingsHref,
  connectedAiWorkspaceConnections,
  aiWorkspaceLaunchUrl,
  isAiWorkspaceConnected,
  pendingAiWorkspaceConnections,
  type AiWorkspaceLaunchState,
  type AiWorkspaceLaunchProvider,
} from "@/lib/ai-workspace-launch";
import { WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

type Props = {
  workspaceId: string;
  initialState: AiWorkspaceLaunchState;
  variant: "mobile" | "rail";
};

function openExternalUrl(url: string | null) {
  if (!url || typeof window === "undefined") return false;
  return window.open(url, "_blank", "noopener,noreferrer") !== null;
}

function parseRouteError(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

function providerRank(provider: AiWorkspaceLaunchProvider) {
  const ranks: Record<string, number> = {
    openwork: 0,
    claude: 1,
    chatgpt: 2,
    cursor: 3,
    copilot: 4,
    gemini: 5,
    generic_mcp: 6,
  };
  return ranks[provider.key] ?? 100;
}

function sortedProviders(providers: AiWorkspaceLaunchProvider[]) {
  return [...providers].sort((a, b) => providerRank(a) - providerRank(b) || a.label.localeCompare(b.label));
}

function claudeInstallerHref(workspaceId: string) {
  const returnTo = aiWorkspaceSettingsHref(workspaceId, "claude");
  const params = new URLSearchParams({
    workspaceId,
    returnTo,
  });
  return `/install/claude?${params.toString()}`;
}

export function AiWorkspaceLaunchPanel({
  workspaceId,
  initialState,
  variant,
}: Props) {
  const [selectionState, setSelectionState] = useState(initialState);
  const [isChoosing, setIsChoosing] = useState(!initialState.activeProviderKey);
  const [selectingProviderKey, setSelectingProviderKey] = useState<string | null>(null);
  const [pendingProviderKey, setPendingProviderKey] = useState(
    initialState.activeProviderKey ?? sortedProviders(initialState.providers)[0]?.key ?? "",
  );
  const [pendingConnectionAction, setPendingConnectionAction] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeConnection = activeAiWorkspaceConnection(selectionState);
  const provider = aiWorkspaceProviderByKey(selectionState, activeConnection?.providerKey ?? selectionState.activeProviderKey);
  const orderedProviders = sortedProviders(selectionState.providers);
  const connectedConnections = connectedAiWorkspaceConnections(selectionState);
  const pendingConnections = pendingAiWorkspaceConnections(selectionState);
  const activeProviderLaunchUrl = aiWorkspaceLaunchUrl(provider?.key);
  const connected = isAiWorkspaceConnected(activeConnection);

  function setupHref(providerKey: string) {
    return providerKey === "claude" ? claudeInstallerHref(workspaceId) : aiWorkspaceSettingsHref(workspaceId, providerKey);
  }

  function applyState(data: unknown) {
    if (!data || typeof data !== "object") return;
    const nextState = data as AiWorkspaceLaunchState;
    if (Array.isArray(nextState.providers) && Array.isArray(nextState.connections)) {
      setSelectionState(nextState);
      setPendingProviderKey(nextState.activeProviderKey ?? pendingProviderKey);
    }
  }

  async function selectProvider(providerKey: string) {
    const nextProvider = selectionState.providers.find((choice) => choice.key === providerKey);
    if (!nextProvider || selectingProviderKey) return;

    setSelectingProviderKey(providerKey);
    setError(null);
    setStatus(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/ai-workspace-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_setup", providerKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? "Could not start setup for this AI app.");
      }
      applyState(data);
      setIsChoosing(false);
      if (typeof window !== "undefined") {
        window.location.href = setupHref(providerKey);
      }
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Could not start setup for this AI app.");
    } finally {
      setSelectingProviderKey(null);
    }
  }

  async function updateConnection(providerKey: string, action: "verify" | "mark_connected") {
    setPendingConnectionAction(`${providerKey}:${action}`);
    setError(null);
    setStatus(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, providerKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? "Could not update this connection.");
      }
      applyState((data as { state?: unknown }).state);
      const message = typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : "Connection updated.";
      setStatus(message);
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : "Could not update this connection.");
    } finally {
      setPendingConnectionAction(null);
    }
  }

  function openProvider(providerKey: string) {
    const launchUrl = aiWorkspaceLaunchUrl(providerKey);
    const opened = openExternalUrl(launchUrl);
    if (!opened && launchUrl) {
      setStatus("Could not open the AI app. Use Add app to review setup.");
    }
  }

  if (selectionState.providers.length === 0) {
    return (
      <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
        <div className="ai-workspace-launch-header">
          <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
          <div>
            <strong>AI app</strong>
            <span>AI app setup is not enabled for this workspace.</span>
          </div>
        </div>
      </div>
    );
  }

  if (isChoosing || (!connectedConnections.length && !pendingConnections.length)) {
    return (
      <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
        <div className="ai-workspace-launch-header">
          <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
          <div>
            <strong>Connect an AI app</strong>
            <span>Choose where you want to use Corgtex.</span>
          </div>
        </div>

        <div className="ai-workspace-launch-form">
          <label>
            <span>AI app</span>
            <select
              value={pendingProviderKey}
              onChange={(event) => setPendingProviderKey(event.target.value)}
              disabled={selectingProviderKey !== null}
            >
              {orderedProviders.map((choice) => (
                <option key={choice.key} value={choice.key}>
                  {choice.shortLabel}
                </option>
              ))}
            </select>
          </label>

          <div className="ai-workspace-launch-actions">
            <button
              type="button"
              className="button small"
              onClick={() => void selectProvider(pendingProviderKey)}
              disabled={selectingProviderKey !== null || !pendingProviderKey}
            >
              {selectingProviderKey ? "Opening" : "Connect"}
            </button>
            {connectedConnections.length || pendingConnections.length ? (
              <button type="button" className="button secondary small" onClick={() => setIsChoosing(false)}>
                Back
              </button>
            ) : null}
          </div>
        </div>

        {error ? <div className="form-message form-message-error">{error}</div> : null}
      </div>
    );
  }

  if (!provider || !activeConnection) {
    return null;
  }

  if (!connected) {
    return (
      <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
        <div className="ai-workspace-launch-header">
          <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
          <div>
            <strong>Finish connecting {provider.shortLabel}</strong>
            <span>Complete setup, then verify it here.</span>
          </div>
        </div>

        <div className="ai-workspace-launch-actions">
          <a className="button small" href={setupHref(provider.key)}>
            Continue setup
          </a>
          <button
            type="button"
            className="button secondary small"
            disabled={pendingConnectionAction !== null}
            onClick={() => void updateConnection(provider.key, "verify")}
          >
            {pendingConnectionAction === `${provider.key}:verify` ? "Checking" : "Verify"}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={pendingConnectionAction !== null}
            onClick={() => void updateConnection(provider.key, "mark_connected")}
          >
            {pendingConnectionAction === `${provider.key}:mark_connected` ? "Saving" : "I connected it"}
          </button>
        </div>

        <button type="button" className="button secondary small" onClick={() => setIsChoosing(true)}>
          Add app
        </button>

        {status ? <div className="ai-workspace-launch-status">{status}</div> : null}
        {error ? <div className="form-message form-message-error">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
      <div className="ai-workspace-launch-header">
        <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
        <div>
          <strong>{provider.shortLabel} connected</strong>
        </div>
      </div>

      {connectedConnections.length > 1 ? (
        <div className="ai-workspace-launch-form">
          {connectedConnections.map((connection) => {
            const connectedProvider = aiWorkspaceProviderByKey(selectionState, connection.providerKey);
            if (!connectedProvider) return null;
            return (
              <button
                key={connection.providerKey}
                type="button"
                className="button secondary small"
                onClick={() => openProvider(connection.providerKey)}
              >
                Open {connectedProvider.shortLabel}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="ai-workspace-launch-actions">
        {activeProviderLaunchUrl ? (
          <button type="button" className="button small" onClick={() => openProvider(provider.key)}>
            <WorkspaceUtilityIcon name="external" className="ai-workspace-action-icon" />
            Open {provider.shortLabel}
          </button>
        ) : null}
        {selectionState.providers.length > 1 ? (
          <button type="button" className="button secondary small" onClick={() => setIsChoosing(true)}>
            Add app
          </button>
        ) : null}
      </div>

      {status ? <div className="ai-workspace-launch-status">{status}</div> : null}
      {error ? <div className="form-message form-message-error">{error}</div> : null}
    </div>
  );
}
