import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin } from "./mcp-context";

const harness = vi.hoisted(() => ({ operation: undefined as any,
  credential: { id: "credential-a", workspaceId: "ws-1", isActive: true, tokenHash: "fixture-hash", scopes: ["brain:write"] } }));
vi.mock("./env", () => ({ env: { DATABASE_URL: "postgres://synthetic/not-connected", NODE_ENV: "production" } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class {
  agentCredential = { findUnique: async () => harness.credential };
  $extends(extension: any) { harness.operation = extension.query.$allModels.$allOperations; return this; }
} }));

beforeEach(async () => {
  harness.credential.scopes = ["brain:write"];
  const { getPrismaClient } = await import("./db");
  getPrismaClient();
});

const origin = () => ({ kind: "agent" as const, id: "credential-a", workspaceId: "ws-1",
  credentialVersion: mcpCredentialVersion("fixture-hash"), scopeHash: mcpScopesHash(["brain:write"]), requiredScopes: ["brain:write"] });

describe("MCP database mutation checkpoint", () => {
  it.each(["create", "update", "delete", "createMany", "updateMany", "deleteMany", "upsert", "createManyAndReturn", "updateManyAndReturn"])("denies revoked scope before %s reaches Prisma", async operation => {
    harness.credential.scopes = [];
    const query = vi.fn();
    await expect(runWithMcpOrigin(origin(), () => harness.operation({model: "BrainArticle", operation, args: {}, query})))
      .rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(query).not.toHaveBeenCalled();
  });

  it("denies result release when scopes change during a mutation without claiming autocommit rollback", async () => {
    const query = vi.fn(async () => { harness.credential.scopes = []; return {id: "written"}; });
    await expect(runWithMcpOrigin(origin(), () => harness.operation({model: "BrainArticle", operation: "update", args: {}, query})))
      .rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(query).toHaveBeenCalledOnce();
  });

  it("retains non-MCP internal mutations", async () => {
    const query = vi.fn(async () => ({id: "written"}));
    await expect(harness.operation({model: "BrainArticle", operation: "update", args: {}, query})).resolves.toEqual({id: "written"});
  });
});
