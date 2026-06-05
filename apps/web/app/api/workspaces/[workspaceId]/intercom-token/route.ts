import { NextRequest, NextResponse } from "next/server";
import {
  AppError,
  requireWorkspaceMembership,
  SELF_SERVE_WORKSPACE_TOUR_KEY,
  SELF_SERVE_WORKSPACE_TOUR_VERSION,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { createIntercomMessengerJwt, intercomApiBase, intercomAppId, intercomMessengerSecret } from "@/lib/intercom";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

type Params = {
  params: Promise<{ workspaceId: string }>;
};

function localeFromRequest(request: NextRequest) {
  const locale = request.nextUrl.searchParams.get("locale")?.trim();
  return locale === "es" ? "es" : "en";
}

function disabledResponse() {
  return NextResponse.json({ enabled: false }, { headers: NO_STORE_HEADERS });
}

function enabledFeatureFlagList(flags: Record<string, boolean>) {
  return Object.entries(flags)
    .filter(([, enabled]) => enabled)
    .map(([flag]) => flag)
    .sort();
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);

    if (actor.kind !== "user") {
      throw new AppError(403, "FORBIDDEN", "Only signed-in users can open Intercom support.");
    }

    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    const appId = intercomAppId();
    const messengerSecret = intercomMessengerSecret();
    if (!appId || !messengerSecret) {
      return disabledResponse();
    }

    const [workspace, featureFlags, onboardingState] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          slug: true,
          name: true,
          plan: true,
        },
      }),
      getWorkspaceFeatureFlags(workspaceId),
      prisma.userWorkspaceOnboardingState.findUnique({
        where: {
          userId_workspaceId_tourKey_tourVersion: {
            userId: actor.user.id,
            workspaceId,
            tourKey: SELF_SERVE_WORKSPACE_TOUR_KEY,
            tourVersion: SELF_SERVE_WORKSPACE_TOUR_VERSION,
          },
        },
        select: {
          completedAt: true,
        },
      }),
    ]);

    if (!workspace) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found.");
    }

    const enabledFeatures = enabledFeatureFlagList(featureFlags);
    const displayName = actor.user.displayName?.trim() || actor.user.email;
    const jwt = createIntercomMessengerJwt({
      user_id: actor.user.id,
      email: actor.user.email,
      name: displayName,
      language_override: localeFromRequest(request),
      corgtex_surface: "web_app",
      corgtex_workspace_id: workspace.id,
      corgtex_workspace_slug: workspace.slug,
      corgtex_workspace_name: workspace.name,
      corgtex_workspace_role: membership?.role ?? "ADMIN",
      corgtex_workspace_plan: workspace.plan,
      corgtex_enabled_features: enabledFeatures.join(","),
      corgtex_enabled_feature_count: enabledFeatures.length,
      corgtex_onboarding_completed: Boolean(onboardingState?.completedAt),
      company: {
        company_id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
        workspace_slug: workspace.slug,
      },
    }, messengerSecret);

    return NextResponse.json({
      enabled: true,
      appId,
      apiBase: intercomApiBase(),
      intercomUserJwt: jwt.token,
      expiresAt: jwt.expiresAt,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return handleRouteError(error);
  }
}
