import { env, prisma, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { NewspaperCadence, NewspaperDeliveryKind, NewspaperDeliveryStatus } from "@prisma/client";
import { createHmac } from "node:crypto";
import { AppError } from "./errors";
import { requireWorkspaceMembership } from "./auth";

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
