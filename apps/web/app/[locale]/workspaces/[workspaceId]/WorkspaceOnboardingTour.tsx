"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../../../demo-tour-theme.css";
import { Dialog } from "@/lib/components/Dialog";

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

function targetUrl(workspaceId: string, step: TourStep) {
  return `/workspaces/${workspaceId}${step.href === "/" ? "" : step.href}`;
}

function currentUrl() {
  return `${window.location.pathname}${window.location.search}`;
}

export function WorkspaceOnboardingTour({
  workspaceId,
  initialCompletedAt,
  featureFlags,
  capabilities,
}: {
  workspaceId: string;
  initialCompletedAt: string | null;
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
  const [completed, setCompleted] = useState(Boolean(initialCompletedAt));
  const [showChecklist, setShowChecklist] = useState(false);
  const isMapRoute = Boolean(pathname?.includes(`/workspaces/${workspaceId}/maps`));
  const routeKey = `${pathname ?? ""}?${searchParams?.toString() ?? ""}`;
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
      }
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

  const finishTour = useCallback((driverObj: ReturnType<typeof driver>) => {
    markCompleted();
    driverObj.destroy();
    setShowChecklist(true);
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

            const expectedUrl = targetUrl(workspaceId, nextStep);
            if (currentUrl() !== expectedUrl) {
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

            const expectedUrl = targetUrl(workspaceId, prevStep);
            if (currentUrl() !== expectedUrl) {
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
        markCompleted();
        driverObj.destroy();
      },
    });

    return driverObj;
  }, [finishTour, markCompleted, router, tourSteps, workspaceId]);

  const restartTour = useCallback(() => {
    setShowChecklist(false);
    const homePath = `/workspaces/${workspaceId}`;
    if (window.location.pathname !== homePath || window.location.search) {
      targetStepIndexRef.current = 0;
      router.push(homePath);
      return;
    }
    driverRef.current?.drive(0);
  }, [router, workspaceId]);

  useEffect(() => {
    completedRef.current = completed;
  }, [completed]);

  useEffect(() => {
    driverRef.current = initDriver();

    if (!completedRef.current && !isMapRoute && targetStepIndexRef.current === null) {
      autoStartTimerRef.current = setTimeout(() => {
        autoStartTimerRef.current = null;
        if (targetStepIndexRef.current === null) {
          driverRef.current?.drive(0);
        }
      }, 1000);
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
  }, [initDriver, isMapRoute, restartTour]);

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
    <Dialog open={showChecklist} onClose={() => setShowChecklist(false)} title={t("checklistTitle")}>
      <p className="demo-tour-briefing-copy" style={{ marginBottom: 20 }}>{t("checklistDescription")}</p>

      <div className="onboarding-flow">
        <div className="onboarding-step">
          <div className="onboarding-step-indicator">
            <div className="onboarding-step-number">1</div>
            <div className="onboarding-connector" />
          </div>
          <div className="onboarding-step-content">
            <h4 className="onboarding-step-title">{t("uploadTitle")}</h4>
            <p className="onboarding-step-description">{t("uploadDescription")}</p>
            <div className="onboarding-step-action">
              <button
                type="button"
                onClick={() => {
                  setShowChecklist(false);
                  router.push(`/workspaces/${workspaceId}/settings?tab=data-sources`);
                }}
              >
                {t("uploadAction")}
              </button>
            </div>
          </div>
        </div>

        <div className="onboarding-step">
          <div className="onboarding-step-indicator">
            <div className="onboarding-step-number">2</div>
            <div className="onboarding-connector" />
          </div>
          <div className="onboarding-step-content">
            <h4 className="onboarding-step-title">{t("connectRecorderTitle")}</h4>
            <p className="onboarding-step-description">{t("connectRecorderDescription")}</p>
            <div className="onboarding-step-action">
              <button
                type="button"
                onClick={() => {
                  setShowChecklist(false);
                  router.push(`/workspaces/${workspaceId}${meetingRecorderOnboardingPath}`);
                }}
              >
                {t("connectRecorderAction")}
              </button>
            </div>
          </div>
        </div>

        <div className="onboarding-step">
          <div className="onboarding-step-indicator">
            <div className="onboarding-step-number">3</div>
            <div className="onboarding-connector" />
          </div>
          <div className="onboarding-step-content">
            <h4 className="onboarding-step-title">{t("connectClientTitle")}</h4>
            <p className="onboarding-step-description">{t("connectClientDescription")}</p>
            <div className="onboarding-step-action">
              <button
                type="button"
                onClick={() => {
                  setShowChecklist(false);
                  router.push(`/workspaces/${workspaceId}/settings?tab=general`);
                }}
              >
                {t("connectClientAction")}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="demo-tour-briefing-actions" style={{ marginTop: 28, justifyContent: "flex-end" }}>
        <button type="button" className="driver-popover-next-btn" onClick={() => setShowChecklist(false)}>
          {t("checklistPrimary")}
        </button>
      </div>
    </Dialog>
  );
}
