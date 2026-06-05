import { createHmac } from "node:crypto";

import { env } from "@corgtex/shared";

export const INTERCOM_MESSENGER_JWT_TTL_SECONDS = 10 * 60;

export type IntercomJwtPayload = Record<string, unknown> & {
  user_id: string;
};

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function intercomAppId() {
  return env.NEXT_PUBLIC_INTERCOM_APP_ID;
}

export function intercomApiBase() {
  return env.NEXT_PUBLIC_INTERCOM_API_BASE;
}

export function intercomMessengerSecret() {
  return env.INTERCOM_MESSENGER_SECRET;
}

export function createIntercomMessengerJwt(
  payload: IntercomJwtPayload,
  secret: string,
  now = new Date(),
) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAt + INTERCOM_MESSENGER_JWT_TTL_SECONDS;
  const claims = {
    ...payload,
    iat: issuedAt,
    exp: expiresAtSeconds,
  };
  const encodedHeader = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const encodedPayload = base64UrlJson(claims);
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return {
    token: `${encodedHeader}.${encodedPayload}.${signature}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    expiresAtSeconds,
    payload: claims,
  };
}
