import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SVIX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export function verifyResendWebhookSignature(params: {
  rawBody: string;
  headers: Headers;
  signingSecret?: string | null;
  now?: Date;
}) {
  const signingSecret = params.signingSecret ?? process.env.RESEND_WEBHOOK_SECRET;
  if (!signingSecret) return false;

  const svixId = params.headers.get("svix-id");
  const svixTimestamp = params.headers.get("svix-timestamp");
  const svixSignature = params.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestampSec = Number.parseInt(svixTimestamp, 10);
  const nowSec = Math.floor((params.now?.getTime() ?? Date.now()) / 1000);
  if (!Number.isFinite(timestampSec) || Math.abs(nowSec - timestampSec) > MAX_SVIX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }

  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(signingSecret.startsWith("whsec_") ? signingSecret.slice(6) : signingSecret, "base64");
  } catch {
    return false;
  }

  const expectedSignature = createHmac("sha256", secretBytes)
    .update(`${svixId}.${svixTimestamp}.${params.rawBody}`)
    .digest();

  return svixSignature.split(" ").some((signature) => {
    const [, rawSignature] = signature.split(",");
    if (!rawSignature) return false;
    try {
      const candidate = Buffer.from(rawSignature, "base64");
      return candidate.length === expectedSignature.length && timingSafeEqual(candidate, expectedSignature);
    } catch {
      return false;
    }
  });
}
