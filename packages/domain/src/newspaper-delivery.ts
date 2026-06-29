import { env, logger, prisma, sendEmail, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { NewspaperCadence, NewspaperDeliveryKind, NewspaperDeliveryStatus } from "@prisma/client";
import { createHmac } from "node:crypto";
import { AppError } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import {
  getNewspaperLocalDateParts,
  getNextNewspaperRunISO,
  isHumanNewspaperRecipientIdentity,
  isNewspaperScheduleDue,
  normalizeNewspaperScheduleConfig,
  type NewspaperScheduleConfig,
} from "./agent-config";

const HREF_ATTR_PATTERN = /href\s*=\s*(["'])(.*?)\1/gi;
const TRACKING_SALT = "corgtex-newspaper-link";
export const NEWSPAPER_DELIVERY_RETRY_JOB_TYPE = "newspaper.delivery-retry";
const DEFAULT_RETRY_TAKE = 50;
const MAX_RETRY_TAKE = 250;

function appUrl() {
  return env.APP_URL.replace(/\/$/, "");
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeTrackableTarget(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(decodeHtmlAttribute(rawUrl));
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.toString().startsWith(`${appUrl()}/api/newspaper/click/`)) {
    return null;
  }

  return parsed.toString();
}

function trackingToken(runKey: string, targetUrlHash: string) {
  return createHmac("sha256", env.SESSION_COOKIE_SECRET)
    .update(`${runKey}:${targetUrlHash}:${TRACKING_SALT}`)
    .digest("base64url");
}

async function getTrackingUrl(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  runKey: string;
  targetUrl: string;
}) {
  const targetUrlHash = sha256(params.targetUrl);
  const token = trackingToken(params.runKey, targetUrlHash);

  await prisma.newspaperTrackedLink.upsert({
    where: {
      runKey_targetUrlHash: {
        runKey: params.runKey,
        targetUrlHash,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      runKey: params.runKey,
      targetUrl: params.targetUrl,
      targetUrlHash,
      tokenHash: sha256(token),
    },
    update: {},
  });

  return `${appUrl()}/api/newspaper/click/${token}`;
}

export async function instrumentNewspaperHtmlLinks(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  runKey: string;
  html: string;
}) {
  const targets = new Set<string>();
  for (const match of params.html.matchAll(HREF_ATTR_PATTERN)) {
    const target = normalizeTrackableTarget(match[2] ?? "");
    if (target) {
      targets.add(target);
    }
  }

  if (targets.size === 0) {
    return params.html;
  }

  const trackingUrls = new Map<string, string>();
  for (const targetUrl of targets) {
    trackingUrls.set(targetUrl, await getTrackingUrl({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      runKey: params.runKey,
      targetUrl,
    }));
  }

  return params.html.replace(HREF_ATTR_PATTERN, (match, quote: string, rawUrl: string) => {
    const target = normalizeTrackableTarget(rawUrl);
    const trackingUrl = target ? trackingUrls.get(target) : null;
    return trackingUrl ? `href=${quote}${escapeHtmlAttribute(trackingUrl)}${quote}` : match;
  });
}

export async function recordNewspaperDelivery(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  memberId?: string | null;
  demoLeadId?: string | null;
  kind: NewspaperDeliveryKind;
  cadence?: NewspaperCadence | null;
  runKey: string;
  recipientEmail: string;
  subject: string;
  status: NewspaperDeliveryStatus;
  providerMessageId?: string | null;
  error?: string | null;
  retryOfDeliveryId?: string | null;
  htmlSnapshot?: string | null;
}) {
  const now = new Date();
  return prisma.newspaperDelivery.create({
    data: {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      memberId: params.memberId ?? null,
      demoLeadId: params.demoLeadId ?? null,
      kind: params.kind,
      cadence: params.cadence ?? null,
      runKey: params.runKey,
      recipientEmail: params.recipientEmail,
      subject: params.subject,
      status: params.status,
      providerMessageId: params.providerMessageId ?? null,
      error: params.error ?? null,
      retryOfDeliveryId: params.retryOfDeliveryId ?? null,
      htmlSnapshot: params.htmlSnapshot ?? null,
      sentAt: params.status === "SENT" ? now : null,
      skippedAt: params.status === "SKIPPED" ? now : null,
      failedAt: params.status === "FAILED" ? now : null,
    },
  });
}

function boundedRetryTake(value: number | null | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_RETRY_TAKE;
  return Math.max(1, Math.min(MAX_RETRY_TAKE, Math.floor(value ?? DEFAULT_RETRY_TAKE)));
}

function isRetryableSkippedNewspaperDelivery(error: string | null | undefined) {
  const normalized = (error ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("no digest inputs")) return false;
  if (normalized.includes("no operating activity")) return false;
  if (normalized.includes("no matching recipients")) return false;
  if (normalized.includes("no digest sections")) return false;
  if (normalized.includes("cadence is off")) return false;
  return normalized.includes("resend")
    || normalized.includes("email")
    || normalized.includes("provider")
    || normalized.includes("api key")
    || normalized.includes("credential");
}

function isRetryableNewspaperDelivery(delivery: {
  status: NewspaperDeliveryStatus;
  error: string | null;
  htmlSnapshot: string | null;
}) {
  if (!delivery.htmlSnapshot?.trim()) return false;
  if (delivery.status === "FAILED") return true;
  if (delivery.status === "SKIPPED") return isRetryableSkippedNewspaperDelivery(delivery.error);
  return false;
}

function newspaperFailureBucket(params: {
  status: NewspaperDeliveryStatus | string;
  error?: string | null;
  emailStatus?: string | null;
  lastEventType?: string | null;
  failureReason?: string | null;
}) {
  const text = [
    params.status,
    params.error,
    params.emailStatus,
    params.lastEventType,
    params.failureReason,
  ].filter(Boolean).join(" ").toLowerCase();

  if (text.includes("complain")) return "complained";
  if (text.includes("bounce")) return "bounced";
  if (text.includes("resend_api_key missing") || text.includes("api key missing") || text.includes("missing")) return "missing_email_config";
  if (text.includes("unauthorized") || text.includes("forbidden") || text.includes("invalid") || text.includes("authentication")) return "invalid_email_config";
  if (text.includes("rate limit") || text.includes("timeout") || text.includes("temporar")) return "provider_transient";
  if (text.includes("no digest inputs") || text.includes("no operating activity")) return "no_digest_inputs";
  if (text.includes("no matching recipients")) return "no_recipients";
  if (text.includes("no digest sections")) return "empty_digest_sections";
  if (text.includes("cadence")) return "cadence_off";
  if (text.includes("email") || text.includes("resend") || text.includes("provider")) return "provider_send_error";
  return params.status === "FAILED" ? "unknown_failure" : "unknown_skip";
}

async function listRetryCandidateDeliveries(params: {
  workspaceId: string;
  deliveryIds?: string[] | null;
  workflowJobId?: string | null;
  runKey?: string | null;
  take?: number | null;
}) {
  const deliveryIds = Array.from(new Set((params.deliveryIds ?? []).map((id) => id.trim()).filter(Boolean)));
  const deliveries = await prisma.newspaperDelivery.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: { in: ["FAILED", "SKIPPED"] },
      retryAttempts: { none: {} },
      ...(deliveryIds.length ? { id: { in: deliveryIds } } : {}),
      ...(params.workflowJobId ? { workflowJobId: params.workflowJobId } : {}),
      ...(params.runKey ? { runKey: params.runKey } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: boundedRetryTake(params.take),
    select: {
      id: true,
      status: true,
      error: true,
      htmlSnapshot: true,
      runKey: true,
      workflowJobId: true,
      createdAt: true,
    },
  });

  return {
    deliveries,
    eligible: deliveries.filter(isRetryableNewspaperDelivery),
    missingSnapshotCount: deliveries.filter((delivery) => !delivery.htmlSnapshot?.trim()).length,
    nonRetryableCount: deliveries.filter((delivery) => delivery.htmlSnapshot?.trim() && !isRetryableNewspaperDelivery(delivery)).length,
  };
}

export async function getRetryableNewspaperDeliverySummary(workspaceId: string, opts?: {
  deliveryIds?: string[] | null;
  workflowJobId?: string | null;
  runKey?: string | null;
  take?: number | null;
}) {
  const result = await listRetryCandidateDeliveries({ workspaceId, ...opts });
  return {
    eligibleCount: result.eligible.length,
    missingSnapshotCount: result.missingSnapshotCount,
    nonRetryableCount: result.nonRetryableCount,
    eligibleDeliveryIds: result.eligible.map((delivery) => delivery.id),
  };
}

export async function retryFailedNewspaperDeliveries(actor: AppActor, params: {
  workspaceId: string;
  deliveryIds?: string[] | null;
  workflowJobId?: string | null;
  runKey?: string | null;
  take?: number | null;
  reason?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  const candidates = await listRetryCandidateDeliveries(params);
  const deliveryIds = candidates.eligible.map((delivery) => delivery.id);
  if (deliveryIds.length === 0) {
    return {
      queued: false,
      message: "No retryable failed or skipped newspaper deliveries with stored HTML snapshots were found.",
      eligibleCount: 0,
      missingSnapshotCount: candidates.missingSnapshotCount,
      nonRetryableCount: candidates.nonRetryableCount,
    };
  }

  const reason = params.reason?.trim() || "Retry failed newspaper deliveries.";
  const dedupeKey = `${params.workspaceId}:newspaper-delivery-retry:${sha256(deliveryIds.sort().join(","))}`;
  const job = await prisma.$transaction(async (tx) => {
    const queued = await tx.workflowJob.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        workspaceId: params.workspaceId,
        type: NEWSPAPER_DELIVERY_RETRY_JOB_TYPE,
        payload: {
          deliveryIds,
          reason,
          retryRequestedAt: new Date().toISOString(),
        },
        dedupeKey,
        runAfter: new Date(),
      },
      select: {
        id: true,
        status: true,
        type: true,
        dedupeKey: true,
        createdAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "newspaper.deliveries_retry_queued",
        entityType: "NewspaperDelivery",
        entityId: deliveryIds[0],
        meta: {
          deliveryIds,
          workflowJobId: queued.id,
          reason,
        },
      },
    });

    return queued;
  });

  return {
    queued: true,
    job,
    eligibleCount: deliveryIds.length,
    missingSnapshotCount: candidates.missingSnapshotCount,
    nonRetryableCount: candidates.nonRetryableCount,
  };
}

export async function runNewspaperDeliveryRetryJob(params: {
  workspaceId: string;
  workflowJobId: string;
  deliveryIds: string[];
}) {
  const requestedIds = Array.from(new Set(params.deliveryIds.map((id) => id.trim()).filter(Boolean)));
  if (requestedIds.length === 0) {
    return { success: true, sentEmails: 0, failedEmails: 0, skippedEmails: 0, ignoredDeliveries: 0 };
  }

  const deliveries = await prisma.newspaperDelivery.findMany({
    where: {
      id: { in: requestedIds },
      workspaceId: params.workspaceId,
      status: { in: ["FAILED", "SKIPPED"] },
      retryAttempts: { none: {} },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      workspaceId: true,
      workflowJobId: true,
      memberId: true,
      demoLeadId: true,
      kind: true,
      cadence: true,
      runKey: true,
      recipientEmail: true,
      subject: true,
      status: true,
      error: true,
      htmlSnapshot: true,
      member: { select: { userId: true } },
    },
  });

  let sentEmails = 0;
  let failedEmails = 0;
  let skippedEmails = 0;
  let ignoredDeliveries = 0;

  for (const delivery of deliveries) {
    if (!isRetryableNewspaperDelivery(delivery)) {
      ignoredDeliveries++;
      continue;
    }

    const html = delivery.htmlSnapshot!;
    const tracking = {
      emailType: delivery.kind === "DEMO_WELCOME" ? "newspaper.demo_welcome" : "newspaper.member",
      userId: delivery.member?.userId ?? null,
      workspaceId: delivery.workspaceId,
      metadata: {
        workspaceId: delivery.workspaceId,
        workflowJobId: params.workflowJobId,
        originalWorkflowJobId: delivery.workflowJobId,
        retryOfDeliveryId: delivery.id,
        runKey: delivery.runKey,
        cadence: delivery.cadence,
        kind: delivery.kind,
      },
    };

    try {
      const emailResult = await sendEmail({
        to: delivery.recipientEmail,
        subject: delivery.subject,
        html,
        tracking,
      });
      if (emailResult.status === "SENT") {
        sentEmails++;
        await recordNewspaperDelivery({
          workspaceId: delivery.workspaceId,
          workflowJobId: params.workflowJobId,
          retryOfDeliveryId: delivery.id,
          memberId: delivery.memberId,
          demoLeadId: delivery.demoLeadId,
          kind: delivery.kind,
          cadence: delivery.cadence,
          runKey: delivery.runKey,
          recipientEmail: delivery.recipientEmail,
          subject: delivery.subject,
          status: "SENT",
          providerMessageId: emailResult.providerMessageId,
        });
      } else {
        skippedEmails++;
        await recordNewspaperDelivery({
          workspaceId: delivery.workspaceId,
          workflowJobId: params.workflowJobId,
          retryOfDeliveryId: delivery.id,
          memberId: delivery.memberId,
          demoLeadId: delivery.demoLeadId,
          kind: delivery.kind,
          cadence: delivery.cadence,
          runKey: delivery.runKey,
          recipientEmail: delivery.recipientEmail,
          subject: delivery.subject,
          status: "SKIPPED",
          error: emailResult.reason,
          htmlSnapshot: html,
        });
      }
    } catch (error) {
      failedEmails++;
      const message = error instanceof Error ? error.message : "Unknown email error";
      await recordNewspaperDelivery({
        workspaceId: delivery.workspaceId,
        workflowJobId: params.workflowJobId,
        retryOfDeliveryId: delivery.id,
        memberId: delivery.memberId,
        demoLeadId: delivery.demoLeadId,
        kind: delivery.kind,
        cadence: delivery.cadence,
        runKey: delivery.runKey,
        recipientEmail: delivery.recipientEmail,
        subject: delivery.subject,
        status: "FAILED",
        error: message,
        htmlSnapshot: html,
      });
      logger.error("newspaper_delivery_retry_failed", {
        workspaceId: delivery.workspaceId,
        workflowJobId: params.workflowJobId,
        retryOfDeliveryId: delivery.id,
        error: message,
      });
    }
  }

  const ignoredMissingIds = requestedIds.length - deliveries.length;
  logger.info("newspaper_delivery_retry_completed", {
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    requestedDeliveries: requestedIds.length,
    sentEmails,
    failedEmails,
    skippedEmails,
    ignoredDeliveries: ignoredDeliveries + ignoredMissingIds,
  });

  return {
    success: true,
    sentEmails,
    failedEmails,
    skippedEmails,
    ignoredDeliveries: ignoredDeliveries + ignoredMissingIds,
  };
}

export async function recordNewspaperLinkClick(token: string) {
  const tokenHash = sha256(token.trim());
  const link = await prisma.newspaperTrackedLink.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      targetUrl: true,
      firstClickedAt: true,
    },
  });

  if (!link) {
    throw new AppError(404, "NOT_FOUND", "Newspaper link not found.");
  }

  const target = normalizeTrackableTarget(link.targetUrl);
  if (!target) {
    throw new AppError(404, "NOT_FOUND", "Newspaper link not found.");
  }

  const now = new Date();
  await prisma.newspaperTrackedLink.update({
    where: { id: link.id },
    data: {
      clickCount: { increment: 1 },
      firstClickedAt: link.firstClickedAt ?? now,
      lastClickedAt: now,
    },
  });

  return { targetUrl: target };
}

export async function listNewspaperDeliverySummaries(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const deliveries = await prisma.newspaperDelivery.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: Math.max((opts?.take ?? 20) * 20, 100),
    select: {
      id: true,
      kind: true,
      cadence: true,
      runKey: true,
      subject: true,
      status: true,
      sentAt: true,
      skippedAt: true,
      failedAt: true,
      createdAt: true,
      workflowJobId: true,
    },
  });

  const groups = new Map<string, {
    runKey: string;
    kind: NewspaperDeliveryKind;
    cadence: NewspaperCadence | null;
    subject: string;
    workflowJobId: string | null;
    createdAt: Date;
    firstSentAt: Date | null;
    lastSentAt: Date | null;
    sentCount: number;
    failedCount: number;
    skippedCount: number;
    recipientCount: number;
    trackedLinkCount: number;
    clickedLinkCount: number;
    totalClickCount: number;
  }>();

  for (const delivery of deliveries) {
    const group = groups.get(delivery.runKey) ?? {
      runKey: delivery.runKey,
      kind: delivery.kind,
      cadence: delivery.cadence,
      subject: delivery.subject,
      workflowJobId: delivery.workflowJobId,
      createdAt: delivery.createdAt,
      firstSentAt: null,
      lastSentAt: null,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      recipientCount: 0,
      trackedLinkCount: 0,
      clickedLinkCount: 0,
      totalClickCount: 0,
    };

    group.createdAt = delivery.createdAt > group.createdAt ? delivery.createdAt : group.createdAt;
    group.recipientCount += 1;
    if (delivery.status === "SENT") {
      group.sentCount += 1;
    } else if (delivery.status === "FAILED") {
      group.failedCount += 1;
    } else {
      group.skippedCount += 1;
    }

    if (delivery.sentAt) {
      group.firstSentAt = !group.firstSentAt || delivery.sentAt < group.firstSentAt ? delivery.sentAt : group.firstSentAt;
      group.lastSentAt = !group.lastSentAt || delivery.sentAt > group.lastSentAt ? delivery.sentAt : group.lastSentAt;
    }
    groups.set(delivery.runKey, group);
  }

  const runKeys = Array.from(groups.keys());
  if (runKeys.length > 0) {
    const links = await prisma.newspaperTrackedLink.findMany({
      where: { workspaceId, runKey: { in: runKeys } },
      select: { runKey: true, clickCount: true },
    });
    for (const link of links) {
      const group = groups.get(link.runKey);
      if (!group) continue;
      group.trackedLinkCount += 1;
      group.totalClickCount += link.clickCount;
      if (link.clickCount > 0) {
        group.clickedLinkCount += 1;
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, opts?.take ?? 20);
}

export async function listNewspaperDeliveryDetails(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.newspaperDelivery.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: opts?.take ?? 100,
    select: {
      id: true,
      kind: true,
      cadence: true,
      runKey: true,
      recipientEmail: true,
      subject: true,
      status: true,
      providerMessageId: true,
      sentAt: true,
      skippedAt: true,
      failedAt: true,
      error: true,
      createdAt: true,
      member: {
        select: {
          user: {
            select: {
              displayName: true,
              email: true,
            },
          },
        },
      },
    },
  });
}

async function countNewspaperSources(workspaceId: string, since: Date) {
  const [
    meetings,
    proposals,
    resolvedTensions,
    openActions,
    goals,
    goalUpdates,
    roleChanges,
    roleHolderChanges,
    newMembers,
    brainArticles,
    documents,
    activeAdviceRequests,
    conversations,
    slackMessages,
    buildArtifacts,
  ] = await Promise.all([
    prisma.meeting.count({
      where: {
        workspaceId,
        archivedAt: null,
        OR: [
          { recordedAt: { gte: since } },
          { updatedAt: { gte: since } },
          { summaryPostedAt: { gte: since } },
          { aiProcessedAt: { gte: since } },
        ],
      },
    }),
    prisma.proposal.count({
      where: {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        OR: [
          { createdAt: { gte: since } },
          { updatedAt: { gte: since } },
          { publishedAt: { gte: since } },
          { decidedAt: { gte: since } },
        ],
      },
    }),
    prisma.tension.count({
      where: {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: "RESOLVED",
        OR: [
          { resolvedAt: { gte: since } },
          { updatedAt: { gte: since } },
        ],
      },
    }),
    prisma.action.count({
      where: {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    }),
    prisma.goal.count({
      where: {
        workspaceId,
        archivedAt: null,
        OR: [
          { updatedAt: { gte: since } },
          { status: { in: ["ACTIVE", "ON_TRACK", "AT_RISK", "BEHIND"] } },
        ],
      },
    }),
    prisma.goalUpdate.count({
      where: {
        createdAt: { gte: since },
        goal: {
          workspaceId,
          archivedAt: null,
        },
      },
    }),
    prisma.roleVersion.count({
      where: {
        workspaceId,
        createdAt: { gte: since },
      },
    }),
    prisma.roleHolderHistory.count({
      where: {
        workspaceId,
        OR: [
          { startedAt: { gte: since } },
          { endedAt: { gte: since } },
        ],
      },
    }),
    prisma.member.count({
      where: {
        workspaceId,
        isActive: true,
        joinedAt: { gte: since },
      },
    }),
    prisma.brainArticle.count({
      where: {
        workspaceId,
        archivedAt: null,
        isPrivate: false,
        type: { not: "DIGEST" },
        OR: [
          { createdAt: { gte: since } },
          { updatedAt: { gte: since } },
          { publishedAt: { gte: since } },
        ],
      },
    }),
    prisma.document.count({
      where: {
        workspaceId,
        archivedAt: null,
        OR: [
          { createdAt: { gte: since } },
          { updatedAt: { gte: since } },
        ],
      },
    }),
    prisma.adviceRequest.count({
      where: {
        workspaceId,
        status: "ACTIVE",
      },
    }),
    prisma.conversationSession.count({
      where: {
        workspaceId,
        turns: { some: { createdAt: { gte: since } } },
      },
    }),
    prisma.communicationMessage.count({
      where: {
        workspaceId,
        provider: "SLACK",
        isHidden: false,
        isDeleted: false,
        receivedAt: { gte: since },
      },
    }),
    prisma.buildArtifact.count({
      where: {
        workspaceId,
        OR: [
          { updatedAt: { gte: since } },
          { mergedAt: { gte: since } },
          { closedAt: { gte: since } },
        ],
      },
    }),
  ]);

  return {
    meetings,
    proposals,
    resolvedTensions,
    openActions,
    goals,
    goalUpdates,
    roleChanges,
    roleHolderChanges,
    newMembers,
    brainArticles,
    documents,
    activeAdviceRequests,
    conversations,
    slackMessages,
    buildArtifacts,
  };
}

function nextRunsForRecipients(params: {
  now: Date;
  schedule: NewspaperScheduleConfig;
  recipientCadences: Set<NewspaperCadence>;
}) {
  return {
    daily: params.recipientCadences.has("DAILY")
      ? getNextNewspaperRunISO({ from: params.now, schedule: params.schedule, cadence: "DAILY" })
      : null,
    weekly: params.recipientCadences.has("WEEKLY")
      ? getNextNewspaperRunISO({ from: params.now, schedule: params.schedule, cadence: "WEEKLY" })
      : null,
  };
}

function newspaperDedupeKey(workspaceId: string, cadence: Exclude<NewspaperCadence, "OFF">, dateKey: string) {
  return `${workspaceId}:${cadence === "DAILY" ? "daily-digest" : "weekly-digest"}:${dateKey}`;
}

function countDeliveryStatuses(deliveries: Array<{ status: NewspaperDeliveryStatus }>) {
  return {
    sent: deliveries.filter((delivery) => delivery.status === "SENT").length,
    failed: deliveries.filter((delivery) => delivery.status === "FAILED").length,
    skipped: deliveries.filter((delivery) => delivery.status === "SKIPPED").length,
    total: deliveries.length,
  };
}

function buildDeliveryHealth(deliveries: Array<{
  runKey: string;
  workflowJobId: string | null;
  status: NewspaperDeliveryStatus;
  createdAt: Date;
  emailDelivery?: { status: string | null; lastEventType: string | null; bouncedAt: Date | null; complainedAt: Date | null } | null;
}>, unrecoveredFailureCount: number) {
  const latestRunKey = deliveries[0]?.runKey ?? null;
  const latestRunDeliveries = latestRunKey ? deliveries.filter((delivery) => delivery.runKey === latestRunKey) : [];
  const latestCounts = countDeliveryStatuses(latestRunDeliveries);
  const bounceOrComplaintCount = deliveries.filter((delivery) => (
    delivery.emailDelivery?.bouncedAt || delivery.emailDelivery?.complainedAt || delivery.emailDelivery?.lastEventType?.toLowerCase().includes("bounce") || delivery.emailDelivery?.lastEventType?.toLowerCase().includes("complain")
  )).length;

  return {
    latestRunKey,
    latestWorkflowJobId: latestRunDeliveries.find((delivery) => delivery.workflowJobId)?.workflowJobId ?? null,
    latestRunCreatedAt: latestRunDeliveries[0]?.createdAt ?? null,
    latestRunStatus: latestCounts.failed > 0 ? "failed" : latestCounts.sent > 0 ? "sent" : latestCounts.skipped > 0 ? "skipped" : "none",
    sentCount: latestCounts.sent,
    failedCount: latestCounts.failed,
    skippedCount: latestCounts.skipped,
    unrecoveredFailureCount,
    bounceOrComplaintCount,
  };
}

function buildFailureBuckets(deliveries: Array<{
  status: NewspaperDeliveryStatus;
  error: string | null;
  emailDelivery?: { status: string | null; lastEventType: string | null; failureReason: string | null } | null;
}>) {
  const buckets = new Map<string, number>();
  for (const delivery of deliveries) {
    const hasDeliveryFailure = delivery.status === "FAILED" || delivery.status === "SKIPPED";
    const hasProviderFailure = Boolean(delivery.emailDelivery?.failureReason)
      || delivery.emailDelivery?.status === "BOUNCED"
      || delivery.emailDelivery?.status === "COMPLAINED"
      || delivery.emailDelivery?.lastEventType?.toLowerCase().includes("bounce")
      || delivery.emailDelivery?.lastEventType?.toLowerCase().includes("complain");
    if (!hasDeliveryFailure && !hasProviderFailure) continue;
    const bucket = newspaperFailureBucket({
      status: delivery.status,
      error: delivery.error,
      emailStatus: delivery.emailDelivery?.status,
      lastEventType: delivery.emailDelivery?.lastEventType,
      failureReason: delivery.emailDelivery?.failureReason,
    });
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((left, right) => right.count - left.count || left.bucket.localeCompare(right.bucket));
}

function expectedRunsForCadences(params: {
  workspaceId: string;
  now: Date;
  schedule: NewspaperScheduleConfig;
  recipientCadences: Set<NewspaperCadence>;
  jobs: Array<{ id: string; status: string; dedupeKey: string | null; error: string | null; runAfter: Date; createdAt: Date; startedAt: Date | null; completedAt: Date | null }>;
  deliveries: Array<{ workflowJobId: string | null; runKey: string; status: NewspaperDeliveryStatus }>;
}) {
  const cadences = (["DAILY", "WEEKLY"] as const).filter((cadence) => params.recipientCadences.has(cadence));
  return cadences.map((cadence) => {
    const nextRunISO = getNextNewspaperRunISO({ from: params.now, schedule: params.schedule, cadence });
    const expectedAt = nextRunISO ? new Date(nextRunISO) : params.now;
    const localDateKey = getNewspaperLocalDateParts(expectedAt, params.schedule.timeZone).dateKey;
    const expectedDedupeKey = newspaperDedupeKey(params.workspaceId, cadence, localDateKey);
    const matchingJob = params.jobs.find((job) => job.dedupeKey === expectedDedupeKey) ?? null;
    const matchingDeliveries = matchingJob
      ? params.deliveries.filter((delivery) => delivery.workflowJobId === matchingJob.id || delivery.runKey === matchingJob.id)
      : [];
    const counts = countDeliveryStatuses(matchingDeliveries);
    const due = isNewspaperScheduleDue({ now: params.now, schedule: params.schedule, cadence });
    let state: "pending" | "completed" | "failed" | "missed" | "deduped" = due ? "missed" : "pending";
    if (matchingJob) {
      if (matchingJob.status === "FAILED" || matchingJob.status === "CANCELLED") {
        state = "failed";
      } else if (matchingJob.status === "COMPLETED") {
        state = counts.failed > 0 ? "failed" : "completed";
      } else {
        state = due ? "deduped" : "pending";
      }
    }
    return {
      cadence,
      localDateKey,
      expectedAt: nextRunISO,
      expectedDedupeKey,
      state,
      matchingJob: matchingJob ? {
        id: matchingJob.id,
        status: matchingJob.status,
        error: matchingJob.error,
        runAfter: matchingJob.runAfter,
        createdAt: matchingJob.createdAt,
        startedAt: matchingJob.startedAt,
        completedAt: matchingJob.completedAt,
      } : null,
      matchingDeliveries: counts,
    };
  });
}

export async function getNewspaperDiagnostics(actor: AppActor, workspaceId: string, opts?: { now?: Date; take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const now = opts?.now ?? new Date();
  const take = opts?.take ?? 10;
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: {
      workspaceId_agentKey: { workspaceId, agentKey: "daily-digest" },
    },
    select: {
      enabled: true,
      configJson: true,
    },
  });
  const schedule = normalizeNewspaperScheduleConfig(config?.configJson);
  const members = await prisma.member.findMany({
    where: { workspaceId, isActive: true },
    orderBy: { joinedAt: "asc" },
    select: {
      id: true,
      newspaperCadence: true,
      joinedAt: true,
      user: {
        select: {
          email: true,
          displayName: true,
        },
      },
    },
  });
  const recipients = members.map((member) => {
    const effectiveCadence = member.newspaperCadence ?? schedule.cadence;
    const isHumanRecipient = isHumanNewspaperRecipientIdentity(member.user);
    return {
      memberId: member.id,
      email: member.user.email,
      displayName: member.user.displayName,
      joinedAt: member.joinedAt,
      memberOverride: member.newspaperCadence,
      effectiveCadence,
      isHumanRecipient,
      receivesNewspaper: isHumanRecipient && effectiveCadence !== "OFF" && (config?.enabled ?? true),
    };
  });
  const recipientCadences = new Set<NewspaperCadence>(
    recipients.filter((recipient) => recipient.receivesNewspaper).map((recipient) => recipient.effectiveCadence),
  );
  const [oneDayCounts, sevenDayCounts, jobs, deliveries, retrySummary] = await Promise.all([
    countNewspaperSources(workspaceId, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    countNewspaperSources(workspaceId, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
    prisma.workflowJob.findMany({
      where: {
        workspaceId,
        type: "brain.daily-digest",
      },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        status: true,
        dedupeKey: true,
        payload: true,
        error: true,
        runAfter: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    prisma.newspaperDelivery.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: take * 5,
      select: {
        id: true,
        workflowJobId: true,
        retryOfDeliveryId: true,
        memberId: true,
        cadence: true,
        runKey: true,
        recipientEmail: true,
        subject: true,
        status: true,
        providerMessageId: true,
        error: true,
        htmlSnapshot: true,
        sentAt: true,
        skippedAt: true,
        failedAt: true,
        createdAt: true,
      },
    }),
    getRetryableNewspaperDeliverySummary(workspaceId, { take: 250 }),
  ]);
  const providerMessageIds = Array.from(new Set(deliveries.map((delivery) => delivery.providerMessageId).filter((id): id is string => Boolean(id))));
  const emailDeliveryRows = providerMessageIds.length
    ? await prisma.emailDelivery.findMany({
        where: { providerMessageId: { in: providerMessageIds } },
        select: {
          providerMessageId: true,
          status: true,
          lastEventType: true,
          lastEventAt: true,
          deliveredAt: true,
          bouncedAt: true,
          complainedAt: true,
          failureReason: true,
        },
      })
    : [];
  const emailDeliveryByMessageId = new Map(emailDeliveryRows.map((delivery) => [delivery.providerMessageId, delivery]));
  const enrichedDeliveries = deliveries.map(({ htmlSnapshot, ...delivery }) => ({
    ...delivery,
    hasHtmlSnapshot: Boolean(htmlSnapshot?.trim()),
    emailDelivery: delivery.providerMessageId ? emailDeliveryByMessageId.get(delivery.providerMessageId) ?? null : null,
  }));

  return {
    workspaceId,
    agentEnabled: config?.enabled ?? true,
    defaultSchedule: schedule,
    nextRuns: nextRunsForRecipients({ now, schedule, recipientCadences }),
    recipients,
    sourceCounts: {
      oneDay: oneDayCounts,
      sevenDays: sevenDayCounts,
    },
    deliveryHealth: buildDeliveryHealth(enrichedDeliveries, retrySummary.eligibleCount),
    failureBuckets: buildFailureBuckets(enrichedDeliveries),
    expectedRuns: expectedRunsForCadences({
      workspaceId,
      now,
      schedule,
      recipientCadences,
      jobs,
      deliveries: enrichedDeliveries,
    }),
    retriableFailures: retrySummary,
    recentJobs: jobs,
    recentDeliveries: enrichedDeliveries,
  };
}
