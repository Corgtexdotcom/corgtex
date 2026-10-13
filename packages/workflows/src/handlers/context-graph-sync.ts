import { prisma } from "@corgtex/shared";
import { retireContextGraphSourceDescendants, type ContextGraphJobExecution } from "../../../domain/src/context-graph-retirement";
import {
  contextGraphSystemActor,
  retireContextGraphFacts,
  attachContextGraphEvidence,
  captureArtifactInputProof,
  type LineageKind,
  type LineageRoot,
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

async function archiveNativeGraphFacts(workspaceId: string, sourceEntityType: string, sourceEntityId: string) {
  await retireContextGraphFacts(contextGraphSystemActor(workspaceId), {
    workspaceId, objectWhere: { sourceEntityType, sourceEntityId }, relationshipWhere: { sourceEntityType, sourceEntityId },
  });
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
  jobId: string,
  payload: ContextGraphSyncPayload,
  workspaceId: string,
  execution?: ContextGraphJobExecution,
) {
  if (!payload.sourceType || !payload.sourceId) return;
  const retireSource = async (kind: string, sourceId: string) => {
    if (execution) return retireContextGraphSourceDescendants({ workspaceId, workflowJobId: jobId,
      sourceType: payload.sourceType!, sourceId: payload.sourceId!, ...execution });
    return archiveNativeGraphFacts(workspaceId, kind, sourceId);
  };
  const actor = contextGraphSystemActor(workspaceId);
  const receipts = new Map<string, LineageRoot[]>();
  const capture = async (kind: LineageKind, row: { id: string; [key: string]: unknown } | null | undefined) => {
    if (!row?.id) return null;
    try {
      const roots = await captureArtifactInputProof(actor, workspaceId, [{ kind, id: row.id, snapshot: row }]);
      receipts.set(`${kind}:${row.id}`, roots);
      return roots;
    } catch (error) {
      if (error instanceof Error && "code" in error
        && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED", "NOT_FOUND"].includes(String(error.code))) return null;
      throw error;
    }
  };
  const primary = async (kind: LineageKind, row: { id: string; [key: string]: unknown } | null) => {
    if (!row) { await retireSource(kind, payload.sourceId!); return false; }
    if (await capture(kind, row)) return true;
    await retireSource(kind, row.id);
    return false;
  };
  const rootsFor = (kind: string | null | undefined, id: string | null | undefined) => {
    const roots = receipts.get(`${kind}:${id}`);
    if (!roots) throw new Error("Graph sync input receipt is missing.");
    return roots;
  };
  const writeObject = (params: Parameters<typeof upsertContextGraphObject>[1]) => upsertContextGraphObject(actor, {
    ...params, lineageInputs: [], lineageRoots: [...rootsFor(params.sourceEntityType, params.sourceEntityId), ...(params.lineageRoots ?? [])],
  });
  const writeRelationship = (params: Parameters<typeof upsertContextGraphRelationship>[1]) => upsertContextGraphRelationship(actor, {
    ...params, lineageInputs: [], lineageRoots: [...rootsFor(params.sourceEntityType, params.sourceEntityId), ...(params.lineageRoots ?? [])],
  });

  if (payload.sourceType === "MEETING") {
    const synced = await syncContextGraphForMeeting(actor, { workspaceId, meetingId: payload.sourceId });
    if (!synced) await retireSource("Meeting", payload.sourceId);
    return;
  }

  if (payload.sourceType === "ACTION") {
    const action = await prisma.action.findFirst({
      where: { id: payload.sourceId, workspaceId },
      include: {
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
        circle: { select: { id: true, name: true, purposeMd: true } },
      },
    });
    if (!await primary("Action", action) || !action) return;
    const assigneeRoots = await capture("Member", action.assigneeMember);
    const object = await writeObject({
      workspaceId,
      lineageRoots: assigneeRoots ?? [],
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
        assignee: assigneeRoots ? action.assigneeMember?.user.displayName ?? null : null,
      },
    });
    if (action.circle && await capture("Circle", action.circle)) {
      const circle = await writeObject({
        workspaceId,
        objectType: "Team",
        title: action.circle.name,
        summary: action.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: action.circle.id,
      });
      await writeRelationship({
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
    if (!await primary("Tension", tension) || !tension) return;
    const assigneeRoots = await capture("Member", tension.assigneeMember);
    const object = await writeObject({
      workspaceId,
      lineageRoots: assigneeRoots ?? [],
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
        assignee: assigneeRoots ? tension.assigneeMember?.user.displayName ?? null : null,
      },
    });
    if (tension.circle && await capture("Circle", tension.circle)) {
      const circle = await writeObject({
        workspaceId,
        objectType: "Team",
        title: tension.circle.name,
        summary: tension.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: tension.circle.id,
      });
      await writeRelationship({
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
    if (!await primary("Proposal", proposal) || !proposal) return;
    const object = await writeObject({
      workspaceId,
      lineageInputs: [{ kind: "Proposal", id: proposal.id }],
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
    if (proposal.circle && await capture("Circle", proposal.circle)) {
      const circle = await writeObject({
        workspaceId,
        objectType: "Team",
        title: proposal.circle.name,
        summary: proposal.circle.purposeMd,
        status: "approved",
        sourceEntityType: "Circle",
        sourceEntityId: proposal.circle.id,
      });
      await writeRelationship({
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
    if (!await primary("Circle", circle) || !circle) return;
    const object = await writeObject({
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
      if (parent && await capture("Circle", parent)) {
        const parentObject = await writeObject({
          workspaceId,
          objectType: "Team",
          title: parent.name,
          summary: parent.purposeMd,
          status: parent.archivedAt ? "archived" : "approved",
          sourceEntityType: "Circle",
          sourceEntityId: parent.id,
        });
        await writeRelationship({
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
    if (!await primary("Role", role) || !role) return;
    const roleObject = await writeObject({
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
    if (!await capture("Circle", role.circle)) return;
    const circleObject = await writeObject({
      workspaceId,
      objectType: "Team",
      title: role.circle.name,
      summary: role.circle.purposeMd,
      status: role.circle.archivedAt ? "archived" : "approved",
      sourceEntityType: "Circle",
      sourceEntityId: role.circle.id,
    });
    await writeRelationship({
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
    if (!await primary("Member", member) || !member) return;
    const person = await writeObject({
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

    const desiredEdges = new Map<string, { targetObjectId: string; relationshipType: "member_of" | "assigned_to"; lineageRoots: LineageRoot[] }>();
    if (member.isActive) {
      for (const assignment of member.roleAssignments) {
        if (assignment.role.archivedAt) continue;
        const assignmentRoots = await capture("RoleAssignment", assignment);
        if (!assignmentRoots || !await capture("Role", assignment.role)) continue;
        const roleObject = await writeObject({
          workspaceId,
          objectType: "Role",
          title: assignment.role.name,
          summary: assignment.role.purposeMd,
          status: "approved",
          sourceEntityType: "Role",
          sourceEntityId: assignment.role.id,
        });
        desiredEdges.set(`assigned_to:${roleObject.id}`, { targetObjectId: roleObject.id, relationshipType: "assigned_to", lineageRoots: assignmentRoots });
        if (!await capture("Circle", assignment.role.circle)) continue;
        const circleObject = await writeObject({
          workspaceId,
          objectType: "Team",
          title: assignment.role.circle.name,
          summary: assignment.role.circle.purposeMd,
          status: assignment.role.circle.archivedAt ? "archived" : "approved",
          sourceEntityType: "Circle",
          sourceEntityId: assignment.role.circle.id,
        });
        desiredEdges.set(`member_of:${circleObject.id}`, { targetObjectId: circleObject.id, relationshipType: "member_of", lineageRoots: assignmentRoots });
      }
    }
    for (const edge of desiredEdges.values()) {
      await writeRelationship({
        workspaceId,
        sourceObjectId: person.id,
        lineageRoots: edge.lineageRoots,
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
      await retireContextGraphFacts(actor, { workspaceId, relationshipWhere: { workspaceId,
        sourceObjectId: edge.sourceObjectId, targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType, sourceEntityType: "Member", sourceEntityId: member.id,
      } });
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
    if (!await primary("AgentIdentity", identity) || !identity) return;
    const active = identity.isActive && !identity.archivedAt;
    const agentObject = await writeObject({
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

    const desiredEdges = new Map<string, { targetObjectId: string; relationshipType: "member_of" | "assigned_to"; lineageRoots: LineageRoot[] }>();
    if (active) {
      for (const assignment of identity.circleAssignments) {
        const assignmentRoots = await capture("CircleAgentAssignment", assignment);
        if (!assignmentRoots) continue;
        if (!assignment.circle.archivedAt && await capture("Circle", assignment.circle)) {
          const circleObject = await writeObject({
            workspaceId,
            objectType: "Team",
            title: assignment.circle.name,
            summary: assignment.circle.purposeMd,
            status: "approved",
            sourceEntityType: "Circle",
            sourceEntityId: assignment.circle.id,
          });
          desiredEdges.set(`member_of:${circleObject.id}`, { targetObjectId: circleObject.id, relationshipType: "member_of", lineageRoots: assignmentRoots });
        }
        if (assignment.role && !assignment.role.archivedAt && await capture("Role", assignment.role)) {
          const roleObject = await writeObject({
            workspaceId,
            objectType: "Role",
            title: assignment.role.name,
            summary: assignment.role.purposeMd,
            status: "approved",
            sourceEntityType: "Role",
            sourceEntityId: assignment.role.id,
          });
          desiredEdges.set(`assigned_to:${roleObject.id}`, { targetObjectId: roleObject.id, relationshipType: "assigned_to", lineageRoots: assignmentRoots });
        }
      }
    }
    for (const edge of desiredEdges.values()) {
      await writeRelationship({
        workspaceId,
        sourceObjectId: agentObject.id,
        lineageRoots: edge.lineageRoots,
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
      await retireContextGraphFacts(actor, { workspaceId, relationshipWhere: { workspaceId,
        sourceObjectId: edge.sourceObjectId, targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType, sourceEntityType: "AgentIdentity", sourceEntityId: identity.id,
      } });
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
    if (!await primary("Goal", goal) || !goal) return;
    if (isPrivateDraftGoal(goal)) {
      await retireSource("Goal", goal.id);
      return;
    }
    const object = await writeObject({
      workspaceId,
      lineageInputs: [{ kind: "Goal", id: goal.id }],
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
    if (goal.parentGoal && !goal.parentGoal.archivedAt && !isPrivateDraftGoal(goal.parentGoal)
      && await capture("Goal", goal.parentGoal)) {
      const parentObject = await writeObject({
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
    if (goal.circle && !goal.circle.archivedAt && await capture("Circle", goal.circle)) {
      const circleObject = await writeObject({
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
    if (goal.ownerMember && await capture("Member", goal.ownerMember)) {
      const ownerObject = await writeObject({
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
      await writeRelationship({
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
      await retireContextGraphFacts(actor, { workspaceId, relationshipWhere: { workspaceId,
        sourceObjectId: edge.sourceObjectId, targetObjectId: edge.targetObjectId,
        relationshipType: edge.relationshipType, sourceEntityType: "Goal", sourceEntityId: goal.id,
      } });
    }
    return;
  }

  if (payload.sourceType === "DOCUMENT") {
    const document = await prisma.document.findFirst({ where: { id: payload.sourceId, workspaceId } });
    if (!await primary("Document", document) || !document) return;
    if (document.accessDomain !== "WORKSPACE") return;
    await writeObject({
      workspaceId,
      lineageInputs: [{ kind: "Document", id: document.id }],
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
    if (!await primary("BrainArticle", article) || !article) return;
    const object = await writeObject({
      workspaceId,
      lineageInputs: [{ kind: "BrainArticle", id: article.id }],
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
      lineageInputs: [], lineageRoots: rootsFor("BrainArticle", article.id),
      objectId: object.id,
      sourceType: "BRAIN_ARTICLE",
      sourceId: article.id,
      quote: article.title,
      metadata: { slug: article.slug },
    });
  }
}
