"use client";

import { useMemo, useState } from "react";

import {
  EXECUTION_WRITEBACK_OPTIONS,
  activeAiWorkspaceProvider,
  aiWorkspaceSettingsHref,
  aiWorkspaceLaunchUrl,
  buildExecutionRequestHandoffPrompt,
  buildExecutionRequestPayload,
  createUiIdempotencyKey,
  writebackOptionLabel,
  type AiWorkspaceLaunchState,
  type AiWorkspaceLaunchProvider,
} from "@/lib/ai-workspace-launch";
import { WorkspaceUtilityIcon } from "./WorkspaceNavIcon";

type CreatedExecutionRequest = {
  id: string;
  goal: string;
  writebackTarget?: {
    type?: string | null;
    label?: string | null;
  } | null;
};

type Props = {
  workspaceId: string;
  initialState: AiWorkspaceLaunchState;
  variant: "mobile" | "rail";
};

async function writeClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

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

export function AiWorkspaceLaunchPanel({
  workspaceId,
  initialState,
  variant,
}: Props) {
  const [selectionState, setSelectionState] = useState(initialState);
  const [isChoosing, setIsChoosing] = useState(!initialState.activeProviderKey);
  const [selectingProviderKey, setSelectingProviderKey] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [writebackTargetType, setWritebackTargetType] = useState("ACTION");
  const [createdRequest, setCreatedRequest] = useState<CreatedExecutionRequest | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const provider = activeAiWorkspaceProvider(selectionState);
  const providerLaunchUrl = aiWorkspaceLaunchUrl(provider?.key);
  const setupHref = aiWorkspaceSettingsHref(workspaceId, provider?.key ?? selectionState.providers[0]?.key ?? "openwork");
  const isRail = variant === "rail";
  const currentGoal = createdRequest?.goal ?? goal;
  const currentWritebackLabel = createdRequest?.writebackTarget?.label
    ?? writebackOptionLabel(createdRequest?.writebackTarget?.type ?? writebackTargetType);
  const handoffPrompt = useMemo(() => {
    if (!createdRequest || !provider) return "";
    return buildExecutionRequestHandoffPrompt({
      requestId: createdRequest.id,
      providerLabel: provider.label,
      goal: currentGoal,
      writebackTargetLabel: currentWritebackLabel,
    });
  }, [createdRequest, currentGoal, currentWritebackLabel, provider]);

  async function selectProvider(nextProvider: AiWorkspaceLaunchProvider) {
    if (selectingProviderKey) return;

    setSelectingProviderKey(nextProvider.key);
    setError(null);
    setCopyStatus(null);
    setManualPrompt(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/ai-workspace-selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerKey: nextProvider.key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? "Could not choose the AI work tool.");
      }
      const nextState = data as AiWorkspaceLaunchState;
      setSelectionState(nextState);
      setIsChoosing(false);
      setCreatedRequest(null);
      setGoal("");
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "Could not choose the AI work tool.");
    } finally {
      setSelectingProviderKey(null);
    }
  }

  async function submitRequest() {
    if (!provider || !goal.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    setCopyStatus(null);
    setManualPrompt(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/execution-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildExecutionRequestPayload({
          goal,
          providerKey: provider.key,
          surface: variant === "mobile" ? "mobile_work" : "desktop_rail",
          currentPath: typeof window === "undefined" ? `/workspaces/${workspaceId}` : window.location.pathname,
          writebackTargetType,
          idempotencyKey: createUiIdempotencyKey(`ui:${workspaceId}:${provider.key}`),
        })),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parseRouteError(data) ?? "Could not create the execution request.");
      }
      const executionRequest = (data as { executionRequest?: CreatedExecutionRequest }).executionRequest;
      if (!executionRequest?.id) {
        throw new Error("Execution request response was incomplete.");
      }
      setCreatedRequest(executionRequest);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create the execution request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyHandoffPrompt() {
    if (!handoffPrompt) return;
    const copied = await writeClipboard(handoffPrompt);
    setCopyStatus(copied ? "Copied the handoff prompt." : "Clipboard blocked. Select and copy the prompt below.");
    setManualPrompt(copied ? null : handoffPrompt);
  }

  function openWorkspace() {
    const opened = openExternalUrl(providerLaunchUrl);
    if (!opened && providerLaunchUrl) {
      setCopyStatus("Could not open the AI workspace. Use the setup link or open it manually.");
    }
  }

  function renderProviderChoice(choice: AiWorkspaceLaunchProvider) {
    const isActive = choice.key === selectionState.activeProviderKey;
    return (
      <div key={choice.key} className={`ai-workspace-choice ${isActive ? "active" : ""}`}>
        <div>
          <strong>{choice.shortLabel}</strong>
          <span>{choice.outcome}</span>
          <div className="ai-workspace-choice-tags">
            {choice.recommendedDefault ? <span className="tag success">Recommended</span> : null}
            {choice.freeDefault ? <span className="tag">Free</span> : null}
            {choice.setupVariants.length > 1 ? <span className="tag">{choice.setupVariants.length} setup paths</span> : null}
          </div>
        </div>
        <div className="ai-workspace-choice-actions">
          <button
            type="button"
            className={isActive ? "button secondary small" : "button small"}
            onClick={() => void selectProvider(choice)}
            disabled={selectingProviderKey !== null}
          >
            {selectingProviderKey === choice.key ? "Choosing" : isActive ? "Keep using" : `Use ${choice.shortLabel}`}
          </button>
          <a className="link-button secondary small" href={aiWorkspaceSettingsHref(workspaceId, choice.key)}>
            Setup
          </a>
        </div>
      </div>
    );
  }

  if (selectionState.providers.length === 0) {
    return (
      <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
        <div className="ai-workspace-launch-header">
          <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
          <div>
            <strong>Work</strong>
            <span>AI workspace setup is not enabled for this workspace.</span>
          </div>
        </div>
      </div>
    );
  }

  if (!provider || isChoosing) {
    const choices = provider
      ? selectionState.providers.filter((choice) => choice.key !== provider.key)
      : selectionState.providers;
    return (
      <div className={`ai-workspace-launch ai-workspace-launch-${variant}`}>
        <div className="ai-workspace-launch-header">
          <WorkspaceUtilityIcon name="work" className="ai-workspace-launch-icon" />
          <div>
            <strong>{provider ? "Connect more" : "Choose AI work tool"}</strong>
            <span>
              {provider
                ? `${provider.shortLabel} is selected. Switch only if your team will work somewhere else.`
                : "Choose the AI workspace your team will use for governed work."}
            </span>
          </div>
        </div>

        <div className="ai-workspace-choice-list">
          {choices.map((choice) => renderProviderChoice(choice))}
        </div>

        <div className="ai-workspace-launch-actions">
          {provider ? (
            <button type="button" className="button secondary small" onClick={() => setIsChoosing(false)}>
              Back to {provider.shortLabel}
            </button>
          ) : null}
          <a className="link-button secondary small" href={aiWorkspaceSettingsHref(workspaceId, choices[0]?.key ?? "openwork")}>
            Setup details
          </a>
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
          <strong>{isRail ? "Send to AI workspace" : "Work"}</strong>
          <span>{provider.shortLabel} is selected. Corgtex supplies context, policy, audit, and write-back.</span>
        </div>
      </div>

      <div className="ai-workspace-launch-form">
        <label>
          <span>Goal</span>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder={isRail ? "Describe the output to create..." : "What should the AI workspace produce?"}
            rows={isRail ? 2 : 4}
            disabled={isSubmitting}
          />
        </label>

        <label>
          <span>Write-back</span>
          <select
            value={writebackTargetType}
            onChange={(event) => setWritebackTargetType(event.target.value)}
            disabled={isSubmitting}
          >
            {EXECUTION_WRITEBACK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        {!isRail && (
          <p className="ai-workspace-launch-help">
            {EXECUTION_WRITEBACK_OPTIONS.find((option) => option.value === writebackTargetType)?.description}
          </p>
        )}

        <div className="ai-workspace-launch-actions">
          <button
            type="button"
            className="button small"
            onClick={() => void submitRequest()}
            disabled={isSubmitting || !goal.trim()}
          >
            <WorkspaceUtilityIcon name="send" className="ai-workspace-action-icon" />
            {isSubmitting ? "Sending" : "Send to AI workspace"}
          </button>
          <a className="link-button secondary small" href={setupHref}>
            Setup
          </a>
          {providerLaunchUrl ? (
            <button type="button" className="button secondary small" onClick={openWorkspace}>
              <WorkspaceUtilityIcon name="external" className="ai-workspace-action-icon" />
              Open
            </button>
          ) : null}
          {selectionState.providers.length > 1 ? (
            <button type="button" className="button secondary small" onClick={() => setIsChoosing(true)}>
              Connect more
            </button>
          ) : null}
        </div>
      </div>

      {createdRequest ? (
        <div className="ai-workspace-launch-result" role="status">
          <div>
            <strong>Execution request ready</strong>
            <span>{createdRequest.id}</span>
          </div>
          <div className="ai-workspace-launch-actions">
            <button type="button" className="button secondary small" onClick={() => void copyHandoffPrompt()}>
              <WorkspaceUtilityIcon name="copy" className="ai-workspace-action-icon" />
              Copy handoff
            </button>
            {providerLaunchUrl ? (
              <button type="button" className="button secondary small" onClick={openWorkspace}>
                <WorkspaceUtilityIcon name="external" className="ai-workspace-action-icon" />
                Open {provider.shortLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {copyStatus ? <div className="ai-workspace-launch-status">{copyStatus}</div> : null}
      {manualPrompt ? (
        <textarea className="ai-workspace-manual-prompt" readOnly value={manualPrompt} aria-label="AI workspace handoff prompt" />
      ) : null}
      {error ? <div className="form-message form-message-error">{error}</div> : null}
    </div>
  );
}
