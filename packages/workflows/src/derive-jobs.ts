import type { Prisma } from "@prisma/client";

const TRIAGE_COALESCE_WINDOW_MS = 5 * 60 * 1_000;
export function triageBucketStart(date: Date) {
  return new Date(Math.floor(date.getTime() / TRIAGE_COALESCE_WINDOW_MS) * TRIAGE_COALESCE_WINDOW_MS);
}

const TRIAGE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "meeting.created",
  "meeting.transcript-uploaded",
  "action.created",
  "tension.created",
  "checkin.response_received",
]);

const KNOWLEDGE_PULSE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "proposal.opened",
  "proposal.approved",
  "document.created",
  "meeting.created",
  "meeting.transcript-uploaded",
  "approval.finalized",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPayloadString(payload: unknown, key: string) {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isReplayEvent(payload: unknown) {
  if (!isObjectRecord(payload)) {
    return false;
  }

  const runtimeMeta = payload.runtimeMeta;
  if (!isObjectRecord(runtimeMeta)) {
    return false;
  }

  return typeof runtimeMeta.replayOfEventId === "string" && runtimeMeta.replayOfEventId.trim().length > 0;
}

export function deriveJobsForEvent(event: {
  id: string;
  type: string;
  workspaceId: string | null;
  payload: unknown;
  createdAt?: Date;
  aggregateId?: string | null;
  aggregateType?: string | null;
}) {
  const jobs: Array<{
    workspaceId?: string | null;
    eventId: string;
    type: string;
    payload: Prisma.InputJsonObject;
    dedupeKey: string;
    dependsOnDedupeKey?: string;
  }> = [];

  const pushContextGraphSync = (
    sourceType: string,
    sourceId: string | undefined,
    dependsOnDedupeKey?: string,
  ) => {
    if (!sourceId || !event.workspaceId) return;
    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "context-graph.sync",
      payload: { sourceType, sourceId },
      dedupeKey: `${event.id}:context-graph-sync:${sourceType}:${sourceId}`,
      dependsOnDedupeKey,
    });
  };

  if (event.type === "proposal.approved") {
    const payload = event.payload as { subjectId?: string };
    if (payload.subjectId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.proposal",
        payload: {
          proposalId: payload.subjectId,
        },
        dedupeKey: `${event.id}:knowledge-sync`,
      });
      pushContextGraphSync("PROPOSAL", payload.subjectId, `${event.id}:knowledge-sync`);
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.constitution-update-trigger",
        payload: {
          proposalId: payload.subjectId,
        },
        dedupeKey: `${event.id}:constitution-update-trigger`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.constitution-synthesis",
        payload: {},
        dedupeKey: `${event.id}:constitution-synthesis`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "governance.score",
        payload: {},
        dedupeKey: `${event.id}:governance-score`,
      });
    }
  }

  if (event.type === "proposal.opened") {
    const payload = event.payload as { proposalId?: string; subjectId?: string };
    const proposalId = payload.proposalId ?? payload.subjectId;
    if (proposalId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.proposal",
        payload: {
          proposalId,
        },
        dedupeKey: `${event.id}:knowledge-sync`,
      });
      pushContextGraphSync("PROPOSAL", proposalId, `${event.id}:knowledge-sync`);
    }
  }

  if (event.type === "meeting.created" || event.type === "meeting.transcript-uploaded") {
    const payload = event.payload as { meetingId?: string; status?: string; hasTranscript?: boolean };
    const shouldRunMeetingAgents = payload.status !== "SCHEDULED" && payload.hasTranscript !== false;
    if (payload.meetingId && event.workspaceId && !shouldRunMeetingAgents) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.meeting",
        payload: {
          meetingId: payload.meetingId,
        },
        dedupeKey: `${event.id}:meeting-knowledge-sync`,
      });
      pushContextGraphSync("MEETING", payload.meetingId, `${event.id}:meeting-knowledge-sync`);
    }
    if (payload.meetingId && event.workspaceId && shouldRunMeetingAgents) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.meeting-summary",
        payload: {
          meetingId: payload.meetingId,
        },
        dedupeKey: `${event.id}:meeting-summary`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "meeting.insights.extract",
        payload: {
          meetingId: payload.meetingId,
        },
        dependsOnDedupeKey: `${event.id}:meeting-summary`,
        dedupeKey: `${event.id}:meeting-insights-extract`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.action-extraction",
        payload: {
          meetingId: payload.meetingId,
        },
        dependsOnDedupeKey: `${event.id}:meeting-insights-extract`,
        dedupeKey: `${event.id}:action-extraction`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "meeting.summary.post",
        payload: {
          meetingId: payload.meetingId,
        },
        dependsOnDedupeKey: `${event.id}:action-extraction`,
        dedupeKey: `${event.id}:meeting-summary-post`,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.meeting",
        payload: {
          meetingId: payload.meetingId,
        },
        dependsOnDedupeKey: `${event.id}:meeting-summary-post`,
        dedupeKey: `${event.id}:meeting-knowledge-sync`,
      });
      pushContextGraphSync("MEETING", payload.meetingId, `${event.id}:meeting-insights-extract`);
    }
  }

  if (event.type === "brain-source.created") {
    const payload = event.payload as { sourceId?: string };
    if (payload.sourceId && event.workspaceId) {
      const absorbDedupeKey = `${event.id}:brain-absorb`;
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.brain-absorb",
        payload: { sourceId: payload.sourceId },
        dedupeKey: absorbDedupeKey,
      });
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.company-understanding",
        payload: { sourceId: payload.sourceId },
        dependsOnDedupeKey: absorbDedupeKey,
        dedupeKey: `${event.id}:company-understanding`,
      });
    }
  }

  if (event.type === "brain-article.created" || event.type === "brain-article.updated" || event.type === "brain-article.published") {
    const payload = event.payload as { articleId?: string };
    if (payload.articleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.brain-article",
        payload: { articleId: payload.articleId },
        dedupeKey: `${event.id}:brain-article-knowledge-sync`,
      });
      pushContextGraphSync("BRAIN_ARTICLE", payload.articleId, `${event.id}:brain-article-knowledge-sync`);
    }
  }

  if (event.type === "document.created") {
    const payload = event.payload as { documentId?: string };
    if (payload.documentId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.document",
        payload: {
          documentId: payload.documentId,
        },
        dedupeKey: `${event.id}:document-knowledge-sync`,
      });
      pushContextGraphSync("DOCUMENT", payload.documentId, `${event.id}:document-knowledge-sync`);
    }
  }

  if (event.type === "tension.created" || event.type === "tension.updated") {
    const payload = event.payload as { tensionId?: string };
    if (payload.tensionId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.tension",
        payload: { tensionId: payload.tensionId },
        dedupeKey: `${event.id}:tension-knowledge-sync`,
      });
      pushContextGraphSync("TENSION", payload.tensionId, `${event.id}:tension-knowledge-sync`);
    }
  }

  if (event.type === "action.created" || event.type === "action.updated") {
    const payload = event.payload as { actionId?: string };
    if (payload.actionId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.action",
        payload: { actionId: payload.actionId },
        dedupeKey: `${event.id}:action-knowledge-sync`,
      });
      pushContextGraphSync("ACTION", payload.actionId, `${event.id}:action-knowledge-sync`);
    }
  }

  if (event.type === "circle.created" || event.type === "circle.updated") {
    const payload = event.payload as { circleId?: string };
    if (payload.circleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.circle",
        payload: { circleId: payload.circleId },
        dedupeKey: `${event.id}:circle-knowledge-sync`,
      });
      pushContextGraphSync("CIRCLE", payload.circleId, `${event.id}:circle-knowledge-sync`);
    }
  }

  if (event.type === "role.created" || event.type === "role.updated") {
    const payload = event.payload as { roleId?: string };
    if (payload.roleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.role",
        payload: { roleId: payload.roleId },
        dedupeKey: `${event.id}:role-knowledge-sync`,
      });
      pushContextGraphSync("ROLE", payload.roleId, `${event.id}:role-knowledge-sync`);
    }
  }

  if (event.type === "role.assigned") {
    const payload = event.payload as { onboardingSessionId?: string };
    if (payload.onboardingSessionId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.role-onboarding-intro",
        payload: { onboardingSessionId: payload.onboardingSessionId },
        dedupeKey: `${event.id}:role-onboarding-intro:${payload.onboardingSessionId}`,
      });
    }
  }

  if (
    event.type === "member.created"
    || event.type === "member.updated"
    || event.type === "member.deactivated"
    || event.type === "member.reactivated"
    || event.type === "role.assigned"
    || event.type === "role.unassigned"
  ) {
    const payload = event.payload as { memberId?: string };
    pushContextGraphSync("MEMBER", payload.memberId);
  }

  if (event.type === "goal.created" || event.type === "goal.updated") {
    const payload = event.payload as { goalId?: string };
    pushContextGraphSync("GOAL", payload.goalId);
  }

  if (
    event.type === "agent-identity.created"
    || event.type === "agent-identity.updated"
    || event.type === "agent-identity.deactivated"
    || event.type === "agent-identity.circle-assigned"
    || event.type === "agent-identity.circle-unassigned"
  ) {
    const payload = event.payload as { agentIdentityId?: string };
    pushContextGraphSync("AGENT_IDENTITY", payload.agentIdentityId);
  }

  if (event.type === "checkin.response_received") {
    const payload = event.payload as { checkInId?: string; memberId?: string };
    if (payload.memberId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.checkin-analysis",
        payload: {
          memberId: payload.memberId,
          checkInId: payload.checkInId,
        },
        dedupeKey: `${event.id}:checkin-analysis`,
      });
    }
  }

  if (event.workspaceId && TRIAGE_EVENT_TYPES.has(event.type)) {
    const payload = (event.payload ?? {}) as { runtimeMeta?: { replayOfEventId?: string } };
    const replayOfEventId = payload.runtimeMeta?.replayOfEventId;
    const bucketStart = triageBucketStart(event.createdAt ?? new Date()).toISOString();
    const dedupeKey = replayOfEventId
      ? `${event.workspaceId}:triage:replay:${event.id}`
      : `${event.workspaceId}:triage:${bucketStart}`;

    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "agent.inbox-triage",
      payload: {
        eventType: event.type,
        bucketStart,
        replayOfEventId: replayOfEventId ?? null,
      },
      dedupeKey,
    });
  }

  if (event.workspaceId && KNOWLEDGE_PULSE_EVENT_TYPES.has(event.type) && !isReplayEvent(event.payload)) {
    jobs.push({
      workspaceId: event.workspaceId,
      eventId: event.id,
      type: "knowledge.sync.event",
      payload: {
        eventId: event.id,
      },
      dedupeKey: `${event.id}:knowledge-sync-event`,
    });
  }

  if (event.type === "crm.qualification.submitted" && event.workspaceId) {
    const channel = readPayloadString(event.payload, "channel");
    const qualificationId = readPayloadString(event.payload, "qualificationId");
    if (channel === "email_reply" && qualificationId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.crm-email-extraction",
        payload: {
          eventId: event.id,
          aggregateId: event.aggregateId,
          qualificationId,
        },
        dedupeKey: `${event.id}:crm-email-extraction`,
      });
    }
  }

  if (event.type === "crm.qualification.approved" && event.workspaceId) {
    const email = readPayloadString(event.payload, "email");
    if (email) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.crm-lead-enrichment",
        payload: {
          eventId: event.id,
          aggregateId: event.aggregateId,
          email,
        },
        dedupeKey: `${event.id}:crm-enrichment`,
      });
    }
  }

  if (event.type === "demo-lead.captured" && event.workspaceId) {
    const demoLeadId = readPayloadString(event.payload, "demoLeadId");
    if (demoLeadId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "email.demo-welcome-newspaper",
        payload: {
          demoLeadId,
        },
        dedupeKey: `${event.workspaceId}:demo-welcome-newspaper:${demoLeadId}`,
      });
    }
  }

  return jobs;
}
