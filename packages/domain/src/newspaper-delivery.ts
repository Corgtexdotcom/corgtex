import { env, prisma, sha256, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { NewspaperCadence, NewspaperDeliveryKind, NewspaperDeliveryStatus } from "@prisma/client";
import { createHmac } from "node:crypto";
import { AppError } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import {
  getNextNewspaperRunISO,
  isHumanNewspaperRecipientIdentity,
  normalizeNewspaperScheduleConfig,
  type NewspaperScheduleConfig,
} from "./agent-config";

const HREF_ATTR_PATTERN = /href\s*=\s*(["'])(.*?)\1/gi;
const TRACKING_SALT = "corgtex-newspaper-link";

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

type NewspaperEditionCadence = Exclude<NewspaperCadence, "OFF">;

export async function upsertNewspaperEdition(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  cadence: NewspaperCadence;
  dateKey: string;
  runKey: string;
  title: string;
  slug: string;
  digestJson: unknown;
  bodyMd: string;
  sourceCounts: unknown;
}) {
  if (params.cadence === "OFF") {
    throw new AppError(400, "INVALID_INPUT", "Newspaper editions require a delivery cadence.");
  }

  const cadence = params.cadence as NewspaperEditionCadence;
  const generatedAt = new Date();
  return prisma.newspaperEdition.upsert({
    where: {
      workspaceId_cadence_dateKey: {
        workspaceId: params.workspaceId,
        cadence,
        dateKey: params.dateKey,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId ?? null,
      cadence,
      dateKey: params.dateKey,
      runKey: params.runKey,
      title: params.title,
      slug: params.slug,
      digestJson: toInputJson(params.digestJson),
      bodyMd: params.bodyMd,
      sourceCounts: toInputJson(params.sourceCounts),
      generatedAt,
    },
    update: {
      workflowJobId: params.workflowJobId ?? null,
      runKey: params.runKey,
      title: params.title,
      slug: params.slug,
      digestJson: toInputJson(params.digestJson),
      bodyMd: params.bodyMd,
      sourceCounts: toInputJson(params.sourceCounts),
      generatedAt,
    },
  });
}

export async function listNewspaperEditions(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.newspaperEdition.findMany({
    where: { workspaceId },
    orderBy: { generatedAt: "desc" },
    take: opts?.take ?? 20,
    select: {
      id: true,
      workflowJobId: true,
      cadence: true,
      dateKey: true,
      runKey: true,
      title: true,
      slug: true,
      digestJson: true,
      bodyMd: true,
      sourceCounts: true,
      generatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
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
      sentAt: params.status === "SENT" ? now : null,
      skippedAt: params.status === "SKIPPED" ? now : null,
      failedAt: params.status === "FAILED" ? now : null,
    },
  });
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

function isProviderSkippedNewspaperDelivery(error: string | null | undefined) {
  const normalized = error?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  if (normalized.includes("no digest inputs")) return false;
  if (normalized.includes("no operating activity")) return false;
  if (normalized.includes("no active members")) return false;
  if (normalized.includes("no matching recipients")) return false;
  if (normalized.includes("no digest sections")) return false;
  if (normalized.includes("cadence is off")) return false;
  if (normalized.includes("demo lead not found")) return false;
  if (normalized.includes("welcome newspaper already sent")) return false;
  return normalized.includes("resend")
    || normalized.includes("api key")
    || normalized.includes("credential")
    || normalized.includes("auth")
    || normalized.includes("provider")
    || normalized.includes("email")
    || normalized.includes("timeout")
    || normalized.includes("rate limit");
}

function hasProviderDeliveryFailure(delivery: {
  status: string | null;
  lastEventType: string | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
} | null | undefined) {
  const status = delivery?.status?.toLowerCase() ?? "";
  const lastEventType = delivery?.lastEventType?.toLowerCase() ?? "";
  return Boolean(delivery?.bouncedAt || delivery?.complainedAt)
    || status.includes("bounce")
    || status.includes("complain")
    || lastEventType.includes("bounce")
    || lastEventType.includes("complain");
}

function buildNewspaperDeliveryAlert(deliveries: Array<{
  id: string;
  runKey: string;
  recipientEmail: string;
  status: NewspaperDeliveryStatus;
  providerMessageId: string | null;
  error: string | null;
  createdAt: Date;
}>, emailDeliveryByMessageId: Map<string, {
  status: string | null;
  lastEventType: string | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
}>) {
  const latestRunKey = deliveries[0]?.runKey ?? null;
  const latestRunDeliveries = latestRunKey
    ? deliveries.filter((delivery) => delivery.runKey === latestRunKey)
    : [];
  const failed = latestRunDeliveries.filter((delivery) => delivery.status === "FAILED");
  const skippedAttention = latestRunDeliveries.filter((delivery) => (
    delivery.status === "SKIPPED" && isProviderSkippedNewspaperDelivery(delivery.error)
  ));
  const providerFailures = latestRunDeliveries.filter((delivery) => (
    delivery.providerMessageId
      ? hasProviderDeliveryFailure(emailDeliveryByMessageId.get(delivery.providerMessageId))
      : false
  ));
  const affectedById = new Map([...failed, ...skippedAttention, ...providerFailures].map((delivery) => [delivery.id, delivery]));
  const affectedRecipients = Array.from(affectedById.values()).map((delivery) => ({
    id: delivery.id,
    runKey: delivery.runKey,
    status: delivery.status,
    createdAt: delivery.createdAt,
    recipientEmail: delivery.recipientEmail,
    error: delivery.error,
  }));
  const failedCount = failed.length;
  const skippedAttentionCount = skippedAttention.length;
  const providerFailureCount = providerFailures.length;
  const state = failedCount + skippedAttentionCount + providerFailureCount > 0 ? "attention" : "ok";
  const reasons = [
    failedCount > 0 ? `${failedCount} failed delivery${failedCount === 1 ? "" : "ies"}` : null,
    skippedAttentionCount > 0 ? `${skippedAttentionCount} provider/config skip${skippedAttentionCount === 1 ? "" : "s"}` : null,
    providerFailureCount > 0 ? `${providerFailureCount} provider bounce/complaint${providerFailureCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  return {
    state,
    reason: reasons.length > 0 ? reasons.join("; ") : "Latest newspaper run has no active delivery alerts.",
    latestRunKey,
    latestRunAt: latestRunDeliveries[0]?.createdAt ?? null,
    failedCount,
    skippedAttentionCount,
    providerFailureCount,
    affectedRecipients,
  };
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
      kind: true,
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
    const isHumanRecipient = isHumanNewspaperRecipientIdentity(member);
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
  const [oneDayCounts, sevenDayCounts, jobs, deliveries, editions] = await Promise.all([
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
        memberId: true,
        cadence: true,
        runKey: true,
        recipientEmail: true,
        subject: true,
        status: true,
        providerMessageId: true,
        error: true,
        sentAt: true,
        skippedAt: true,
        failedAt: true,
        createdAt: true,
      },
    }),
    prisma.newspaperEdition.findMany({
      where: { workspaceId },
      orderBy: { generatedAt: "desc" },
      take,
      select: {
        id: true,
        workflowJobId: true,
        cadence: true,
        dateKey: true,
        runKey: true,
        title: true,
        slug: true,
        generatedAt: true,
        updatedAt: true,
      },
    }),
  ]);
  const providerMessageIds = Array.from(new Set(deliveries
    .map((delivery) => delivery.providerMessageId)
    .filter((id): id is string => Boolean(id))));
  const emailDeliveryRows = providerMessageIds.length > 0
    ? await prisma.emailDelivery.findMany({
        where: { providerMessageId: { in: providerMessageIds } },
        select: {
          providerMessageId: true,
          status: true,
          lastEventType: true,
          bouncedAt: true,
          complainedAt: true,
        },
      })
    : [];
  const emailDeliveryByMessageId = new Map(emailDeliveryRows.map((delivery) => [delivery.providerMessageId, delivery]));

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
    recentJobs: jobs,
    recentDeliveries: deliveries,
    recentEditions: editions,
    deliveryAlert: buildNewspaperDeliveryAlert(deliveries, emailDeliveryByMessageId),
  };
}
