import { createHmac, timingSafeEqual } from "node:crypto";
import { env, randomOpaqueToken } from "@corgtex/shared";
import { AppError, invariant } from "./errors";

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

type OAuthStatePayload = {
  userId: string;
  workspaceId: string | null;
  intent: IntegrationOAuthIntent;
  nonce: string;
  issuedAt: number;
};

export type IntegrationOAuthIntent = "calendar" | "documents";

function signingSecret() {
  return env.SESSION_COOKIE_SECRET;
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(payload: string) {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function createIntegrationOAuthState(params: {
  userId: string;
  workspaceId?: string | null;
  intent?: IntegrationOAuthIntent;
}) {
  const payload = base64UrlJson({
    userId: params.userId,
    workspaceId: params.workspaceId?.trim() || null,
    intent: params.intent ?? "calendar",
    nonce: randomOpaqueToken(16),
    issuedAt: Date.now(),
  } satisfies OAuthStatePayload);
  return `${payload}.${sign(payload)}`;
}

export function verifyIntegrationOAuthState(state: string | null | undefined, expectedUserId: string) {
  invariant(state, 400, "OAUTH_STATE_REQUIRED", "OAuth state is required.");
  const [payloadRaw, signatureRaw] = state.split(".");
  invariant(payloadRaw && signatureRaw, 400, "OAUTH_STATE_INVALID", "OAuth state is invalid.");

  const expectedSignature = sign(payloadRaw);
  const expected = Buffer.from(expectedSignature);
  const candidate = Buffer.from(signatureRaw);
  if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) {
    throw new AppError(400, "OAUTH_STATE_INVALID", "OAuth state is invalid.");
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadRaw, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    throw new AppError(400, "OAUTH_STATE_INVALID", "OAuth state is invalid.");
  }

  invariant(payload.userId === expectedUserId, 400, "OAUTH_STATE_USER_MISMATCH", "OAuth state does not match the signed-in user.");
  invariant(Date.now() - payload.issuedAt <= OAUTH_STATE_TTL_MS, 400, "OAUTH_STATE_EXPIRED", "OAuth state has expired.");

  return {
    userId: payload.userId,
    workspaceId: payload.workspaceId,
    intent: payload.intent ?? "calendar",
  };
}
