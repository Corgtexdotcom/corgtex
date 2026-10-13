import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  let serial = 0;
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === "AND") { if (!(value as any[]).every((entry) => matches(row, entry))) return false; }
      else if (key === "OR") { if (!(value as any[]).some((entry) => matches(row, entry))) return false; }
      else if (value instanceof Date) { if (!(row[key] instanceof Date) || row[key].getTime() !== value.getTime()) return false; }
      else if (value && typeof value === "object" && "in" in value) { if (!(value.in as any[]).includes(row[key])) return false; }
      else if (value && typeof value === "object" && "not" in value) { if (row[key] === value.not) return false; }
      else if (value && typeof value === "object" && "startsWith" in value) { if (!String(row[key]).startsWith(String(value.startsWith))) return false; }
      else if (row[key] !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
  const base = { $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [] as any[]) };
  const prisma = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    const name = String(property);
    if (!delegates.has(name)) {
      const rows = () => [...(tables.get(name)?.values() ?? [])];
      const find = ({ where, select, orderBy, take }: any) => {
        let result = rows().filter((row) => matches(row, where));
        for (const [field, direction] of Object.entries(orderBy ?? {})) result.sort((a, b) => {
          const left = a[field] instanceof Date ? a[field].getTime() : a[field];
          const right = b[field] instanceof Date ? b[field].getTime() : b[field];
          return (left === right ? 0 : left > right ? 1 : -1) * (direction === "desc" ? -1 : 1);
        });
        return result.slice(0, take ?? result.length).map((row) => project(row, select));
      };
      delegates.set(name, {
        findFirst: vi.fn(async (args) => find(args)[0] ?? null),
        findUnique: vi.fn(async (args) => find(args)[0] ?? null),
        findMany: vi.fn(async (args) => find(args)),
        create: vi.fn(async ({ data }) => {
          const now = new Date();
          const row = { id: `${name}-${++serial}`, createdAt: now, updatedAt: now,
            ...(name === "conversationPendingOperation" ? { status: "PENDING", proposedAt: now, resultJson: null, errorCode: null, errorMessage: null, executedAt: null, canceledAt: null } : {}), ...structuredClone(data) };
          if (!tables.has(name)) tables.set(name, new Map());
          tables.get(name)!.set(row.id, row);
          return structuredClone(row);
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = rows().find((entry) => matches(entry, where));
          if (!row) throw new Error("Synthetic row unavailable");
          Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return structuredClone(row);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows().filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, { updatedAt: new Date() }, structuredClone(data));
          return { count: found.length };
        }),
      });
    }
    return delegates.get(name);
  } });
  return { tables, memberships, delegates, membership, prisma, base };
});

vi.mock("../../shared/src/env", () => ({ env: { ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/mcp-context"), ...await import("../../shared/src/crypto"), prisma: fixture.prisma, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]) }));

import { assertMcpOriginActive, getMcpOrigin, mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin } from "../../shared/src/mcp-context";
import { AppError } from "./errors";
import { decryptSecret, encryptSecret } from "../../shared/src/crypto";
import { withMcpToolInput } from "./mcp-tool-input";
import { getConversationOperationOutcomeInputRoots, recordConversationToolLinkArchiveOutcome } from "./conversation-operation-outcome";
import { getMcpToolInputRoots } from "./mcp-tool-input-context";
import { isMcpToolInputEncryptedPayload } from "./mcp-tool-input-cipher";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage, withArtifactInputWriteFence } from "./source-lineage";
import { prepareProducerLineage } from "./producer-lineage";

const workspaceId = "synthetic-ws-a";
const alice: AppActor = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } };
const bob: AppActor = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } };
// A Prisma transaction client has no $transaction method. Keep that shape so
// OAuth epoch checks retain their lock on this same synthetic connection.
const tx = new Proxy(fixture.prisma, { get(target, property) {
  return property === "$transaction" ? undefined : Reflect.get(target, property);
} }) as any;
let oauthEpochs: ReturnType<typeof installSourcePermissionEpochFixture>;
const payload = { title: "Synthetic submitted title", bodyMd: "  Exact synthetic submission\n", nested: { values: [1, true, null] } };
const params = { workspaceId, toolName: "create_goal", args: payload, requiredScopes: ["goals:write"] };
function insert(delegate: string, value: { id: string; [key: string]: unknown }) {
  const row: { id: string; [key: string]: any } = { createdAt: new Date(), ...value };
  if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map()); fixture.tables.get(delegate)!.set(row.id, row); return row;
}
function oauth(actor = alice, ws = workspaceId, id = "oauth-alice") {
  const row = insert("mcpOAuthAccessToken", { id, workspaceId: ws, userId: actor.kind === "user" ? actor.user.id : "", revokedAt: null,
    scopes: ["workspace:read", "goals:write", "brain:write", "brain:read", "tools:read", "conversations:write"], client: { isActive: true }, refreshExpiresAt: null });
  oauthEpochs.bump(ws, "McpOAuthGrantPolicy", id);
  return { row, origin: { kind: "oauth" as const, id, workspaceId: ws, scopeHash: mcpScopesHash(row.scopes), grantEpoch: "1", requiredScopes: [] } };
}
function credential(id = "credential-a", ws = workspaceId) {
  const row = insert("agentCredential", { id, workspaceId: ws, tokenHash: `synthetic-token-${id}`, scopes: ["goals:write", "brain:write"], isActive: true });
  const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic credential", credentialId: id, credentialVersion: mcpCredentialVersion(row.tokenHash), workspaceIds: [ws], scopes: [...row.scopes] };
  return { row, actor, origin: { kind: "agent" as const, id, workspaceId: ws, credentialVersion: mcpCredentialVersion(row.tokenHash), scopeHash: mcpScopesHash(row.scopes), requiredScopes: [] } };
}
function inputs() { return [...(fixture.tables.get("mcpToolInput")?.values() ?? [])]; }

beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear();
  oauthEpochs = installSourcePermissionEpochFixture(fixture.prisma);
  fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR" });
  fixture.memberships.set(`${workspaceId}:synthetic-bob`, { id: "member-bob", role: "CONTRIBUTOR" });
  fixture.memberships.set("synthetic-ws-b:synthetic-bob", { id: "member-bob-b", role: "CONTRIBUTOR" });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    const origin = getMcpOrigin(); if (origin) await assertMcpOriginActive(tx, origin, ws);
    if (actor.kind === "agent") { if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "FORBIDDEN", "Synthetic workspace unavailable"); return null; }
    const member = fixture.memberships.get(`${ws}:${actor.user.id}`);
    if (!member) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable"); return member;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const prior = structuredClone(fixture.tables);
    try { return await callback(tx); } catch (error) { fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows); throw error; }
  });
});

describe("exact authenticated MCP tool inputs and process-local producer scope", () => {
  it("requires an actual MCP origin and matches OAuth's authenticated user", async () => {
    const work = vi.fn(async () => "value");
    await expect(withMcpToolInput(alice, params, work)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const { origin } = oauth(bob);
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, work))).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
    expect(work).not.toHaveBeenCalled(); expect(inputs()).toHaveLength(0);
  });

  it("captures exact user arguments before the trusted handler without a manufactured certificate", async () => {
    const { origin } = oauth();
    const roots = await runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async (args) => {
      expect(args).toEqual(payload); expect(Object.isFrozen(args)).toBe(true); expect(Object.isFrozen(args.nested.values)).toBe(true);
      const roots = getMcpToolInputRoots(alice, workspaceId); expect(roots).toHaveLength(1); return roots;
    }));
    expect(inputs()[0]).toMatchObject({ actorKind: "user", userId: "synthetic-alice", credentialId: null, credentialVersion: null, scopeHash: null,
      toolName: params.toolName, requiredScopes: ["goals:write"] });
    expect(decryptSecret(inputs()[0].argumentsJson)).toBe(JSON.stringify(payload));
    expect(isMcpToolInputEncryptedPayload(inputs()[0].argumentsJson)).toBe(true);
    expect(roots[0]).toMatchObject({ kind: "McpToolInput", id: inputs()[0].id, fingerprint: lineageContentFingerprint("McpToolInput", inputs()[0]),
      permissionEpochs: { version: 1, policyVersion: "pun68-permissions-v3", entries: expect.arrayContaining([
        { kind: "McpToolInput", id: inputs()[0].id, epoch: "0" },
      ]) } });
    expect(fixture.tables.get("artifactInputLineage")?.size ?? 0).toBe(0); expect(getMcpToolInputRoots(alice, workspaceId)).toEqual([]);
    expect(await isArtifactInputProofReadable(bob, workspaceId, roots, tx)).toBe(false);
    expect(await isArtifactInputProofReadable(bob, "synthetic-ws-b", roots, tx)).toBe(false);
  });

  it("captures exact credential version/full scope hash and denies other credentials and users", async () => {
    const first = credential(); const second = credential("credential-b");
    const roots = await runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, params, async () => getMcpToolInputRoots(first.actor, workspaceId)));
    expect(inputs()[0]).toMatchObject({ actorKind: "agent", userId: null, credentialId: first.row.id,
      credentialVersion: mcpCredentialVersion(first.row.tokenHash), scopeHash: mcpScopesHash(first.row.scopes) });
    expect(await isArtifactInputProofReadable(second.actor, workspaceId, roots, tx)).toBe(false);
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(false);
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(second.actor, params, async () => null))).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
    expect(fixture.tables.get("artifactInputLineage")?.size ?? 0).toBe(0);
  });

  it("prevents foreign workspace, missing scope and non-native principal execution", async () => {
    const first = credential(); const work = vi.fn(async () => null);
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, { ...params, workspaceId: "synthetic-ws-b" }, work))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, { ...params, requiredScopes: ["goals:approve"] }, work))).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
    for (const authProvider of ["bootstrap", "control-plane"] as const) {
      await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput({ ...first.actor, authProvider } as AppActor, params, work))).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
    }
    expect(work).not.toHaveBeenCalled(); expect(inputs()).toHaveLength(0);
  });

  it("freezes the original parsed payload synchronously, rejects mutation of handler args and ignores claimed roots", async () => {
    const { origin } = oauth(); const args = { ...payload, nested: { values: [1, true, null] }, lineageRoots: [{ kind: "BrainArticle", id: "guessed-private-source", fingerprint: "f".repeat(64) }] };
    const pending = runWithMcpOrigin(origin, () => withMcpToolInput(alice, { ...params, args }, async (frozen) => {
      expect(frozen.title).toBe(payload.title); expect(frozen.nested.values).toEqual([1, true, null]);
      expect(() => { frozen.nested.values.push("changed" as any); }).toThrow();
      expect(getMcpToolInputRoots(alice, workspaceId).every((root) => root.kind === "McpToolInput")).toBe(true);
    }));
    args.title = "Changed after submission"; args.nested.values[0] = 99;
    await pending;
    expect(JSON.parse(decryptSecret(inputs()[0].argumentsJson)).title).toBe(payload.title);
  });

  it("rejects non-JSON or incomplete submissions without silently discarding fields", async () => {
    const { origin } = oauth(); const cyclic: any = {}; cyclic.self = cyclic;
    for (const args of [{ value: undefined }, { value: Number.NaN }, { value: new Date() }, cyclic, new Array(1)]) {
      await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, { ...params, args }, async () => null))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, { ...params, requiredScopes: [] }, async () => null))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(inputs()).toHaveLength(0);
  });

  it("retains outer receipt roots through same-principal nesting and refuses actor/workspace shadowing", async () => {
    const { origin } = oauth();
    await runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => {
      const outer = getMcpToolInputRoots(alice, workspaceId);
      await withMcpToolInput(alice, { ...params, toolName: "store_brain", requiredScopes: ["brain:write"] }, async () => {
        const both = getMcpToolInputRoots(alice, workspaceId); expect(both).toHaveLength(2); expect(both).toEqual(expect.arrayContaining(outer));
        expect(() => getMcpToolInputRoots({ ...alice } as AppActor, workspaceId)).toThrow("does not belong");
        expect(() => getMcpToolInputRoots(alice, "synthetic-ws-b")).toThrow("does not belong");
      });
      expect(getMcpToolInputRoots(alice, workspaceId)).toEqual(outer);
    }));
    expect(getMcpToolInputRoots(alice, workspaceId)).toEqual([]);
  });

  it("rejects principal mutation instead of dropping the input receipt into an original-content fallback", async () => {
    const first = credential();
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, params, async () => {
      if (first.actor.kind !== "agent") throw new Error("Synthetic actor fixture");
      first.actor.label = "Changed actor identity";
      expect(() => getMcpToolInputRoots(first.actor, workspaceId)).toThrow("does not belong");
    }))).rejects.toMatchObject({ code: "MCP_INPUT_SCOPE_MISMATCH" });
  });

  it.each(["deactivate", "rotate", "scope"] as const)("checks current credential %s before handler execution", async (change) => {
    const first = credential(); const work = vi.fn(async () => null);
    if (change === "deactivate") first.row.isActive = false;
    if (change === "rotate") first.row.tokenHash = "synthetic-rotated-token";
    if (change === "scope") first.row.scopes = ["brain:write"];
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, params, work))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(work).not.toHaveBeenCalled(); expect(inputs()).toHaveLength(0);
  });

  it("checks grants after the handler and preserves originals without granting stale receipt access", async () => {
    const first = credential(); let roots: any[] = [];
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, params, async () => {
      roots = getMcpToolInputRoots(first.actor, workspaceId); first.row.scopes = ["brain:write"]; return "Unreleased result";
    }))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(inputs()).toHaveLength(1); expect(decryptSecret(inputs()[0].argumentsJson)).toBe(JSON.stringify(payload));
    expect(await isArtifactInputProofReadable(first.actor, workspaceId, roots, tx)).toBe(false);
    expect(getMcpToolInputRoots(first.actor, workspaceId)).toEqual([]);
  });

  it("honors unknown native receipts and empty legacy user scope arrays", async () => {
    const { origin } = oauth(); await runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => null));
    const input = inputs()[0]; input.requiredScopes = [];
    await expect(captureArtifactInputProof(alice, workspaceId, [{ kind: "McpToolInput", id: input.id }], tx)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    input.requiredScopes = ["goals:write"];
    insert("artifactInputLineage", { id: "unknown-native", workspaceId, artifactType: "McpToolInput", artifactId: input.id, revision: 1, origin: "UNKNOWN",
      contentHash: lineageContentFingerprint("McpToolInput", input), rootsJson: null });
    await expect(captureArtifactInputProof(alice, workspaceId, [{ kind: "McpToolInput", id: input.id }], tx)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("encrypts the entire exact secret-bearing payload and rejects authenticated-envelope tampering or plaintext legacy inputs", async () => {
    const { origin } = oauth();
    const secretPayload = { ...payload, credentialSecret: "SYNTHETIC_SECRET_MARKER", recorderToken: "SYNTHETIC_RECORDER_TOKEN", nested: { password: "SYNTHETIC_PASSWORD_MARKER" } };
    let roots: any[] = [];
    await runWithMcpOrigin(origin, () => withMcpToolInput(alice, { ...params, args: secretPayload }, async (frozen) => {
      expect(frozen).toEqual(secretPayload); roots = getMcpToolInputRoots(alice, workspaceId);
    }));
    const input = inputs()[0];
    for (const marker of [secretPayload.credentialSecret, secretPayload.recorderToken, secretPayload.nested.password, payload.bodyMd]) expect(input.argumentsJson).not.toContain(marker);
    expect(JSON.parse(decryptSecret(input.argumentsJson))).toEqual(secretPayload);
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(true);
    const frozenRoots = await captureImmutableArtifactInputProof(alice, workspaceId, roots, tx);
    for (const marker of [secretPayload.credentialSecret, secretPayload.recorderToken, secretPayload.nested.password, payload.bodyMd]) {
      expect(JSON.stringify([...fixture.tables.get("artifactInputSnapshot")!.values()])).not.toContain(marker);
    }
    expect(await isArtifactInputProofReadable(alice, workspaceId, frozenRoots, tx)).toBe(true);
    const saved = input.argumentsJson;
    expect(isMcpToolInputEncryptedPayload(`${saved}:SYNTHETIC_PLAINTEXT_SUFFIX`)).toBe(false);
    input.argumentsJson = saved.slice(0, -2) + (saved.slice(-2) === "AA" ? "BB" : "AA");
    expect(isMcpToolInputEncryptedPayload(input.argumentsJson)).toBe(false);
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(false);
    await expect(captureArtifactInputProof(alice, workspaceId, [{ kind: "McpToolInput", id: input.id }], tx)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(isMcpToolInputEncryptedPayload(JSON.stringify(secretPayload))).toBe(false);
    expect(isMcpToolInputEncryptedPayload(encryptSecret("not parsed JSON"))).toBe(false);
    input.argumentsJson = JSON.stringify(secretPayload);
    await expect(captureArtifactInputProof(alice, workspaceId, [{ kind: "McpToolInput", id: input.id }], tx)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    input.argumentsJson = saved;
    expect(await isArtifactInputProofReadable(alice, workspaceId, roots, tx)).toBe(true);
    expect(await isArtifactInputProofReadable(alice, workspaceId, frozenRoots, tx)).toBe(true);
  });

  it("withholds results when membership or the exact submitted native record is revoked during work", async () => {
    const { origin } = oauth();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => {
      fixture.memberships.delete(`${workspaceId}:synthetic-alice`); return "Unreleased member result";
    }))).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR" });
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => {
      const [root] = getMcpToolInputRoots(alice, workspaceId);
      fixture.tables.get("mcpToolInput")!.get(root.id).argumentsJson = JSON.stringify({ title: "Changed server record" });
      return "Unreleased changed-source result";
    }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("automatically records native tool inputs on actual artifact producers and prevents human-original laundering", async () => {
    const { origin } = oauth();
    const artifact = insert("brainArticle", { id: "submitted-article", workspaceId, title: payload.title, bodyMd: payload.bodyMd, isPrivate: false, ownerMemberId: null, archivedAt: null });
    await runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => {
      await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "BrainArticle", id: artifact.id }, content: artifact, origin: "HUMAN_ORIGINAL", inputs: [] });
    }));
    const manifest = [...fixture.tables.get("artifactInputLineage")!.values()].find((row) => row.artifactId === artifact.id);
    expect(manifest.origin).toBe("DERIVED"); expect(manifest.rootsJson.some((root: any) => root.kind === "McpToolInput")).toBe(true);
    expect(await isArtifactInputProofReadable(bob, workspaceId, [{ kind: "BrainArticle", id: artifact.id, fingerprint: lineageContentFingerprint("BrainArticle", artifact) }], tx)).toBe(false);
  });

  it("withholds a committed derived result if a contributing private SQL source is revoked before return", async () => {
    const { origin } = oauth();
    const source = insert("brainArticle", { id: "private-source", workspaceId, title: "Synthetic private contributor", bodyMd: "Synthetic private body", isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "BrainArticle", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => {
      const roots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id, snapshot: source }], tx);
      const goal = insert("goal", { id: "derived-result", workspaceId, title: "Synthetic derived goal", descriptionMd: source.bodyMd, isPrivate: false, authorUserId: "synthetic-alice" });
      await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "Goal", id: goal.id }, content: goal, origin: "DERIVED", inputs: [], inheritedRoots: roots });
      source.ownerMemberId = "member-bob";
      return goal.descriptionMd;
    }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const goal = fixture.tables.get("goal")!.get("derived-result");
    expect(goal.descriptionMd).toBe("Synthetic private body");
    expect(await isArtifactInputProofReadable(alice, workspaceId, [{ kind: "Goal", id: goal.id, fingerprint: lineageContentFingerprint("Goal", goal) }], tx)).toBe(false);
  });

  it("retains consumed old and new revisions through a permitted mutation while honoring current privacy", async () => {
    const { origin } = oauth();
    const source = insert("brainArticle", { id: "edited-source", workspaceId, title: "Synthetic editable article", bodyMd: "Original synthetic body", isPrivate: false, ownerMemberId: null, archivedAt: null });
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "BrainArticle", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    const original = structuredClone(source);
    const value = await runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => {
      const oldRoots = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id, snapshot: original }], tx);
      const immutableOld = await captureImmutableArtifactInputProof(alice, workspaceId, oldRoots, tx);
      source.bodyMd = `${original.bodyMd}\n${payload.bodyMd}`;
      await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "BrainArticle", id: source.id }, content: source,
        origin: "DERIVED", inputs: [], inheritedRoots: immutableOld });
      await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id, snapshot: source }], tx);
      return source.bodyMd;
    }));
    expect(value).toBe(`${original.bodyMd}\n${payload.bodyMd}`);
    const snapshots = [...fixture.tables.get("artifactInputSnapshot")!.values()];
    expect(snapshots.some((row) => JSON.stringify(row).includes(original.bodyMd))).toBe(true);
    const current = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: source.id }], tx);
    source.isPrivate = true; source.ownerMemberId = "member-bob";
    expect(await isArtifactInputProofReadable(alice, workspaceId, current, tx)).toBe(false);
    expect(source.bodyMd).toBe(value);
  });

  it("requires a complete prior receipt before a partial MCP edit can be certified", async () => {
    const { origin } = oauth();
    const legacy = insert("brainArticle", { id: "legacy-article", workspaceId, title: "Old title", bodyMd: "Unproven old body", isPrivate: false, ownerMemberId: null, archivedAt: null });
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, params, async () => prepareProducerLineage({ tx, actor: alice, workspaceId,
      artifact: { kind: "BrainArticle", id: legacy.id }, before: legacy, capture: {}, copied: true })))).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(legacy.bodyMd).toBe("Unproven old body");
  });

  it("preserves active owner fences and rolls back native input creation on receipt/grant failure", async () => {
    const { origin } = oauth(); const stale = async () => { throw new AppError(409, "OWNER_STALE", "Synthetic owner revoked"); };
    await expect(runWithMcpOrigin(origin, () => withArtifactInputWriteFence(stale, () => withMcpToolInput(alice, params, async () => null)))).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(inputs()).toHaveLength(0);
    const first = credential(); const create = tx.mcpToolInput.create; const implementation = create.getMockImplementation()!;
    create.mockImplementationOnce(async (args: any) => { const input = await implementation(args); fixture.tables.get("agentCredential")!.get(first.row.id).isActive = false; return input; });
    await expect(runWithMcpOrigin(first.origin, () => withMcpToolInput(first.actor, params, async () => null))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
    expect(inputs()).toHaveLength(0);
  });
});


const archiveParams = { workspaceId, toolName: "archive_tool_link", args: { toolLinkId: "archive-target" }, requiredScopes: ["tools:write"] };
function archiveOauth() {
  const fixture = oauth(); fixture.row.scopes.push("tools:write"); fixture.origin.scopeHash = mcpScopesHash(fixture.row.scopes); return fixture;
}
function archiveCredential() {
  const fixture = credential("archive-credential"); fixture.row.scopes.push("tools:write");
  if (fixture.actor.kind === "agent") fixture.actor.scopes = [...fixture.row.scopes];
  fixture.origin.scopeHash = mcpScopesHash(fixture.row.scopes); return fixture;
}
async function archiveTarget(id = archiveParams.args.toolLinkId) {
  const row = insert("workspaceToolLink", { id, workspaceId, createdByUserId: "synthetic-alice", title: "OLD_TOOL_BODY_CANARY",
    url: "https://example.test", descriptionMd: "OLD_TOOL_DESCRIPTION_CANARY", circleTags: [], archivedAt: null });
  await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "WorkspaceToolLink", id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}
async function performArchive(actor: AppActor, row: any, snapshotRequest = false) {
  const bodyRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "WorkspaceToolLink", id: row.id }], tx);
  let requestRoots = getMcpToolInputRoots(actor, workspaceId);
  if (snapshotRequest) requestRoots = await captureImmutableArtifactInputProof(actor, workspaceId, requestRoots, tx);
  const value = await fixture.prisma.$transaction(async (writeTx: any) => {
    fixture.tables.get("workspaceToolLink")!.get(row.id).archivedAt = new Date();
    return recordConversationToolLinkArchiveOutcome(actor, { workspaceId, toolLinkId: row.id, requestLineageRoots: requestRoots }, writeTx);
  });
  expect(await isArtifactInputProofReadable(actor, workspaceId, bodyRoots, tx)).toBe(false);
  return value;
}

describe("exact registered MCP terminal archive outcome", () => {
  beforeEach(() => {
    Object.assign(fixture.memberships.get(`${workspaceId}:synthetic-alice`)!, { isActive: true, userId: "synthetic-alice", workspaceId });
    Object.assign(fixture.memberships.get(`${workspaceId}:synthetic-bob`)!, { isActive: true, userId: "synthetic-bob", workspaceId });
  });
  it("releases only the committed constant result while old body/model context remains unreadable", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    const privateSource = insert("brainArticle", { id: "private-model-source", workspaceId, title: "PRIVATE_MODEL_TITLE_CANARY", bodyMd: "PRIVATE_MODEL_BODY_CANARY",
      isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    await recordArtifactInputLineage({ tx, actor: alice, workspaceId, artifact: { kind: "BrainArticle", id: privateSource.id }, content: privateSource, origin: "HUMAN_ORIGINAL", inputs: [] });
    let oldContext: any[] = [];
    const result = await runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => {
      oldContext = await captureArtifactInputProof(alice, workspaceId, [{ kind: "BrainArticle", id: privateSource.id }], tx);
      const value = await performArchive(alice, target);
      privateSource.ownerMemberId = "member-bob";
      return value;
    }));
    expect(result).toEqual({ success: true, message: "The tool link was archived." });
    expect(JSON.stringify(result)).not.toMatch(/OLD_TOOL|PRIVATE_MODEL|archive-target/);
    expect(await isArtifactInputProofReadable(alice, workspaceId, oldContext, tx)).toBe(false);
    const roots = await getConversationOperationOutcomeInputRoots(alice, workspaceId, result);
    expect(roots).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ConversationOperationOutcome" }), expect.objectContaining({ kind: "McpToolInput", id: inputs()[0].id })]));
    expect(roots.some(root => ["WorkspaceToolLink", "BrainArticle"].includes(root.kind))).toBe(false);
  });

  it("admits this immutable native request when the operation captured its exact snapshot", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    const result = await runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, () => performArchive(alice, target, true)));
    expect(result).toEqual({ success: true, message: "The tool link was archived." });
  });

  it("rejects serialized or invented receipt/result lookalikes after archive", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => ({ ...await performArchive(alice, target) })))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rejects an earlier registered outcome whose native input is superseded by this invocation", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    const first = await runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, () => performArchive(alice, target)));
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => first))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(inputs()).toHaveLength(2);
  });

  it("rejects a registered outcome for a different selected target even when this input is included", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget("other-target");
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, () => performArchive(alice, target)))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("keeps the full read-result gate for every normal tool even if it returns a registered archive outcome", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, { ...archiveParams, toolName: "upsert_tool_link" }, () => performArchive(alice, target)))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("never converts canceled work into success just because a native outcome was committed", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => {
      await performArchive(alice, target);
      throw new Error("Synthetic work canceled");
    }))).rejects.toThrow("Synthetic work canceled");
    expect(fixture.tables.get("conversationOperationOutcome")!.size).toBe(1);
  });

  it("does not release an outcome from a rolled-back archive transaction", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    let result: any;
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => {
      await captureArtifactInputProof(alice, workspaceId, [{ kind: "WorkspaceToolLink", id: target.id }], tx);
      await expect(fixture.prisma.$transaction(async (writeTx: any) => {
        fixture.tables.get("workspaceToolLink")!.get(target.id).archivedAt = new Date();
        result = await recordConversationToolLinkArchiveOutcome(alice, { workspaceId, toolLinkId: target.id, requestLineageRoots: getMcpToolInputRoots(alice, workspaceId) }, writeTx);
        throw new Error("Synthetic transaction canceled");
      })).rejects.toThrow("Synthetic transaction canceled");
      return result;
    }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.get("workspaceToolLink")!.get(target.id).archivedAt).toBeNull();
    expect(fixture.tables.get("conversationOperationOutcome")?.size ?? 0).toBe(0);
  });

  it.each(["scope", "rotate", "deactivate"] as const)("rechecks live credential %s before releasing the registered constant outcome", async change => {
    const current = archiveCredential(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(current.origin, () => withMcpToolInput(current.actor, archiveParams, async () => {
      const value = await performArchive(current.actor, target);
      const row = fixture.tables.get("agentCredential")!.get(current.row.id);
      if (change === "scope") row.scopes = ["brain:write"];
      if (change === "rotate") row.tokenHash = "rotated-native-fixture";
      if (change === "deactivate") row.isActive = false;
      return value;
    }))).rejects.toThrow();
  });

  it("rejects an archive registration missing the actual tool write scope before invoking work", async () => {
    const { origin } = archiveOauth(); const work = vi.fn(async () => null);
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, { ...archiveParams, requiredScopes: ["brain:write"] }, work))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(work).not.toHaveBeenCalled();
    expect(inputs()).toHaveLength(0);
  });

  it("withholds a registered result if this exact encrypted submission is changed after its effect", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => {
      const value = await performArchive(alice, target);
      fixture.tables.get("mcpToolInput")!.get(inputs()[0].id).argumentsJson = encryptSecret(JSON.stringify({ toolLinkId: "changed-request" }));
      return value;
    }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("withholds old source labels smuggled into the exact registered mutable result", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => {
      const value = await performArchive(alice, target);
      Object.assign(value, { title: "OLD_TOOL_BODY_CANARY" });
      return value;
    }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rechecks current membership and this exact native source after successful archive", async () => {
    const { origin } = archiveOauth(); const target = await archiveTarget();
    await expect(runWithMcpOrigin(origin, () => withMcpToolInput(alice, archiveParams, async () => {
      const value = await performArchive(alice, target);
      fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
      return value;
    }))).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });
});
