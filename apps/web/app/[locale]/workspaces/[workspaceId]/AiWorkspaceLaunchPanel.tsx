"use client";

import { useEffect, useState } from "react";

import {
  activeAiWorkspaceProvider,
  aiWorkspaceConnectionForProvider,
  aiWorkspaceLaunchUrl,
  aiWorkspaceSetupHref,
  isAiWorkspaceConnected,
  type AiWorkspaceLaunchState,
  type AiWorkspaceLaunchProvider,
} from "@/lib/ai-workspace-launch";
import { WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

type Props = {
  workspaceId: string;
  initialState: AiWorkspaceLaunchState;
  variant: "mobile" | "rail";
};

function parseRouteError(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

function providerConnectedSignal(value: unknown, providerKey: string) {
  if (!value || typeof value !== "object") return null;
  const signals = (value as { signals?: unknown }).signals;
  if (signals && typeof signals === "object") {
    const provider = (signals as Record<string, unknown>)[providerKey];
    if (provider && typeof provider === "object" && typeof (provider as { connected?: unknown }).connected === "boolean") {
      return (provider as { connected: boolean }).connected;
    }
  }

  const connections = (value as { connections?: unknown }).connections;
  if (Array.isArray(connections)) {
    const provider = connections.find((connection) =>
      connection &&
      typeof connection === "object" &&
      (connection as { providerKey?: unknown }).providerKey === providerKey
    );
    if (provider && typeof (provider as { connected?: unknown }).connected === "boolean") {
      return (provider as { connected: boolean }).connected;
    }
  }

  if (providerKey === "claude") {
    const claude = (value as { claude?: unknown }).claude;
    if (claude && typeof claude === "object" && typeof (claude as { connected?: unknown }).connected === "boolean") {
      return (claude as { connected: boolean }).connected;
    }
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
  const [verifiedProviderConnections, setVerifiedProviderConnections] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const provider = activeAiWorkspaceProvider(selectionState);
  const orderedProviders = sortedProviders(selectionState.providers);
  const activeConnection = aiWorkspaceConnectionForProvider(selectionState, provider?.key);
  const activeProviderVerified = provider ? verifiedProviderConnections[provider.key] : undefined;
  const activeProviderConnected = activeProviderVerified ?? isAiWorkspaceConnected(activeConnection);
  const activeProviderLaunchUrl = aiWorkspaceLaunchUrl(provider?.key);

  useEffect(() => {
    const providerKey = provider?.key;
    if (!providerKey) return;
    const checkedProviderKey: string = providerKey;

    let cancelled = false;

    async function checkProviderConnection() {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/mcp-connections`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return;
        const connected = providerConnectedSignal(data, checkedProviderKey);
        if (connected === null || cancelled) return;
        setVerifiedProviderConnections((current) => ({
          ...current,
          [checkedProviderKey]: connected,
        }));
      } catch {
        return;
      }
    }

    void checkProviderConnection();

    return () => {
      cancelled = true;
    };
  }, [provider?.key, workspaceId]);

  function setupHref(providerKey: string) {
    return aiWorkspaceSetupHref(workspaceId, providerKey);
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
        body: JSON.stringify({ providerKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? "Could not choose the AI app.");
      }
      applyState(data);
      setPendingProviderKey(providerKey);
      setIsChoosing(false);
      setStatus(`${nextProvider.shortLabel} is selected. Connect it once, then work from ${nextProvider.shortLabel}.`);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Could not choose the AI app.");
    } finally {
      setSelectingProviderKey(null);
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

  if (isChoosing || !provider) {
    return (
      <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
        <div className="ai-workspace-launch-header">
          <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
          <div>
            <strong>{provider ? "Change AI app" : "Choose AI app"}</strong>
            <span>Pick the app where your team wants to work with Corgtex.</span>
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
              {selectingProviderKey ? "Saving" : "Use this app"}
            </button>
            {provider ? (
              <button type="button" className="button secondary small" onClick={() => setIsChoosing(false)}>
                Back to {provider.shortLabel}
              </button>
            ) : null}
          </div>
        </div>

        {error ? <div className="form-message form-message-error">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
      <div className="ai-workspace-launch-header">
        <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
        <div>
          <strong>Corgtex in {provider.shortLabel}</strong>
          <span>Work from {provider.shortLabel}. Corgtex is available there after the connector is set up.</span>
        </div>
      </div>

      {activeProviderLaunchUrl ? (
        <a
          className="ai-workspace-launch-result ai-workspace-launch-result-link"
          href={activeProviderLaunchUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${provider.shortLabel}`}
        >
          <div>
            <strong>{provider.shortLabel} {activeProviderConnected ? "connected" : "selected"}</strong>
            <span>Corgtex supplies context, policy, audit, and write-back through MCP.</span>
          </div>
          <WorkspaceUtilityIcon name="external" className="ai-workspace-action-icon" />
        </a>
      ) : (
        <div className="ai-workspace-launch-result" role="status">
          <div>
            <strong>{provider.shortLabel} {activeProviderConnected ? "connected" : "selected"}</strong>
            <span>Corgtex supplies context, policy, audit, and write-back through MCP.</span>
          </div>
        </div>
      )}

      <div className="ai-workspace-launch-actions">
        <a className="link-button small" href={setupHref(provider.key)}>
          Connect
        </a>
        {selectionState.providers.length > 1 ? (
          <button type="button" className="button secondary small" onClick={() => setIsChoosing(true)}>
            Change app
          </button>
        ) : null}
      </div>

      {status ? <div className="ai-workspace-launch-status">{status}</div> : null}
      {error ? <div className="form-message form-message-error">{error}</div> : null}
    </div>
  );
}
