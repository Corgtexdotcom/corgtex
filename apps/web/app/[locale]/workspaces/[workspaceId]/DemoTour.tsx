"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "../../../demo-tour-theme.css";

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
  const targetStepIndexRef = useRef<number | null>(null);

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
      path: "/",
      element: ".ws-agent-sidebar",
      popover: {
        title: t("askTitle"),
        description: t("askDescription"),
        side: "left",
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
      steps: tourSteps.map((step, index) => ({
        element: step.element,
        popover: {
          ...step.popover,
          onNextClick: () => {
            const nextStep = tourSteps[index + 1];
            if (!nextStep) {
              markTourCompleted(workspaceId);
              driverObj.destroy();
              return;
            }

            const currentPath = window.location.pathname;
            const expectedPath = `/workspaces/${workspaceId}${nextStep.path === "/" ? "" : nextStep.path}`;

            if (currentPath !== expectedPath) {
              targetStepIndexRef.current = index + 1;
              router.push(expectedPath);
              driverObj.destroy(); // Temporarily kill overlay during nav
            } else {
              driverObj.moveNext();
            }
          },
          onPrevClick: () => {
            const prevStep = tourSteps[index - 1];
            if (!prevStep) return;

            const currentPath = window.location.pathname;
            const expectedPath = `/workspaces/${workspaceId}${prevStep.path === "/" ? "" : prevStep.path}`;

            if (currentPath !== expectedPath) {
              targetStepIndexRef.current = index - 1;
              router.push(expectedPath);
              driverObj.destroy();
            } else {
              driverObj.movePrevious();
            }
          }
        }
      })),
      onCloseClick: () => {
        markTourCompleted(workspaceId);
        driverObj.destroy();
      },
    });

    return driverObj;
  }, [router, tourSteps, workspaceId]);

  const restartTour = useCallback(() => {
    const homePath = `/workspaces/${workspaceId}`;
    if (window.location.pathname !== homePath) {
      targetStepIndexRef.current = 0;
      router.push(homePath);
      return;
    }

    driverRef.current?.drive(0);
  }, [router, workspaceId]);

  useEffect(() => {
    const completed = isTourCompleted(workspaceId);
    
    driverRef.current = initDriver();

    if (!completed) {
      // Start tour on first visit after a brief delay
      setTimeout(() => {
        driverRef.current?.drive(0);
      }, 1000);
    }

    // Listen for custom restart event
    const handleRestart = () => restartTour();

    window.addEventListener("corgtex:restart-tour", handleRestart);
    
    return () => {
      window.removeEventListener("corgtex:restart-tour", handleRestart);
      if (targetStepIndexRef.current === null) {
        driverRef.current?.destroy();
      }
    };
  }, [workspaceId, initDriver, restartTour]);

  useEffect(() => {
    // Handle cross-page navigation continuation
    if (targetStepIndexRef.current !== null) {
      const targetIndex = targetStepIndexRef.current;
      targetStepIndexRef.current = null;
      
      // Wait for DOM to settle after page transition
      setTimeout(() => {
        // Force re-init if destroyed by navigation
        driverRef.current = initDriver();
        driverRef.current.drive(targetIndex);
      }, 500);
    }
  }, [pathname, initDriver]);



  return null;
}
