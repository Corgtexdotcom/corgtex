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
  const actor = contextGraphSystemActor();

  if (payload.sourceType === "MEETING") {
    await syncContextGraphForMeeting(actor, { workspaceId, meetingId: payload.sourceId });
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

  if (payload.sourceType === "DOCUMENT") {
    const document = await prisma.document.findFirst({ where: { id: payload.sourceId, workspaceId } });
    if (!document) return;
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
