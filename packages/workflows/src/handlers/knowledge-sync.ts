import { prisma } from "@corgtex/shared";
import { syncKnowledgeForSource } from "@corgtex/knowledge";
import {
  fetchCalendarEvents,
  fetchFilteredEmailMessages,
  fetchSelectedDocuments,
  externalResourceKnowledgeInput,
  materializeCrmCalendarTouchpoints,
  materializeCrmEmailTouchpoints,
  syncExternalContentSource,
  syncCalendarEventRecorder,
} from "@corgtex/domain";

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
      ingestionGuidanceMd: true,
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
      hasIngestionGuidance: Boolean(meeting.ingestionGuidanceMd),
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

export async function handleExternalResourceKnowledgeSync(jobId: string, payload: { resourceId?: string }, workspaceId: string) {
  if (!payload.resourceId) {
    return;
  }
  const input = await externalResourceKnowledgeInput(payload.resourceId, workspaceId);
  if (!input) {
    return;
  }
  await syncKnowledgeForSource({
    ...input,
    metadata: {
      ...input.metadata,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}

export async function handleExternalContentKnowledgeSync(jobId: string, payload: { sourceId?: string }, workspaceId: string) {
  if (!payload.sourceId) {
    return;
  }

  await syncExternalContentSource({
    workspaceId,
    sourceId: payload.sourceId,
    workflowJobId: jobId,
    syncKnowledge: (input) => syncKnowledgeForSource(input),
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
    include: {
      author: { select: { displayName: true } },
      assigneeMember: { include: { user: { select: { displayName: true } } } },
      raisedByMember: { include: { user: { select: { displayName: true } } } },
      circle: { select: { name: true } },
    },
  });
  if (!tension || tension.workspaceId !== workspaceId) return;

  const content = [
    `# Tension: ${tension.title}`,
    `**Status:** ${tension.status} | **Priority:** ${tension.priority}`,
    `**Author:** ${tension.author.displayName || "Unknown"}`,
    `**Raised by:** ${tension.raisedByMember?.user.displayName || "Unknown"}`,
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

export async function handleSlackMessageKnowledgeSync(jobId: string, payload: { messageId?: string }, workspaceId: string) {
  if (!payload.messageId) return;
  const message = await prisma.communicationMessage.findUnique({
    where: { id: payload.messageId },
    include: {
      installation: { select: { id: true, externalTeamName: true } },
    },
  });
  if (!message || message.workspaceId !== workspaceId || message.provider !== "SLACK") return;

  if (!message.text || message.textRedactedAt || message.isBot || message.isHidden || message.isDeleted) {
    await prisma.knowledgeChunk.deleteMany({
      where: {
        workspaceId,
        sourceType: "SLACK",
        sourceId: message.id,
      },
    });
    return;
  }

  const channel = await prisma.communicationChannel.findUnique({
    where: {
      installationId_externalChannelId: {
        installationId: message.installationId,
        externalChannelId: message.externalChannelId,
      },
    },
    select: { name: true, kind: true },
  });
  if (channel?.kind !== "PUBLIC") return;

  const channelLabel = channel.name ? `#${channel.name}` : message.externalChannelId;
  const content = [
    `Slack message in ${channelLabel}`,
    message.messageTs ? `Posted at ${message.messageTs.toISOString()}` : null,
    message.externalUserId ? `Author: ${message.externalUserId}` : null,
    message.threadExternalId ? `Thread: ${message.threadExternalId}` : null,
    "",
    message.text,
  ].filter((entry) => entry !== null).join("\n");

  await syncKnowledgeForSource({
    workspaceId,
    sourceType: "SLACK",
    sourceId: message.id,
    sourceTitle: `Slack ${channelLabel}`,
    content,
    metadata: {
      installationId: message.installationId,
      externalTeamName: message.installation.externalTeamName,
      externalChannelId: message.externalChannelId,
      externalMessageId: message.externalMessageId,
      externalUserId: message.externalUserId,
      threadExternalId: message.threadExternalId,
      messageTs: message.messageTs?.toISOString() ?? null,
      permalink: message.permalink,
      workflowJobId: jobId,
    },
    workflowJobId: jobId,
  });
}


export async function handleCalendarSync(jobId: string, payload: { connectionId?: string }, workspaceId: string) {
  if (!payload.connectionId) return;
  const connection = await prisma.oAuthConnection.findUnique({ where: { id: payload.connectionId } });
  if (!connection || connection.status !== "ACTIVE") return;
  if (connection.workspaceId && connection.workspaceId !== workspaceId) return;
  const syncSettings = connection.syncSettings && typeof connection.syncSettings === "object" && !Array.isArray(connection.syncSettings)
    ? connection.syncSettings as Record<string, unknown>
    : {};
  const calendarSettings = syncSettings.calendar && typeof syncSettings.calendar === "object" && !Array.isArray(syncSettings.calendar)
    ? syncSettings.calendar as Record<string, unknown>
    : {};
  if (calendarSettings.enabled === false) return;
  const includeAllEvents = calendarSettings.includeAllEvents === true;

  const now = new Date();
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneMonthAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  try {
    const events = await fetchCalendarEvents(connection.id, oneMonthAgo, oneMonthAhead);
    
    for (const event of events) {
      const shouldIndex = includeAllEvents || Boolean(event.meetingUrl) || event.attendees.length > 1;
      if (!shouldIndex) {
        continue;
      }
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
      await syncCalendarEventRecorder({
        workspaceId,
        connectionId: connection.id,
        event,
      });
    }
    await materializeCrmCalendarTouchpoints({
      workspaceId,
      connectionId: connection.id,
      events,
    });
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncError: null,
        status: "ACTIVE",
      },
    });
  } catch (error) {
    console.warn("Calendar sync failed:", error);
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncError: error instanceof Error ? error.message : "Calendar sync failed.",
        status: "ERROR",
      },
    });
    throw error;
  }
}

function recordSection(settings: unknown, key: "documents" | "email") {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const section = (settings as Record<string, unknown>)[key];
  return section && typeof section === "object" && !Array.isArray(section)
    ? section as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean)
    : [];
}

export async function handleOAuthDocumentsSync(jobId: string, payload: { connectionId?: string }, workspaceId: string) {
  if (!payload.connectionId) return;
  const connection = await prisma.oAuthConnection.findUnique({ where: { id: payload.connectionId } });
  if (!connection || connection.status !== "ACTIVE") return;
  if (connection.workspaceId && connection.workspaceId !== workspaceId) return;

  const documentSettings = recordSection(connection.syncSettings, "documents");
  if (documentSettings.enabled !== true) return;
  const selectedDocumentIds = stringArray(documentSettings.selectedDriveIds ?? documentSettings.selectedDocumentIds);
  if (selectedDocumentIds.length === 0) return;

  try {
    const documents = await fetchSelectedDocuments(connection.id, selectedDocumentIds);
    for (const document of documents) {
      if (!document.contentText.trim()) continue;
      const documentSourceKey = document.sourceKey ?? document.id;
      await syncKnowledgeForSource({
        workspaceId,
        sourceType: "DOCUMENT",
        sourceId: `oauth-doc-${connection.id}-${document.provider.toLowerCase()}-${documentSourceKey}`,
        sourceTitle: document.name,
        content: [document.name, document.contentText].filter(Boolean).join("\n\n"),
        metadata: {
          connectionId: connection.id,
          provider: document.provider,
          providerDocumentId: document.id,
          mimeType: document.mimeType,
          webUrl: document.webUrl,
          modifiedAt: document.modifiedAt?.toISOString() ?? null,
          workflowJobId: jobId,
        },
        workflowJobId: jobId,
      });
    }
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null, status: "ACTIVE" },
    });
  } catch (error) {
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncError: error instanceof Error ? error.message : "Document sync failed.",
        status: "ERROR",
      },
    });
    throw error;
  }
}

export async function handleOAuthEmailSync(jobId: string, payload: { connectionId?: string }, workspaceId: string) {
  if (!payload.connectionId) return;
  const connection = await prisma.oAuthConnection.findUnique({ where: { id: payload.connectionId } });
  if (!connection || connection.status !== "ACTIVE") return;
  if (connection.workspaceId && connection.workspaceId !== workspaceId) return;

  const emailSettings = recordSection(connection.syncSettings, "email");
  if (emailSettings.enabled !== true) return;
  const filters = stringArray(emailSettings.filters ?? emailSettings.queries);
  if (filters.length === 0) return;

  try {
    const messages = await fetchFilteredEmailMessages(connection.id, filters);
    for (const message of messages) {
      if (!message.snippet.trim()) continue;
      await syncKnowledgeForSource({
        workspaceId,
        sourceType: "DOCUMENT",
        sourceId: `oauth-email-${connection.id}-${message.provider.toLowerCase()}-${message.id}`,
        sourceTitle: `Email: ${message.subject}`,
        content: [message.subject, message.from ? `From: ${message.from}` : null, message.snippet].filter(Boolean).join("\n\n"),
        metadata: {
          connectionId: connection.id,
          provider: message.provider,
          providerMessageId: message.id,
          sourceKind: "email",
          from: message.from,
          receivedAt: message.receivedAt?.toISOString() ?? null,
          webUrl: message.webUrl,
          filter: message.filter,
          workflowJobId: jobId,
        },
        workflowJobId: jobId,
      });
    }
    await materializeCrmEmailTouchpoints({
      workspaceId,
      connectionId: connection.id,
      messages,
    });
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null, status: "ACTIVE" },
    });
  } catch (error) {
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncError: error instanceof Error ? error.message : "Email sync failed.",
        status: "ERROR",
      },
    });
    throw error;
  }
}
