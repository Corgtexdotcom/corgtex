"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../../../demo-tour-theme.css";
import { Dialog } from "@/lib/components/Dialog";
import { KnowledgeFileUploader } from "./KnowledgeFileUploader";
import { workspaceRouteMatches, workspaceStepUrl } from "./onboarding-tour-routing";

const TOUR_KEY = "self_serve_workspace";
const TOUR_VERSION = "v2";
const RESTART_EVENT = "corgtex:restart-self-serve-tour";

interface TourStep {
  href: string;
  element?: string;
  popover: {
    title: string;
    description: string;
    side?: "top" | "bottom" | "left" | "right";
    align?: "start" | "center" | "end";
  };
}

type SetupMode = "setup" | "setupReturn" | null;

type DriveConnection = {
  id: string;
  providerEmail: string | null;
  providerAccountId: string;
  hasDocumentScope: boolean;
};

type DriveDocument = {
  id: string;
  name: string;
  mimeType: string | null;
  webUrl: string | null;
  modifiedAt: string | null;
};

type RecorderStatus = {
  featureEnabled: boolean;
  enabled: boolean;
  autoRecordEnabled: boolean;
  defaultProvider: string;
  botName: string;
  monthlyMinuteCap: number;
  usedMinutes: number;
};

function currentUrl() {
  return `${window.location.pathname}${window.location.search}`;
}

function parseApiError(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

export function WorkspaceOnboardingTour({
  workspaceId,
  initialCompletedAt,
  hasInitialKnowledge,
  featureFlags,
  capabilities,
}: {
  workspaceId: string;
  initialCompletedAt: string | null;
  hasInitialKnowledge: boolean;
  featureFlags?: Record<string, boolean>;
  capabilities?: {
    canManageAgentGovernance?: boolean;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("onboarding.tour");
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);
  const targetStepIndexRef = useRef<number | null>(null);
  const autoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedRef = useRef(Boolean(initialCompletedAt));
  const hasContextRef = useRef(hasInitialKnowledge);
  const [completed, setCompleted] = useState(Boolean(initialCompletedAt));
  const [hasContext, setHasContext] = useState(hasInitialKnowledge);
  const [setupMode, setSetupMode] = useState<SetupMode>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [driveConnection, setDriveConnection] = useState<DriveConnection | null>(null);
  const [driveDocuments, setDriveDocuments] = useState<DriveDocument[]>([]);
  const [driveQuery, setDriveQuery] = useState("");
  const [driveSelectedIds, setDriveSelectedIds] = useState<string[]>([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveSaving, setDriveSaving] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus | null>(null);
  const [recorderLoading, setRecorderLoading] = useState(false);
  const [recorderSaving, setRecorderSaving] = useState(false);
  const [recorderError, setRecorderError] = useState<string | null>(null);
  const isMapRoute = Boolean(pathname?.includes(`/workspaces/${workspaceId}/maps`));
  const routeKey = `${pathname ?? ""}?${searchParams?.toString() ?? ""}`;
  const onboardingRequested = searchParams?.get("onboarding") === "setup";
  const goalsTourEnabled = Boolean(featureFlags?.GOALS);
  const contextMapsTourEnabled = Boolean(featureFlags?.CONTEXT_MAPS);
  const agentGovernanceTourEnabled = Boolean(featureFlags?.AGENT_GOVERNANCE && capabilities?.canManageAgentGovernance);
  const meetingRecorderOnboardingPath = featureFlags?.TOOL_LINKS
    ? "/tools?type=TOOL&q=meeting%20recorder"
    : "/settings?tab=general";

  const tourSteps: TourStep[] = useMemo(() => {
    const steps: TourStep[] = [
      {
        href: "/",
        popover: {
          title: t("welcomeTitle"),
          description: t("welcomeDescription"),
        },
      },
      {
        href: "/",
        element: ".ws-main-content",
        popover: {
          title: t("homeTitle"),
          description: t("homeDescription"),
          side: "top",
        },
      },
      {
        href: "/circles",
        element: ".ws-main-content",
        popover: {
          title: t("circlesTitle"),
          description: t("circlesDescription"),
          side: "top",
        },
      },
      {
        href: "/tensions",
        element: ".ws-main-content",
        popover: {
          title: t("tensionsTitle"),
          description: t("tensionsDescription"),
          side: "top",
        },
      },
      {
        href: "/actions",
        element: ".ws-main-content",
        popover: {
          title: t("actionsTitle"),
          description: t("actionsDescription"),
          side: "top",
        },
      },
      {
        href: "/meetings",
        element: ".ws-main-content",
        popover: {
          title: t("meetingsTitle"),
          description: t("meetingsDescription"),
          side: "top",
        },
      },
      {
        href: "/proposals",
        element: ".ws-main-content",
        popover: {
          title: t("proposalsTitle"),
          description: t("proposalsDescription"),
          side: "top",
        },
      },
    ];

    if (goalsTourEnabled) {
      steps.push({
        href: "/goals",
        element: ".ws-main-content",
        popover: {
          title: t("goalsTitle"),
          description: t("goalsDescription"),
          side: "top",
        },
      });
    }

    if (contextMapsTourEnabled) {
      steps.push({
        href: "/maps",
        element: ".ws-main-content",
        popover: {
          title: t("mapsTitle"),
          description: t("mapsDescription"),
          side: "top",
        },
      });
    }

    if (agentGovernanceTourEnabled) {
      steps.push({
        href: "/agents",
        element: ".ws-main-content",
        popover: {
          title: t("agentGovernanceTitle"),
          description: t("agentGovernanceDescription"),
          side: "top",
        },
      });
    }

    steps.push(
      {
        href: meetingRecorderOnboardingPath,
        element: ".ws-main-content",
        popover: {
          title: t("integrationsTitle"),
          description: t("integrationsDescription"),
          side: "top",
        },
      },
      {
        href: "/",
        element: ".ws-agent-sidebar",
        popover: {
          title: t("assistantTitle"),
          description: t("assistantDescription"),
          side: "left",
        },
      },
    );

    return steps;
  }, [t, goalsTourEnabled, contextMapsTourEnabled, agentGovernanceTourEnabled, meetingRecorderOnboardingPath]);

  const markCompleted = useCallback(() => {
    completedRef.current = true;
    setCompleted(true);
    void fetch(`/api/workspaces/${workspaceId}/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tourKey: TOUR_KEY, tourVersion: TOUR_VERSION }),
    });
  }, [workspaceId]);

  const startTour = useCallback(() => {
    setSetupMode(null);
    setSetupMessage(null);
    const homePath = workspaceStepUrl(workspaceId, "/");
    if (!workspaceRouteMatches(currentUrl(), homePath)) {
      targetStepIndexRef.current = 0;
      router.push(homePath);
      return;
    }
    driverRef.current?.drive(0);
  }, [router, workspaceId]);

  const finishTour = useCallback((driverObj: ReturnType<typeof driver>) => {
    driverObj.destroy();
    if (hasContextRef.current) {
      markCompleted();
      return;
    }
    setSetupMode("setupReturn");
  }, [markCompleted]);

  const initDriver = useCallback(() => {
    const driverObj = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      steps: tourSteps.map((step, index) => ({
        element: step.element,
        popover: {
          ...step.popover,
          onNextClick: () => {
            const nextStep = tourSteps[index + 1];
            if (!nextStep) {
              finishTour(driverObj);
              return;
            }

            const expectedUrl = workspaceStepUrl(workspaceId, nextStep.href);
            if (!workspaceRouteMatches(currentUrl(), expectedUrl)) {
              targetStepIndexRef.current = index + 1;
              router.push(expectedUrl);
              driverObj.destroy();
            } else {
              driverObj.moveNext();
            }
          },
          onPrevClick: () => {
            const prevStep = tourSteps[index - 1];
            if (!prevStep) return;

            const expectedUrl = workspaceStepUrl(workspaceId, prevStep.href);
            if (!workspaceRouteMatches(currentUrl(), expectedUrl)) {
              targetStepIndexRef.current = index - 1;
              router.push(expectedUrl);
              driverObj.destroy();
            } else {
              driverObj.movePrevious();
            }
          },
        },
      })),
      onCloseClick: () => {
        if (hasContextRef.current) {
          markCompleted();
        } else {
          setSetupMode("setupReturn");
        }
        driverObj.destroy();
      },
    });

    return driverObj;
  }, [finishTour, markCompleted, router, tourSteps, workspaceId]);

  const restartTour = useCallback(() => {
    setSetupMode(null);
    const homePath = workspaceStepUrl(workspaceId, "/");
    if (!workspaceRouteMatches(currentUrl(), homePath)) {
      targetStepIndexRef.current = 0;
      router.push(homePath);
      return;
    }
    driverRef.current?.drive(0);
  }, [router, workspaceId]);

  const loadDriveDocuments = useCallback(async (query = "") => {
    setDriveLoading(true);
    setDriveError(null);
    try {
      const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const response = await fetch(`/api/workspaces/${workspaceId}/onboarding/google-drive${params}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseApiError(data, t("driveErrorLoad")));
      }
      setDriveConnection(data.connection ?? null);
      setDriveDocuments(Array.isArray(data.documents) ? data.documents : []);
    } catch (error) {
      setDriveError(error instanceof Error ? error.message : t("driveErrorLoad"));
    } finally {
      setDriveLoading(false);
    }
  }, [t, workspaceId]);

  const saveDriveSelection = useCallback(async () => {
    if (driveSelectedIds.length === 0) return;
    setDriveSaving(true);
    setDriveError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/onboarding/google-drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: driveSelectedIds }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseApiError(data, t("driveErrorSave")));
      }
      hasContextRef.current = true;
      setHasContext(true);
      setSetupMessage(t("driveSyncQueued"));
      setDriveSelectedIds([]);
      router.refresh();
    } catch (error) {
      setDriveError(error instanceof Error ? error.message : t("driveErrorSave"));
    } finally {
      setDriveSaving(false);
    }
  }, [driveSelectedIds, router, t, workspaceId]);

  const loadRecorderStatus = useCallback(async () => {
    if (!featureFlags?.MEETING_RECORDERS) return;
    setRecorderLoading(true);
    setRecorderError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/onboarding/meeting-recorder`);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseApiError(data, t("recorderErrorLoad")));
      }
      setRecorderStatus(data);
    } catch (error) {
      setRecorderError(error instanceof Error ? error.message : t("recorderErrorLoad"));
    } finally {
      setRecorderLoading(false);
    }
  }, [featureFlags?.MEETING_RECORDERS, t, workspaceId]);

  const enableRecorder = useCallback(async () => {
    setRecorderSaving(true);
    setRecorderError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/onboarding/meeting-recorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, autoRecordEnabled: false }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseApiError(data, t("recorderErrorSave")));
      }
      setRecorderStatus(data);
      setSetupMessage(t("recorderEnabled"));
      router.refresh();
    } catch (error) {
      setRecorderError(error instanceof Error ? error.message : t("recorderErrorSave"));
    } finally {
      setRecorderSaving(false);
    }
  }, [router, t, workspaceId]);

  const toggleDriveSelection = useCallback((documentId: string) => {
    setDriveSelectedIds((current) => (
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId]
    ));
  }, []);

  const handleUploaded = useCallback((count: number) => {
    hasContextRef.current = true;
    setHasContext(true);
    setSetupMessage(t("uploadComplete", { count }));
  }, [t]);

  const handleSetupClose = useCallback(() => {
    if (hasContextRef.current) {
      markCompleted();
      setSetupMode(null);
      return;
    }

    if (setupMode === "setup") {
      startTour();
      return;
    }

    setSetupMode(null);
  }, [markCompleted, setupMode, startTour]);

  useEffect(() => {
    completedRef.current = completed;
  }, [completed]);

  useEffect(() => {
    hasContextRef.current = hasContext;
  }, [hasContext]);

  useEffect(() => {
    driverRef.current = initDriver();

    if (!completedRef.current && !isMapRoute && targetStepIndexRef.current === null) {
      if (onboardingRequested || !hasContextRef.current) {
        setSetupMode((current) => current ?? "setup");
      } else {
        autoStartTimerRef.current = setTimeout(() => {
          autoStartTimerRef.current = null;
          if (targetStepIndexRef.current === null) {
            driverRef.current?.drive(0);
          }
        }, 1000);
      }
    }

    window.addEventListener(RESTART_EVENT, restartTour);

    return () => {
      window.removeEventListener(RESTART_EVENT, restartTour);
      if (autoStartTimerRef.current !== null) {
        clearTimeout(autoStartTimerRef.current);
        autoStartTimerRef.current = null;
      }
      if (targetStepIndexRef.current === null) {
        driverRef.current?.destroy();
      }
    };
  }, [initDriver, isMapRoute, onboardingRequested, restartTour]);

  useEffect(() => {
    if (!setupMode) return;
    void loadDriveDocuments("");
    void loadRecorderStatus();
  }, [loadDriveDocuments, loadRecorderStatus, setupMode]);

  useEffect(() => {
    if (targetStepIndexRef.current !== null) {
      const targetIndex = targetStepIndexRef.current;
      targetStepIndexRef.current = null;

      setTimeout(() => {
        driverRef.current = initDriver();
        driverRef.current.drive(targetIndex);
      }, 500);
    }
  }, [routeKey, initDriver]);

  return (
    <Dialog
      open={setupMode !== null}
      onClose={handleSetupClose}
      title={setupMode === "setupReturn" ? t("setupReturnTitle") : t("setupTitle")}
    >
      <div className="onboarding-setup stack">
        <p className="demo-tour-briefing-copy">
          {setupMode === "setupReturn" ? t("setupReturnDescription") : t("setupDescription")}
        </p>

        {setupMessage && <p className="form-message form-message-success">{setupMessage}</p>}

        <div className="onboarding-setup-grid">
          <section className="onboarding-setup-panel stack">
            <div>
              <h3>{t("uploadTitle")}</h3>
              <p className="nr-item-meta">{t("uploadDescription")}</p>
            </div>
            <KnowledgeFileUploader
              workspaceId={workspaceId}
              defaultSource="onboarding-upload"
              initiallyOpen
              showTrigger={false}
              doneLabel={t("setupContinueTour")}
              onUploaded={handleUploaded}
              onDone={startTour}
            />
          </section>

          <section className="onboarding-setup-panel stack">
            <div>
              <h3>{t("driveTitle")}</h3>
              <p className="nr-item-meta">{t("driveDescription")}</p>
            </div>
            {driveLoading && <p className="nr-item-meta">{t("driveLoading")}</p>}
            {driveError && <p className="form-message form-message-error">{driveError}</p>}
            {!driveLoading && (!driveConnection || !driveConnection.hasDocumentScope) && (
              <div className="stack">
                <p className="nr-item-meta">
                  {driveConnection ? t("driveScopeNeeded") : t("driveConnectNeeded")}
                </p>
                <a className="button secondary small" href={`/api/integrations/google/connect?workspaceId=${workspaceId}&intent=documents`}>
                  {t("driveConnectAction")}
                </a>
              </div>
            )}
            {driveConnection?.hasDocumentScope && (
              <div className="stack">
                <div className="actions-inline">
                  <input
                    value={driveQuery}
                    onChange={(event) => setDriveQuery(event.target.value)}
                    placeholder={t("driveSearchPlaceholder")}
                  />
                  <button type="button" className="secondary small" disabled={driveLoading} onClick={() => loadDriveDocuments(driveQuery)}>
                    {t("driveSearchAction")}
                  </button>
                </div>
                {driveDocuments.length === 0 ? (
                  <p className="nr-item-meta">{t("driveEmpty")}</p>
                ) : (
                  <div className="stack onboarding-drive-list">
                    {driveDocuments.map((document) => (
                      <label key={document.id} className="onboarding-drive-row">
                        <input
                          type="checkbox"
                          checked={driveSelectedIds.includes(document.id)}
                          onChange={() => toggleDriveSelection(document.id)}
                        />
                        <span>
                          <strong>{document.name}</strong>
                          <small>{document.mimeType ?? t("driveUnknownType")}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <button type="button" disabled={driveSelectedIds.length === 0 || driveSaving} onClick={saveDriveSelection}>
                  {driveSaving ? t("driveSaving") : t("driveSaveAction", { count: driveSelectedIds.length })}
                </button>
              </div>
            )}
          </section>

          <section className="onboarding-setup-panel stack">
            <div>
              <h3>{t("connectRecorderTitle")}</h3>
              <p className="nr-item-meta">{t("connectRecorderDescription")}</p>
            </div>
            {!featureFlags?.MEETING_RECORDERS ? (
              <p className="nr-item-meta">{t("recorderUnavailable")}</p>
            ) : (
              <div className="stack">
                {recorderLoading && <p className="nr-item-meta">{t("recorderLoading")}</p>}
                {recorderError && <p className="form-message form-message-error">{recorderError}</p>}
                {recorderStatus && (
                  <div className="nr-item">
                    <div className="row">
                      <strong className="nr-item-title">{t("recorderStatusTitle")}</strong>
                      <span className="tag">{recorderStatus.enabled ? t("recorderStatusEnabled") : t("recorderStatusDisabled")}</span>
                    </div>
                    <p className="nr-item-meta">
                      {t("recorderMeta", {
                        provider: recorderStatus.defaultProvider,
                        minutes: recorderStatus.monthlyMinuteCap,
                      })}
                    </p>
                  </div>
                )}
                <div className="actions-inline">
                  <button type="button" className="secondary small" disabled={recorderSaving || recorderStatus?.enabled === true} onClick={enableRecorder}>
                    {recorderSaving ? t("recorderSaving") : t("connectRecorderAction")}
                  </button>
                  <a className="link-button secondary" href={workspaceStepUrl(workspaceId, meetingRecorderOnboardingPath)}>
                    {t("recorderDetailsAction")}
                  </a>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="demo-tour-briefing-actions onboarding-setup-actions">
          <button type="button" className="secondary" onClick={startTour}>
            {t("setupSkipTour")}
          </button>
          {hasContext && (
            <button type="button" onClick={startTour}>
              {t("setupContinueTour")}
            </button>
          )}
          {setupMode === "setupReturn" && !hasContext && (
            <button type="button" className="ghost" onClick={() => setSetupMode(null)}>
              {t("setupLater")}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
