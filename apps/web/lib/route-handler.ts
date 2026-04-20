import { NextRequest, NextResponse } from "next/server";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireWorkspaceMembership } from "@corgtex/domain";
import type { AppActor, MembershipSummary } from "@corgtex/shared";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

export function withRoute<T>(
  handler: (req: NextRequest, ctx: RouteContext) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: RouteContext) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function withWorkspaceRoute(
  handler: (
    req: NextRequest,
    context: {
      actor: AppActor;
      membership: MembershipSummary | null;
      workspaceId: string;
      params: Record<string, string>;
    }
  ) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: RouteContext) => {
    try {
      const actor = await resolveRequestActor(req);
      const params = await ctx.params;
      const workspaceId = params.workspaceId;
      const membership = await requireWorkspaceMembership({ actor, workspaceId });
      return await handler(req, { actor, membership, workspaceId, params });
    } catch (error) {
      return handleRouteError(error);
    }
  };
}
