import { env } from "./env";
import { prisma } from "./db";
import { Resend } from "resend";

export type EmailSendResult =
  | { status: "SENT"; providerMessageId: string | null }
  | { status: "SKIPPED"; reason: string };

export type EmailTrackingOptions = {
  emailType: string;
  userId?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tracking?: EmailTrackingOptions;
}): Promise<EmailSendResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping email send. Would have sent to:", params.to);
    console.warn("[email] Subject:", params.subject);
    return { status: "SKIPPED", reason: "RESEND_API_KEY missing" };
  }

  const resend = new Resend(apiKey);
  const replyTo = params.replyTo ?? env.EMAIL_REPLY_TO;

  const { data, error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    ...(params.text ? { text: params.text } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  if (error) {
    console.error("[email] Resend API error:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  if (data?.id && params.tracking) {
    await recordEmailDelivery({
      providerMessageId: data.id,
      to: params.to,
      subject: params.subject,
      tracking: params.tracking,
    }).catch((trackingError) => {
      console.error("[email] Failed to record email delivery metadata:", trackingError);
    });
  }

  return { status: "SENT", providerMessageId: data?.id ?? null };
}

async function recordEmailDelivery(params: {
  providerMessageId: string;
  to: string;
  subject: string;
  tracking: EmailTrackingOptions;
}) {
  const toEmail = normalizeEmailAddress(params.to);
  const toDomain = emailDomain(toEmail);

  await prisma.emailDelivery.upsert({
    where: { providerMessageId: params.providerMessageId },
    update: {
      emailType: params.tracking.emailType,
      toEmail,
      toDomain,
      subject: params.subject,
      status: "SENT",
      sentAt: new Date(),
      userId: params.tracking.userId ?? null,
      workspaceId: params.tracking.workspaceId ?? null,
      metadata: params.tracking.metadata ? sanitizeJson(params.tracking.metadata) : undefined,
    },
    create: {
      provider: "resend",
      providerMessageId: params.providerMessageId,
      emailType: params.tracking.emailType,
      toEmail,
      toDomain,
      subject: params.subject,
      status: "SENT",
      userId: params.tracking.userId ?? null,
      workspaceId: params.tracking.workspaceId ?? null,
      metadata: params.tracking.metadata ? sanitizeJson(params.tracking.metadata) : undefined,
    },
  });
}

function normalizeEmailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

function emailDomain(email: string) {
  const [, domain] = email.split("@");
  return domain?.toLowerCase() ?? "";
}

function sanitizeJson(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value));
}
