import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import {
  listMembersEnriched,
  getMemberProfile,
  updateMember,
  assignRole,
  unassignRole,
} from "@corgtex/domain";
import type { MemberRole } from "@prisma/client";

export const listMembersTool: ModelTool = {
  type: "function",
  function: {
    name: "list_members",
    description: "List all members in the workspace, including their roles and role assignments. Use this to find out who is part of the organization.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const getMemberProfileTool: ModelTool = {
  type: "function",
  function: {
    name: "get_member_profile",
    description: "Get detailed information about a specific member, including their recent activity, meetings, and authored items.",
    parameters: {
      type: "object",
      properties: {
        memberId: { type: "string", description: "The UUID of the member" },
      },
      required: ["memberId"],
    },
  },
};

export const updateMemberTool: ModelTool = {
  type: "function",
  function: {
    name: "update_member",
    description: "Update a member's core workspace role (CONTRIBUTOR, FACILITATOR, ADMIN) or their active status. This requires ADMIN permissions.",
    parameters: {
      type: "object",
      properties: {
        memberId: { type: "string" },
        role: { type: "string", description: "CONTRIBUTOR, FACILITATOR, FINANCE_STEWARD, or ADMIN" },
        isActive: { type: "boolean", description: "Set to false to deactivate the member" },
        displayName: { type: "string" },
      },
      required: ["memberId"],
    },
  },
};

export const assignRoleTool: ModelTool = {
  type: "function",
  function: {
    name: "assign_role",
    description: "Assign a member to a specific governance role within a circle. This requires FACILITATOR or ADMIN permissions.",
    parameters: {
      type: "object",
      properties: {
        roleId: { type: "string", description: "The UUID of the role to assign to the member" },
        memberId: { type: "string", description: "The UUID of the member being assigned the role" },
      },
      required: ["roleId", "memberId"],
    },
  },
};

export const unassignRoleTool: ModelTool = {
  type: "function",
  function: {
    name: "unassign_role",
    description: "Remove a member from a governance role. This requires FACILITATOR or ADMIN permissions.",
    parameters: {
      type: "object",
      properties: {
        roleId: { type: "string", description: "The UUID of the role" },
        memberId: { type: "string", description: "The UUID of the member to unassign" },
      },
      required: ["roleId", "memberId"],
    },
  },
};

export async function listMembersAction(actor: AppActor, ctx: any) {
  const members = await listMembersEnriched(ctx.workspaceId);
  return { members };
}

export async function getMemberProfileAction(actor: AppActor, ctx: any, args: any) {
  const profile = await getMemberProfile(ctx.workspaceId, args.memberId);
  return profile;
}

export async function updateMemberAction(actor: AppActor, ctx: any, args: any) {
  const updated = await updateMember(actor, {
    workspaceId: ctx.workspaceId,
    memberId: args.memberId,
    role: args.role as MemberRole | undefined,
    isActive: args.isActive,
    displayName: args.displayName,
  });
  return { success: true, memberId: updated.id, role: updated.role, isActive: updated.isActive };
}

export async function assignRoleAction(actor: AppActor, ctx: any, args: any) {
  const assignment = await assignRole(actor, {
    workspaceId: ctx.workspaceId,
    roleId: args.roleId,
    memberId: args.memberId,
  });
  return { success: true, assignmentId: assignment.id };
}

export async function unassignRoleAction(actor: AppActor, ctx: any, args: any) {
  await unassignRole(actor, {
    workspaceId: ctx.workspaceId,
    roleId: args.roleId,
    memberId: args.memberId,
  });
  return { success: true };
}
