import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";
import { randomBytes, createHmac } from "node:crypto";

// --- Webhook Endpoints (outbound) ---

export async function listWebhookEndpoints(actor: AppActor, workspaceId: string, opts?: { archiveFilter?: ArchiveFilter }) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.webhookEndpoint.findMany({
    where: { workspaceId, ...archiveFilterWhere(opts?.archiveFilter) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      label: true,
      eventTypes: true,
      status: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { deliveries: true } },
    },
  });
}

export async function createWebhookEndpoint(actor: AppActor, params: {
  workspaceId: string;
  url: string;
  label?: string | null;
  eventTypes?: string[];
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  invariant(params.url.startsWith("https://"), 400, "INVALID_INPUT", "Webhook URL must use HTTPS.");

  const secret = randomBytes(32).toString("hex");

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      workspaceId: params.workspaceId,
      url: params.url,
      secret,
      label: params.label?.trim() || null,
      eventTypes: params.eventTypes ?? [],
    },
  });

  return { ...endpoint, secret };
}

export async function updateWebhookEndpoint(actor: AppActor, params: {
  workspaceId: string;
  endpointId: string;
  url?: string;
  label?: string | null;
  eventTypes?: string[];
  status?: "ACTIVE" | "PAUSED" | "DISABLED";
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  if (params.url) {
    invariant(params.url.startsWith("https://"), 400, "INVALID_INPUT", "Webhook URL must use HTTPS.");
  }

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: params.endpointId, workspaceId: params.workspaceId, archivedAt: null },
  });
  invariant(endpoint, 404, "NOT_FOUND", "Webhook endpoint not found.");

  return prisma.webhookEndpoint.update({
    where: { id: params.endpointId },
    data: {
      ...(params.url ? { url: params.url } : {}),
      ...(params.label !== undefined ? { label: params.label?.trim() || null } : {}),
      ...(params.eventTypes ? { eventTypes: params.eventTypes } : {}),
      ...(params.status ? { status: params.status } : {}),
    },
  });
}

export async function deleteWebhookEndpoint(actor: AppActor, params: {
  workspaceId: string;
  endpointId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "WebhookEndpoint",
    entityId: params.endpointId,
    reason: "Archived from webhook delete path.",
  });

  return { id: params.endpointId };
}

export async function rotateWebhookSecret(actor: AppActor, params: {
  workspaceId: string;
  endpointId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: params.endpointId, workspaceId: params.workspaceId, archivedAt: null },
  });
  invariant(endpoint, 404, "NOT_FOUND", "Webhook endpoint not found.");

  const secret = randomBytes(32).toString("hex");
  await prisma.webhookEndpoint.update({
    where: { id: params.endpointId },
    data: { secret },
  });

  return { secret };
}

// --- Webhook Delivery ---

export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function createWebhookDeliveries(params: {
  workspaceId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: "ACTIVE",
    },
    select: {
      id: true,
      eventTypes: true,
    },
  });

  const matchingEndpoints = endpoints.filter((ep) => {
    if (ep.eventTypes.length === 0) return true;
    return ep.eventTypes.includes(params.eventType);
  });

  if (matchingEndpoints.length === 0) return [];

  const deliveries = await prisma.webhookDelivery.createManyAndReturn({
    data: matchingEndpoints.map((ep) => ({
      endpointId: ep.id,
      eventId: params.eventId,
      eventType: params.eventType,
      payload: toInputJson(params.payload),
      status: "PENDING" as const,
      nextRetryAt: new Date(),
    })),
  });

  return deliveries;
}

export async function deliverWebhook(deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      endpoint: {
        select: { url: true, secret: true, status: true },
      },
    },
  });

  if (!delivery || delivery.endpoint.status !== "ACTIVE") {
    return;
  }

  const payloadStr = JSON.stringify(delivery.payload);
  const signature = signWebhookPayload(payloadStr, delivery.endpoint.secret);

  try {
    const response = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Webhook-Event": delivery.eventType,
        "X-Webhook-Delivery": delivery.id,
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10_000),
    });

    const responseBody = await response.text().catch(() => "");

    if (response.ok) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "DELIVERED",
          httpStatus: response.status,
          responseBody: responseBody.slice(0, 2000),
          attempts: delivery.attempts + 1,
          lastAttemptedAt: new Date(),
          error: null,
        },
      });
    } else {
      await handleDeliveryFailure(deliveryId, delivery.attempts + 1, `HTTP ${response.status}: ${responseBody.slice(0, 500)}`, response.status);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown delivery error";
    await handleDeliveryFailure(deliveryId, delivery.attempts + 1, message, null);
  }
}

const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_BASE_MS = 30_000;

async function handleDeliveryFailure(deliveryId: string, attempts: number, error: string, httpStatus: number | null) {
  const isFinal = attempts >= MAX_DELIVERY_ATTEMPTS;
  const nextRetryAt = isFinal
    ? null
    : new Date(Date.now() + DELIVERY_RETRY_BASE_MS * 2 ** (attempts - 1));

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: isFinal ? "FAILED" : "PENDING",
      httpStatus,
      attempts,
      lastAttemptedAt: new Date(),
      error,
      nextRetryAt,
    },
  });
}

export async function listWebhookDeliveries(actor: AppActor, params: {
  workspaceId: string;
  endpointId: string;
  take?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: params.endpointId, workspaceId: params.workspaceId },
  });
  invariant(endpoint, 404, "NOT_FOUND", "Webhook endpoint not found.");

  return prisma.webhookDelivery.findMany({
    where: { endpointId: params.endpointId },
    orderBy: { createdAt: "desc" },
    take: params.take ?? 50,
  });
}

// --- Inbound Webhooks ---

export async function processInboundWebhook(params: {
  workspaceId: string;
  source: string;
  externalId?: string | null;
  payload: Record<string, unknown>;
}) {
  const inbound = await prisma.inboundWebhook.create({
    data: {
      workspaceId: params.workspaceId,
      source: params.source,
      externalId: params.externalId ?? null,
      payload: toInputJson(params.payload),
    },
  });

  try {
    const eventType = mapInboundToEventType(params.source, params.payload);
    if (!eventType) {
      await prisma.inboundWebhook.update({
        where: { id: inbound.id },
        data: { processedAt: new Date(), error: "Unmapped event type" },
      });
      return { inboundId: inbound.id, eventCreated: false };
    }

    const event = await prisma.event.create({
      data: {
        workspaceId: params.workspaceId,
        type: eventType.type,
        aggregateType: eventType.aggregateType ?? null,
        aggregateId: eventType.aggregateId ?? null,
        payload: toInputJson({
          ...eventType.payload,
          inboundWebhookId: inbound.id,
          source: params.source,
        }),
      },
    });

    await prisma.inboundWebhook.update({
      where: { id: inbound.id },
      data: { processedAt: new Date() },
    });

    return { inboundId: inbound.id, eventCreated: true, eventId: event.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown processing error";
    await prisma.inboundWebhook.update({
      where: { id: inbound.id },
      data: { error: message },
    });
    return { inboundId: inbound.id, eventCreated: false, error: message };
  }
}

function mapInboundToEventType(source: string, payload: Record<string, unknown>): {
  type: string;
  aggregateType?: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
} | null {
  if (source === "slack") {
    return mapSlackEvent(payload);
  }

  if (source === "calendar") {
    return mapCalendarEvent(payload);
  }

  if (source === "generic") {
    const type = typeof payload.type === "string" ? payload.type : null;
    if (!type) return null;
    return {
      type,
      aggregateType: typeof payload.aggregateType === "string" ? payload.aggregateType : undefined,
      aggregateId: typeof payload.aggregateId === "string" ? payload.aggregateId : undefined,
      payload: (typeof payload.data === "object" && payload.data !== null ? payload.data : payload) as Record<string, unknown>,
    };
  }

  return null;
}

function mapSlackEvent(payload: Record<string, unknown>): {
  type: string;
  aggregateType?: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
} | null {
  const slackType = typeof payload.type === "string" ? payload.type : null;

  if (slackType === "message" || slackType === "app_mention") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const channel = typeof payload.channel === "string" ? payload.channel : "";
    const user = typeof payload.user === "string" ? payload.user : "";

    // Check for tension trigger (e.g., message containing "/tension" or "!tension")
    if (text.match(/^[!/]tension\s/i)) {
      return {
        type: "tension.created",
        aggregateType: "Tension",
        payload: {
          title: text.replace(/^[!/]tension\s*/i, "").trim(),
          bodyMd: `Filed via Slack by <${user}> in <#${channel}>`,
          slackChannel: channel,
          slackUser: user,
        },
      };
    }

    // Check for action trigger
    if (text.match(/^[!/]action\s/i)) {
      return {
        type: "action.created",
        aggregateType: "Action",
        payload: {
          title: text.replace(/^[!/]action\s*/i, "").trim(),
          bodyMd: `Filed via Slack by <${user}> in <#${channel}>`,
          slackChannel: channel,
          slackUser: user,
        },
      };
    }
  }

  return null;
}

function mapCalendarEvent(payload: Record<string, unknown>): {
  type: string;
  aggregateType?: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
} | null {
  const calendarType = typeof payload.type === "string" ? payload.type : null;

  if (calendarType === "meeting.ended" || calendarType === "recording.completed") {
    const title = typeof payload.title === "string" ? payload.title : "Untitled meeting";
    const recordingUrl = typeof payload.recordingUrl === "string" ? payload.recordingUrl : null;
    const transcript = typeof payload.transcript === "string" ? payload.transcript : null;

    return {
      type: "meeting.created",
      aggregateType: "Meeting",
      payload: {
        title,
        source: typeof payload.platform === "string" ? payload.platform : "calendar",
        recordingUrl,
        transcript,
        calendarEventId: typeof payload.calendarEventId === "string" ? payload.calendarEventId : null,
        participantEmails: Array.isArray(payload.participants) ? payload.participants : [],
      },
    };
  }

  return null;
}

export async function listInboundWebhooks(actor: AppActor, workspaceId: string, opts?: {
  take?: number;
  source?: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId, allowedRoles: ["ADMIN"] });

  return prisma.inboundWebhook.findMany({
    where: {
      workspaceId,
      ...(opts?.source ? { source: opts.source } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts?.take ?? 50,
  });
}
