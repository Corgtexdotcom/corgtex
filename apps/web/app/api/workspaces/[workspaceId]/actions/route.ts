import { NextRequest, NextResponse } from "next/server";
import { createAction, listActions } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const GET = withWorkspaceRoute(async (req, { actor, workspaceId }) => {
  const actions = await listActions(actor, workspaceId);
  return NextResponse.json({ actions });
});

export const POST = withWorkspaceRoute(async (req, { actor, workspaceId, membership }) => {
  const body = (await req.json()) as { title?: unknown; bodyMd?: unknown };
  const action = await createAction(actor, {
    workspaceId,
    title: String(body.title ?? ""),
    bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : null,
    _membership: membership ?? undefined,
  });
  return NextResponse.json({ action }, { status: 201 });
});
