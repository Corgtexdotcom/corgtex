import { NextRequest, NextResponse } from "next/server";
import { createCircle, listCircles } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const GET = withWorkspaceRoute(async (req, { workspaceId }) => {
  const circles = await listCircles(workspaceId);
  return NextResponse.json({ circles });
});

export const POST = withWorkspaceRoute(async (req, { actor, workspaceId, membership }) => {
  const body = (await req.json()) as { name?: unknown; purposeMd?: unknown; domainMd?: unknown; maturityStage?: unknown };
  const circle = await createCircle(actor, {
    workspaceId,
    name: String(body.name ?? ""),
    purposeMd: typeof body.purposeMd === "string" ? body.purposeMd : null,
    domainMd: typeof body.domainMd === "string" ? body.domainMd : null,
    maturityStage: typeof body.maturityStage === "string" ? body.maturityStage : undefined,
    _membership: membership ?? undefined,
  });
  return NextResponse.json({ circle }, { status: 201 });
});
