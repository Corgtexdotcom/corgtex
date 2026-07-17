import type { Prisma } from "@prisma/client";
import { env, prisma, sendEmail } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { humanMemberIdentityWhere } from "./member-identity";

export const DEFAULT_NOTIFICATION_CHANNEL = "IN_APP";
export const NOTIFICATION_DELIVERY_JOB_TYPE = "notification.delivery";
export const NOTIFICATION_DELIVERY_EMAIL_CHANNEL = "EMAIL";
export const NOTIFICATION_DELIVERY_SLACK_CHANNEL = "SLACK";
const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

export const OUTBOUND_ELIGIBLE_NOTIFICATION_TYPES = new Set([
  "deliberation.mention",
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

export type NotificationIntentParams = {
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
      user: { select: { email: true } },
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
  const bulkRecipients = recipients.filter((recipient) => (
    !notificationDedupeKey(params.dedupeKey, recipient.userId)
      && !shouldCreateEmailDelivery(recipient)
      && !shouldCreateSlackDelivery(recipient)
  ));
  const individualRecipients = recipients.filter((recipient) => !bulkRecipients.includes(recipient));
  let count = 0;

  if (bulkRecipients.length > 0) {
    const result = await tx.notification.createMany({
      data: bulkRecipients.map((recipient) => ({
        workspaceId: params.workspaceId,
        userId: recipient.userId,
        type: params.type,
        priority,
        entityType: params.entityType ?? null,
        entityId: params.entityId ?? null,
        title: params.title,
        bodyMd: params.bodyMd ?? null,
      })),
    });
    count += result.count;
  }

  for (const recipient of individualRecipients) {
    const dedupeKey = notificationDedupeKey(params.dedupeKey, recipient.userId);
    const data = {
      workspaceId: params.workspaceId,
      userId: recipient.userId,
      type: params.type,
      dedupeKey,
      priority,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      title: params.title,
      bodyMd: params.bodyMd ?? null,
    };
    const notification = dedupeKey
      ? await tx.notification.upsert({
        where: { dedupeKey },
        update: {},
        create: data,
        select: { id: true, workspaceId: true, userId: true },
      })
      : await tx.notification.create({
        data,
        select: { id: true, workspaceId: true, userId: true },
      });

    count += 1;

    if (shouldCreateEmailDelivery(recipient)) {
      await createEmailDeliveryIntent(tx, notification);
    }
    if (shouldCreateSlackDelivery(recipient)) {
      await createSlackDeliveryIntent(tx, notification);
    }
  }

  return { count };
}

type NotificationDeliveryWithRecipient = Prisma.NotificationDeliveryGetPayload<{
  include: {
    notification: true;
    user: { select: { email: true } };
  };
}>;

async function createEmailFallbackDelivery(delivery: NotificationDeliveryWithRecipient) {
  if (!delivery.user.email) return;
  await createEmailDeliveryIntent(prisma, {
    id: delivery.notificationId,
    workspaceId: delivery.workspaceId,
    userId: delivery.userId,
  });
}

async function deliverEmailNotificationDelivery(delivery: NotificationDeliveryWithRecipient) {
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

async function deliverSlackNotificationDelivery(delivery: NotificationDeliveryWithRecipient) {
  const attempt = delivery.attempts + 1;

  try {
    const { resolveSlackNotificationRecipient, sendSlackMessage } = await import("./communication");
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

    const slack = renderNotificationSlackMessage({
      workspaceId: delivery.workspaceId,
      title: delivery.notification.title,
      bodyMd: delivery.notification.bodyMd,
    });
    const result = await sendSlackMessage(recipient.installationId, {
      channel: recipient.externalUserId,
      text: slack.text,
    }, slack.blocks);

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
  if (delivery.channel === NOTIFICATION_DELIVERY_EMAIL_CHANNEL) {
    return deliverEmailNotificationDelivery(delivery);
  }
  if (delivery.channel === NOTIFICATION_DELIVERY_SLACK_CHANNEL) {
    return deliverSlackNotificationDelivery(delivery);
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

export async function listNotifications(actor: AppActor, workspaceId: string, opts?: {
  unreadOnly?: boolean;
  take?: number;
  skip?: number;
}) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return [];

  await requireWorkspaceMembership({ actor, workspaceId });

  return prisma.notification.findMany({
    where: {
      workspaceId,
      userId,
      ...(opts?.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts?.take ?? 30,
    skip: opts?.skip,
  });
}

export async function countUnreadNotifications(userId: string, workspaceId: string) {
  return prisma.notification.count({
    where: { workspaceId, userId, readAt: null },
  });
}

export async function markNotificationRead(actor: AppActor, workspaceId: string, notificationId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return;

  await requireWorkspaceMembership({ actor, workspaceId });

  await prisma.notification.updateMany({
    where: { id: notificationId, workspaceId, userId },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(actor: AppActor, workspaceId: string) {
  const userId = actor.kind === "user" ? actor.user.id : null;
  if (!userId) return;

  await prisma.notification.updateMany({
    where: { workspaceId, userId, readAt: null },
    data: { readAt: new Date() },
  });
}
