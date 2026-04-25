import type { AgentMemberType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { AGENT_REGISTRY } from "./agent-registry";// ---------------------------------------------------------------------------
// CRUD — AgentIdentity
// ---------------------------------------------------------------------------

export async function createAgentIdentity(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentKey: string;
    memberType?: AgentMemberType;
    displayName: string;
    avatarUrl?: string | null;
    purposeMd?: string | null;
    behaviorMd?: string | null;
    linkedCredentialId?: string | null;
    maxSpendPerRunCents?: number | null;
    maxRunsPerDay?: number | null;
    maxRunsPerHour?: number | null;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const createdByUserId = actor.kind === "user" ? actor.user.id : null;

  return prisma.agentIdentity.create({
    data: {
      workspaceId: params.workspaceId,
      agentKey: params.agentKey,
      memberType: params.memberType ?? "INTERNAL",
      displayName: params.displayName,
      avatarUrl: params.avatarUrl ?? null,
      purposeMd: params.purposeMd ?? null,
      behaviorMd: params.behaviorMd ?? null,
      createdByUserId,
      linkedCredentialId: params.linkedCredentialId ?? null,
      maxSpendPerRunCents: params.maxSpendPerRunCents ?? null,
      maxRunsPerDay: params.maxRunsPerDay ?? null,
      maxRunsPerHour: params.maxRunsPerHour ?? null,
    },
  });
}

export async function updateAgentIdentity(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentIdentityId: string;
    displayName?: string;
    avatarUrl?: string | null;
    purposeMd?: string | null;
    memberType?: AgentMemberType;
    linkedCredentialId?: string | null;
    maxSpendPerRunCents?: number | null;
    maxRunsPerDay?: number | null;
    maxRunsPerHour?: number | null;
    isActive?: boolean;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const existing = await prisma.agentIdentity.findFirst({
    where: { id: params.agentIdentityId, workspaceId: params.workspaceId, archivedAt: null },
  });
  invariant(existing, 404, "NOT_FOUND", "Agent identity not found.");

  return prisma.agentIdentity.update({
    where: { id: params.agentIdentityId },
    data: {
      ...(params.displayName !== undefined && { displayName: params.displayName }),
      ...(params.avatarUrl !== undefined && { avatarUrl: params.avatarUrl }),
      ...(params.purposeMd !== undefined && { purposeMd: params.purposeMd }),
      ...(params.memberType !== undefined && { memberType: params.memberType }),
      ...(params.linkedCredentialId !== undefined && { linkedCredentialId: params.linkedCredentialId }),
      ...(params.maxSpendPerRunCents !== undefined && { maxSpendPerRunCents: params.maxSpendPerRunCents }),
      ...(params.maxRunsPerDay !== undefined && { maxRunsPerDay: params.maxRunsPerDay }),
      ...(params.maxRunsPerHour !== undefined && { maxRunsPerHour: params.maxRunsPerHour }),
      ...(params.isActive !== undefined && { isActive: params.isActive }),
    },
  });
}

export async function listAgentIdentities(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.agentIdentity.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    include: {
      circleAssignments: {
        include: {
          circle: { select: { id: true, name: true } },
          role: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function getAgentIdentity(actor: AppActor, workspaceId: string, agentIdentityId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const identity = await prisma.agentIdentity.findFirst({
    where: { id: agentIdentityId, workspaceId, archivedAt: null },
    include: {
      circleAssignments: {
        include: {
          circle: { select: { id: true, name: true } },
          role: { select: { id: true, name: true } },
        },
      },
      createdByUser: { select: { id: true, displayName: true } },
    },
  });
  invariant(identity, 404, "NOT_FOUND", "Agent identity not found.");
  return identity;
}

export async function deactivateAgentIdentity(
  actor: AppActor,
  workspaceId: string,
  agentIdentityId: string,
) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  const existing = await prisma.agentIdentity.findFirst({
    where: { id: agentIdentityId, workspaceId, archivedAt: null },
  });
  invariant(existing, 404, "NOT_FOUND", "Agent identity not found.");

  return archiveWorkspaceArtifact(actor, {
    workspaceId,
    entityType: "AgentIdentity",
    entityId: agentIdentityId,
    reason: "Archived from agent identity deactivate path.",
  });
}

// ---------------------------------------------------------------------------
// External Agent Linking
// ---------------------------------------------------------------------------

export async function getOrCreateExternalAgentIdentity(
  workspaceId: string,
  credentialId: string,
  label: string,
  createdByUserId: string | null,
) {
  const existing = await prisma.agentIdentity.findFirst({
    where: { workspaceId, linkedCredentialId: credentialId },
  });
  if (existing) {
    return existing;
  }

  // Create a unique key for the external agent using credentialId
  const agentKey = `ext_${credentialId.substring(0, 8)}`;

  return prisma.agentIdentity.create({
    data: {
      workspaceId,
      agentKey,
      memberType: "EXTERNAL",
      displayName: label,
      linkedCredentialId: credentialId,
      createdByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Circle assignment
// ---------------------------------------------------------------------------

export async function assignAgentToCircle(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentIdentityId: string;
    circleId: string;
    roleId?: string | null;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const identity = await prisma.agentIdentity.findFirst({
    where: { id: params.agentIdentityId, workspaceId: params.workspaceId },
  });
  invariant(identity, 404, "NOT_FOUND", "Agent identity not found.");

  const circle = await prisma.circle.findFirst({
    where: { id: params.circleId, workspaceId: params.workspaceId },
  });
  invariant(circle, 404, "NOT_FOUND", "Circle not found.");

  return prisma.circleAgentAssignment.upsert({
    where: {
      circleId_agentIdentityId: {
        circleId: params.circleId,
        agentIdentityId: params.agentIdentityId,
      },
    },
    create: {
      circleId: params.circleId,
      agentIdentityId: params.agentIdentityId,
      roleId: params.roleId ?? null,
    },
    update: {
      roleId: params.roleId ?? null,
    },
  });
}

export async function removeAgentFromCircle(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentIdentityId: string;
    circleId: string;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const assignment = await prisma.circleAgentAssignment.findUnique({
    where: {
      circleId_agentIdentityId: {
        circleId: params.circleId,
        agentIdentityId: params.agentIdentityId,
      },
    },
  });
  invariant(assignment, 404, "NOT_FOUND", "Circle agent assignment not found.");

  return prisma.circleAgentAssignment.delete({
    where: { id: assignment.id },
  });
}

// ---------------------------------------------------------------------------
// Behavior config (agent.md)
// ---------------------------------------------------------------------------

export async function updateAgentBehavior(
  actor: AppActor,
  params: {
    workspaceId: string;
    agentIdentityId: string;
    behaviorMd: string;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const existing = await prisma.agentIdentity.findFirst({
    where: { id: params.agentIdentityId, workspaceId: params.workspaceId },
  });
  invariant(existing, 404, "NOT_FOUND", "Agent identity not found.");

  return prisma.agentIdentity.update({
    where: { id: params.agentIdentityId },
    data: { behaviorMd: params.behaviorMd },
  });
}

export async function getWorkspaceAgentBehavior(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const record = await prisma.agentIdentity.findUnique({
    where: { workspaceId_agentKey: { workspaceId, agentKey: "__workspace__" } },
    select: { behaviorMd: true },
  });

  return record?.behaviorMd ?? null;
}

export async function updateWorkspaceAgentBehavior(
  actor: AppActor,
  params: {
    workspaceId: string;
    behaviorMd: string;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.agentIdentity.upsert({
    where: {
      workspaceId_agentKey: {
        workspaceId: params.workspaceId,
        agentKey: "__workspace__",
      },
    },
    create: {
      workspaceId: params.workspaceId,
      agentKey: "__workspace__",
      displayName: "Workspace Agent Config",
      behaviorMd: params.behaviorMd,
      isActive: false,
    },
    update: {
      behaviorMd: params.behaviorMd,
    },
  });
}

// ---------------------------------------------------------------------------
// Runtime helpers (called from packages/agents)
// ---------------------------------------------------------------------------

export async function seedAgentIdentities(workspaceId: string) {
  for (const [agentKey, definition] of Object.entries(AGENT_REGISTRY)) {
    const existing = await prisma.agentIdentity.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey } },
    });
    if (!existing) {
      await prisma.agentIdentity.create({
        data: {
          workspaceId,
          agentKey,
          memberType: "INTERNAL",
          displayName: definition.label,
          purposeMd: definition.description,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------

export async function resolveAgentIdentityLimits(workspaceId: string, agentKey: string) {
  const identity = await prisma.agentIdentity.findUnique({
    where: { workspaceId_agentKey: { workspaceId, agentKey } },
    select: {
      id: true,
      maxRunsPerDay: true,
      maxRunsPerHour: true,
      maxSpendPerRunCents: true,
      behaviorMd: true,
      isActive: true,
    },
  });

  return identity ?? null;
}

export async function resolveAgentBehaviorContext(workspaceId: string, agentKey: string) {
  const [workspaceBehavior, agentIdentity] = await Promise.all([
    prisma.agentIdentity.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey: "__workspace__" } },
      select: { behaviorMd: true },
    }),
    prisma.agentIdentity.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey } },
      select: { behaviorMd: true },
    }),
  ]);

  const parts: string[] = [];
  if (workspaceBehavior?.behaviorMd) {
    parts.push(`## Workspace Agent Policy\n\n${workspaceBehavior.behaviorMd}`);
  }
  if (agentIdentity?.behaviorMd) {
    parts.push(`## Agent-Specific Behavior\n\n${agentIdentity.behaviorMd}`);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}
