import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";

export type McpConsent = {
  userId: string; workspaceId: string; resource: string; clientId: string;
  redirectUri: string; scopes: string; state: string; codeChallenge: string;
  codeChallengeMethod: string; supportGrantVersion: number | null;
};
const sign = (payload: string) => createHmac("sha256", env.SESSION_COOKIE_SECRET).update(`mcp-consent-v1:${payload}`).digest();
export function signMcpConsent(consent: McpConsent) {
  const payload = Buffer.from(JSON.stringify({ ...consent, expiresAt: Date.now() + 10 * 60_000 })).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}
export function verifyMcpConsent(value: string, userId: string, posted: Omit<McpConsent, "userId" | "supportGrantVersion">): McpConsent {
  try {
    const [payload, signature, extra] = value.split(".");
    const actual = Buffer.from(signature ?? "", "base64url");
    const expected = sign(payload);
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const consent = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (consent.userId !== userId || !Number.isSafeInteger(consent.expiresAt) || consent.expiresAt <= Date.now()
      || Object.entries(posted).some(([key, val]) => consent[key] !== val)
      || !(consent.supportGrantVersion === null || Number.isSafeInteger(consent.supportGrantVersion))) throw new Error();
    return consent;
  } catch { throw new AppError(400, "INVALID_MCP_CONSENT", "Consent changed or expired. Restart this workspace connection."); }
}
