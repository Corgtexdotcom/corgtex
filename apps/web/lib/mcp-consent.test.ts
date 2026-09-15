import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@corgtex/shared", () => ({ env: { SESSION_COOKIE_SECRET: "synthetic-consent-test-only" } }));
vi.mock("@corgtex/domain", async () => await import("../../../packages/domain/src/errors"));
import { signMcpConsent, verifyMcpConsent, type McpConsent } from "./mcp-consent";

const consent: McpConsent = { userId: "human", workspaceId: "A", resource: "https://app.example/mcp/workspaces/A",
  clientId: "shared-software", redirectUri: "https://client.example/callback", scopes: "workspace:read", state: "nonce",
  codeChallenge: "pkce", codeChallengeMethod: "S256", supportGrantVersion: 1 };
const { userId, supportGrantVersion: _version, ...posted } = consent;
afterEach(() => vi.useRealTimers());
describe("server-captured MCP consent", () => {
  it("authenticates the exact user, workspace, resource and captured epoch", () => {
    expect(verifyMcpConsent(signMcpConsent(consent), userId, posted)).toMatchObject(consent);
  });
  it.each(Object.keys(posted) as Array<keyof typeof posted>)("rejects changed %s", key => {
    expect(() => verifyMcpConsent(signMcpConsent(consent), userId, { ...posted, [key]: "changed" })).toThrow();
  });
  it("rejects changing the epoch inside the signed payload even with the same nonce", () => {
    const [payload, signature] = signMcpConsent(consent).split(".");
    const changed = { ...JSON.parse(Buffer.from(payload, "base64url").toString()), supportGrantVersion: 3 };
    expect(() => verifyMcpConsent(`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`, userId, posted)).toThrow();
  });
  it("rejects another human, expiry, and malformed tickets", () => {
    vi.useFakeTimers();
    const ticket = signMcpConsent(consent);
    expect(() => verifyMcpConsent(ticket, "other-human", posted)).toThrow();
    vi.advanceTimersByTime(600_001);
    expect(() => verifyMcpConsent(ticket, userId, posted)).toThrow();
    expect(() => verifyMcpConsent("bad", userId, posted)).toThrow();
  });
});
