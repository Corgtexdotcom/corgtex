"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../../../demo-tour-theme.css";
import { Dialog } from "@/lib/components/Dialog";

const TOUR_KEY = "self_serve_workspace";
const TOUR_VERSION = "v1";
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
}: {
  workspaceId: string;
  initialCompletedAt: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("onboarding.tour");
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);
  const targetStepIndexRef = useRef<number | null>(null);
  const completedRef = useRef(Boolean(initialCompletedAt));
  const [completed, setCompleted] = useState(Boolean(initialCompletedAt));
  const [showChecklist, setShowChecklist] = useState(false);
  const isMapRoute = Boolean(pathname?.includes(`/workspaces/${workspaceId}/maps`));
  const routeKey = `${pathname ?? ""}?${searchParams?.toString() ?? ""}`;

  const tourSteps: TourStep[] = useMemo(() => [
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
      href: "/brain",
      element: ".ws-main-content",
      popover: {
        title: t("brainTitle"),
        description: t("brainDescription"),
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
      href: "/proposals",
      element: ".ws-main-content",
      popover: {
        title: t("proposalsTitle"),
        description: t("proposalsDescription"),
        side: "top",
      },
    },
    {
      href: "/settings?tab=general",
      element: ".ws-main-content",
      popover: {
        title: t("integrationsTitle"),
        description: t("integrationsDescription"),
        side: "top",
      },
    },
    {
      href: "/settings?tab=members",
      element: ".ws-main-content",
      popover: {
        title: t("membersTitle"),
        description: t("membersDescription"),
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
  ], [t]);

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

    if (!completedRef.current && !isMapRoute) {
      setTimeout(() => {
        driverRef.current?.drive(0);
      }, 1000);
    }

    window.addEventListener(RESTART_EVENT, restartTour);

    return () => {
      window.removeEventListener(RESTART_EVENT, restartTour);
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
      <p className="demo-tour-briefing-copy">{t("checklistDescription")}</p>
      <div className="stack" style={{ gap: 10, marginTop: 16 }}>
        {["invite", "mcp", "calendar", "spend", "context"].map((item) => (
          <div key={item} className="nr-item" style={{ padding: "10px 0" }}>
            <strong className="nr-item-title">{t(`${item}Title`)}</strong>
            <p className="nr-item-meta" style={{ marginTop: 4 }}>{t(`${item}Description`)}</p>
          </div>
        ))}
      </div>
      <div className="demo-tour-briefing-actions">
        <button type="button" onClick={() => setShowChecklist(false)}>
          {t("checklistPrimary")}
        </button>
      </div>
    </Dialog>
  );
}
