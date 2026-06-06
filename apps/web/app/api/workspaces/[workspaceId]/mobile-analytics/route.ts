import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma, toInputJson } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { capturePostHogEvent } from "@/lib/posthog-server";

const analyticsSchema = z.object({
  eventName: z.enum(["mode_viewed", "mode_changed"]),
  mode: z.enum(["workspace", "ai"]),
  previousMode: z.enum(["workspace", "ai"]).optional(),
  source: z.string().trim().max(48).optional(),
  route: z.string().trim().max(256).optional(),
  viewportWidth: z.number().int().min(1).max(4000).optional(),
  coarsePointer: z.boolean().optional(),
});

type Params = {
  params: Promise<{ workspaceId: string }>;
};

function actorUserId(actor: Awaited<ReturnType<typeof resolveRequestActor>>) {
  return actor.kind === "user" ? actor.user.id : null;
}

export async function POST(request: NextRequest, { params }: Params) {
  let workspaceId: string | undefined;
  try {
    ({ workspaceId } = await params);
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, analyticsSchema);

    await requireWorkspaceMembership({ actor, workspaceId });

    if (body.previousMode && body.previousMode === body.mode && body.eventName === "mode_changed") {
      throw new AppError(400, "VALIDATION_ERROR", "Mode change events must include a different previous mode.");
    }

    const actorId = actorUserId(actor);
    const serverReceivedAt = new Date().toISOString();

    await prisma.productAnalyticsEvent.create({
      data: {
        workspaceId,
        actorUserId: actorId,
        eventName: body.eventName,
        surface: "mobile_mode",
        mode: body.mode,
        previousMode: body.previousMode ?? null,
        source: body.source ?? "unknown",
        route: body.route ?? null,
        viewportWidth: body.viewportWidth ?? null,
        coarsePointer: body.coarsePointer ?? null,
        meta: toInputJson({
          serverReceivedAt,
        }),
      },
    });
    await capturePostHogEvent({
      event: `corgtex_mobile_${body.eventName}`,
      distinctId: actorId ? `user:${actorId}` : `workspace:${workspaceId}`,
      properties: {
        workspace_id: workspaceId,
        actor_kind: actor.kind,
        surface: "mobile_mode",
        mode: body.mode,
        previous_mode: body.previousMode,
        source: body.source ?? "unknown",
        route: body.route,
        viewport_width: body.viewportWidth,
        coarse_pointer: body.coarsePointer,
        server_received_at: serverReceivedAt,
      },
      timestamp: serverReceivedAt,
    });

    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    return handleRouteError(error, { request, surface: "mobile_mode", workspaceId });
  }
}
