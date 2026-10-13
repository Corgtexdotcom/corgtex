import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

const f = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const delegates = new Map<string, any>();
  let serial = 0;
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([field, value]: [string, any]) => {
    if (value && typeof value === "object" && !(value instanceof Date) && "in" in value) return value.in.includes(row[field]);
    return row[field] === value;
  });
  const insert = (table: string, row: any) => {
    const value = { createdAt: new Date("2026-10-13T12:00:00Z"), ...row };
    if (!tables.has(table)) tables.set(table, new Map());
    tables.get(table)!.set(value.id, value); return value;
  };
  const base = { $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []), $transaction: vi.fn() };
  const db: any = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const table = String(property);
    if (!delegates.has(table)) {
      const find = ({ where, select, orderBy }: any) => {
        let result = [...(tables.get(table)?.values() ?? [])].filter(row => matches(row, where));
        if (orderBy?.revision === "desc") result = result.sort((a, b) => b.revision - a.revision);
        return result.map(row => select ? Object.fromEntries(Object.keys(select).map(key => [key, structuredClone(row[key])])) : structuredClone(row));
      };
      delegates.set(table, {
        findFirst: vi.fn(async (args: any) => find(args)[0] ?? null),
        findUnique: vi.fn(async (args: any) => find(args)[0] ?? null),
        findMany: vi.fn(async (args: any) => find(args)),
        create: vi.fn(async ({ data }: any) => structuredClone(insert(table, { id: `${table}-${++serial}`, ...data }))),
      });
    }
    return delegates.get(table);
  } });
  const authorize = vi.fn(async ({ actor, workspaceId }: any) => {
    if (!["ws-a", "ws-b"].includes(workspaceId) || actor.kind === "agent" && !actor.workspaceIds?.includes(workspaceId)) throw new Error("Synthetic workspace unavailable");
    return actor.kind === "user" ? { id: "member-owner", role: "ADMIN" } : null;
  });
  return { tables, db, base, insert, authorize };
});
vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: f.db }));
vi.mock("../../shared/src/env", () => ({ env: { ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.authorize }));
vi.mock("./finance", () => ({ getFinanceAccessPolicy: async () => ({ canRead: false }) }));

import { captureMcpOAuthGrantEpoch, mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin } from "../../shared/src/mcp-context";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, isArtifactInputProofReadable,
  recordArtifactInputLineage, type LineageKind, type LineageRoot } from "./source-lineage";
import { createConversationIngressInput } from "./conversation-ingress";
import { withMcpToolInput } from "./mcp-tool-input";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";

const owner: AppActor = { kind: "user", user: { id: "owner", email: "owner@example.test", displayName: "Owner" } };
function grant(id: string, scopes: string[], workspaceId = "ws-a") {
  const row = f.insert("agentCredential", { id, workspaceId, scopes: [...scopes], isActive: true,
    tokenHash: `synthetic-token-${id}`, createdByUserId: "owner" });
  return { row, actor: actorFor(row) };
}
function actorFor(row: any): AppActor {
  return { kind: "agent", authProvider: "credential", credentialId: row.id, credentialVersion: mcpCredentialVersion(row.tokenHash),
    label: "Synthetic current grant", workspaceIds: [row.workspaceId], scopes: [...row.scopes] };
}
function oauth(id: string, scopes: string[], userId = "owner", workspaceId = "ws-a") {
  const row = f.insert("mcpOAuthAccessToken", { id, workspaceId, userId, scopes: [...scopes], revokedAt: null,
    client: { isActive: true }, refreshExpiresAt: new Date("2099-01-01") });
  return { row, run: async <T>(work: () => Promise<T>) => {
    const grantEpoch = await captureMcpOAuthGrantEpoch(f.db, workspaceId, id);
    return runWithMcpOrigin({ kind: "oauth", id, workspaceId, scopeHash: mcpScopesHash(row.scopes), grantEpoch }, work);
  } };
}
async function original(kind: "BrainArticle" | "Action", id: string, workspaceId = "ws-a", isPrivate = false) {
  const row = f.insert(kind === "Action" ? "action" : "brainArticle", { id, workspaceId, title: "Synthetic original", bodyMd: "Synthetic original body",
    isPrivate, archivedAt: null, ownerMemberId: "member-owner", authorUserId: "owner", status: "DRAFT" });
  await recordArtifactInputLineage({ tx: f.db, actor: owner, workspaceId, artifact: { kind, id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}
async function copiedGraph(id: string, kind: LineageKind, source: any) {
  const row = f.insert("contextGraphObject", { id, workspaceId: source.workspaceId, title: "Copied synthetic body", properties: { copied: "body" }, archivedAt: null });
  await recordArtifactInputLineage({ tx: f.db, actor: owner, workspaceId: source.workspaceId,
    artifact: { kind: "ContextGraphObject", id }, content: row, origin: "DERIVED", inputs: [{ kind, id: source.id }] });
  return row;
}
async function proof(actor: AppActor, workspaceId: string, kind: LineageKind, id: string) {
  return captureArtifactInputProof(actor, workspaceId, [{ kind, id }], f.db);
}

beforeEach(() => {
  vi.clearAllMocks(); f.tables.clear();
  installSourcePermissionEpochFixture(f.db);
  f.base.$transaction.mockImplementation(async work => {
    const before = structuredClone(f.tables);
    const tx = new Proxy(f.db, { get(target, property) { return property === "$transaction" ? undefined : target[property]; } });
    try { return await work(tx); } catch (error) { f.tables.clear(); for (const [name, rows] of before) f.tables.set(name, rows); throw error; }
  });
});

describe("closed credential source families with actual lineage checks", () => {
  it("requires brain read for public Article even when graph/execution output scopes are present", async () => {
    const source = await original("BrainArticle", "article");
    for (const id of ["credential-a", "credential-b"]) {
      const { row, actor } = grant(id, ["context-graph:read", "execution:read"]);
      await expect(proof(actor, "ws-a", "BrainArticle", source.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
      row.scopes.push("brain:read");
      expect(await proof(actorFor(row), "ws-a", "BrainArticle", source.id)).toHaveLength(1);
    }
  });

  it.each(["actions:read", "brain:read"])("requires each transitive Action family and admits its explicit %s alternative", async scope => {
    const action = await original("Action", "action"); const graph = await copiedGraph("graph", "Action", action);
    const { row, actor } = grant("credential-a", ["context-graph:read", "execution:read"]);
    await expect(proof(actor, "ws-a", "ContextGraphObject", graph.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    row.scopes.push(scope);
    const roots = await proof(actorFor(row), "ws-a", "ContextGraphObject", graph.id);
    expect(roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Action", id: action.id })]));
  });

  it("keeps private Article ancestry denied to both owner-created credentials with full family grants", async () => {
    const source = await original("BrainArticle", "private", "ws-a", true);
    const graph = await copiedGraph("private-graph", "BrainArticle", source);
    for (const id of ["credential-a", "credential-b"]) {
      const { actor } = grant(id, ["brain:read", "context-graph:read"]);
      await expect(proof(actor, "ws-a", "BrainArticle", source.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
      await expect(proof(actor, "ws-a", "ContextGraphObject", graph.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    }
  });

  it("binds two workspace grants independently and rejects foreign and substituted actor grants", async () => {
    const a = await original("BrainArticle", "article-a"); const b = await original("BrainArticle", "article-b", "ws-b");
    const first = grant("credential-a", ["brain:read"]); const second = grant("credential-b", ["brain:read"], "ws-b");
    expect(await proof(first.actor, "ws-a", "BrainArticle", a.id)).toHaveLength(1);
    expect(await proof(second.actor, "ws-b", "BrainArticle", b.id)).toHaveLength(1);
    await expect(proof({ ...first.actor, workspaceIds: ["ws-a", "ws-b"] } as AppActor, "ws-b", "BrainArticle", b.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(proof({ ...first.actor, credentialId: second.row.id } as AppActor, "ws-a", "BrainArticle", a.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("does not let an immutable Action snapshot bypass its current source-family grant", async () => {
    const action = await original("Action", "snapshotted-action");
    const { row, actor } = grant("credential-a", ["actions:read", "context-graph:read"]);
    const roots = await captureArtifactInputSnapshotProof(actor, "ws-a", { kind: "Action", id: action.id }, f.db);
    expect(roots[0].kind).toBe("ArtifactInputSnapshot");
    expect(await isArtifactInputProofReadable(actor, "ws-a", roots, f.db)).toBe(true);
    row.scopes = ["context-graph:read", "execution:read"];
    expect(await isArtifactInputProofReadable(actorFor(row), "ws-a", roots, f.db)).toBe(false);
  });

  it("binds a completion note even when a raw mutation leaves timestamps unchanged", async () => {
    const action = await original("Action", "completion-note-fingerprint");
    const roots = await proof(owner, "ws-a", "Action", action.id);
    expect(await isArtifactInputProofReadable(owner, "ws-a", roots, f.db)).toBe(true);
    action.completedVia = "Synthetic changed completion note";
    expect(await isArtifactInputProofReadable(owner, "ws-a", roots, f.db)).toBe(false);
  });

  it.each(["scope-hash", "token-rotation", "deleted-grant"] as const)("withholds a paused cached proof after %s changes", async change => {
    const article = await original("BrainArticle", "cached");
    const { row, actor } = grant("credential-a", ["brain:read", "tools:write"]);
    const roots = await proof(actor, "ws-a", "BrainArticle", article.id);
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const pending = (async () => { await pause; return await isArtifactInputProofReadable(actor, "ws-a", roots, f.db) ? "cached synthetic body" : null; })();
    if (change === "scope-hash") row.scopes = ["brain:read"];
    else if (change === "token-rotation") row.tokenHash = "synthetic-rotated-token";
    else f.tables.get("agentCredential")!.delete(row.id);
    release(); expect(await pending).toBeNull();
  });

  it("preserves native MCP required scopes and original credential identity without granting Brain inputs", async () => {
    const { row, actor } = grant("credential-a", ["tools:write"]);
    const roots = await runWithMcpOrigin({ kind: "agent", id: row.id, workspaceId: "ws-a", credentialVersion: mcpCredentialVersion(row.tokenHash),
      scopeHash: mcpScopesHash(row.scopes), requiredScopes: ["tools:write"] }, () => withMcpToolInput(actor,
      { workspaceId: "ws-a", toolName: "synthetic_operation", args: { text: "synthetic original request" }, requiredScopes: ["tools:write"] },
      async () => getMcpToolInputRoots(actor, "ws-a")));
    expect(roots.some(root => root.kind === "McpToolInput")).toBe(true);
    expect(await isArtifactInputProofReadable(actor, "ws-a", roots, f.db)).toBe(true);
    const other = grant("credential-b", ["tools:write"]);
    expect(await isArtifactInputProofReadable(other.actor, "ws-a", roots, f.db)).toBe(false);
    row.scopes = ["brain:read"];
    expect(await isArtifactInputProofReadable(actorFor(row), "ws-a", roots, f.db)).toBe(false);
  });

  it("preserves native ingress conversation scope and denies other credentials and removed scope", async () => {
    const { row, actor } = grant("credential-a", ["conversations:write"]);
    const input = await createConversationIngressInput(actor, { workspaceId: "ws-a", content: "Synthetic independently submitted request" });
    const roots: LineageRoot[] = await proof(actor, "ws-a", "ConversationIngressInput", input.id);
    const other = grant("credential-b", ["conversations:write"]);
    expect(await isArtifactInputProofReadable(other.actor, "ws-a", roots, f.db)).toBe(false);
    row.scopes = ["brain:read"];
    expect(await isArtifactInputProofReadable(actorFor(row), "ws-a", roots, f.db)).toBe(false);
  });
});

describe("OAuth consent at every contributing source", () => {
  it.each(["actions:read", "brain:read"])("withholds Action-derived graph content until %s is consented", async scope => {
    const action = await original("Action", "oauth-action");
    const graph = await copiedGraph("oauth-graph", "Action", action);
    const grant = oauth("oauth-a", ["context-graph:read"]);
    await grant.run(async () => {
      await expect(proof(owner, "ws-a", "ContextGraphObject", graph.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    });
    grant.row.scopes.push(scope);
    expect(await grant.run(() => proof(owner, "ws-a", "ContextGraphObject", graph.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "Action", id: action.id })]));
  });

  it("requires the Finance source scope even for a workspace administrator", async () => {
    const budget = f.insert("modelUsageBudget", { id: "budget", workspaceId: "ws-a", monthlyBudgetCents: 100 });
    const graph = await copiedGraph("finance-graph", "ModelUsageBudget", budget);
    const grant = oauth("oauth-finance", ["context-graph:read", "brain:read"]);
    await grant.run(async () => {
      await expect(proof(owner, "ws-a", "ContextGraphObject", graph.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    });
    grant.row.scopes.push("finance:read");
    expect(await grant.run(() => proof(owner, "ws-a", "ContextGraphObject", graph.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ModelUsageBudget", id: budget.id })]));
  });

  it("checks an immutable snapshot's original source scope", async () => {
    const action = await original("Action", "oauth-snapshot");
    const roots = await captureArtifactInputSnapshotProof(owner, "ws-a", { kind: "Action", id: action.id }, f.db);
    const grant = oauth("oauth-a", ["context-graph:read"]);
    expect(await grant.run(() => isArtifactInputProofReadable(owner, "ws-a", roots, f.db))).toBe(false);
    grant.row.scopes.push("actions:read");
    expect(await grant.run(() => isArtifactInputProofReadable(owner, "ws-a", roots, f.db))).toBe(true);
  });

  it("binds the token to its actual user and workspace, without widening ordinary web reads", async () => {
    const article = await original("BrainArticle", "oauth-article");
    const other = await original("BrainArticle", "oauth-other", "ws-b");
    const grant = oauth("oauth-a", ["brain:read"]);
    const beta: AppActor = { kind: "user", user: { id: "beta", email: "beta@example.test", displayName: "Beta" } };
    expect(await grant.run(() => proof(owner, "ws-a", "BrainArticle", article.id))).toHaveLength(1);
    await grant.run(async () => {
      await expect(proof(beta, "ws-a", "BrainArticle", article.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
      await expect(proof(owner, "ws-b", "BrainArticle", other.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    });
    expect(await proof(beta, "ws-a", "BrainArticle", article.id)).toHaveLength(1);
  });

  it.each(["revoke", "client-disable", "scope-change", "delete", "refresh-expiry"] as const)(
    "withholds previously captured content after OAuth %s", async change => {
      const article = await original("BrainArticle", "oauth-cached");
      const grant = oauth("oauth-a", ["brain:read"]);
      await grant.run(async () => {
        const roots = await proof(owner, "ws-a", "BrainArticle", article.id);
        if (change === "revoke") grant.row.revokedAt = new Date();
        else if (change === "client-disable") grant.row.client.isActive = false;
        else if (change === "scope-change") grant.row.scopes = ["context-graph:read"];
        else if (change === "delete") f.tables.get("mcpOAuthAccessToken")!.delete(grant.row.id);
        else grant.row.refreshExpiresAt = new Date("2000-01-01");
        expect(await isArtifactInputProofReadable(owner, "ws-a", roots, f.db)).toBe(false);
      });
    },
  );
});
