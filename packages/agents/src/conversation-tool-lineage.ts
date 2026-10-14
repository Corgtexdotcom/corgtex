import type { AppActor } from "@corgtex/shared";
import {
  captureArtifactInputProof,
  captureConversationInputReceipt,
  requireWorkspaceMembership,
  sealArtifactInputActor,
  withArtifactInputReadCapture,
  type ConversationInputReceipt,
} from "@corgtex/domain";
import type { ActionStatus, GoalCadence, GoalLevel, GoalStatus, ProposalStatus, TensionStatus } from "@prisma/client";
import type { ConversationPageContext } from "./page-context";
import { getWorkspaceOverview, queryActions, queryGoals, queryOrgStructure, queryProposals, queryTensions } from "./tools/workspace";
import { getMemberProfileAction, listMembersAction } from "./tools/members";
import { listDueRelationshipWorkAction } from "./tools/crm";
import { contextMapToolHandlers } from "./tools/context-map";
import { searchConnectedContextAction, fetchConnectedContextAction } from "./tools/external-mcp";

const trustedReadTools = new Set([
  "get_workspace_overview", "query_tensions", "query_actions", "query_proposals", "query_goals", "query_org_structure",
  "list_members", "get_member_profile", "list_due_relationship_work", "get_context_map_info", "get_selected_context_map_region",
  "search_connected_context", "fetch_connected_context",
]);

type MemberProfileInput = {
  id: string; workspaceId: string; userId: string; role: unknown; isActive: boolean; joinedAt: Date;
  user: { id: string; email: string; displayName: string | null; [key: string]: unknown };
  roleAssignments: Array<{ id: string; roleId: string; memberId: string; assignedAt: Date; expiresAt: Date | null;
    role: { id: string; name: string; purposeMd: string | null; circle: { id: string; name: string; purposeMd: string | null } } }>;
};

async function captureMemberProfile(actor: AppActor, workspaceId: string, member: MemberProfileInput) {
  // A Member stores a bounded identity projection. Profile fields have their own User proof.
  await captureArtifactInputProof(actor, workspaceId, [
    { kind: "Member", id: member.id, snapshot: { ...member,
      user: { id: member.user.id, email: member.user.email, displayName: member.user.displayName } } },
    { kind: "User", id: member.user.id, snapshot: member.user },
  ]);
  return {
    id: member.id, workspaceId: member.workspaceId, userId: member.userId, role: member.role,
    isActive: member.isActive, joinedAt: member.joinedAt, user: member.user,
    roleAssignments: member.roleAssignments.map((assignment) => ({ id: assignment.id, roleId: assignment.roleId,
      memberId: assignment.memberId, assignedAt: assignment.assignedAt, expiresAt: assignment.expiresAt,
      role: { id: assignment.role.id, name: assignment.role.name, purposeMd: assignment.role.purposeMd,
        circle: { id: assignment.role.circle.id, name: assignment.role.circle.name, purposeMd: assignment.role.circle.purposeMd } } })),
  };
}

function workItemSummary(item: { id: string; title: string; bodyMd: string | null; status: string; priority: number; createdAt: Date }) {
  return { id: item.id, title: item.title, bodyMd: item.bodyMd, status: item.status, priority: item.priority, createdAt: item.createdAt };
}

/** Closed dispatch: a receipt cannot certify an arbitrary caller-supplied handler or connector result. */
export async function executeTrustedConversationReadTool(params: {
  actor: AppActor;
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
  pageContext?: ConversationPageContext | null;
  operationScopes?: readonly string[];
}): Promise<{ value: unknown; receipt: ConversationInputReceipt } | null> {
  if (!trustedReadTools.has(params.toolName)) return null;
  sealArtifactInputActor(params.actor);
  params = { ...params, args: structuredClone(params.args), pageContext: structuredClone(params.pageContext),
    operationScopes: params.operationScopes ? Object.freeze([...params.operationScopes]) : undefined };
  const { actor, workspaceId, toolName, args } = params;
  const ctx = { workspaceId, operationScopes: params.operationScopes };
  const captured = await withArtifactInputReadCapture(actor, workspaceId, async () => {
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    if (toolName !== "search_connected_context" && toolName !== "fetch_connected_context") {
      await captureArtifactInputProof(actor, workspaceId, [
        { kind: "Workspace", id: workspaceId },
        ...(membership ? [{ kind: "Member" as const, id: membership.id }] : []),
      ]);
    }
    switch (toolName) {
      case "get_workspace_overview": return getWorkspaceOverview(workspaceId, actor);
      case "query_tensions": return queryTensions(workspaceId, args.status as TensionStatus | undefined, args.assigneeId as string | undefined, args.tensionId as string | undefined, actor);
      case "query_actions": return queryActions(workspaceId, args.status as ActionStatus | undefined, args.assigneeId as string | undefined, args.actionId as string | undefined, actor);
      case "query_proposals": return queryProposals(workspaceId, args.status as ProposalStatus | undefined, actor);
      case "query_goals": return queryGoals(actor, workspaceId, args.cadence as GoalCadence | undefined, args.level as GoalLevel | undefined, args.status as GoalStatus | undefined);
      case "query_org_structure": return queryOrgStructure(workspaceId, actor);
      case "search_connected_context": return searchConnectedContextAction(actor, ctx, args);
      case "fetch_connected_context": return fetchConnectedContextAction(actor, ctx, args);
      case "list_members": {
        const result = await listMembersAction(actor, ctx);
        return { members: await Promise.all(result.members.map((member) => captureMemberProfile(actor, workspaceId, member))) };
      }
      case "get_member_profile": {
        const result = await getMemberProfileAction(actor, ctx, args);
        const member = await captureMemberProfile(actor, workspaceId, result.member);
        // Historical audit notes and raw operational/link metadata have no content receipt.
        return { member: { ...member, assignedActions: result.member.assignedActions.map(workItemSummary),
          assignedTensions: result.member.assignedTensions.map(workItemSummary) }, recentActivity: [],
          meetings: result.meetings.map((meeting) => ({ id: meeting.id, title: meeting.title, status: meeting.status,
            source: meeting.source, summaryMd: meeting.summaryMd, recordedAt: meeting.recordedAt })),
          proposals: result.proposals.map(workItemSummary), authoredTensions: result.authoredTensions.map(workItemSummary) };
      }
      case "list_due_relationship_work": {
        const accountId = args.accountId ?? (params.pageContext?.surface === "crm" ? params.pageContext.selectedIds.accountId : undefined);
        return listDueRelationshipWorkAction(actor, ctx, { ...args, accountId });
      }
      case "get_context_map_info":
      case "get_selected_context_map_region": {
        // Client page titles, snippets, paths and metadata are never echoed under graph proof.
        const page = params.pageContext?.surface === "context-map" ? params.pageContext : null;
        const selectors = { ...args, mapViewId: args.mapViewId ?? page?.mapView.id,
          objectIds: args.objectIds ?? page?.selectedObjectIds, includeStale: args.includeStale ?? page?.includeStale };
        if (typeof selectors.mapViewId === "string") {
          await captureArtifactInputProof(actor, workspaceId, [{ kind: "ContextMapView", id: selectors.mapViewId }]);
        }
        return contextMapToolHandlers[toolName](actor, ctx, selectors);
      }
    }
    throw new Error("Trusted conversation reader has no handler.");
  });
  if (toolName === "search_connected_context" || toolName === "fetch_connected_context") {
    const expected = toolName === "search_connected_context" ? "ExternalMcpConnectionSet" : "ExternalMcpResponseInput";
    if (!captured.roots.some(root => root.kind === expected)) throw new Error("External context has no complete native response receipt.");
  }
  const receipt = await captureConversationInputReceipt({ actor, workspaceId, value: captured.value, trustedRoots: captured.roots });
  return { value: captured.value, receipt };
}
