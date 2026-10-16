import type { Prisma } from "@prisma/client";
import { env, prisma, sendEmail } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { humanMemberIdentityWhere } from "./member-identity";
import { captureArtifactInputProof, captureArtifactReadHeadObservation, mergeLineageInputRoot,
  readableArtifactIds, sealArtifactInputActor, withArtifactCountReleaseSnapshot, type LineageRoot } from "./source-lineage";
import type { SlackAttemptControls } from "./communication";
import { AppError, invariant } from "./errors";
import { prepareProducerLineage, finishProducerLineage, type ProducerLineageParams } from "./producer-lineage";

export const DEFAULT_NOTIFICATION_CHANNEL = "IN_APP";
export const NOTIFICATION_DELIVERY_JOB_TYPE = "notification.delivery";
export const NOTIFICATION_DELIVERY_EMAIL_CHANNEL = "EMAIL";
export const NOTIFICATION_DELIVERY_SLACK_CHANNEL = "SLACK";
const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

export const OUTBOUND_ELIGIBLE_NOTIFICATION_TYPES = new Set([
  "deliberation.mention",
  "deliberation.reply",
  "advice.requested",
  "advice.reminder_due",
  "advice.reply_posted",
  "role-onboarding.assigned",
  "budget.threshold_reached",
  "action.assigned",
  "tension.assigned",
]);

export const STORED_NOTIFICATION_CHANNELS = [
  "IN_APP",
  "EMAIL",
  "SLACK",
  "IN_APP_EMAIL",
  "IN_APP_SLACK",
  "EMAIL_SLACK",
  "ALL",
  "BOTH",
  "OFF",
] as const;

export const NOTIFICATION_PREFERENCE_CHANNELS = [
  ...STORED_NOTIFICATION_CHANNELS,
  "USE_DEFAULT",
] as const;

export type StoredNotificationChannel = typeof STORED_NOTIFICATION_CHANNELS[number];
export type NotificationPreferenceChannel = typeof NOTIFICATION_PREFERENCE_CHANNELS[number];
export type NotificationPriority = "LOW" | "NORMAL" | "HIGH";

export type NotificationIntentParams = ProducerLineageParams & {
  lineageActor?: AppActor;
  workspaceId: string;
  type: string;
  recipientUserIds: string[];
  title: string;
  bodyMd?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  actorUserId?: string | null;
  priority?: NotificationPriority;
  dedupeKey?: string | null;
};

export function isNotificationPreferenceChannel(value: string): value is NotificationPreferenceChannel {
  return (NOTIFICATION_PREFERENCE_CHANNELS as readonly string[]).includes(value);
}

function storedChannel(value: string | null | undefined): StoredNotificationChannel {
  if ((STORED_NOTIFICATION_CHANNELS as readonly string[]).includes(value ?? "")) {
    return value as StoredNotificationChannel;
  }
  return DEFAULT_NOTIFICATION_CHANNEL;
}

function channelEnablesInApp(channel: StoredNotificationChannel) {
  return channel !== "OFF";
}

function channelEnablesEmail(channel: StoredNotificationChannel) {
  return channel === "EMAIL"
    || channel === "IN_APP_EMAIL"
    || channel === "EMAIL_SLACK"
    || channel === "ALL"
    || channel === "BOTH";
}

function channelEnablesSlack(channel: StoredNotificationChannel) {
  return channel === "SLACK"
    || channel === "IN_APP_SLACK"
    || channel === "EMAIL_SLACK"
    || channel === "ALL";
}

function effectiveChannels(preferences: Array<{ userId: string; notifType: string; channel: string }>, userId: string, type: string) {
  const exact = preferences.find((preference) => preference.userId === userId && preference.notifType === type);
  const globalDefault = preferences.find((preference) => preference.userId === userId && preference.notifType === "*");
  return storedChannel(exact?.channel ?? globalDefault?.channel ?? DEFAULT_NOTIFICATION_CHANNEL);
}

function notificationDedupeKey(baseDedupeKey: string | null | undefined, userId: string) {
  const trimmed = baseDedupeKey?.trim();
  return trimmed ? `${trimmed}:${userId}` : null;
}

function notificationRetryTime(attempt: number) {
  const normalizedAttempt = Math.max(1, attempt);
  const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (normalizedAttempt - 1), RETRY_MAX_DELAY_MS);
  return new Date(Date.now() + delayMs);
}

function deliveryJobDedupeKey(deliveryId: string) {
  return `notification-delivery:${deliveryId}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function notificationUrl(workspaceId: string) {
  return `${env.APP_URL.replace(/\/$/, "")}/workspaces/${encodeURIComponent(workspaceId)}/notifications`;
}

function renderNotificationEmail(params: {
  workspaceId: string;
  title: string;
  bodyMd?: string | null;
}) {
  const url = notificationUrl(params.workspaceId);
  const body = params.bodyMd?.trim() ?? "";
  const escapedBody = body ? escapeHtml(body).replace(/\r?\n/g, "<br />") : "";
  const html = [
    `<p>${escapeHtml(params.title)}</p>`,
    escapedBody ? `<p>${escapedBody}</p>` : "",
    `<p><a href="${escapeHtml(url)}">Open in Corgtex</a></p>`,
  ].filter(Boolean).join("\n");
  const text = [
    params.title,
    body,
    `Open in Corgtex: ${url}`,
  ].filter(Boolean).join("\n\n");
  return { html, text };
}

function escapeSlackMrkdwn(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function slackText(value: string, maxLength: number) {
  const escaped = escapeSlackMrkdwn(value.trim());
  return escaped.length > maxLength ? `${escaped.slice(0, Math.max(0, maxLength - 3))}...` : escaped;
}

function renderNotificationSlackMessage(params: {
  workspaceId: string;
  title: string;
  bodyMd?: string | null;
}) {
  const url = notificationUrl(params.workspaceId);
  const body = params.bodyMd?.trim() ?? "";
  const text = [
    params.title,
    body,
    `Open in Corgtex: ${url}`,
  ].filter(Boolean).join("\n\n");
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${slackText(params.title, 250)}*`,
      },
    },
    body
      ? {
        type: "section",
        text: {
          type: "mrkdwn",
          text: slackText(body, 2_900),
        },
      }
      : null,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open in Corgtex",
          },
          url,
        },
      ],
    },
  ].filter(Boolean);
  return { blocks, text };
}

type NotificationDeliveryIntentClient = Pick<Prisma.TransactionClient, "notificationDelivery" | "workflowJob">;

async function createNotificationDeliveryIntent(
  tx: NotificationDeliveryIntentClient,
  notification: { id: string; workspaceId: string; userId: string },
  channel: string,
) {
  const nextAttemptAt = new Date();
  const delivery = await tx.notificationDelivery.upsert({
    where: {
      notificationId_channel: {
        notificationId: notification.id,
        channel,
      },
    },
    update: {},
    create: {
      notificationId: notification.id,
      workspaceId: notification.workspaceId,
      userId: notification.userId,
      channel,
      status: "PENDING",
      nextAttemptAt,
    },
    select: { id: true },
  });

  await tx.workflowJob.upsert({
    where: { dedupeKey: deliveryJobDedupeKey(delivery.id) },
    update: {},
    create: {
      workspaceId: notification.workspaceId,
      type: NOTIFICATION_DELIVERY_JOB_TYPE,
      payload: { deliveryId: delivery.id },
      dedupeKey: deliveryJobDedupeKey(delivery.id),
      runAfter: nextAttemptAt,
    },
  });
}

async function createEmailDeliveryIntent(
  tx: NotificationDeliveryIntentClient,
  notification: { id: string; workspaceId: string; userId: string },
) {
  await createNotificationDeliveryIntent(tx, notification, NOTIFICATION_DELIVERY_EMAIL_CHANNEL);
}

async function createSlackDeliveryIntent(
  tx: NotificationDeliveryIntentClient,
  notification: { id: string; workspaceId: string; userId: string },
) {
  await createNotificationDeliveryIntent(tx, notification, NOTIFICATION_DELIVERY_SLACK_CHANNEL);
}

function isDefinitiveNotificationDenial(error: unknown) {
  return error instanceof AppError
    && ["AUTH_REQUIRED", "NOT_A_MEMBER", "SOURCE_RESTRICTED", "UNKNOWN_LINEAGE"].includes(error.code);
}

export async function createNotificationIntent(
  tx: Prisma.TransactionClient,
  params: NotificationIntentParams,
) {
  const recipientUserIds = Array.from(new Set(params.recipientUserIds.filter(Boolean)))
    .filter((userId) => userId !== params.actorUserId);
  if (recipientUserIds.length === 0) {
    return { count: 0 };
  }

  const activeRecipients = await tx.member.findMany({
    where: {
      workspaceId: params.workspaceId,
      userId: { in: recipientUserIds },
      isActive: true,
      ...humanMemberIdentityWhere(),
    },
    select: {
      userId: true,
      user: { select: { id: true, email: true, displayName: true, globalRole: true } },
    },
  });
  if (activeRecipients.length === 0) {
    return { count: 0 };
  }

  const activeRecipientsByUserId = new Map(activeRecipients.map((member) => [member.userId, member]));
  const uniqueActiveRecipients = Array.from(activeRecipientsByUserId.values());
  const activeRecipientUserIds = uniqueActiveRecipients.map((member) => member.userId);
  const preferences = await tx.notificationPreference.findMany({
    where: {
      userId: { in: activeRecipientUserIds },
      notifType: { in: [params.type, "*"] },
    },
    select: {
      userId: true,
      notifType: true,
      channel: true,
    },
  });

  const channelByUserId = new Map(uniqueActiveRecipients.map((recipient) => [
    recipient.userId,
    effectiveChannels(preferences, recipient.userId, params.type),
  ]));
  const recipients = uniqueActiveRecipients
    .filter((recipient) => channelEnablesInApp(channelByUserId.get(recipient.userId) ?? DEFAULT_NOTIFICATION_CHANNEL));
  if (recipients.length === 0) {
    return { count: 0 };
  }

  const priority = params.priority ?? "NORMAL";
  const shouldAllowOutbound = OUTBOUND_ELIGIBLE_NOTIFICATION_TYPES.has(params.type);
  const shouldCreateEmailDelivery = (recipient: typeof recipients[number]) => {
    const channel = channelByUserId.get(recipient.userId) ?? DEFAULT_NOTIFICATION_CHANNEL;
    return shouldAllowOutbound && channelEnablesEmail(channel) && Boolean(recipient.user?.email);
  };
  const shouldCreateSlackDelivery = (recipient: typeof recipients[number]) => {
    const channel = channelByUserId.get(recipient.userId) ?? DEFAULT_NOTIFICATION_CHANNEL;
    return shouldAllowOutbound && channelEnablesSlack(channel);
  };
  const lineageActor = params.lineageActor ?? { kind: "agent" as const, authProvider: "bootstrap" as const,
    label: "notification-without-receipt", workspaceIds: [params.workspaceId] };
  const receipt = await prepareProducerLineage({ tx, actor: lineageActor, workspaceId: params.workspaceId,
    copied: true, capture: params.lineageActor ? params : {} });
  let count = 0;
  for (const recipient of recipients) {
    const dedupeKey = notificationDedupeKey(params.dedupeKey, recipient.userId);
    // Existing content keeps its own receipt. A retry cannot certify an older
    // payload with a new caller's input set.
    if (dedupeKey) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification:${dedupeKey}`}, 0))`;
    const existing = dedupeKey ? await tx.notification.findUnique({ where: { dedupeKey } }) : null;
    const notification = existing ?? await tx.notification.create({ data: {
      workspaceId: params.workspaceId, userId: recipient.userId, type: params.type, dedupeKey, priority,
      entityType: params.entityType ?? null, entityId: params.entityId ?? null,
      title: params.title, bodyMd: params.bodyMd ?? null,
    } });
    if (!existing) await finishProducerLineage({ tx, actor: lineageActor, workspaceId: params.workspaceId,
      artifact: { kind: "Notification", id: notification.id }, content: notification, receipt });
    count += 1;
    if (!existing && receipt.mode === "UNKNOWN") continue;
    if (!recipient.user || notification.workspaceId !== params.workspaceId || notification.userId !== recipient.userId) continue;
    const recipientActor: AppActor = { kind: "user", user: recipient.user };
    let readable = false;
    try {
      readable = (await readableArtifactIds(recipientActor, params.workspaceId, "Notification", [notification], tx)).has(notification.id);
    } catch (error) {
      // A revoked recipient does not block other recipients. Infrastructure or
      // proof drift must abort the producer transaction so its intent can retry.
      if (!isDefinitiveNotificationDenial(error)) throw error;
    }
    if (!readable) continue;
    if (shouldCreateEmailDelivery(recipient)) await createEmailDeliveryIntent(tx, notification);
    if (shouldCreateSlackDelivery(recipient)) await createSlackDeliveryIntent(tx, notification);
  }

  return { count };
}

type NotificationDeliveryWithRecipient = Prisma.NotificationDeliveryGetPayload<{
  include: {
    notification: true;
    user: { select: { email: true } };
  };
}>;

async function refreshReadableDelivery(delivery: NotificationDeliveryWithRecipient, retainProof = false) {
  const actor = await currentRecipientActor(delivery.userId, delivery.workspaceId);
  const notification = actor ? await prisma.notification.findFirst({ where: {
    id: delivery.notificationId, workspaceId: delivery.workspaceId, userId: delivery.userId,
  } }) : null;
  let readable = false;
  let roots: LineageRoot[] = [];
  let heads = new Map<string, string>();
  if (actor && notification) {
    try {
      if (retainProof) sealArtifactInputActor(actor);
      const observed = await captureArtifactReadHeadObservation(async () => {
        readable = (await readableArtifactIds(actor, delivery.workspaceId, "Notification", [notification])).has(notification.id);
        if (readable && retainProof) roots = await captureArtifactInputProof(actor, delivery.workspaceId,
          [{ kind: "Notification", id: notification.id, snapshot: notification }]);
      });
      heads = observed.heads;
    } catch (error) {
      // Unavailable proof infrastructure must leave the queued intent retryable.
      // A current denial still permanently withholds this outbound content.
      if (!isDefinitiveNotificationDenial(error)) throw error;
      readable = false;
    }
  }
  if (!readable || !notification || actor?.kind !== "user") {
    await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: {
      status: "SKIPPED", failedAt: new Date(), error: "Notification inputs or recipient access are unavailable.",
    } });
    return false;
  }
  delivery.notification = notification;
  delivery.user = { email: actor.user.email };
  return { actor, roots, heads };
}

type DeliveryProof = Exclude<Awaited<ReturnType<typeof refreshReadableDelivery>>, false>;

async function createEmailFallbackDelivery(delivery: NotificationDeliveryWithRecipient) {
  if (!delivery.user.email) return;
  await createEmailDeliveryIntent(prisma, {
    id: delivery.notificationId,
    workspaceId: delivery.workspaceId,
    userId: delivery.userId,
  });
}

async function deliverEmailNotificationDelivery(delivery: NotificationDeliveryWithRecipient) {
  if (!await refreshReadableDelivery(delivery)) return { status: "SKIPPED" as const };
  if (!delivery.user.email) {
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SKIPPED",
        failedAt: new Date(),
        error: "Recipient user has no email address.",
      },
    });
    return { status: "SKIPPED" as const };
  }

  const attempt = delivery.attempts + 1;
  const email = renderNotificationEmail({
    workspaceId: delivery.workspaceId,
    title: delivery.notification.title,
    bodyMd: delivery.notification.bodyMd,
  });

  try {
    const result = await sendEmail({
      to: delivery.user.email,
      subject: delivery.notification.title,
      html: email.html,
      text: email.text,
      tracking: {
        emailType: `notification.${delivery.notification.type}`,
        userId: delivery.userId,
        workspaceId: delivery.workspaceId,
        metadata: {
          notificationId: delivery.notificationId,
          notificationType: delivery.notification.type,
          channel: delivery.channel,
        },
      },
    });

    if (result.status === "SKIPPED") {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SKIPPED",
          attempts: attempt,
          failedAt: new Date(),
          error: result.reason,
        },
      });
      return { status: "SKIPPED" as const };
    }

    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SENT",
        attempts: attempt,
        sentAt: new Date(),
        failedAt: null,
        providerMessageId: result.providerMessageId,
        error: null,
      },
    });
    return { status: "SENT" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown notification email delivery error.";
    const finalAttempt = attempt >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS;
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: finalAttempt ? "FAILED" : "PENDING",
        attempts: attempt,
        nextAttemptAt: finalAttempt ? new Date() : notificationRetryTime(attempt),
        failedAt: finalAttempt ? new Date() : null,
        error: message,
      },
    });
    if (!finalAttempt) {
      throw error;
    }
    return { status: "FAILED" as const };
  }
}

async function deliverSlackNotificationDelivery(delivery: NotificationDeliveryWithRecipient, original: DeliveryProof) {
  const attempt = delivery.attempts + 1;
  let checkingAuthority = false;
  const controller = new AbortController();
  const originalEmail = original.actor.user.email;
  const controls: SlackAttemptControls = {
    signal: controller.signal,
    authorizeAttempt: async ({ signal }) => {
      try {
        controller.signal.throwIfAborted();
        signal.throwIfAborted();
        await withArtifactCountReleaseSnapshot(original.actor, delivery.workspaceId, original.roots, async () => {}, async tx => {
          await requireWorkspaceMembership({ actor: original.actor, workspaceId: delivery.workspaceId, tx });
          const user = await tx.user.findFirst({ where: { id: delivery.userId,
            memberships: { some: { workspaceId: delivery.workspaceId, isActive: true } } }, select: { email: true } });
          invariant(user?.email === originalEmail, 403, "SOURCE_RESTRICTED", "Notification recipient identity is unavailable.");
        }, original.heads);
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    },
  };

  try {
    const { resolveSlackNotificationRecipient, sendSlackMessage } = await import("./communication");
    const resolvedEmail = delivery.user.email;
    const recipient = await resolveSlackNotificationRecipient({
      workspaceId: delivery.workspaceId,
      userId: delivery.userId,
      email: delivery.user.email,
    });
    if (!recipient) {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SKIPPED",
          attempts: attempt,
          failedAt: new Date(),
          error: "Recipient user has no mapped Slack identity.",
        },
      });
      await createEmailFallbackDelivery(delivery);
      return { status: "SKIPPED" as const };
    }

    checkingAuthority = true;
    const readable = await refreshReadableDelivery(delivery);
    checkingAuthority = false;
    if (!readable) return { status: "SKIPPED" as const };
    if (delivery.user.email !== resolvedEmail) {
      await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: {
        status: "SKIPPED", failedAt: new Date(), error: "Recipient identity changed during Slack resolution.",
      } });
      return { status: "SKIPPED" as const };
    }
    const slack = renderNotificationSlackMessage({
      workspaceId: delivery.workspaceId,
      title: delivery.notification.title,
      bodyMd: delivery.notification.bodyMd,
    });
    const result = await sendSlackMessage(recipient.installationId, {
      channel: recipient.externalUserId,
      text: slack.text,
    }, slack.blocks, undefined, controls);
    controller.signal.throwIfAborted();

    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SENT",
        attempts: attempt,
        sentAt: new Date(),
        failedAt: null,
        providerMessageId: typeof result.ts === "string" ? result.ts : null,
        error: null,
      },
    });
    return { status: "SENT" as const };
  } catch (error) {
    // Proof failure is not a Slack transport failure and must not terminalize
    // the intent or create fallback mail before a later retry can revalidate it.
    controller.signal.throwIfAborted();
    if (checkingAuthority) throw error;
    const message = error instanceof Error ? error.message : "Unknown notification Slack delivery error.";
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        attempts: attempt,
        failedAt: new Date(),
        error: message,
      },
    });
    await createEmailFallbackDelivery(delivery);
    return { status: "FAILED" as const };
  }
}

export async function deliverNotificationDelivery(deliveryId: string) {
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      notification: true,
      user: { select: { email: true } },
    },
  });
  if (!delivery || delivery.status === "SENT" || delivery.status === "SKIPPED" || delivery.status === "FAILED") {
    return { status: "SKIPPED" as const };
  }
  const original = await refreshReadableDelivery(delivery, delivery.channel === NOTIFICATION_DELIVERY_SLACK_CHANNEL);
  if (!original) return { status: "SKIPPED" as const };
  if (delivery.channel === NOTIFICATION_DELIVERY_EMAIL_CHANNEL) {
    return deliverEmailNotificationDelivery(delivery);
  }
  if (delivery.channel === NOTIFICATION_DELIVERY_SLACK_CHANNEL) {
    return deliverSlackNotificationDelivery(delivery, original);
  }
  {
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SKIPPED",
        failedAt: new Date(),
        error: `Unsupported notification delivery channel: ${delivery.channel}`,
      },
    });
    return { status: "SKIPPED" as const };
  }
}

async function currentRecipientActor(userId: string, workspaceId: string): Promise<AppActor | null> {
  const user = await prisma.user.findFirst({ where: { id: userId,
    memberships: { some: { workspaceId, isActive: true } } },
    select: { id: true, email: true, displayName: true, globalRole: true },
  });
  return user ? { kind: "user", user } : null;
}

export async function listNotifications(actor: AppActor, workspaceId: string, opts?: {
  unreadOnly?: boolean;
  take?: number;
  skip?: number;
}) {
  if (actor.kind !== "user") return [];
  await requireWorkspaceMembership({ actor, workspaceId });
  const skip = Math.max(0, opts?.skip ?? 0);
  const take = Math.max(0, opts?.take ?? 30);
  const result: Awaited<ReturnType<typeof prisma.notification.findMany>> = [];
  if (!take) return result;
  let visible = 0;
  return visitReadableNotifications(actor, workspaceId, Boolean(opts?.unreadOnly), rows => {
    for (const row of rows) {
      if (visible++ >= skip) result.push(row);
      if (result.length >= take) return false;
    }
  }, async () => result);
}

async function visitReadableNotifications<T>(actor: AppActor & { kind: "user" }, workspaceId: string,
  unreadOnly: boolean, visit: (rows: Awaited<ReturnType<typeof prisma.notification.findMany>>) => false | void,
  finish: (tx: Prisma.TransactionClient) => Promise<T>, notificationId?: string): Promise<T> {
  sealArtifactInputActor(actor);
  const roots = new Map<string, LineageRoot>();
  const heads = new Map<string, string>();
  let after: { id: string; createdAt: Date } | undefined;
  while (true) {
    const rows = await prisma.notification.findMany({ where: {
      workspaceId, userId: actor.user.id, ...(unreadOnly ? { readAt: null } : {}),
      ...(notificationId === undefined ? {} : { id: notificationId }),
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } },
        { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
    const last = rows.at(-1);
    const next = last ? { id: last.id, createdAt: last.createdAt } : undefined;
    const observed = await captureArtifactReadHeadObservation(async () => {
      const readable = await readableArtifactIds(actor, workspaceId, "Notification", rows);
      const admitted = rows.filter(row => readable.has(row.id));
      if (admitted.length) for (const root of await captureArtifactInputProof(actor, workspaceId,
        admitted.map(row => ({ kind: "Notification", id: row.id, snapshot: row })))) {
        const key = `${root.kind}:${root.id}`;
        roots.set(key, mergeLineageInputRoot(roots.get(key), root));
      }
      return admitted;
    });
    for (const [key, stamp] of observed.heads) {
      invariant(!heads.has(key) || heads.get(key) === stamp, 409, "SOURCE_CHANGED", "Notification inputs changed during collection.");
      heads.set(key, stamp);
    }
    if (visit(observed.value) === false || rows.length < 100) break;
    after = next;
  }
  // Earlier pages retain their original bodies, epochs and manifest heads. Check
  // all of them and current membership together before releasing a result/write.
  return withArtifactCountReleaseSnapshot(actor, workspaceId, [...roots.values()], async () => {}, async tx => {
    await requireWorkspaceMembership({ actor, workspaceId, tx });
    return finish(tx);
  }, heads);
}

export async function countUnreadNotifications(actor: AppActor, workspaceId: string) {
  if (actor.kind !== "user") return 0;
  try {
    let count = 0;
    return await visitReadableNotifications(actor, workspaceId, true, rows => { count += rows.length; }, async () => count);
  } catch { return 0; }
}

export async function markNotificationRead(actor: AppActor, workspaceId: string, notificationId: string) {
  if (actor.kind !== "user" || !actor.user.id) return;
  const userId = actor.user.id;

  await requireWorkspaceMembership({ actor, workspaceId });

  const ids: string[] = [];
  await visitReadableNotifications(actor, workspaceId, false, rows => {
    ids.push(...rows.map(row => row.id));
  }, async tx => {
    await tx.notification.updateMany({
      where: { id: { in: ids }, workspaceId, userId },
      data: { readAt: new Date() },
    });
  }, notificationId);
}

export async function markAllNotificationsRead(actor: AppActor, workspaceId: string) {
  if (actor.kind !== "user") return;
  const userId = actor.user.id;
  await requireWorkspaceMembership({ actor, workspaceId });
  const pages: string[][] = [];
  await visitReadableNotifications(actor, workspaceId, true, rows => {
    if (rows.length) pages.push(rows.map(row => row.id));
  }, async tx => {
    for (const ids of pages) await tx.notification.updateMany({
      where: { id: { in: ids }, workspaceId, userId, readAt: null },
      data: { readAt: new Date() },
    });
  });
}
