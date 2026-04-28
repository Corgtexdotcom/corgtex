import { NextRequest, NextResponse } from "next/server";
import { receiveEmailReply, syncEmailReplyToConversation } from "@corgtex/domain";
import { createHmac, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

/**
 * Verify the Resend/Svix webhook signature.
 * Resend sends three headers: svix-id, svix-timestamp, svix-signature.
 * The signature is HMAC-SHA256 over "msgId.timestamp.body" using the
 * webhook signing secret (base64-encoded, prefixed with "whsec_").
 *
 * Falls back to a simple shared-secret bearer token if RESEND_WEBHOOK_SECRET
 * is not set but WEBHOOK_SIGNING_SECRET is configured.
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

    const { from, subject, text } = payload.data;

    if (!from || !text) {
      return NextResponse.json({ error: "Missing from or text" }, { status: 400 });
    }

    // Extract email from "Name <email@domain.com>" or "email@domain.com"
    const emailMatch = from.match(/<([^>]+)>/);
    const fromEmail = emailMatch ? emailMatch[1] : from;

    // Run both domain functions concurrently
    await Promise.all([
      receiveEmailReply({
        fromEmail,
        subject: subject || "No Subject",
        bodyText: text,
      }).catch(err => console.error("Error receiving email reply:", err)),

      syncEmailReplyToConversation({
        fromEmail,
        subject: subject || "No Subject",
        bodyText: text,
      }).catch(err => console.error("Error syncing conversation:", err)),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[resend-inbound] Error processing webhook:", error);
    // Return 200 anyway so Resend doesn't retry infinitely on domain logic failures
    return NextResponse.json({ ok: true, error: "Internal processing error" });
  }
}
