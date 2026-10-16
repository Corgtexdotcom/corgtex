import type { AgentMemberType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { appendEvents } from "./events";
import { closeRoleLifecycleForAgent, endRoleHolderHistory, startRoleHolderHistory } from "./role-onboarding";
import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { readableArtifactIds, invalidateArtifactInputLineage } from "./source-lineage";
import { DigestReadRelease } from "./digest-lineage";
import { AGENT_REGISTRY } from "./agent-registry";
// ---------------------------------------------------------------------------
// CRUD — AgentIdentity
// ---------------------------------------------------------------------------

async function readableIdentityRows<T extends { id: string; createdByUserId: string | null; circleAssignments: Array<{
  id: string; circleId: string; roleId: string | null; circle: { id: string; name: string }; role: { id: string; name: string } | null;
}> }>(release: DigestReadRelease, rows: T[]) {
  const identities = (await release.capture("AgentIdentity", rows)).records;
  const assignments = identities.flatMap((row) => row.circleAssignments);
  const [safeAssignments, circles, roles, authors] = await Promise.all([
    release.capture("CircleAgentAssignment", assignments),
    release.capture("Circle", assignments.map((row) => row.circle)),
    release.capture("Role", assignments.flatMap((row) => row.role ? [row.role] : [])),
    release.capture("User", identities.flatMap((row) => row.createdByUserId ? [{ id: row.createdByUserId }] : [])),
  ]);
  const assignmentIds = new Set(safeAssignments.records.map((row) => row.id)), circleIds = new Set(circles.records.map((row) => row.id));
  const roleIds = new Set(roles.records.map((row) => row.id)), authorIds = new Set(authors.records.map((row) => row.id));
  return identities.map((identity) => ({ ...identity,
    createdByUserId: identity.createdByUserId && authorIds.has(identity.createdByUserId) ? identity.createdByUserId : null,
    circleAssignments: identity.circleAssignments.filter((row) => assignmentIds.has(row.id) && circleIds.has(row.circleId))
      .map((row) => ({ ...row, roleId: row.roleId && roleIds.has(row.roleId) ? row.roleId : null,
        role: row.role && roleIds.has(row.role.id) ? row.role : null })),
  }));
}

export async function createAgentIdentity(
  actor: AppActor,
  params: ProducerLineageParams & {
    copied?: boolean;
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

  return prisma.$transaction(async (tx) => {
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      capture: params, copied: params.copied || actor.kind !== "user" });
    const identity = await tx.agentIdentity.create({
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

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "AgentIdentity", id: identity.id }, content: identity, receipt });
    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "agent-identity.created",
        aggregateType: "AgentIdentity",
        aggregateId: identity.id,
        payload: { agentIdentityId: identity.id, agentKey: identity.agentKey },
      },
    ]);

    return (await readableArtifactIds(actor, params.workspaceId, "AgentIdentity", [identity], tx)).has(identity.id)
      ? identity : { id: identity.id, contentWithheld: true };
  });
}

export async function updateAgentIdentity(
  actor: AppActor,
  params: ProducerLineageParams & {
    copied?: boolean;
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

  return prisma.$transaction(async (tx) => {
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "AgentIdentity", id: existing.id }, before: existing, capture: params,
      copied: params.copied || actor.kind !== "user" });
    const updated = await tx.agentIdentity.update({
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

    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "AgentIdentity", id: updated.id }, content: updated, receipt });
    if (params.isActive === false && existing.isActive) {
      await closeRoleLifecycleForAgent(tx, {
        workspaceId: params.workspaceId,
        agentIdentityId: params.agentIdentityId,
        actor,
      });
    }

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: params.isActive === false && existing.isActive ? "agent-identity.deactivated" : "agent-identity.updated",
        aggregateType: "AgentIdentity",
        aggregateId: updated.id,
        payload: { agentIdentityId: updated.id, agentKey: updated.agentKey },
      },
    ]);

    return (await readableArtifactIds(actor, params.workspaceId, "AgentIdentity", [updated], tx)).has(updated.id)
      ? updated : { id: updated.id, contentWithheld: true };
  });
}

export async function listAgentIdentities(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const identities = await prisma.agentIdentity.findMany({
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
  const release = new DigestReadRelease(actor, workspaceId);
  return release.finish(await readableIdentityRows(release, identities));
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
  const release = new DigestReadRelease(actor, workspaceId);
  const readable = (await readableIdentityRows(release, [identity]))[0];
  invariant(readable, 404, "NOT_FOUND", "Agent identity not found.");
  const authors = identity.createdByUser ? await release.capture("User", [identity.createdByUser]) : null;
  return release.finish({ ...readable, createdByUser: authors?.records.length ? identity.createdByUser : null });
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

  const archived = await archiveWorkspaceArtifact(actor, {
    workspaceId,
    entityType: "AgentIdentity",
    entityId: agentIdentityId,
    reason: "Archived from agent identity deactivate path.",
  });

  await prisma.$transaction(async (tx) => {
    await closeRoleLifecycleForAgent(tx, {
      workspaceId,
      agentIdentityId,
      actor,
    });

    await appendEvents(tx, [
      {
        workspaceId,
        type: "agent-identity.deactivated",
        aggregateType: "AgentIdentity",
        aggregateId: agentIdentityId,
        payload: { agentIdentityId, agentKey: existing.agentKey },
      },
    ]);
  });

  return archived;
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

  return prisma.$transaction(async (tx) => {
    const identity = await tx.agentIdentity.create({
      data: {
        workspaceId,
        agentKey,
        memberType: "EXTERNAL",
        displayName: label,
        linkedCredentialId: credentialId,
        createdByUserId,
      },
    });

    await invalidateArtifactInputLineage({ tx, workspaceId, artifact: { kind: "AgentIdentity", id: identity.id }, content: identity });
    await appendEvents(tx, [
      {
        workspaceId,
        type: "agent-identity.created",
        aggregateType: "AgentIdentity",
        aggregateId: identity.id,
        payload: { agentIdentityId: identity.id, agentKey: identity.agentKey },
      },
    ]);

    return identity;
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

  const roleId = params.roleId?.trim() || null;
  if (roleId) {
    const role = await prisma.role.findFirst({
      where: {
        id: roleId,
        circleId: params.circleId,
        circle: { workspaceId: params.workspaceId },
        archivedAt: null,
      },
      select: { id: true },
    });
    invariant(role, 404, "NOT_FOUND", "Role not found.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('circle_agent_assignment'), hashtext(${`${params.circleId}:${params.agentIdentityId}`}))
    `;
    const existing = await tx.circleAgentAssignment.findUnique({
      where: {
        circleId_agentIdentityId: {
          circleId: params.circleId,
          agentIdentityId: params.agentIdentityId,
        },
      },
    });

    const assignment = await tx.circleAgentAssignment.upsert({
      where: {
        circleId_agentIdentityId: {
          circleId: params.circleId,
          agentIdentityId: params.agentIdentityId,
        },
      },
      update: { roleId },
      create: {
        circleId: params.circleId,
        agentIdentityId: params.agentIdentityId,
        roleId,
      },
    });

    if (existing?.roleId && existing.roleId !== roleId) {
      await endRoleHolderHistory(tx, {
        workspaceId: params.workspaceId,
        roleId: existing.roleId,
        agentIdentityId: params.agentIdentityId,
        actor,
      });
    }

    if (roleId && existing?.roleId !== roleId) {
      await startRoleHolderHistory(tx, {
        workspaceId: params.workspaceId,
        roleId,
        agentIdentityId: params.agentIdentityId,
        assignmentId: assignment.id,
        actor,
      });
    }

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "agent-identity.circle-assigned",
        aggregateType: "CircleAgentAssignment",
        aggregateId: assignment.id,
        payload: {
          agentIdentityId: params.agentIdentityId,
          circleId: params.circleId,
          roleId,
        },
      },
    ]);

    return assignment;
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

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('circle_agent_assignment'), hashtext(${`${params.circleId}:${params.agentIdentityId}`}))
    `;
    const assignment = await tx.circleAgentAssignment.findUnique({
      where: {
        circleId_agentIdentityId: {
          circleId: params.circleId,
          agentIdentityId: params.agentIdentityId,
        },
      },
    });
    invariant(assignment, 404, "NOT_FOUND", "Circle agent assignment not found.");

    const deleted = await tx.circleAgentAssignment.delete({
      where: { id: assignment.id },
    });

    if (assignment.roleId) {
      await endRoleHolderHistory(tx, {
        workspaceId: params.workspaceId,
        roleId: assignment.roleId,
        agentIdentityId: params.agentIdentityId,
        actor,
      });
    }

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "agent-identity.circle-unassigned",
        aggregateType: "CircleAgentAssignment",
        aggregateId: assignment.id,
        payload: {
          agentIdentityId: params.agentIdentityId,
          circleId: params.circleId,
        },
      },
    ]);

    return deleted;
  });
}

// ---------------------------------------------------------------------------
// Behavior config (agent.md)
// ---------------------------------------------------------------------------

export async function updateAgentBehavior(
  actor: AppActor,
  params: ProducerLineageParams & {
    copied?: boolean;
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

  return prisma.$transaction(async (tx) => {
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "AgentIdentity", id: existing.id }, before: existing, capture: params,
      copied: params.copied || actor.kind !== "user" });
    const updated = await tx.agentIdentity.update({ where: { id: existing.id }, data: { behaviorMd: params.behaviorMd } });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "AgentIdentity", id: updated.id }, content: updated, receipt });
    return (await readableArtifactIds(actor, params.workspaceId, "AgentIdentity", [updated], tx)).has(updated.id)
      ? updated : { id: updated.id, contentWithheld: true };
  });
}

export async function getWorkspaceAgentBehavior(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const record = await prisma.agentIdentity.findUnique({
    where: { workspaceId_agentKey: { workspaceId, agentKey: "__workspace__" } },
  });

  return record && (await readableArtifactIds(actor, workspaceId, "AgentIdentity", [record])).has(record.id)
    ? record.behaviorMd : null;
}

export async function updateWorkspaceAgentBehavior(
  actor: AppActor,
  params: ProducerLineageParams & {
    copied?: boolean;
    workspaceId: string;
    behaviorMd: string;
  },
) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.agentIdentity.findUnique({ where: { workspaceId_agentKey: { workspaceId: params.workspaceId, agentKey: "__workspace__" } } });
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      ...(existing ? { artifact: { kind: "AgentIdentity" as const, id: existing.id }, before: existing } : {}),
      capture: params, copied: params.copied || actor.kind !== "user" });
    const updated = await tx.agentIdentity.upsert({
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
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "AgentIdentity", id: updated.id }, content: updated, receipt });
    return (await readableArtifactIds(actor, params.workspaceId, "AgentIdentity", [updated], tx)).has(updated.id)
      ? updated : { id: updated.id, contentWithheld: true };
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
      await prisma.$transaction(async (tx) => {
        const identity = await tx.agentIdentity.create({
          data: {
            workspaceId,
            agentKey,
            memberType: "INTERNAL",
            displayName: definition.label,
            purposeMd: definition.description,
          },
        });

        await invalidateArtifactInputLineage({ tx, workspaceId, artifact: { kind: "AgentIdentity", id: identity.id }, content: identity });
        await appendEvents(tx, [
          {
            workspaceId,
            type: "agent-identity.created",
            aggregateType: "AgentIdentity",
            aggregateId: identity.id,
            payload: { agentIdentityId: identity.id, agentKey: identity.agentKey },
          },
        ]);
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

export async function resolveAgentBehaviorContext(workspaceId: string, agentKey: string, actor?: AppActor) {
  if (!actor) return null;
  await requireWorkspaceMembership({ actor, workspaceId });
  const [workspaceBehavior, agentIdentity] = await Promise.all([
    prisma.agentIdentity.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey: "__workspace__" } },
    }),
    prisma.agentIdentity.findUnique({
      where: { workspaceId_agentKey: { workspaceId, agentKey } },
    }),
  ]);

  const parts: string[] = [];
  const readableIds = await readableArtifactIds(actor, workspaceId, "AgentIdentity", [workspaceBehavior, agentIdentity].filter((row): row is NonNullable<typeof row> => row !== null));
  if (workspaceBehavior?.behaviorMd && readableIds.has(workspaceBehavior.id)) {
    parts.push(`## Workspace Agent Policy\n\n${workspaceBehavior.behaviorMd}`);
  }
  if (agentIdentity?.isActive && agentIdentity.behaviorMd && readableIds.has(agentIdentity.id)) {
    parts.push(`## Agent-Specific Behavior\n\n${agentIdentity.behaviorMd}`);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}
