import { NextRequest, NextResponse } from "next/server";
import {
  completeUserWorkspaceOnboarding,
  getUserWorkspaceOnboardingState,
  SELF_SERVE_WORKSPACE_TOUR_KEY,
  SELF_SERVE_WORKSPACE_TOUR_VERSION,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = {
  params: Promise<{ workspaceId: string }>;
};

function tourParams(request: NextRequest) {
  return {
    tourKey: request.nextUrl.searchParams.get("tourKey") || SELF_SERVE_WORKSPACE_TOUR_KEY,
    tourVersion: request.nextUrl.searchParams.get("tourVersion") || SELF_SERVE_WORKSPACE_TOUR_VERSION,
  };
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    const state = await getUserWorkspaceOnboardingState(actor, {
      workspaceId,
      ...tourParams(request),
    });

    return NextResponse.json({
      ...state,
      completedAt: state.completedAt?.toISOString() ?? null,
      restartedAt: state.restartedAt?.toISOString() ?? null,
      updatedAt: state.updatedAt?.toISOString() ?? null,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    const body = await request.json().catch(() => ({}));
    const state = await completeUserWorkspaceOnboarding(actor, {
      workspaceId,
      tourKey: typeof body.tourKey === "string" ? body.tourKey : SELF_SERVE_WORKSPACE_TOUR_KEY,
      tourVersion: typeof body.tourVersion === "string" ? body.tourVersion : SELF_SERVE_WORKSPACE_TOUR_VERSION,
    });

    return NextResponse.json({
      tourKey: state.tourKey,
      tourVersion: state.tourVersion,
      completedAt: state.completedAt?.toISOString() ?? null,
      restartedAt: state.restartedAt?.toISOString() ?? null,
      updatedAt: state.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
