import { NextRequest, NextResponse } from "next/server";
import { recordInboundEmailReply } from "@corgtex/domain";
import { createHmac, timingSafeEqual } from "crypto";
import sanitizeHtml from "sanitize-html";

export const dynamic = "force-dynamic";

/**
 * Verify the Resend/Svix webhook signature.
 * Resend sends three headers: svix-id, svix-timestamp, svix-signature.
 * The signature is HMAC-SHA256 over "msgId.timestamp.body" using the
 * webhook signing secret (base64-encoded, prefixed with "whsec_").
 */
function verifyWebhookSignature(
  rawBody: string,
  headers: Headers
): boolean {
  const signingSecret = process.env.RESEND_WEBHOOK_SECRET;

  if (!signingSecret) {
    // If no signing secret is configured, reject all requests.
    // This prevents unauthenticated mutation of CRM state.
    console.error("[resend-inbound] RESEND_WEBHOOK_SECRET is not configured. Rejecting webhook.");
    return false;
  }

  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignature = headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  // Guard against replay attacks: reject timestamps > 5 minutes old
  const timestampSec = parseInt(svixTimestamp, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (isNaN(timestampSec) || Math.abs(nowSec - timestampSec) > 300) {
    return false;
  }

  // Resend/Svix secrets are prefixed with "whsec_" and the key is base64-encoded
  const secretBytes = Buffer.from(
    signingSecret.startsWith("whsec_") ? signingSecret.slice(6) : signingSecret,
    "base64"
  );

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSignature = createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  // svix-signature can contain multiple signatures separated by spaces (versioned)
  // Each is prefixed with "v1," — we check if any match
  const signatures = svixSignature.split(" ");
  for (const sig of signatures) {
    const [, sigValue] = sig.split(",");
    if (!sigValue) continue;
    try {
      const sigBuf = Buffer.from(sigValue, "base64");
      const expectedBuf = Buffer.from(expectedSignature, "base64");
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

export async function POST(request: NextRequest) {
  try {
    // Read the raw body for signature verification
    const rawBody = await request.text();

    // Verify webhook authenticity
    if (!verifyWebhookSignature(rawBody, request.headers)) {
      console.warn("[resend-inbound] Webhook signature verification failed");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (payload.type !== "email.received" || !payload.data) {
      return NextResponse.json({ ok: true }); // Ignore non-inbound events
    }

    // Resend sends metadata only; retrieve content after authenticating origin.
    const emailId = payload.data.email_id;
    if (typeof emailId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emailId)) {
      return NextResponse.json({ error: "Invalid email identifier" }, { status: 400 });
    }
    const recipient = process.env.EMAIL_REPLY_TO?.trim().toLowerCase();
    if (!recipient || !/^[^\s@]+@[^\s@]+$/.test(recipient)) {
      return NextResponse.json({ error: "Reply recipient unavailable" }, { status: 503 });
    }
    const addressedToRecipient = (values: unknown) => Array.isArray(values)
      && values.some(value => typeof value === "string" && value.trim().toLowerCase() === recipient);
    if (!addressedToRecipient(payload.data.to)) return NextResponse.json({ ok: true, ignored: "unrelated_recipient" });
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Email content unavailable" }, { status: 503 });
    let email: { id?: string; from?: string; subject?: string; text?: string | null; html?: string | null; to?: string[]; received_for?: string[] };
    try {
      const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("RECEIVED_EMAIL_UNAVAILABLE");
      email = await response.json();
      if (email.id !== emailId || typeof email.from !== "string") throw new Error("RECEIVED_EMAIL_INVALID");
    } catch {
      // Retry retrieval failures instead of acknowledging and losing the reply.
      return NextResponse.json({ error: "Email content unavailable" }, { status: 503 });
    }
    if (!addressedToRecipient(email.to) && !addressedToRecipient(email.received_for)) {
      return NextResponse.json({ ok: true, ignored: "unrelated_recipient" });
    }
    const text = typeof email.text === "string" && email.text.trim() ? email.text
      : typeof email.html === "string" ? sanitizeHtml(email.html, { allowedTags: [], allowedAttributes: {} }) : "";
    if (!text.trim()) return NextResponse.json({ ok: true, ignored: "empty_body" });
    const emailMatch = email.from!.match(/<([^>]+)>/);
    const fromEmail = (emailMatch ? emailMatch[1] : email.from!).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(fromEmail)) return NextResponse.json({ error: "Invalid sender" }, { status: 400 });
    await recordInboundEmailReply({ fromEmail, subject: email.subject || "No Subject", bodyText: text, providerEmailId: emailId });

    return NextResponse.json({ ok: true });
  } catch (error) {
    // The combined transaction rolls back both effects before a retry.
    if ((error as { code?: string })?.code === "CRM_PUBLIC_WRITES_PAUSED") {
      return NextResponse.json({ error: "Lead intake is temporarily paused." }, { status: 503 });
    }
    console.error("[resend-inbound] CRM reply processing failed");
    if ((error as { code?: string })?.code === "NOT_FOUND") return NextResponse.json({ ok: true, ignored: "unmatched_sender" });
    return NextResponse.json({ error: "Reply processing unavailable" }, { status: 503 });
  }
}
