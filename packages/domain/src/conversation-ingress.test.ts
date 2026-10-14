import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";

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

vi.mock("@corgtex/shared", async () => ({
  ...await import("../../shared/src/mcp-context"), prisma: fixture.prisma, toInputJson: (value: unknown) => value,
  env: { MODEL_PROVIDER: "fake", MODEL_REQUEST_TIMEOUT_MS: 1000 },
}));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]) }));

import { mcpCredentialVersion, mcpScopesHash } from "../../shared/src/mcp-context";
import { AppError } from "./errors";
import { createConversationIngressInput } from "./conversation-ingress";
import { captureConversationInputReceipt, validateConversationInputReceipt } from "./conversation-lineage";
import { captureArtifactInputProof, isArtifactInputProofReadable, isArtifactInputProofPubliclyShareable, lineageContentFingerprint,
  recordArtifactInputLineage, withArtifactInputWriteFence } from "./source-lineage";

const workspaceId = "synthetic-ws-a";
const otherWorkspaceId = "synthetic-ws-b";
const alice = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } } as AppActor;
const bob = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } } as AppActor;
const tx = fixture.prisma as any;
const content = "  Synthetic raw submission\nincluding exact whitespace.\n";
function insert(delegate: string, value: { id: string; [key: string]: unknown }) {
  const row: { id: string; [key: string]: any } = { createdAt: new Date(), ...value };
  if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map());
  fixture.tables.get(delegate)!.set(row.id, row);
  return row;
}
function credential(id = "credential-a", ws = workspaceId, scopes = ["conversations:write", "brain:read"]) {
  return insert("agentCredential", { id, workspaceId: ws, tokenHash: `synthetic-token-hash-${id}`, scopes, isActive: true });
}
function actorFor(row: any): AppActor {
  return { kind: "agent", authProvider: "credential", label: "Synthetic credential", credentialId: row.id,
    credentialVersion: mcpCredentialVersion(row.tokenHash), scopes: [...row.scopes], workspaceIds: [row.workspaceId] };
}
function stored(id: string) { return fixture.tables.get("conversationIngressInput")!.get(id); }
async function proof(actor: AppActor, input: { id: string }, ws = workspaceId) {
  return captureArtifactInputProof(actor, ws, [{ kind: "ConversationIngressInput", id: input.id }], tx);
}

beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear();
  for (const [ws, userId] of [[workspaceId, "synthetic-alice"], [workspaceId, "synthetic-bob"], [otherWorkspaceId, "synthetic-bob"]]) {
    fixture.memberships.set(`${ws}:${userId}`, { id: `member-${userId}-${ws}`, role: "CONTRIBUTOR" });
  }
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    if (actor.kind === "agent") {
      if (!actor.workspaceIds?.includes(ws)) throw new AppError(403, "FORBIDDEN", "Synthetic workspace unavailable");
      return null;
    }
    const membership = fixture.memberships.get(`${ws}:${actor.user.id}`);
    if (!membership) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable");
    return membership;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => {
    const prior = structuredClone(fixture.tables);
    try { return await callback(fixture.prisma); } catch (error) {
      fixture.tables.clear(); for (const [key, rows] of prior) fixture.tables.set(key, rows);
      throw error;
    }
  });
  fixture.base.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.base.$queryRaw.mockReset().mockResolvedValue([]);
  installSourcePermissionEpochFixture(tx);
});

describe("authenticated conversation ingress with actual native source proofs", () => {
  it("stores the exact user's submission as native owned input without manufacturing a lineage certificate", async () => {
    const input = await createConversationIngressInput(alice, { workspaceId, content });
    expect(input).toMatchObject({ workspaceId, actorKind: "user", userId: "synthetic-alice", credentialId: null, credentialVersion: null, scopeHash: null, content });
    expect(await proof(alice, input)).toEqual([expect.objectContaining({ kind: "ConversationIngressInput", id: input.id,
      fingerprint: lineageContentFingerprint("ConversationIngressInput", input),
      permissionEpochs: expect.objectContaining({ version: 1, entries: expect.arrayContaining([
        { kind: "ConversationIngressInput", id: input.id, epoch: "0" }, { kind: "MemberUserPolicy", id: "synthetic-alice", epoch: "0" },
        { kind: "Workspace", id: workspaceId, epoch: "0" },
      ]) }) })]);
    expect(fixture.tables.get("artifactInputLineage")?.size ?? 0).toBe(0);
    const transactionalMembership = fixture.membership.mock.calls.find(([call]) => call.tx === tx)?.[0];
    expect(transactionalMembership?.actor).toBe(alice);
    expect(transactionalMembership?.workspaceId).toBe(workspaceId);
  });

  it("requires current membership and denies another user's or workspace's native content", async () => {
    const input = await createConversationIngressInput(alice, { workspaceId, content });
    await expect(proof(bob, input)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(proof(bob, input, otherWorkspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(createConversationIngressInput(alice, { workspaceId: otherWorkspaceId, content })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(proof(alice, input)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(createConversationIngressInput(alice, { workspaceId, content })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(fixture.tables.get("conversationIngressInput")!.size).toBe(1);
  });

  it("records exact active credential identity, token version and complete scope hash", async () => {
    const current = credential(); const actor = actorFor(current);
    const input = await createConversationIngressInput(actor, { workspaceId, content });
    expect(input).toMatchObject({ actorKind: "agent", userId: null, credentialId: current.id, credentialVersion: mcpCredentialVersion(current.tokenHash), scopeHash: mcpScopesHash(current.scopes), content });
    expect(await proof(actor, input)).toHaveLength(1);
    expect(fixture.tables.get("artifactInputLineage")?.size ?? 0).toBe(0);
    const sameGrants = { ...actor, scopes: [...current.scopes].reverse() } as AppActor;
    expect(await proof(sameGrants, input)).toHaveLength(1);
  });

  it("isolates two credentials from each other, from users and from other workspaces", async () => {
    const first = credential(); const second = credential("credential-b"); const foreign = credential("credential-foreign", otherWorkspaceId);
    const actor = actorFor(first); const input = await createConversationIngressInput(actor, { workspaceId, content });
    await expect(proof(actorFor(second), input)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(proof(alice, input)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(proof(actorFor(foreign), input, otherWorkspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(createConversationIngressInput(actorFor(foreign), { workspaceId, content })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const forgedTenantScope = { ...actorFor(foreign), workspaceIds: [workspaceId] } as AppActor;
    await expect(createConversationIngressInput(forgedTenantScope, { workspaceId, content })).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
  });

  it.each(["bootstrap", "control-plane"] as const)("does not invent native ownership for a %s actor", async (authProvider) => {
    const actor = { kind: "agent", authProvider, label: "Synthetic non-native principal", workspaceIds: [workspaceId], scopes: ["conversations:write"], credentialId: "invented", credentialVersion: "a".repeat(64) } as AppActor;
    await expect(createConversationIngressInput(actor, { workspaceId, content })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fixture.tables.get("conversationIngressInput")?.size ?? 0).toBe(0);
  });

  it("requires a concrete credential ID/version and conversations:write before insertion", async () => {
    const row = credential(); const actor = actorFor(row);
    for (const changes of [{ credentialId: undefined }, { credentialVersion: undefined }, { credentialVersion: "" }, { scopes: ["brain:read"] }]) {
      await expect(createConversationIngressInput({ ...actor, ...changes } as AppActor, { workspaceId, content })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    }
    await expect(createConversationIngressInput(alice, { workspaceId, content: undefined as any })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fixture.tables.get("conversationIngressInput")?.size ?? 0).toBe(0);
  });

  it.each(["deactivate", "rotate", "remove-scope", "add-scope"] as const)("honors current credential %s and never reuses stale principal proof", async (change) => {
    const row = credential(); const actor = actorFor(row); const input = await createConversationIngressInput(actor, { workspaceId, content });
    const roots = await proof(actor, input);
    if (change === "deactivate") row.isActive = false;
    if (change === "rotate") row.tokenHash = "synthetic-rotated-token-hash";
    if (change === "remove-scope") row.scopes = ["brain:read"];
    if (change === "add-scope") row.scopes = [...row.scopes, "goals:read"];
    expect(await isArtifactInputProofReadable(actor, workspaceId, roots, tx)).toBe(false);
    await expect(createConversationIngressInput(actor, { workspaceId, content })).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
    const live = fixture.tables.get("agentCredential")!.get(row.id);
    if (live.isActive && live.scopes.includes("conversations:write")) {
      const renewed = actorFor(live);
      expect(await isArtifactInputProofReadable(renewed, workspaceId, roots, tx)).toBe(false);
      const fresh = await createConversationIngressInput(renewed, { workspaceId, content: "Fresh independently submitted payload" });
      expect(fresh.id).not.toBe(input.id); expect(await proof(renewed, fresh)).toHaveLength(1);
    }
    expect(stored(input.id).content).toBe(content);
  });

  it("binds the exact native payload before model admission and refuses edited records and receipt replays", async () => {
    const input = await createConversationIngressInput(alice, { workspaceId, content });
    const receipt = await captureConversationInputReceipt({ actor: alice, workspaceId, value: input.content, inputs: [{ kind: "ConversationIngressInput", id: input.id, snapshot: input }], db: tx });
    expect(await validateConversationInputReceipt({ actor: alice, workspaceId, value: content, receipt, db: tx })).toHaveLength(1);
    await expect(validateConversationInputReceipt({ actor: alice, workspaceId, value: content.trim(), receipt, db: tx })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(validateConversationInputReceipt({ actor: bob, workspaceId, value: content, receipt, db: tx })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(validateConversationInputReceipt({ actor: alice, workspaceId, value: content, receipt: structuredClone(receipt), db: tx })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    stored(input.id).content = "Changed raw record";
    await expect(captureArtifactInputProof(alice, workspaceId, [{ kind: "ConversationIngressInput", id: input.id, snapshot: input }], tx)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(validateConversationInputReceipt({ actor: alice, workspaceId, value: content, receipt, db: tx })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("binds the authenticated principal before asynchronous membership checks", async () => {
    const first = credential(); const second = credential("credential-b"); const actor = actorFor(first);
    fixture.membership.mockImplementationOnce(async () => { Object.assign(actor, actorFor(second)); return null; });
    await expect(createConversationIngressInput(actor, { workspaceId, content })).rejects.toMatchObject({ code: "AUTHORIZATION_CHANGED" });
    expect(fixture.tables.get("conversationIngressInput")?.size ?? 0).toBe(0);
  });

  it("carries native ingress proof into actual derived artifacts without making them public", async () => {
    const row = credential(); const actor = actorFor(row); const input = await createConversationIngressInput(actor, { workspaceId, content });
    const roots = await proof(actor, input);
    const memory = insert("agentMemory", { id: "derived-output", workspaceId, agentKey: "assistant", memoryType: "conversation-summary", content: "Synthetic output influenced by submission" });
    await recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "AgentMemory", id: memory.id }, content: memory, origin: "DERIVED", inputs: [], inheritedRoots: roots });
    const outputRoots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "AgentMemory", id: memory.id }], tx);
    expect(outputRoots.some((root) => root.kind === "ConversationIngressInput" && root.id === input.id)).toBe(true);
    expect(await isArtifactInputProofPubliclyShareable(actor, workspaceId, outputRoots, tx)).toBe(false);
    expect(await isArtifactInputProofReadable(actorFor(credential("other-credential")), workspaceId, outputRoots, tx)).toBe(false);
    await expect(recordArtifactInputLineage({ tx, actor, workspaceId, artifact: { kind: "AgentMemory", id: memory.id }, content: memory, origin: "HUMAN_ORIGINAL", inputs: [] })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    row.isActive = false;
    expect(await isArtifactInputProofReadable(actor, workspaceId, outputRoots, tx)).toBe(false);
  });

  it("withholds UNKNOWN receipts and malformed native principal envelopes", async () => {
    const input = await createConversationIngressInput(alice, { workspaceId, content });
    insert("artifactInputLineage", { id: "unknown", workspaceId, artifactType: "ConversationIngressInput", artifactId: input.id, revision: 1,
      origin: "UNKNOWN", contentHash: lineageContentFingerprint("ConversationIngressInput", input), rootsJson: null });
    await expect(proof(alice, input)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const row = credential(); const actor = actorFor(row);
    const invalid = insert("conversationIngressInput", { id: "malformed-principal", workspaceId, actorKind: "bootstrap", userId: null,
      credentialId: row.id, credentialVersion: mcpCredentialVersion(row.tokenHash), scopeHash: mcpScopesHash(row.scopes), content: "Unproven malformed record" });
    await expect(proof(actor, invalid)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("rejects current owner fences and rolls back an ingress record whose grant changes during capture", async () => {
    const reject = async () => { throw new AppError(409, "OWNER_STALE", "Synthetic owner revoked"); };
    await expect(withArtifactInputWriteFence(reject, () => createConversationIngressInput(alice, { workspaceId, content }))).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(fixture.tables.get("conversationIngressInput")?.size ?? 0).toBe(0);
    let fenceChecks = 0;
    const finalFence = async () => { if (++fenceChecks === 3) throw new AppError(409, "OWNER_STALE", "Synthetic final checkpoint revoked"); };
    await expect(withArtifactInputWriteFence(finalFence, () => createConversationIngressInput(alice, { workspaceId, content }))).rejects.toMatchObject({ code: "OWNER_STALE" });
    expect(fixture.tables.get("conversationIngressInput")?.size ?? 0).toBe(0);
    const row = credential(); const actor = actorFor(row);
    const create = tx.conversationIngressInput.create;
    const implementation = create.getMockImplementation()!;
    create.mockImplementationOnce(async (args: any) => {
      const input = await implementation(args);
      fixture.tables.get("agentCredential")!.get(row.id).isActive = false;
      return input;
    });
    await expect(createConversationIngressInput(actor, { workspaceId, content })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.tables.get("conversationIngressInput")?.size ?? 0).toBe(0);
  });
});
