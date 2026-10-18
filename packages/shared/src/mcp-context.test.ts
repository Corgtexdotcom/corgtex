import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { assertMcpOriginActive, assertMcpOriginActiveAdvisory, getMcpOrigin, mcpCredentialVersion, mcpScopesHash,
  parseMcpOrigin, recordMcpRequiredScope, runWithMcpOrigin, withMcpRequiredScopes, type McpOrigin } from "./mcp-context";

function fixture(kind: "agent" | "oauth" = "agent") {
  const grants = ["brain:read", "brain:write", "actions:read"];
  let epoch = 0n;
  const row = { id: "credential-a", workspaceId: "ws-1", tokenHash: "stored-hash", isActive: true,
    scopes: [...grants], client: { isActive: true }, revokedAt: null as Date | null, refreshExpiresAt: new Date(Date.now() + 60_000) };
  const db = { agentCredential: { findUnique: vi.fn(async ({ where }) => where.id === row.id ? row : null) },
    mcpOAuthAccessToken: { findUnique: vi.fn(async ({ where }) => where.id === row.id ? row : null) },
    $queryRaw: vi.fn(async (_statement?: unknown) => [{ epoch }]), $executeRaw: vi.fn(async () => 1) };
  const origin: McpOrigin = { kind, id: row.id, workspaceId: row.workspaceId, scopeHash: mcpScopesHash(grants),
    ...(kind === "agent" ? { credentialVersion: mcpCredentialVersion(row.tokenHash) } : { grantEpoch: "0" }) };
  return { db: db as unknown as Prisma.TransactionClient, raw: db.$queryRaw, row, origin, bumpEpoch: () => { epoch++; } };
}

describe("live MCP origin scope authority", () => {
  it.each(["agent", "oauth"] as const)("withholds %s output if its granted scope changes during work without token rotation", async kind => {
    const { db, row, origin } = fixture(kind);
    const released = vi.fn();
    await expect(withMcpRequiredScopes(db, origin, ["brain:read"], async () => {
      row.scopes = ["actions:read"];
      return "copied source contents";
    }).then(released)).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(released).not.toHaveBeenCalled();
  });

  it("rejects a required scope at the persistence checkpoint before writing", async () => {
    const { db, row, origin } = fixture();
    const persist = vi.fn();
    await expect(withMcpRequiredScopes(db, origin, ["brain:read"], async () => {
      recordMcpRequiredScope("brain:write");
      const queuedOrigin = parseMcpOrigin(getMcpOrigin());
      expect(queuedOrigin.requiredScopes).toEqual(["brain:read", "brain:write"]);
      row.scopes = ["brain:read"];
      await assertMcpOriginActive(db, queuedOrigin, "ws-1");
      persist();
    })).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not substitute a second credential in the same workspace", async () => {
    const { db, origin } = fixture();
    const execute = vi.fn();
    await expect(runWithMcpOrigin(origin, () => withMcpRequiredScopes(db, { ...origin, id: "credential-b" }, ["brain:read"], execute)))
      .rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps concurrent tools' exact required scope sets separate", async () => {
    const { db, origin } = fixture();
    const sets = await Promise.all(["brain:read", "actions:read"].map(scope =>
      withMcpRequiredScopes(db, origin, [scope], async () => getMcpOrigin()?.requiredScopes)));
    expect(sets).toEqual([["brain:read"], ["actions:read"]]);
    expect(origin.requiredScopes).toBeUndefined();
  });

  it("rejects legacy unbound origins and preserves valid origins across queue serialization", async () => {
    const { db, origin } = fixture();
    expect(() => parseMcpOrigin({ ...origin, scopeHash: undefined })).toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(() => parseMcpOrigin({ ...origin, requiredScopes: [3] })).toThrow("MCP_AUTHORIZATION_REVOKED");
    const persisted = parseMcpOrigin(JSON.parse(JSON.stringify({ ...origin, requiredScopes: ["brain:read"] })));
    await expect(assertMcpOriginActive(db, persisted, "ws-1")).resolves.toBeUndefined();
    await expect(assertMcpOriginActive(db, persisted, "ws-other")).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("withholds OAuth output after revoke and restore without a scope-hash change", async () => {
    const { db, row, origin, bumpEpoch } = fixture("oauth");
    await expect(withMcpRequiredScopes(db, origin, ["brain:read"], async () => {
      row.revokedAt = new Date();
      bumpEpoch();
      row.revokedAt = null;
      bumpEpoch();
      return "stale response";
    })).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("rejects missing OAuth epochs and a substituted ambient epoch", async () => {
    const { db, origin } = fixture("oauth");
    expect(() => parseMcpOrigin({ ...origin, grantEpoch: undefined })).toThrow("MCP_AUTHORIZATION_REVOKED");
    await expect(runWithMcpOrigin(origin, () => withMcpRequiredScopes(db, { ...origin, grantEpoch: "1" },
      ["brain:read"], async () => "unreachable"))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });

  it("observes an OAuth epoch on both sides of live token checks without taking a row lock", async () => {
    const { db, raw, origin } = fixture("oauth");
    await expect(assertMcpOriginActiveAdvisory(db, origin, "ws-1")).resolves.toBeUndefined();
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls.every(([statement]) => !String((statement as { sql: string }).sql).includes("FOR SHARE"))).toBe(true);
    let reads = 0;
    raw.mockImplementation(async () => [{ epoch: ++reads === 1 ? 0n : 1n }]);
    await expect(assertMcpOriginActiveAdvisory(db, origin, "ws-1")).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });
});
