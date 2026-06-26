import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { verifyResendWebhookSignature } from "@/lib/resend-webhook";

export const dynamic = "force-dynamic";

const TRACKED_EVENT_TYPES = new Set([
  "email.delivered",
  "email.bounced",
  "email.complained",
]);

type ResendDeliveryEvent = {
  type?: unknown;
  created_at?: unknown;
  data?: Record<string, unknown>;
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifyResendWebhookSignature({ rawBody, headers: request.headers })) {
    console.warn("[resend-delivery] Webhook signature verification failed");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: ResendDeliveryEvent;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = typeof payload.type === "string" ? payload.type : "";
  if (!TRACKED_EVENT_TYPES.has(eventType)) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const data = isRecord(payload.data) ? payload.data : {};
  const providerMessageId = stringValue(data.email_id ?? data.emailId ?? data.id);
  if (!providerMessageId) {
    return NextResponse.json({ error: "Missing email id" }, { status: 400 });
  }

  const occurredAt = dateValue(payload.created_at ?? data.created_at);
  const status = statusForEvent(eventType);
  const timestamp = occurredAt ?? new Date();
  const failureReason = eventType === "email.bounced" || eventType === "email.complained"
    ? failureReasonFromData(data)
    : null;
  const recipientEmail = normalizeEmailAddress(firstRecipient(data.to));
  const subject = stringValue(data.subject) ?? "(unknown subject)";
  const dedupeKey = request.headers.get("svix-id") ?? `${eventType}:${providerMessageId}:${payload.created_at ?? ""}`;

  await prisma.emailDeliveryEvent.upsert({
    where: { dedupeKey },
    update: { receivedAt: new Date() },
    create: {
      provider: "resend",
      providerMessageId,
      eventType,
      dedupeKey,
      occurredAt,
      payload: payload as any,
    },
  });

  await prisma.emailDelivery.upsert({
    where: { providerMessageId },
    update: {
      status,
      lastEventType: eventType,
      lastEventAt: occurredAt,
      rawLastEvent: payload as any,
      ...(eventType === "email.delivered" ? { deliveredAt: timestamp } : {}),
      ...(eventType === "email.bounced" ? { bouncedAt: timestamp, failureReason } : {}),
      ...(eventType === "email.complained" ? { complainedAt: timestamp, failureReason } : {}),
    },
    create: {
      provider: "resend",
      providerMessageId,
      emailType: "unknown",
      toEmail: recipientEmail,
      toDomain: emailDomain(recipientEmail),
      subject,
      status,
      lastEventType: eventType,
      lastEventAt: occurredAt,
      rawLastEvent: payload as any,
      ...(eventType === "email.delivered" ? { deliveredAt: timestamp } : {}),
      ...(eventType === "email.bounced" ? { bouncedAt: timestamp, failureReason } : {}),
      ...(eventType === "email.complained" ? { complainedAt: timestamp, failureReason } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}

function statusForEvent(eventType: string) {
  if (eventType === "email.delivered") return "DELIVERED";
  if (eventType === "email.bounced") return "BOUNCED";
  return "COMPLAINED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown) {
  const raw = stringValue(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstRecipient(value: unknown) {
  if (Array.isArray(value)) {
    return stringValue(value[0]) ?? "unknown";
  }
  return stringValue(value) ?? "unknown";
}

function normalizeEmailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

function emailDomain(email: string) {
  const [, domain] = email.split("@");
  return domain?.toLowerCase() ?? "";
}

function failureReasonFromData(data: Record<string, unknown>) {
  for (const key of ["reason", "message", "error", "smtp_response", "bounce_type", "complaint_type"]) {
    const value = stringValue(data[key]);
    if (value) return value;
  }
  return null;
}
