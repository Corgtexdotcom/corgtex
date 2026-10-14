import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "./errors";
import type { LineageRoot } from "./source-lineage";

const fixture = vi.hoisted(() => ({
  rows: [] as any[],
  manifests: new Map<string, { origin: string; content: string; roots: any[] }>(),
  memberships: new Set<string>(),
  sources: new Map<string, { workspaceId: string; userId?: string; fingerprint: string; active: boolean }>(),
  readable: vi.fn(), capture: vi.fn(), record: vi.fn(), invalidate: vi.fn(), membership: vi.fn(),
  beforeCreate: null as null | (() => void),
  prisma: { $transaction: vi.fn(), agentMemory: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() } },
}));
vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, toInputJson: (value: unknown) => JSON.parse(JSON.stringify(value)) }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: fixture.capture,
  isArtifactInputProofReadable: fixture.readable,
  recordArtifactInputLineage: fixture.record,
  invalidateArtifactInputLineage: fixture.invalidate,
}));
import { listAgentMemories, loadRelevantMemories, storeAgentMemory } from "./agent-memory";

const alice = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } } as AppActor;
const bob = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } } as AppActor;
const workspaceId = "synthetic-ws-a";
const publicRoot = { kind: "BrainSource" as const, id: "source-public", fingerprint: "a".repeat(64) };
const privateRoot = { kind: "ConversationPromptInput" as const, id: "prompt-alice", fingerprint: "b".repeat(64) };
const store = { workspaceId, agentKey: "assistant", memoryType: "conversation-summary", content: "Synthetic summarized content" };

function owner(actor: AppActor) { return actor.kind === "user" ? actor.user.id : "agent"; }

async function permitted(actor: AppActor, ws: string, roots: any[]) {
  await fixture.membership({ actor, workspaceId: ws });
  return roots.length > 0 && roots.every((root) => {
    const source = fixture.sources.get(root.id);
    return source && source.workspaceId === ws && source.active && source.fingerprint === root.fingerprint
      && (!source.userId || source.userId === owner(actor));
  });
}

function memory(id: string, index: number, ws = workspaceId) {
  return { id, workspaceId: ws, agentKey: "assistant", memoryType: "conversation-summary",
    content: `Synthetic memory ${id}`, metadata: null, embedding: null,
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date(Date.UTC(2026, 9, 12, 12, 0, index)) };
}

function known(row: ReturnType<typeof memory>, roots: LineageRoot[] = [publicRoot]) {
  fixture.rows.push(row);
  fixture.manifests.set(row.id, { origin: "DERIVED", content: row.content, roots });
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.rows = [];
  fixture.manifests = new Map();
  fixture.memberships = new Set([`${workspaceId}:synthetic-alice`, `${workspaceId}:synthetic-bob`, "synthetic-ws-b:synthetic-bob"]);
  fixture.sources = new Map([
    [publicRoot.id, { workspaceId, fingerprint: publicRoot.fingerprint, active: true }],
    [privateRoot.id, { workspaceId, userId: "synthetic-alice", fingerprint: privateRoot.fingerprint, active: true }],
  ]);
  fixture.beforeCreate = null;
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    if (!fixture.memberships.has(`${ws}:${owner(actor)}`)) throw new AppError(403, "NOT_A_MEMBER", "Synthetic nonmember");
    return { id: `member-${owner(actor)}` };
  });
  fixture.readable.mockImplementation(permitted);
  fixture.capture.mockImplementation(async (actor, ws, inputs) => {
    await fixture.membership({ actor, workspaceId: ws });
    const roots: any[] = [];
    for (const input of inputs) {
      if (input.kind === "AgentMemory") {
        const row = fixture.rows.find((item) => item.id === input.id && item.workspaceId === ws);
        const receipt = fixture.manifests.get(input.id);
        if (!row || !receipt || receipt.origin !== "DERIVED" || receipt.content !== row.content
          || !await permitted(actor, ws, receipt.roots)) throw new AppError(409, "UNKNOWN_LINEAGE", "Synthetic memory is unproven");
        roots.push(...receipt.roots);
      } else {
        const source = fixture.sources.get(input.id);
        const root = { kind: input.kind, id: input.id, fingerprint: source?.fingerprint };
        if (!await permitted(actor, ws, [root])) throw new AppError(409, "UNKNOWN_LINEAGE", "Synthetic input is unproven");
        roots.push(root);
      }
    }
    return roots;
  });
  fixture.record.mockImplementation(async (params) => {
    if (!await permitted(params.actor, params.workspaceId, params.inheritedRoots)) throw new AppError(409, "SOURCE_CHANGED", "Synthetic revoked input");
    fixture.manifests.set(params.artifact.id, { origin: params.origin, content: params.content.content, roots: params.inheritedRoots });
  });
  fixture.invalidate.mockImplementation(async (params) => {
    fixture.manifests.set(params.artifact.id, { origin: "UNKNOWN", content: params.content.content, roots: [] });
  });
  fixture.prisma.$transaction.mockImplementation(async (callback) => {
    const beforeRows = structuredClone(fixture.rows);
    const beforeReceipts = structuredClone(fixture.manifests);
    try { return await callback(fixture.prisma); }
    catch (error) { fixture.rows = beforeRows; fixture.manifests = beforeReceipts; throw error; }
  });
  fixture.prisma.agentMemory.create.mockImplementation(async ({ data }) => {
    fixture.beforeCreate?.();
    const row = { ...memory(`memory-${fixture.rows.length}`, fixture.rows.length), ...data };
    fixture.rows.push(row);
    return row;
  });
  fixture.prisma.agentMemory.findMany.mockImplementation(async ({ where, take }) => {
    let rows = fixture.rows.filter((row) => row.workspaceId === where.workspaceId
      && (!where.agentKey || row.agentKey === where.agentKey) && (!where.memoryType || row.memoryType === where.memoryType));
    if (where.OR) {
      const edge = where.OR[1];
      rows = rows.filter((row) => row.updatedAt < edge.updatedAt || (+row.updatedAt === +edge.updatedAt && row.id < edge.id.lt));
    }
    return [...rows].sort((left, right) => +right.updatedAt - +left.updatedAt || right.id.localeCompare(left.id)).slice(0, take);
  });
});

describe("agent memory source permissions", () => {
  it("withholds legacy unknown entries individually and finds permitted entries behind the first database batch", async () => {
    fixture.rows = Array.from({ length: 55 }, (_, index) => memory(`unknown-${index}`, index + 1));
    const permittedMemory = memory("known-last", 0);
    known(permittedMemory);
    expect(await listAgentMemories(alice, workspaceId, { take: 1 })).toEqual([permittedMemory]);
    expect(fixture.prisma.agentMemory.findMany).toHaveBeenCalledTimes(2);
    expect(fixture.rows).toHaveLength(56);
  });

  it("supports two members and two workspaces without returning private copied context or tenant text", async () => {
    const publicMemory = memory("public-memory", 1);
    const privateMemory = memory("private-memory", 2);
    known(publicMemory);
    known(privateMemory, [publicRoot, privateRoot]);
    fixture.rows.push(memory("other-tenant", 3, "synthetic-ws-b"));
    expect(await listAgentMemories(alice, workspaceId)).toEqual([privateMemory, publicMemory]);
    expect(await listAgentMemories(bob, workspaceId)).toEqual([publicMemory]);
    expect(await listAgentMemories(bob, "synthetic-ws-b")).toEqual([]);
  });

  it("withholds a known memory immediately after source privacy revocation, deletion or source content change", async () => {
    const row = memory("known", 1);
    known(row, [publicRoot, privateRoot]);
    expect(await loadRelevantMemories({ actor: alice, workspaceId, agentKey: "assistant" })).toEqual([row]);
    fixture.sources.get(privateRoot.id)!.active = false;
    expect(await listAgentMemories(alice, workspaceId)).toEqual([]);
    fixture.sources.get(privateRoot.id)!.active = true;
    fixture.sources.get(privateRoot.id)!.fingerprint = "c".repeat(64);
    expect(await listAgentMemories(alice, workspaceId)).toEqual([]);
    fixture.sources.delete(privateRoot.id);
    expect(await listAgentMemories(alice, workspaceId)).toEqual([]);
  });

  it("fails closed for missing requester and rejects a departed member", async () => {
    known(memory("known", 1));
    expect(await loadRelevantMemories({ workspaceId, agentKey: "assistant" })).toEqual([]);
    expect(fixture.prisma.agentMemory.findMany).not.toHaveBeenCalled();
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(loadRelevantMemories({ actor: alice, workspaceId, agentKey: "assistant" })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("rechecks the selected full proof immediately before returning memory content", async () => {
    known(memory("known", 1));
    fixture.readable.mockResolvedValueOnce(false);
    await expect(listAgentMemories(alice, workspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("applies agent/type filters and stable updatedAt/id keysets before the permitted sample limit", async () => {
    const first = memory("b", 0);
    const second = memory("a", 0);
    known(first); known(second);
    const otherAgent = { ...memory("other-agent", 5), agentKey: "unrelated" }; known(otherAgent);
    expect(await listAgentMemories(alice, workspaceId, { agentKey: "assistant", memoryType: "conversation-summary", take: 1 })).toEqual([first]);
    expect(fixture.prisma.agentMemory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId, agentKey: "assistant", memoryType: "conversation-summary" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 50,
    }));
  });

  it("stores a model memory and all complete input roots atomically as DERIVED", async () => {
    const row = await storeAgentMemory({ ...store, actor: alice, lineageRoots: [publicRoot, privateRoot],
      metadata: { topic: "Synthetic" }, embedding: [0.1, 0.2] });
    expect(fixture.record).toHaveBeenCalledWith(expect.objectContaining({
      tx: fixture.prisma, actor: alice, workspaceId, artifact: { kind: "AgentMemory", id: row.id },
      origin: "DERIVED", inheritedRoots: [publicRoot, privateRoot],
    }));
    expect(await listAgentMemories(alice, workspaceId)).toEqual([row]);
    expect(await listAgentMemories(bob, workspaceId)).toEqual([]);
  });

  it("leaves missing-actor and missing-root writes UNKNOWN even when plausible source IDs are supplied", async () => {
    const noActor = await storeAgentMemory({ ...store, lineageRoots: [publicRoot], lineageInputs: [{ kind: publicRoot.kind, id: publicRoot.id }] });
    const noRoots = await storeAgentMemory({ ...store, actor: alice, lineageInputs: [{ kind: publicRoot.kind, id: publicRoot.id }] });
    expect(fixture.manifests.get(noActor.id)?.origin).toBe("UNKNOWN");
    expect(fixture.manifests.get(noRoots.id)?.origin).toBe("UNKNOWN");
    expect(fixture.record).not.toHaveBeenCalled();
    expect(await listAgentMemories(alice, workspaceId)).toEqual([]);
    expect(fixture.rows).toHaveLength(2);
  });

  it("rejects revoked captured inputs before content creation", async () => {
    fixture.sources.get(privateRoot.id)!.active = false;
    await expect(storeAgentMemory({ ...store, actor: alice, lineageRoots: [publicRoot, privateRoot] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.prisma.agentMemory.create).not.toHaveBeenCalled();
    expect(fixture.rows).toEqual([]);
  });

  it("rolls back memory content if source access changes or receipt persistence fails after creation", async () => {
    fixture.beforeCreate = () => { fixture.sources.get(privateRoot.id)!.active = false; };
    await expect(storeAgentMemory({ ...store, actor: alice, lineageRoots: [publicRoot, privateRoot] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.rows).toEqual([]);
    fixture.beforeCreate = null;
    fixture.sources.get(privateRoot.id)!.active = true;
    fixture.record.mockRejectedValueOnce(new Error("Synthetic receipt persistence failure"));
    await expect(storeAgentMemory({ ...store, actor: alice, lineageRoots: [publicRoot] })).rejects.toThrow("Synthetic receipt persistence failure");
    expect(fixture.rows).toEqual([]);
    expect(fixture.manifests.size).toBe(0);
  });

  it("rejects a requested cross-tenant write and preserves zero-limit behavior", async () => {
    await expect(storeAgentMemory({ ...store, workspaceId: "synthetic-ws-b", actor: alice, lineageRoots: [publicRoot] })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(await listAgentMemories(alice, workspaceId, { take: 0 })).toEqual([]);
    expect(fixture.prisma.agentMemory.findMany).not.toHaveBeenCalled();
  });
});
