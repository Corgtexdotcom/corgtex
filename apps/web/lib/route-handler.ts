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
      return handleRouteError(error, { request: req });
    }
  };
}

export function withWorkspaceRoute(
  handler: (
    req: NextRequest,
    context: {
      actor: AppActor;
      membership: MembershipSummary | undefined;
      workspaceId: string;
      params: Record<string, string>;
    }
  ) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: RouteContext) => {
    let actorKind: AppActor["kind"] | undefined;
    let workspaceId: string | undefined;
    try {
      const actor = await resolveRequestActor(req);
      actorKind = actor.kind;
      const params = await ctx.params;
      workspaceId = params.workspaceId;
      const membership = await requireWorkspaceMembership({ actor, workspaceId });
      return await handler(req, { actor, membership: membership ?? undefined, workspaceId, params });
    } catch (error) {
      return handleRouteError(error, { actorKind, request: req, workspaceId });
    }
  };
}
