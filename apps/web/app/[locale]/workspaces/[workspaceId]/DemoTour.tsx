"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
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

const TOUR_STEPS: TourStep[] = [
  {
    path: "/",
    popover: {
      title: "Welcome to Corgtex",
      description: "You're about to explore how Johnson & Johnson — a $89B company with 138,000 employees — could run on self-management. This demo is populated with real public J&J data.",
    },
  },
  {
    path: "/",
    element: ".ws-main-content",
    popover: {
      title: "Your Daily Newspaper",
      description: "Every morning, this is what you see. A living newspaper of your organization — featured knowledge, recent meetings, active tensions, and to-dos.",
      side: "top",
    },
  },
  {
    path: "/brain",
    element: ".ws-main-content",
    popover: {
      title: "Organizational Memory",
      description: "Every piece of knowledge — from board meetings to R&D reports — is automatically processed by AI into a searchable encyclopedia.",
      side: "top",
    },
  },
  {
    path: "/circles",
    element: ".ws-main-content",
    popover: {
      title: "Structure Without Hierarchy",
      description: "Instead of departments and managers, the organization runs on circles — self-governing teams with clear purposes and distributed authority.",
      side: "top",
    },
  },
  {
    path: "/proposals",
    element: ".ws-main-content",
    popover: {
      title: "Consent-Based Decisions",
      description: "Proposals turn tensions into action through consent-based governance. No politics, no management committees — just reasoned objections.",
      side: "top",
    },
  },
  {
    path: "/",
    element: ".ws-agent-sidebar",
    popover: {
      title: "Ask Anything",
      description: "The AI assistant knows everything in the Brain. Ask it about any topic, draft proposals, or get context for decisions.",
      side: "left",
    },
  },
  {
    path: "/",
    popover: {
      title: "Your Turn to Explore",
      description: "Tour complete! You now have full access to explore Johnson & Johnson's governance through Corgtex. The workspace is read-only, but feel free to click around.",
    },
  }
];

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
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);
  const targetStepIndexRef = useRef<number | null>(null);



  const initDriver = useCallback(() => {
    const driverObj = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      steps: TOUR_STEPS.map((step, index) => ({
        element: step.element,
        popover: {
          ...step.popover,
          onNextClick: () => {
            const nextStep = TOUR_STEPS[index + 1];
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
            const prevStep = TOUR_STEPS[index - 1];
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
  }, [router, workspaceId]);

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
