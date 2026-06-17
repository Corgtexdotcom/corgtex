"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../../../demo-tour-theme.css";
import { Dialog } from "@/lib/components/Dialog";
import { KnowledgeFileUploader } from "./KnowledgeFileUploader";
import { GoogleDrivePicker } from "./tools/GoogleDrivePicker";
import { workspaceRouteMatches, workspaceStepUrl } from "./onboarding-tour-routing";

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
  tourKey,
  tourVersion,
  initialCompletedAt,
  hasInitialKnowledge,
  featureFlags,
  capabilities,
  googleDrivePicker,
}: {
  workspaceId: string;
  tourKey: string;
  tourVersion: string;
  initialCompletedAt: string | null;
  hasInitialKnowledge: boolean;
  featureFlags?: Record<string, boolean>;
  capabilities?: {
    canManageAgentGovernance?: boolean;
  };
  googleDrivePicker?: {
    clientId: string | null;
    developerKey: string | null;
    appId: string | null;
    hasDocumentScope: boolean;
    initialSelectedIds: string[];
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
  const [transcriptSourceSaving, setTranscriptSourceSaving] = useState(false);
  const [transcriptSourceError, setTranscriptSourceError] = useState<string | null>(null);
  const isMapRoute = Boolean(pathname?.includes(`/workspaces/${workspaceId}/maps`));
  const routeKey = `${pathname ?? ""}?${searchParams?.toString() ?? ""}`;
  const onboardingRequested = searchParams?.get("onboarding") === "setup";
  const openGoogleDrivePicker = searchParams?.get("googleDrivePicker") === "1";
  const goalsTourEnabled = Boolean(featureFlags?.GOALS);
  const contextMapsTourEnabled = Boolean(featureFlags?.CONTEXT_MAPS);
  const agentGovernanceTourEnabled = Boolean(featureFlags?.AGENT_GOVERNANCE && capabilities?.canManageAgentGovernance);
  const transcriptImportPath = featureFlags?.TOOL_LINKS
    ? "/tools?type=TOOL&q=meeting%20transcripts"
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
        href: transcriptImportPath,
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
  }, [t, goalsTourEnabled, contextMapsTourEnabled, agentGovernanceTourEnabled, transcriptImportPath]);

  const markCompleted = useCallback(async () => {
    completedRef.current = true;
    setCompleted(true);
    await fetch(`/api/workspaces/${workspaceId}/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tourKey, tourVersion }),
    }).catch(() => undefined);
  }, [tourKey, tourVersion, workspaceId]);

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
    void markCompleted().finally(() => {
      if (!hasContextRef.current) {
        setSetupMode("setupReturn");
      }
    });
  }, [markCompleted]);

  const initDriver = useCallback(() => {
    const driverObj = driver({
      showProgress: true,
      animate: true,
      allowClose: false,
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
    });

    return driverObj;
  }, [finishTour, router, tourSteps, workspaceId]);

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

  const openTranscriptImport = useCallback(async () => {
    setTranscriptSourceSaving(true);
    setTranscriptSourceError(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/onboarding/meeting-transcript-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseApiError(data, t("transcriptSourcesErrorSave")));
      }
      setSetupMessage(t("transcriptSourcesInitialized"));
      setSetupMode(null);
      router.push(workspaceStepUrl(workspaceId, transcriptImportPath));
    } catch (error) {
      setTranscriptSourceError(error instanceof Error ? error.message : t("transcriptSourcesErrorSave"));
    } finally {
      setTranscriptSourceSaving(false);
    }
  }, [router, t, transcriptImportPath, workspaceId]);

  const handleUploaded = useCallback((count: number) => {
    hasContextRef.current = true;
    setHasContext(true);
    setSetupMessage(t("uploadComplete", { count }));
  }, [t]);

  const handleDriveSynced = useCallback((count: number) => {
    hasContextRef.current = true;
    setHasContext(true);
    setSetupMessage(t("drivePickerComplete", { count }));
    router.refresh();
  }, [router, t]);

  const handleSetupClose = useCallback(() => {
    if (!setupMode) return;

    if (setupMode === "setup") {
      startTour();
      return;
    }

    setSetupMode(null);
    router.refresh();
  }, [router, setupMode, startTour]);

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
              <h3>{t("drivePickerTitle")}</h3>
              <p className="nr-item-meta">{t("drivePickerDescription")}</p>
            </div>
            {googleDrivePicker?.hasDocumentScope ? (
              <GoogleDrivePicker
                workspaceId={workspaceId}
                clientId={googleDrivePicker.clientId}
                developerKey={googleDrivePicker.developerKey}
                appId={googleDrivePicker.appId}
                initialSelectedIds={googleDrivePicker.initialSelectedIds}
                autoOpen={openGoogleDrivePicker}
                onSynced={handleDriveSynced}
              />
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                <p className="nr-item-meta" style={{ margin: 0 }}>
                  {t("drivePickerConnectDescription")}
                </p>
                <a
                  className="button secondary small"
                  href={`/api/integrations/google/connect?workspaceId=${workspaceId}&intent=documents&returnTo=${encodeURIComponent(`/workspaces/${workspaceId}?onboarding=setup&googleDrivePicker=1`)}`}
                >
                  {t("drivePickerConnectAction")}
                </a>
              </div>
            )}
          </section>

          <section className="onboarding-setup-panel stack">
            <div>
              <h3>{t("transcriptSourcesTitle")}</h3>
              <p className="nr-item-meta">{t("transcriptSourcesDescription")}</p>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {transcriptSourceError && <p className="form-message form-message-error">{transcriptSourceError}</p>}
              <div className="actions-inline" style={{ gap: 8 }}>
                <span className="tag">Read.ai</span>
                <span className="tag">Fathom</span>
                <span className="tag">Fireflies</span>
                <span className="tag">{t("transcriptSourcesUploadTag")}</span>
              </div>
              <p className="nr-item-meta">{t("transcriptSourcesReady")}</p>
              <div className="actions-inline">
                <button type="button" className="secondary small" disabled={transcriptSourceSaving} onClick={openTranscriptImport}>
                  {transcriptSourceSaving ? t("transcriptSourcesSaving") : t("transcriptSourcesAction")}
                </button>
                <a className="link-button secondary" href={workspaceStepUrl(workspaceId, transcriptImportPath)}>
                  {t("transcriptSourcesDetailsAction")}
                </a>
              </div>
            </div>
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
            <button type="button" className="ghost" onClick={handleSetupClose}>
              {t("setupLater")}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
