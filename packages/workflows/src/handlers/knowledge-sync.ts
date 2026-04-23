import { prisma } from "@corgtex/shared";
import { syncKnowledgeForSource, syncBrainArticleKnowledge } from "@corgtex/knowledge";
import { fetchCalendarEvents } from "@corgtex/domain";

export async function handleKnowledgeSync(jobId: string, payload: { proposalId?: string }, workspaceId: string) {
  if (!payload.proposalId) {
    return;
  }

  const proposal = await prisma.proposal.findUnique({
    where: { id: payload.proposalId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      summary: true,
      bodyMd: true,
      status: true,
    },
  });

  if (!proposal || proposal.workspaceId !== workspaceId) {
    return;
  }

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "PROPOSAL",
    sourceId: proposal.id,
    sourceTitle: proposal.title,
    content: [proposal.title, proposal.summary, proposal.bodyMd].filter(Boolean).join("\n\n"),
    metadata: {
      status: proposal.status,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}


export async function handleMeetingKnowledgeSync(jobId: string, payload: { meetingId?: string }, workspaceId: string) {
  if (!payload.meetingId) {
    return;
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id: payload.meetingId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      source: true,
      transcript: true,
      summaryMd: true,
      recordedAt: true,
    },
  });

  if (!meeting || meeting.workspaceId !== workspaceId) {
    return;
  }

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "MEETING",
    sourceId: meeting.id,
    sourceTitle: meeting.title,
    content: [meeting.title, meeting.summaryMd, meeting.transcript].filter(Boolean).join("\n\n"),
    metadata: {
      source: meeting.source,
      recordedAt: meeting.recordedAt.toISOString(),
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}


export async function handleDocumentKnowledgeSync(jobId: string, payload: { documentId?: string }, workspaceId: string) {
  if (!payload.documentId) {
    return;
  }

  const document = await prisma.document.findUnique({
    where: { id: payload.documentId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      source: true,
      mimeType: true,
      storageKey: true,
      textContent: true,
    },
  });

  if (!document || document.workspaceId !== workspaceId) {
    return;
  }

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "DOCUMENT",
    sourceId: document.id,
    sourceTitle: document.title,
    content: [document.title, document.textContent].filter(Boolean).join("\n\n"),
    metadata: {
      source: document.source,
      mimeType: document.mimeType,
      storageKey: document.storageKey,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}


export async function handleEventKnowledgeSync(jobId: string, payload: { eventId?: string }, workspaceId: string) {
  if (!payload.eventId) {
    return;
  }

  const event = await prisma.event.findUnique({
    where: { id: payload.eventId },
    select: {
      id: true,
      workspaceId: true,
      type: true,
      aggregateType: true,
      aggregateId: true,
      payload: true,
      createdAt: true,
    },
  });

  if (!event || event.workspaceId !== workspaceId) {
    return;
  }

  const title = `Event: ${event.type}`;
  const content = [
    `An event of type '${event.type}' occurred on ${event.createdAt.toISOString()}.`,
    `Payload details:`,
    JSON.stringify(event.payload, null, 2),
  ].join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "EVENT",
    sourceId: event.id,
    sourceTitle: title,
    content,
    metadata: {
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}


export async function handleTensionKnowledgeSync(jobId: string, payload: { tensionId?: string }, workspaceId: string) {
  if (!payload.tensionId) return;
  const tension = await prisma.tension.findUnique({
    where: { id: payload.tensionId },
    include: { author: { select: { displayName: true } }, assigneeMember: { include: { user: { select: { displayName: true } } } }, circle: { select: { name: true } } },
  });
  if (!tension || tension.workspaceId !== workspaceId) return;

  const content = [
    `# Tension: ${tension.title}`,
    `**Status:** ${tension.status} | **Priority:** ${tension.priority}`,
    `**Author:** ${tension.author.displayName || "Unknown"}`,
    `**Circle:** ${tension.circle?.name || "None"} | **Assigned to:** ${tension.assigneeMember?.user.displayName || "Unassigned"}`,
    `**Created:** ${tension.createdAt.toISOString()}`,
    tension.bodyMd ? `\n${tension.bodyMd}` : "",
  ].filter(Boolean).join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "TENSION",
    sourceId: tension.id,
    sourceTitle: tension.title,
    content,
    metadata: { status: tension.status, workflowJobId: jobId },
    workflowJobId: jobId,
  });
}


export async function handleActionKnowledgeSync(jobId: string, payload: { actionId?: string }, workspaceId: string) {
  if (!payload.actionId) return;
  const action = await prisma.action.findUnique({
    where: { id: payload.actionId },
    include: { author: { select: { displayName: true } }, assigneeMember: { include: { user: { select: { displayName: true } } } }, circle: { select: { name: true } } },
  });
  if (!action || action.workspaceId !== workspaceId) return;

  const content = [
    `# Action: ${action.title}`,
    `**Status:** ${action.status} | **Due:** ${action.dueAt ? action.dueAt.toISOString() : "None"}`,
    `**Author:** ${action.author.displayName || "Unknown"}`,
    `**Circle:** ${action.circle?.name || "None"} | **Assigned to:** ${action.assigneeMember?.user.displayName || "Unassigned"}`,
    `**Created:** ${action.createdAt.toISOString()}`,
    action.bodyMd ? `\n${action.bodyMd}` : "",
  ].filter(Boolean).join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "ACTION",
    sourceId: action.id,
    sourceTitle: action.title,
    content,
    metadata: { status: action.status, workflowJobId: jobId },
    workflowJobId: jobId,
  });
}


export async function handleCircleKnowledgeSync(jobId: string, payload: { circleId?: string }, workspaceId: string) {
  if (!payload.circleId) return;
  const circle = await prisma.circle.findUnique({
    where: { id: payload.circleId },
  });
  if (!circle || circle.workspaceId !== workspaceId) return;

  const content = [
    `# Circle: ${circle.name}`,
    `**Purpose:**\n${circle.purposeMd || "Not specified"}`,
    `**Domain:**\n${circle.domainMd || "Not specified"}`,
  ].filter(Boolean).join("\n\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "CIRCLE",
    sourceId: circle.id,
    sourceTitle: circle.name,
    content,
    metadata: { workflowJobId: jobId },
    workflowJobId: jobId,
  });
}


export async function handleRoleKnowledgeSync(jobId: string, payload: { roleId?: string }, workspaceId: string) {
  if (!payload.roleId) return;
  const role = await prisma.role.findUnique({
    where: { id: payload.roleId },
    include: { circle: { select: { name: true, workspaceId: true } } },
  });
  if (!role || role.circle.workspaceId !== workspaceId) return;

  const content = [
    `# Role: ${role.name}`,
    `**Circle:** ${role.circle.name}`,
    `**Purpose:**\n${role.purposeMd || "Not specified"}`,
    `**Accountabilities:**\n${role.accountabilities.length > 0 ? role.accountabilities.map(a => "- " + a).join("\n") : "None"}`,
  ].filter(Boolean).join("\n\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "ROLE",
    sourceId: role.id,
    sourceTitle: role.name,
    content,
    metadata: { workflowJobId: jobId },
    workflowJobId: jobId,
  });
}


export async function handleCalendarSync(jobId: string, payload: { connectionId?: string }, workspaceId: string) {
  if (!payload.connectionId) return;
  const connection = await prisma.oAuthConnection.findUnique({ where: { id: payload.connectionId } });
  if (!connection) return;

  const now = new Date();
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneMonthAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  try {
    const events = await fetchCalendarEvents(connection.id, oneMonthAgo, oneMonthAhead);
    
    for (const event of events) {
      const sourceId = `calendar-${event.id}`;
      await syncKnowledgeForSource({
        workspaceId,
        sourceType: "MEETING",
        sourceId,
        sourceTitle: event.title,
        content: [event.title, event.description].filter(Boolean).join("\n\n"),
        metadata: {
          connectionId: connection.id,
          recordedAt: event.startTime.toISOString(),
          attendees: event.attendees,
          workflowJobId: jobId,
        },
        workflowJobId: jobId,
      });
    }
  } catch (error) {
    console.warn("Calendar sync failed:", error);
    throw error;
  }
}


