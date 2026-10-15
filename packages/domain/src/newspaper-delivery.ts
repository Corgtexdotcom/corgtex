import { env, prisma, sha256, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { NewspaperCadence, NewspaperDelivery, NewspaperDeliveryKind, NewspaperDeliveryStatus, NewspaperEdition, NewspaperTrackedLink, Prisma } from "@prisma/client";
import { createHmac } from "node:crypto";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { invalidateArtifactInputLineage, readableArtifactIds, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";
import { DigestReadRelease, loadReadableDigestQuery } from "./digest-lineage";
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
  actor?: AppActor;
  lineageRoots?: LineageRoot[];
}) {
  if (params.cadence === "OFF") {
    throw new AppError(400, "INVALID_INPUT", "Newspaper editions require a delivery cadence.");
  }

  const cadence = params.cadence as NewspaperEditionCadence;
  const generatedAt = new Date();
  const actor = params.actor ?? { kind: "agent", authProvider: "bootstrap", label: "newspaper-edition",
    workspaceIds: [params.workspaceId] } as AppActor;
  return prisma.$transaction(async (tx) => {
    const edition = await tx.newspaperEdition.upsert({
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
    if (params.lineageRoots?.length) await recordArtifactInputLineage({
      tx, actor, workspaceId: params.workspaceId, artifact: { kind: "NewspaperEdition", id: edition.id },
      content: edition, origin: "DERIVED", inputs: [], inheritedRoots: params.lineageRoots,
    });
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "NewspaperEdition", id: edition.id }, content: edition });
    return edition;
  });
}

export async function listNewspaperEditions(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return loadReadableDigestQuery<NewspaperEdition>({ actor, workspaceId, kind: "NewspaperEdition", limit: opts?.take ?? 20,
    loadBatch: ({ take, skip }) => prisma.newspaperEdition.findMany({ where: { workspaceId },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }], take, skip }),
  });
}

async function getTrackingUrl(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  runKey: string;
  targetUrl: string;
  actor?: AppActor;
  lineageRoots?: LineageRoot[];
}) {
  // Distinct input permissions must never share one reusable redirect token.
  const scope = (params.lineageRoots ?? []).map((root) => `${root.kind}:${root.id}:${root.fingerprint}`).sort();
  const targetUrlHash = sha256(JSON.stringify([params.targetUrl, scope]));
  const token = trackingToken(params.runKey, targetUrlHash);

  await prisma.$transaction(async (tx) => {
    const link = await tx.newspaperTrackedLink.upsert({
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
    invariant(link.workspaceId === params.workspaceId, 409, "SOURCE_CHANGED", "Newspaper link scope changed.");
    if (params.lineageRoots?.length) await recordArtifactInputLineage({ tx,
      actor: params.actor ?? { kind: "agent", authProvider: "bootstrap", label: "newspaper-link", workspaceIds: [params.workspaceId] },
      workspaceId: params.workspaceId, artifact: { kind: "NewspaperTrackedLink", id: link.id }, content: link,
      origin: "DERIVED", inputs: [], inheritedRoots: params.lineageRoots });
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "NewspaperTrackedLink", id: link.id }, content: link });
  });

  return `${appUrl()}/api/newspaper/click/${token}`;
}

export async function instrumentNewspaperHtmlLinks(params: {
  workspaceId: string;
  workflowJobId?: string | null;
  runKey: string;
  html: string;
  actor?: AppActor;
  lineageRoots?: LineageRoot[];
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
      actor: params.actor,
      lineageRoots: params.lineageRoots,
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
  actor?: AppActor;
  lineageRoots?: LineageRoot[];
}) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const delivery = await tx.newspaperDelivery.create({
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
    if (params.lineageRoots?.length) {
      try {
        await recordArtifactInputLineage({ tx,
          actor: params.actor ?? { kind: "agent", authProvider: "bootstrap", label: "newspaper-delivery", workspaceIds: [params.workspaceId] },
          workspaceId: params.workspaceId, artifact: { kind: "NewspaperDelivery", id: delivery.id }, content: delivery,
          origin: "DERIVED", inputs: [], inheritedRoots: params.lineageRoots });
        return delivery;
      } catch (error) {
        if (!(error instanceof AppError) || !["SOURCE_CHANGED", "SOURCE_RESTRICTED", "UNKNOWN_LINEAGE"].includes(error.code)) throw error;
      }
    }
    // Keep the historical delivery outcome if authorization changed after send;
    // it remains unreadable until an independently safe receipt can be established.
    await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "NewspaperDelivery", id: delivery.id }, content: delivery });
    return delivery;
  });
}

export async function recordNewspaperLinkClick(actor: AppActor, token: string) {
  const tokenHash = sha256(token.trim());
  const link = await prisma.newspaperTrackedLink.findUnique({
    where: { tokenHash },
  });

  if (!link) {
    throw new AppError(404, "NOT_FOUND", "Newspaper link not found.");
  }

  try {
    await requireWorkspaceMembership({ actor, workspaceId: link.workspaceId });
    const readableRuns = await readableNewspaperRunKeys(actor, link.workspaceId, [link.runKey]);
    if (!readableRuns.has(link.runKey)) throw new Error("Unreadable edition");
    if (!(await readableArtifactIds(actor, link.workspaceId, "NewspaperTrackedLink", [link])).has(link.id)) throw new Error("Unreadable link");
  } catch {
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

async function readableNewspaperRunKeys(actor: AppActor, workspaceId: string, runKeys: string[]) {
  if (runKeys.length === 0) return new Set<string>();
  const editions = await prisma.newspaperEdition.findMany({
    where: { workspaceId, runKey: { in: [...new Set(runKeys)] } },
  });
  const readable = await readableArtifactIds(actor, workspaceId, "NewspaperEdition", editions);
  return new Set(editions.filter((edition) => readable.has(edition.id)).map((edition) => edition.runKey));
}

export async function listNewspaperDeliverySummaries(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  const limit = opts?.take ?? 20;
  invariant(Number.isInteger(limit) && limit >= 0 && limit <= 5_000, 400, "INVALID_INPUT", "Delivery summary limit is invalid.");
  if (limit === 0) return [];
  // Group identities are discovery only. Every count below still comes from
  // complete, permission-admitted rows, never from raw database aggregates.
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

  const addDelivery = (delivery: NewspaperDelivery) => {
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
  };

  const release = new DigestReadRelease(actor, workspaceId);
  const latestReadable = new Map<string, number>();
  let scannedGroups = 0, complete = false;
  const visitedRunKeys = new Set<string>();
  while (!complete) {
    const candidates = await prisma.newspaperDelivery.groupBy({by: ["runKey"], where: {workspaceId},
      _max: {createdAt: true}, orderBy: [{_max: {createdAt: "desc"}}, {runKey: "desc"}],
      take: 50, skip: scannedGroups});
    for (const candidate of candidates) {
      const threshold = [...latestReadable.values()].sort((a, b) => b - a)[limit - 1];
      // A group's raw latest timestamp is an upper bound on any permitted row.
      // Once it falls below the requested visible groups, older runs cannot win.
      if (threshold !== undefined && candidate._max.createdAt && candidate._max.createdAt.getTime() < threshold) {
        complete = true; break;
      }
      invariant(!visitedRunKeys.has(candidate.runKey), 409, "SOURCE_CHANGED", "Delivery groups changed during pagination.");
      visitedRunKeys.add(candidate.runKey);
      scannedGroups++;
      let after: NewspaperDelivery | undefined;
      while (true) {
        const batch: NewspaperDelivery[] = await prisma.newspaperDelivery.findMany({
          where: {workspaceId, runKey: candidate.runKey,
            ...(after ? {OR: [{createdAt: {lt: after.createdAt}}, {createdAt: after.createdAt, id: {lt: after.id}}]} : {})},
          orderBy: [{createdAt: "desc"}, {id: "desc"}], take: 100,
        });
        if (after) invariant(batch.every(row => row.createdAt < after!.createdAt ||
          (row.createdAt.getTime() === after!.createdAt.getTime() && row.id < after!.id)),
          409, "SOURCE_CHANGED", "Delivery collection changed during pagination.");
        const captured = await release.capture("NewspaperDelivery", batch);
        for (const row of captured.records) addDelivery(row);
        if (batch.length < 100) break;
        after = batch.at(-1);
      }
      const group = groups.get(candidate.runKey);
      if (group) latestReadable.set(candidate.runKey, group.createdAt.getTime());
    }
    if (candidates.length < 50) complete = true;
  }
  const selectedKeys = new Set([...latestReadable].sort(([a, left], [b, right]) => right - left || b.localeCompare(a))
    .slice(0, limit).map(([key]) => key));

  for (const key of groups.keys()) if (!selectedKeys.has(key)) groups.delete(key);

  const runKeys = Array.from(groups.keys());
  if (runKeys.length > 0) {
    let after: NewspaperTrackedLink | undefined;
    while (true) {
      const batch: NewspaperTrackedLink[] = await prisma.newspaperTrackedLink.findMany({
        where: { workspaceId, runKey: { in: runKeys }, ...(after ? { id: { gt: after.id } } : {}) },
        orderBy: { id: "asc" }, take: 100,
      });
      if (after) invariant(batch.every(link => link.id > after!.id),
        409, "SOURCE_CHANGED", "Delivery link collection changed during pagination.");
      const captured = await release.capture("NewspaperTrackedLink", batch);
      for (const link of captured.records) {
        const group = groups.get(link.runKey);
        if (!group) continue;
        group.trackedLinkCount += 1;
        group.totalClickCount += link.clickCount;
        if (link.clickCount > 0) group.clickedLinkCount += 1;
      }
      if (batch.length < 100) break;
      after = batch.at(-1);
    }
  }

  return release.finish(Array.from(groups.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.runKey.localeCompare(a.runKey))
    .slice(0, limit));
}

export async function listNewspaperDeliveryDetails(actor: AppActor, workspaceId: string, opts?: { take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });

  return loadReadableDigestQuery<Prisma.NewspaperDeliveryGetPayload<{ include: { member: { select: { user: { select: { displayName: true; email: true } } } } } }>>({ actor, workspaceId, kind: "NewspaperDelivery", limit: opts?.take ?? 100,
    loadBatch: ({ take, skip }) => prisma.newspaperDelivery.findMany({
    where: { workspaceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take, skip,
    include: {
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
    }),
  });
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
  const [visibleEditions, visibleDeliveries] = await Promise.all([
    listNewspaperEditions(actor, workspaceId, { take }),
    loadReadableDigestQuery<NewspaperDelivery>({ actor, workspaceId, kind: "NewspaperDelivery", limit: take * 5,
      loadBatch: ({ take, skip }) => prisma.newspaperDelivery.findMany({ where: { workspaceId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, skip }),
    }),
  ]);
  const visibleJobIds = [...new Set([
    ...visibleEditions.map((edition) => edition.workflowJobId),
    ...visibleDeliveries.map((delivery) => delivery.workflowJobId),
  ].filter((id): id is string => Boolean(id)))];
  const jobs = visibleJobIds.length ? await prisma.workflowJob.findMany({
    where: { workspaceId, type: "brain.daily-digest", id: { in: visibleJobIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take,
    select: { id: true, status: true, dedupeKey: true, runAfter: true,
      createdAt: true, startedAt: true, completedAt: true },
  }) : [];
  const providerMessageIds = Array.from(new Set(visibleDeliveries
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
  const deliveryAlert = buildNewspaperDeliveryAlert(visibleDeliveries, emailDeliveryByMessageId);

  return {
    workspaceId,
    agentEnabled: config?.enabled ?? true,
    defaultSchedule: schedule,
    nextRuns: nextRunsForRecipients({ now, schedule, recipientCadences }),
    recipients,
    sourceCounts: visibleEditions[0]?.sourceCounts ?? null,
    recentJobs: jobs,
    recentDeliveries: visibleDeliveries.map((delivery) => ({ ...delivery, subject: null, error: null })),
    recentEditions: visibleEditions.map((edition) => ({
      id: edition.id, workflowJobId: edition.workflowJobId, cadence: edition.cadence,
      dateKey: edition.dateKey, runKey: edition.runKey, title: edition.title, slug: edition.slug,
      generatedAt: edition.generatedAt, updatedAt: edition.updatedAt,
    })),
    deliveryAlert: {
      ...deliveryAlert,
      affectedRecipients: deliveryAlert.affectedRecipients.map((recipient) => ({ ...recipient, error: null })),
    },
  };
}
