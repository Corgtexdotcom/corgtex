import { prisma } from "@corgtex/shared";
import {
  contextGraphSystemActor,
  attachContextGraphEvidence,
  syncContextGraphForMeeting,
  upsertContextGraphObject,
  upsertContextGraphRelationship,
  type ContextGraphObjectType,
} from "@corgtex/domain";

type ContextGraphSyncPayload = {
  sourceType?: string;
  sourceId?: string;
};

function statusForRecord(status: string | null | undefined) {
  if (!status) return "approved";
  if (["DRAFT", "SUGGESTED"].includes(status)) return "proposed";
  if (["DISMISSED", "ARCHIVED"].includes(status)) return "archived";
  return "approved";
}

function goalGraphStatus(goal: { status: string; archivedAt: Date | null }) {
  if (goal.archivedAt || goal.status === "ABANDONED") return "archived";
  if (goal.status === "DRAFT") return "proposed";
  return "approved";
}

function isPrivateDraftGoal(goal: { isPrivate?: boolean | null; status: string }) {
  return goal.isPrivate === true && goal.status === "DRAFT";
}

async function archiveGoalGraphFacts(workspaceId: string, goalId: string) {
  await Promise.all([
    prisma.contextGraphObject.updateMany({
      where: {
        workspaceId,
        sourceEntityType: "Goal",
        sourceEntityId: goalId,
        status: { not: "archived" },
      },
      data: { status: "archived" },
    }),
    prisma.contextGraphRelationship.updateMany({
      where: {
        workspaceId,
        sourceEntityType: "Goal",
        sourceEntityId: goalId,
        status: { not: "archived" },
      },
      data: { status: "archived" },
    }),
  ]);
}

function articleTypeToObjectType(type: string): ContextGraphObjectType {
  if (type === "PROCESS") return "Process";
  if (type === "DECISION") return "Decision";
  if (type === "TEAM") return "Team";
  if (type === "PERSON") return "Person";
  if (type === "CUSTOMER") return "Customer";
  if (type === "PROJECT") return "Project";
  if (type === "POLICY" || type === "RUNBOOK") return "Policy";
  if (type === "PRODUCT" || type === "INTEGRATION") return "Tool";
  if (type === "INCIDENT") return "Risk";
  return "Document";
}

export async function handleContextGraphSync(
  _jobId: string,
  payload: ContextGraphSyncPayload,
  workspaceId: string,
) {
  if (!payload.sourceType || !payload.sourceId) return;
  const actor = contextGraphSystemActor(workspaceId);

  if (payload.sourceType === "MEETING") {
    await syncContextGraphForMeeting(actor, { workspaceId, meetingId: payload.sourceId });
    return;
  }

  if (payload.sourceType === "ACTION") {
    const action = await prisma.action.findFirst({
      where: { id: payload.sourceId, workspaceId, archivedAt: null },
      include: {
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
        circle: { select: { id: true, name: true, purposeMd: true } },
      },
    });
    if (!action) return;
    const object = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Task",
      title: action.title,
      summary: action.bodyMd,
      status: statusForRecord(action.status),
      sourceEntityType: "Action",
      sourceEntityId: action.id,
      validFrom: action.createdAt,
      lastVerifiedAt: action.updatedAt,
      properties: {
        status: action.status,
        dueAt: action.dueAt?.toISOString() ?? null,
        assignee: action.assigneeMember?.user.displayName ?? null,
      },
    });
    if (action.circle) {
      const circle = await upsertContextGraphObject(actor, {
        workspaceId,
        objectType: "Team",
        title: action.circle.name,
        summary: action.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: action.circle.id,
      });
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: object.id,
        targetObjectId: circle.id,
        relationshipType: "part_of",
        status: "approved",
        sourceEntityType: "Action",
        sourceEntityId: action.id,
      });
    }
    return;
  }

  if (payload.sourceType === "TENSION") {
    const tension = await prisma.tension.findFirst({
      where: { id: payload.sourceId, workspaceId },
      include: {
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
        circle: { select: { id: true, name: true, purposeMd: true } },
      },
    });
    if (!tension) return;
    const object = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Risk",
      title: tension.title,
      summary: tension.bodyMd,
      status: statusForRecord(tension.status),
      sourceEntityType: "Tension",
      sourceEntityId: tension.id,
      validFrom: tension.createdAt,
      lastVerifiedAt: tension.updatedAt,
      properties: {
        status: tension.status,
        priority: tension.priority,
        assignee: tension.assigneeMember?.user.displayName ?? null,
      },
    });
    if (tension.circle) {
      const circle = await upsertContextGraphObject(actor, {
        workspaceId,
        objectType: "Team",
        title: tension.circle.name,
        summary: tension.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: tension.circle.id,
      });
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: object.id,
        targetObjectId: circle.id,
        relationshipType: "part_of",
        status: "approved",
        sourceEntityType: "Tension",
        sourceEntityId: tension.id,
      });
    }
    return;
  }

  if (payload.sourceType === "PROPOSAL") {
    const proposal = await prisma.proposal.findFirst({
      where: { id: payload.sourceId, workspaceId },
      include: { circle: { select: { id: true, name: true, purposeMd: true } } },
    });
    if (!proposal) return;
    const object = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: proposal.status === "RESOLVED" ? "Decision" : "Hypothesis",
      title: proposal.title,
      summary: [proposal.summary, proposal.bodyMd].filter(Boolean).join("\n\n"),
      status: statusForRecord(proposal.status),
      sourceEntityType: "Proposal",
      sourceEntityId: proposal.id,
      validFrom: proposal.createdAt,
      lastVerifiedAt: proposal.updatedAt,
      properties: {
        status: proposal.status,
        resolutionOutcome: proposal.resolutionOutcome,
      },
    });
    if (proposal.circle) {
      const circle = await upsertContextGraphObject(actor, {
        workspaceId,
        objectType: "Team",
        title: proposal.circle.name,
        summary: proposal.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: proposal.circle.id,
      });
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: object.id,
        targetObjectId: circle.id,
        relationshipType: "part_of",
        status: "approved",
        sourceEntityType: "Proposal",
        sourceEntityId: proposal.id,
      });
    }
    return;
  }

  if (payload.sourceType === "CIRCLE") {
    const circle = await prisma.circle.findFirst({ where: { id: payload.sourceId, workspaceId } });
    if (!circle) return;
    const object = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Team",
      title: circle.name,
      summary: [circle.purposeMd, circle.domainMd].filter(Boolean).join("\n\n"),
      status: circle.archivedAt ? "archived" : "approved",
      sourceEntityType: "Circle",
      sourceEntityId: circle.id,
      validFrom: circle.createdAt,
      lastVerifiedAt: circle.updatedAt,
    });
    if (circle.parentCircleId) {
      const parent = await prisma.circle.findFirst({ where: { id: circle.parentCircleId, workspaceId } });
      if (parent) {
        const parentObject = await upsertContextGraphObject(actor, {
          workspaceId,
          objectType: "Team",
          title: parent.name,
          summary: parent.purposeMd,
          status: parent.archivedAt ? "archived" : "approved",
          sourceEntityType: "Circle",
          sourceEntityId: parent.id,
        });
        await upsertContextGraphRelationship(actor, {
          workspaceId,
          sourceObjectId: object.id,
          targetObjectId: parentObject.id,
          relationshipType: "part_of",
          status: "approved",
          sourceEntityType: "Circle",
          sourceEntityId: circle.id,
        });
      }
    }
    return;
  }

  if (payload.sourceType === "ROLE") {
    const role = await prisma.role.findFirst({
      where: { id: payload.sourceId, circle: { workspaceId } },
      include: { circle: true },
    });
    if (!role) return;
    const roleObject = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Role",
      title: role.name,
      summary: [role.purposeMd, role.accountabilities.map((item) => `- ${item}`).join("\n")].filter(Boolean).join("\n\n"),
      status: role.archivedAt ? "archived" : "approved",
      sourceEntityType: "Role",
      sourceEntityId: role.id,
      validFrom: role.createdAt,
      lastVerifiedAt: role.updatedAt,
      properties: { accountabilities: role.accountabilities, artifacts: role.artifacts },
    });
    const circleObject = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Team",
      title: role.circle.name,
      summary: role.circle.purposeMd,
      status: role.circle.archivedAt ? "archived" : "approved",
      sourceEntityType: "Circle",
      sourceEntityId: role.circle.id,
    });
    await upsertContextGraphRelationship(actor, {
      workspaceId,
      sourceObjectId: roleObject.id,
      targetObjectId: circleObject.id,
      relationshipType: "part_of",
      status: "approved",
      sourceEntityType: "Role",
      sourceEntityId: role.id,
    });
    return;
  }

  if (payload.sourceType === "MEMBER") {
    const member = await prisma.member.findFirst({
      where: { id: payload.sourceId, workspaceId },
      include: {
        user: { select: { displayName: true, email: true } },
        roleAssignments: {
          include: {
            role: { include: { circle: true } },
          },
        },
      },
    });
    if (!member) return;
    const person = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Person",
      title: member.user.displayName?.trim() || member.user.email,
      status: member.isActive ? "approved" : "archived",
      sourceEntityType: "Member",
      sourceEntityId: member.id,
      validFrom: member.joinedAt,
      properties: {
        workspaceRole: member.role,
        isActive: member.isActive,
      },
    });

    const desiredEdges = new Map<string, { targetObjectId: string; relationshipType: "member_of" | "assigned_to" }>();
    if (member.isActive) {
      for (const assignment of member.roleAssignments) {
        if (assignment.role.archivedAt) continue;
        const roleObject = await upsertContextGraphObject(actor, {
          workspaceId,
          objectType: "Role",
          title: assignment.role.name,
          summary: assignment.role.purposeMd,
          status: "approved",
          sourceEntityType: "Role",
          sourceEntityId: assignment.role.id,
        });
        const circleObject = await upsertContextGraphObject(actor, {
          workspaceId,
          objectType: "Team",
          title: assignment.role.circle.name,
          summary: assignment.role.circle.purposeMd,
          status: assignment.role.circle.archivedAt ? "archived" : "approved",
          sourceEntityType: "Circle",
          sourceEntityId: assignment.role.circle.id,
        });
        desiredEdges.set(`assigned_to:${roleObject.id}`, { targetObjectId: roleObject.id, relationshipType: "assigned_to" });
        desiredEdges.set(`member_of:${circleObject.id}`, { targetObjectId: circleObject.id, relationshipType: "member_of" });
      }
    }
    for (const edge of desiredEdges.values()) {
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: person.id,
        targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType,
        status: "approved",
        sourceEntityType: "Member",
        sourceEntityId: member.id,
      });
    }
    const existingEdges = await prisma.contextGraphRelationship.findMany({
      where: {
        workspaceId,
        sourceEntityType: "Member",
        sourceEntityId: member.id,
        status: { not: "archived" },
      },
      select: { sourceObjectId: true, targetObjectId: true, relationshipType: true },
    });
    for (const edge of existingEdges) {
      if (desiredEdges.has(`${edge.relationshipType}:${edge.targetObjectId}`)) continue;
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: edge.sourceObjectId,
        targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType,
        status: "archived",
        sourceEntityType: "Member",
        sourceEntityId: member.id,
      });
    }
    return;
  }

  if (payload.sourceType === "AGENT_IDENTITY") {
    const identity = await prisma.agentIdentity.findFirst({
      where: { id: payload.sourceId, workspaceId },
      include: {
        circleAssignments: {
          include: {
            circle: { select: { id: true, name: true, purposeMd: true, archivedAt: true } },
            role: { select: { id: true, name: true, purposeMd: true, archivedAt: true } },
          },
        },
      },
    });
    if (!identity) return;
    const active = identity.isActive && !identity.archivedAt;
    const agentObject = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Agent",
      title: identity.displayName,
      summary: identity.purposeMd,
      status: active ? "approved" : "archived",
      sourceEntityType: "AgentIdentity",
      sourceEntityId: identity.id,
      validFrom: identity.createdAt,
      lastVerifiedAt: identity.updatedAt,
      properties: {
        agentKey: identity.agentKey,
        memberType: identity.memberType,
        isActive: identity.isActive,
      },
    });

    const desiredEdges = new Map<string, { targetObjectId: string; relationshipType: "member_of" | "assigned_to" }>();
    if (active) {
      for (const assignment of identity.circleAssignments) {
        if (!assignment.circle.archivedAt) {
          const circleObject = await upsertContextGraphObject(actor, {
            workspaceId,
            objectType: "Team",
            title: assignment.circle.name,
            summary: assignment.circle.purposeMd,
            status: "approved",
            sourceEntityType: "Circle",
            sourceEntityId: assignment.circle.id,
          });
          desiredEdges.set(`member_of:${circleObject.id}`, { targetObjectId: circleObject.id, relationshipType: "member_of" });
        }
        if (assignment.role && !assignment.role.archivedAt) {
          const roleObject = await upsertContextGraphObject(actor, {
            workspaceId,
            objectType: "Role",
            title: assignment.role.name,
            summary: assignment.role.purposeMd,
            status: "approved",
            sourceEntityType: "Role",
            sourceEntityId: assignment.role.id,
          });
          desiredEdges.set(`assigned_to:${roleObject.id}`, { targetObjectId: roleObject.id, relationshipType: "assigned_to" });
        }
      }
    }
    for (const edge of desiredEdges.values()) {
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: agentObject.id,
        targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType,
        status: "approved",
        sourceEntityType: "AgentIdentity",
        sourceEntityId: identity.id,
      });
    }
    const existingEdges = await prisma.contextGraphRelationship.findMany({
      where: {
        workspaceId,
        sourceEntityType: "AgentIdentity",
        sourceEntityId: identity.id,
        status: { not: "archived" },
      },
      select: { sourceObjectId: true, targetObjectId: true, relationshipType: true },
    });
    for (const edge of existingEdges) {
      if (desiredEdges.has(`${edge.relationshipType}:${edge.targetObjectId}`)) continue;
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: edge.sourceObjectId,
        targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType,
        status: "archived",
        sourceEntityType: "AgentIdentity",
        sourceEntityId: identity.id,
      });
    }
    return;
  }

  if (payload.sourceType === "GOAL") {
    const goal = await prisma.goal.findFirst({
      where: { id: payload.sourceId, workspaceId },
      include: {
        parentGoal: true,
        circle: { select: { id: true, name: true, purposeMd: true, archivedAt: true } },
        ownerMember: { include: { user: { select: { displayName: true, email: true } } } },
      },
    });
    if (!goal) return;
    if (isPrivateDraftGoal(goal)) {
      await archiveGoalGraphFacts(workspaceId, goal.id);
      return;
    }
    const object = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Goal",
      title: goal.title,
      summary: goal.descriptionMd,
      status: goalGraphStatus(goal),
      sourceEntityType: "Goal",
      sourceEntityId: goal.id,
      validFrom: goal.startDate ?? goal.createdAt,
      lastVerifiedAt: goal.updatedAt,
      properties: {
        level: goal.level,
        cadence: goal.cadence,
        status: goal.status,
        progressPercent: goal.progressPercent,
        targetDate: goal.targetDate?.toISOString() ?? null,
      },
    });

    const desiredEdges = new Map<string, { sourceObjectId: string; targetObjectId: string; relationshipType: "part_of" | "owns" }>();
    if (goal.parentGoal && !goal.parentGoal.archivedAt && !isPrivateDraftGoal(goal.parentGoal)) {
      const parentObject = await upsertContextGraphObject(actor, {
        workspaceId,
        objectType: "Goal",
        title: goal.parentGoal.title,
        summary: goal.parentGoal.descriptionMd,
        status: goalGraphStatus(goal.parentGoal),
        sourceEntityType: "Goal",
        sourceEntityId: goal.parentGoal.id,
      });
      desiredEdges.set(`part_of:${object.id}:${parentObject.id}`, { sourceObjectId: object.id, targetObjectId: parentObject.id, relationshipType: "part_of" });
    }
    if (goal.circle && !goal.circle.archivedAt) {
      const circleObject = await upsertContextGraphObject(actor, {
        workspaceId,
        objectType: "Team",
        title: goal.circle.name,
        summary: goal.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: goal.circle.id,
      });
      desiredEdges.set(`owns:${circleObject.id}:${object.id}`, { sourceObjectId: circleObject.id, targetObjectId: object.id, relationshipType: "owns" });
    }
    if (goal.ownerMember) {
      const ownerObject = await upsertContextGraphObject(actor, {
        workspaceId,
        objectType: "Person",
        title: goal.ownerMember.user.displayName?.trim() || goal.ownerMember.user.email,
        status: goal.ownerMember.isActive ? "approved" : "archived",
        sourceEntityType: "Member",
        sourceEntityId: goal.ownerMember.id,
        properties: {
          workspaceRole: goal.ownerMember.role,
          isActive: goal.ownerMember.isActive,
        },
      });
      desiredEdges.set(`owns:${ownerObject.id}:${object.id}`, { sourceObjectId: ownerObject.id, targetObjectId: object.id, relationshipType: "owns" });
    }
    for (const edge of desiredEdges.values()) {
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: edge.sourceObjectId,
        targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType,
        status: "approved",
        sourceEntityType: "Goal",
        sourceEntityId: goal.id,
      });
    }
    const existingEdges = await prisma.contextGraphRelationship.findMany({
      where: {
        workspaceId,
        sourceEntityType: "Goal",
        sourceEntityId: goal.id,
        status: { not: "archived" },
      },
      select: { sourceObjectId: true, targetObjectId: true, relationshipType: true },
    });
    for (const edge of existingEdges) {
      if (desiredEdges.has(`${edge.relationshipType}:${edge.sourceObjectId}:${edge.targetObjectId}`)) continue;
      await upsertContextGraphRelationship(actor, {
        workspaceId,
        sourceObjectId: edge.sourceObjectId,
        targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType,
        status: "archived",
        sourceEntityType: "Goal",
        sourceEntityId: goal.id,
      });
    }
    return;
  }

  if (payload.sourceType === "DOCUMENT") {
    const document = await prisma.document.findFirst({ where: { id: payload.sourceId, workspaceId } });
    if (!document) return;
    if (document.accessDomain !== "WORKSPACE") return;
    await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: "Document",
      title: document.title,
      summary: document.textContent?.slice(0, 1000) ?? null,
      status: "approved",
      sourceEntityType: "Document",
      sourceEntityId: document.id,
      validFrom: document.createdAt,
      lastVerifiedAt: document.updatedAt,
      properties: { source: document.source, mimeType: document.mimeType },
    });
    return;
  }

  if (payload.sourceType === "BRAIN_ARTICLE") {
    const article = await prisma.brainArticle.findFirst({ where: { id: payload.sourceId, workspaceId } });
    if (!article) return;
    const object = await upsertContextGraphObject(actor, {
      workspaceId,
      objectType: articleTypeToObjectType(article.type),
      title: article.title,
      summary: article.bodyMd.slice(0, 1600),
      status: article.authority === "DRAFT" ? "draft" : "approved",
      sourceEntityType: "BrainArticle",
      sourceEntityId: article.id,
      validFrom: article.publishedAt ?? article.createdAt,
      lastVerifiedAt: article.lastVerifiedAt,
      properties: {
        slug: article.slug,
        type: article.type,
        authority: article.authority,
      },
    });
    await attachContextGraphEvidence(actor, {
      workspaceId,
      objectId: object.id,
      sourceType: "BRAIN_ARTICLE",
      sourceId: article.id,
      quote: article.title,
      metadata: { slug: article.slug },
    });
  }
}
