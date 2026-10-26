"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../../../demo-tour-theme.css";
import { Dialog } from "@/lib/components/Dialog";
import { workspaceRouteMatches, workspaceStepUrl } from "./onboarding-tour-routing";
import { onTourHighlightStarted } from "./tour-accessibility";

interface TourStep {
  path: string;
  element?: string;
  popover: {
    title: string;
    description: string;
    side?: "top" | "bottom" | "left" | "right";
    align?: "start" | "center" | "end";
  };
}

const TOUR_KEY = (id: string) => `corgtex_tour_completed_${id}`;
const BOOK_DEMO_URL = process.env.NEXT_PUBLIC_BOOK_DEMO_URL || "https://calendar.app.google/jJd5yeSuDStVZm896";

function markTourCompleted(workspaceId: string) {
  localStorage.setItem(TOUR_KEY(workspaceId), "true");
}

function isTourCompleted(workspaceId: string) {
  return localStorage.getItem(TOUR_KEY(workspaceId)) === "true";
}

export function DemoTour({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("demo.tour");
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);
  const targetStepRef = useRef<{ index: number; path: string; from: string } | null>(null);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoStartRef = useRef<{ path: string; started: boolean } | null>(null);
  const [showBriefingCta, setShowBriefingCta] = useState(false);
  const isMapRoute = Boolean(pathname?.includes(`/workspaces/${workspaceId}/maps`));

  const clearScheduledStart = useCallback(() => {
    if (startTimerRef.current !== null) {
      clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
  }, []);

  // Programmatic teardown (navigation, restart, unmount) is not a dismissal.
  // Driver.js destroy() bypasses onDestroyStarted and clears its active state.
  const destroyTour = useCallback(() => {
    clearScheduledStart();
    const current = driverRef.current;
    driverRef.current = null;
    current?.destroy();
  }, [clearScheduledStart]);

  const tourSteps: TourStep[] = useMemo(() => [
    {
      path: "/",
      popover: {
        title: t("welcomeTitle"),
        description: t("welcomeDescription"),
      },
    },
    {
      path: "/",
      element: ".ws-main-content",
      popover: {
        title: t("newspaperTitle"),
        description: t("newspaperDescription"),
        side: "top",
      },
    },
    {
      path: "/brain",
      element: ".ws-main-content",
      popover: {
        title: t("memoryTitle"),
        description: t("memoryDescription"),
        side: "top",
      },
    },
    {
      path: "/circles",
      element: ".ws-main-content",
      popover: {
        title: t("structureTitle"),
        description: t("structureDescription"),
        side: "top",
      },
    },
    {
      path: "/proposals",
      element: ".ws-main-content",
      popover: {
        title: t("decisionsTitle"),
        description: t("decisionsDescription"),
        side: "top",
      },
    },
    {
      path: "/meetings",
      element: ".ws-main-content",
      popover: {
        title: t("meetingsTitle"),
        description: t("meetingsDescription"),
        side: "top",
      },
    },
    {
      path: "/",
      popover: {
        title: t("exploreTitle"),
        description: t("exploreDescription"),
      },
    },
  ], [t]);

  const initDriver = useCallback(() => {
    const driverObj = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      onHighlightStarted: onTourHighlightStarted,
      popoverClass: "demo-tour-popover",
      onPopoverRender: (popover) => {
        popover.closeButton.textContent = t("skip");
        popover.closeButton.setAttribute("aria-label", t("skip"));
      },
      steps: tourSteps.map((step, index) => ({
        element: step.element,
        popover: {
          ...step.popover,
          onNextClick: () => {
            const nextStep = tourSteps[index + 1];
            if (!nextStep) {
              markTourCompleted(workspaceId);
              destroyTour();
              setShowBriefingCta(true);
              return;
            }

            const currentPath = window.location.pathname;
            const expectedPath = workspaceStepUrl(workspaceId, nextStep.path);

            if (!workspaceRouteMatches(currentPath, expectedPath)) {
              targetStepRef.current = { index: index + 1, path: expectedPath, from: currentPath };
              destroyTour();
              router.push(expectedPath);
            } else {
              driverObj.moveNext();
            }
          },
          onPrevClick: () => {
            const prevStep = tourSteps[index - 1];
            if (!prevStep) return;

            const currentPath = window.location.pathname;
            const expectedPath = workspaceStepUrl(workspaceId, prevStep.path);

            if (!workspaceRouteMatches(currentPath, expectedPath)) {
              targetStepRef.current = { index: index - 1, path: expectedPath, from: currentPath };
              destroyTour();
              router.push(expectedPath);
            } else {
              driverObj.movePrevious();
            }
          }
        }
      })),
      // Escape, overlay click and Skip all pass through this user-dismissal hook.
      onDestroyStarted: () => {
        targetStepRef.current = null;
        markTourCompleted(workspaceId);
        destroyTour();
      },
    });

    return driverObj;
  }, [destroyTour, router, t, tourSteps, workspaceId]);

  const restartTour = useCallback(() => {
    setShowBriefingCta(false);
    destroyTour();
    targetStepRef.current = null;
    autoStartRef.current = { path: window.location.pathname, started: true };

    const homePath = workspaceStepUrl(workspaceId, "/");
    const navigateHome = !workspaceRouteMatches(window.location.pathname, homePath);
    if (navigateHome) {
      targetStepRef.current = { index: 0, path: homePath, from: window.location.pathname };
    }

    // Explicit Restart supersedes any in-flight navigation, even after Escape.
    router.push(homePath);
    if (navigateHome) return;
    driverRef.current = initDriver();
    driverRef.current.drive(0);
  }, [destroyTour, initDriver, router, workspaceId]);

  useEffect(() => {
    const handleRestart = () => restartTour();
    const handleEscape = (event: KeyboardEvent) => {
      // A route transition temporarily has no Driver overlay to receive Escape.
      if (event.key === "Escape" && targetStepRef.current !== null) {
        targetStepRef.current = null;
        markTourCompleted(workspaceId);
        destroyTour();
      }
    };
    window.addEventListener("corgtex:restart-tour", handleRestart);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("corgtex:restart-tour", handleRestart);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [destroyTour, restartTour, workspaceId]);

  useEffect(() => {
    const currentPath = pathname ?? window.location.pathname;
    const target = targetStepRef.current;
    if (target) {
      if (workspaceRouteMatches(currentPath, target.path)) {
        startTimerRef.current = setTimeout(() => {
          startTimerRef.current = null;
          targetStepRef.current = null;
          driverRef.current = initDriver();
          driverRef.current.drive(target.index);
        }, 500);
      } else if (!workspaceRouteMatches(currentPath, target.from)) {
        // A redirect or unrelated navigation interrupts the requested step.
        targetStepRef.current = null;
      }
    } else if (!isMapRoute && !isTourCompleted(workspaceId)) {
      autoStartRef.current ??= { path: currentPath, started: false };
      const initial = autoStartRef.current;
      if (initial.path !== currentPath) initial.started = true;
      if (!initial.started && initial.path === currentPath) {
        startTimerRef.current = setTimeout(() => {
          startTimerRef.current = null;
          initial.started = true;
          driverRef.current = initDriver();
          driverRef.current.drive(0);
        }, 1000);
      }
    }

    return destroyTour;
  }, [destroyTour, initDriver, isMapRoute, pathname, workspaceId]);

  const keepExploring = useCallback(() => {
    setShowBriefingCta(false);
  }, []);

  const scheduleBriefing = useCallback(() => {
    window.open(BOOK_DEMO_URL, "_blank", "noopener,noreferrer");
    setShowBriefingCta(false);
  }, []);

  return (
    <Dialog open={showBriefingCta} onClose={keepExploring} title={t("briefingCtaTitle")}>
      <p className="demo-tour-briefing-copy">{t("briefingCtaDescription")}</p>
      <div className="demo-tour-briefing-actions">
        <button type="button" onClick={scheduleBriefing}>
          {t("briefingCtaPrimary")}
        </button>
        <button type="button" className="secondary" onClick={keepExploring}>
          {t("briefingCtaSecondary")}
        </button>
      </div>
    </Dialog>
  );
}
