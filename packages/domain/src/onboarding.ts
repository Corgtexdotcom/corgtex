import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export const SELF_SERVE_WORKSPACE_TOUR_KEY = "self_serve_workspace";
export const SELF_SERVE_WORKSPACE_TOUR_VERSION = "v1";

function requireUserActor(actor: AppActor) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only signed-in users have onboarding state.");
  return actor;
}

function normalizeTour(params?: { tourKey?: string | null; tourVersion?: string | null }) {
  return {
    tourKey: params?.tourKey?.trim() || SELF_SERVE_WORKSPACE_TOUR_KEY,
    tourVersion: params?.tourVersion?.trim() || SELF_SERVE_WORKSPACE_TOUR_VERSION,
  };
}

export async function getUserWorkspaceOnboardingState(actor: AppActor, params: {
  workspaceId: string;
  tourKey?: string | null;
  tourVersion?: string | null;
}) {
  const userActor = requireUserActor(actor);
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const tour = normalizeTour(params);

  const state = await prisma.userWorkspaceOnboardingState.findUnique({
    where: {
      userId_workspaceId_tourKey_tourVersion: {
        userId: userActor.user.id,
        workspaceId: params.workspaceId,
        tourKey: tour.tourKey,
        tourVersion: tour.tourVersion,
      },
    },
    select: {
      id: true,
      tourKey: true,
      tourVersion: true,
      completedAt: true,
      restartedAt: true,
      updatedAt: true,
    },
  });

  return {
    tourKey: tour.tourKey,
    tourVersion: tour.tourVersion,
    completedAt: state?.completedAt ?? null,
    restartedAt: state?.restartedAt ?? null,
    updatedAt: state?.updatedAt ?? null,
  };
}

export async function completeUserWorkspaceOnboarding(actor: AppActor, params: {
  workspaceId: string;
  tourKey?: string | null;
  tourVersion?: string | null;
}) {
  const userActor = requireUserActor(actor);
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const tour = normalizeTour(params);
  const now = new Date();

  const state = await prisma.userWorkspaceOnboardingState.upsert({
    where: {
      userId_workspaceId_tourKey_tourVersion: {
        userId: userActor.user.id,
        workspaceId: params.workspaceId,
        tourKey: tour.tourKey,
        tourVersion: tour.tourVersion,
      },
    },
    create: {
      userId: userActor.user.id,
      workspaceId: params.workspaceId,
      tourKey: tour.tourKey,
      tourVersion: tour.tourVersion,
      completedAt: now,
    },
    update: {
      completedAt: now,
    },
    select: {
      id: true,
      tourKey: true,
      tourVersion: true,
      completedAt: true,
      restartedAt: true,
      updatedAt: true,
    },
  });

  return state;
}
