import { NextRequest, NextResponse } from "next/server";
import { createAction, getWorkspacePermanentPathForEntity, listActions } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { env } from "@corgtex/shared";

export const GET = withWorkspaceRoute(async (req, { actor, workspaceId }) => {
  const archiveFilter = req.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
  const actions = await listActions(actor, workspaceId, { archiveFilter: archiveFilter ?? undefined });
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
  const origin = env.APP_URL.replace(/\/$/, "");
  const permanentPath = await getWorkspacePermanentPathForEntity({ workspaceId, entityType: "Action", entityId: action.id });
  return NextResponse.json({
    action,
    webUrl: `${origin}/workspaces/${workspaceId}/actions/${action.id}`,
    permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
  }, { status: 201 });
});
