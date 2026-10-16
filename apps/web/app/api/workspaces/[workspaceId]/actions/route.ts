import { NextResponse } from "next/server";
import { z } from "zod";
import { actionRequestSource, createAction, getWorkspacePermanentPathForEntity, listActions } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import type { ActionStatus } from "@prisma/client";
import { searchParamValues } from "@/lib/filter-query";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { loadActionWorkItemResponse, serializeActionWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";
import { normalizeWorkItemSort } from "@/lib/work-item-view";
import { env } from "@corgtex/shared";

const ACTION_STATUSES: ActionStatus[] = ["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"];
const ARCHIVE_FILTERS: ArchiveFilter[] = ["active", "archived", "all"];
const createActionSchema = z.object({
  title: z.string().trim().min(1),
  bodyMd: z.string().optional().nullable(),
  assigneeMemberId: z.string().optional().nullable(),
  priority: z.union([z.number().int(), z.string()]).optional().nullable(),
  priorityLabel: z.string().optional().nullable(),
}).strip();

function parseActionStatus(value: string | null): ActionStatus | undefined {
  if (!value || value === "ALL") return undefined;
  return ACTION_STATUSES.includes(value as ActionStatus) ? value as ActionStatus : undefined;
}

function parseArchiveFilter(value: string | null): ArchiveFilter | undefined {
  return ARCHIVE_FILTERS.includes(value as ArchiveFilter) ? value as ArchiveFilter : undefined;
}

function parseNonNegativeInt(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const GET = withWorkspaceRoute(async (req, { actor, workspaceId }) => {
  const searchParams = req.nextUrl.searchParams;
  const actions = await listActions(actor, workspaceId, {
    archiveFilter: parseArchiveFilter(searchParams.get("archiveFilter")),
    status: parseActionStatus(searchParams.get("status")),
    circleIds: searchParamValues(searchParams.getAll("circleId")),
    assigneeMemberIds: searchParamValues(searchParams.getAll("assigneeMemberId")),
    memberIds: searchParamValues(searchParams.getAll("memberId")),
    sort: normalizeWorkItemSort(searchParams.get("sort") ?? undefined),
    take: parseNonNegativeInt(searchParams.get("take")),
    skip: parseNonNegativeInt(searchParams.get("skip")),
  });
  return NextResponse.json({
    actions: {
      ...actions,
      items: actions.items.map(serializeActionWorkItem),
    },
  });
});

export const POST = withWorkspaceRoute(async (req, { actor, workspaceId, membership }) => {
  const body = await validateBody(req, createActionSchema);
  const action = await createAction(actor, {
    workspaceId,
    title: body.title,
    bodyMd: body.bodyMd ?? null,
    assigneeMemberId: body.assigneeMemberId,
    priority: workItemPriorityFromBody(body),
    _membership: membership ?? undefined,
    source: req.headers.has("Idempotency-Key")
      ? actionRequestSource("API_REQUEST", actor.kind === "user" ? actor.user.id : actor.credentialId ?? actor.agentIdentityId ?? actor.label, req.headers.get("Idempotency-Key") ?? "")
      : undefined,
  });
  const origin = env.APP_URL.replace(/\/$/, "");
  const permanentPath = await getWorkspacePermanentPathForEntity({ workspaceId, entityType: "Action", entityId: action.id });
  const actionForResponse = await loadActionWorkItemResponse(workspaceId, action.id) ?? action;
  return NextResponse.json({
    action: serializeActionWorkItem(actionForResponse),
    webUrl: `${origin}/workspaces/${workspaceId}/actions/${action.id}`,
    permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
  }, { status: 201 });
});
