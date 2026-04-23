import type { Prisma } from "@prisma/client";

const TRIAGE_COALESCE_WINDOW_MS = 5 * 60 * 1_000;
export function triageBucketStart(date: Date) {
  return new Date(Math.floor(date.getTime() / TRIAGE_COALESCE_WINDOW_MS) * TRIAGE_COALESCE_WINDOW_MS);
}

const TRIAGE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "spend.submitted",
  "meeting.created",
  "action.created",
  "tension.created",
  "advice-process.initiated",
  "advice-process.executed",
  "checkin.response_received",
]);

const KNOWLEDGE_PULSE_EVENT_TYPES = new Set([
  "proposal.submitted",
  "proposal.approved",
  "document.created",
  "spend.created",
  "spend.submitted",
  "spend.paid",
  "meeting.created",
  "approval.finalized",
  "advice-process.advice-recorded",
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

  if (event.type === "advice-process.initiated") {
    const payload = event.payload as { proposalId?: string };
    if (payload.proposalId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.advice-routing",
        payload: {
          proposalId: payload.proposalId,
        },
        dedupeKey: `${event.id}:advice-routing`,
      });
    }
  }

  if (event.type === "advice-process.executed") {
    const payload = event.payload as { proposalId?: string };
    if (event.aggregateId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.process-linting",
        payload: {
          processId: event.aggregateId,
        },
        dedupeKey: `${event.id}:process-linting`,
      });
      if (payload.proposalId) {
        jobs.push({
          workspaceId: event.workspaceId,
          eventId: event.id,
          type: "knowledge.sync.proposal",
          payload: {
            proposalId: payload.proposalId,
          },
          dedupeKey: `${event.id}:knowledge-sync`,
        });
      }
    }
  }

  if (event.type === "meeting.created") {
    const payload = event.payload as { meetingId?: string };
    if (payload.meetingId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.meeting",
        payload: {
          meetingId: payload.meetingId,
        },
        dedupeKey: `${event.id}:meeting-knowledge-sync`,
      });
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
        type: "agent.action-extraction",
        payload: {
          meetingId: payload.meetingId,
        },
        dependsOnDedupeKey: `${event.id}:meeting-summary`,
        dedupeKey: `${event.id}:action-extraction`,
      });
    }
  }

  if (event.type === "brain-source.created") {
    const payload = event.payload as { sourceId?: string };
    if (payload.sourceId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.brain-absorb",
        payload: { sourceId: payload.sourceId },
        dedupeKey: `${event.id}:brain-absorb`,
      });
    }
  }

  if (event.type === "brain-article.created" || event.type === "brain-article.updated") {
    const payload = event.payload as { articleId?: string };
    if (payload.articleId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "knowledge.sync.brain-article",
        payload: { articleId: payload.articleId },
        dedupeKey: `${event.id}:brain-article-knowledge-sync`,
      });
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
    }
  }

  if (event.type === "spend.paid") {
    const payload = event.payload as { spendId?: string };
    if (payload.spendId && event.workspaceId) {
      jobs.push({
        workspaceId: event.workspaceId,
        eventId: event.id,
        type: "agent.finance-reconciliation-prep",
        payload: {
          spendId: payload.spendId,
        },
        dedupeKey: `${event.id}:finance-reconciliation-prep`,
      });
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
    }
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

  return jobs;
}

