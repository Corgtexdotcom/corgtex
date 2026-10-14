import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const sources: Array<Record<string, any>> = [];
  const chunks: Array<Record<string, any>> = [];
  const domains = new Map<string, string[]>();
  const permitted = new Map<string, Set<string>>();
  const rows = (type: string, where: any) => sources.filter((source) => source.type === type
    && source.workspaceId === where.workspaceId && (!where.id || where.id.in.includes(source.id))
    && (!where.accessDomain || where.accessDomain.in.includes(source.accessDomain))
    && source.archivedAt === null && (where.isPrivate !== false || !source.isPrivate));
  const prisma = {
    $queryRaw: vi.fn(async (query: {sql: string}) => query.sql.includes("AS stamp") ? [{stamp: "empty-native-collection"}]
      : query.sql.includes("AS current") ? [{current: true}] : []),
    knowledgeChunk: { findMany: vi.fn(async ({ where, take }: any) => chunks.filter((chunk) =>
      chunk.workspaceId === where.workspaceId && where.accessDomain.in.includes(chunk.accessDomain)
      && (!where.sourceType || chunk.sourceType === where.sourceType)
      && (!where.OR || where.OR.some((parent: any) => parent.sourceType === chunk.sourceType && parent.sourceId === chunk.sourceId))
      && (!where.AND || where.AND[0].OR.some((condition: any) => condition.createdAt?.lt ? chunk.createdAt < condition.createdAt.lt
        : chunk.createdAt.getTime() === condition.createdAt.getTime() && (condition.chunkIndex?.gt !== undefined
          ? chunk.chunkIndex > condition.chunkIndex.gt : chunk.chunkIndex === condition.chunkIndex && chunk.id > condition.id.gt))))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.chunkIndex - b.chunkIndex || a.id.localeCompare(b.id)).slice(0, take)) },
    brainArticle: { findMany: vi.fn(async ({ where }: any) => rows("BRAIN_ARTICLE", where)) },
    document: { findMany: vi.fn(async ({ where }: any) => rows("DOCUMENT", where)) },
    meeting: { findMany: vi.fn(async ({ where }: any) => rows("MEETING", where)) },
    proposal: { findMany: vi.fn(async ({ where }: any) => rows("PROPOSAL", where)) },
    externalContentSource: { findMany: vi.fn(async ({ where }: any) => rows("EXTERNAL_CONTENT", where)) },
    sqlNativeRunInput: { findMany: vi.fn(async () => []) },
  };
  const hash = (kind: string, row: any) => JSON.stringify([kind, row.title, row.bodyMd ?? row.textContent]);
  return { sources, chunks, domains, permitted, prisma, hash };
});

vi.mock("@corgtex/shared", async original => ({...await original<any>(), prisma: fixture.prisma}));
vi.mock("@corgtex/domain", () => ({
  lineageContentFingerprint: fixture.hash,
  captureArtifactInputProof: vi.fn(async (_actor, _ws, inputs) => inputs.map((input: any) => ({kind: input.kind, id: input.id, fingerprint: fixture.hash(input.kind, input.snapshot)}))),
  isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  resolveKnowledgeAccessDomains: vi.fn(async (actor: AppActor, workspaceId: string) =>
    fixture.domains.get(`${actor.kind === "user" ? actor.user.id : "agent"}:${workspaceId}`) ?? []),
  readableArtifactIds: vi.fn(async (actor: AppActor, workspaceId: string, _kind: string, rows: Array<{ id: string }>) =>
    new Set(rows.filter((row) => fixture.permitted.get(`${actor.kind === "user" ? actor.user.id : "agent"}:${workspaceId}`)?.has(row.id))
      .map((row) => row.id))),
}));
vi.mock("../../domain/src/source-lineage", () => ({withArtifactCountReleaseSnapshot: async (_actor: AppActor, _ws: string,
  _roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
  await remote(); return finish(fixture.prisma);
}}));

import { countReadableKnowledgeChunks } from "./counts";

const alice: AppActor = { kind: "user", user: { id: "alice", email: "alice@example.test", displayName: "Alice" } };
const bob: AppActor = { kind: "user", user: { id: "bob", email: "bob@example.test", displayName: "Bob" } };

function article(id: string, workspaceId: string, accessDomain = "WORKSPACE", validReceipt = true) {
  const row = { id, workspaceId, type: "BRAIN_ARTICLE", title: id, bodyMd: `Synthetic ${id}`, archivedAt: null, isPrivate: false };
  fixture.sources.push(row);
  fixture.chunks.push({ id: `chunk-${id}`, createdAt: new Date("2026-10-13T00:00:00Z"), chunkIndex: fixture.chunks.length, content: row.bodyMd, sourceTitle: row.title, workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: id, accessDomain,
    metadata: { sourceContentHash: validReceipt ? fixture.hash("BrainArticle", row) : "stale" } });
  return row;
}

describe("readable knowledge chunk counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.sources.length = 0;
    fixture.chunks.length = 0;
    fixture.domains.clear();
    fixture.permitted.clear();
    fixture.domains.set("alice:ws-1", ["WORKSPACE", "FINANCE"]);
    fixture.domains.set("bob:ws-1", ["WORKSPACE"]);
    fixture.domains.set("alice:ws-2", ["WORKSPACE"]);
    fixture.permitted.set("alice:ws-1", new Set(["public", "finance", "stale", "chunk-public", "chunk-finance", "chunk-stale"]));
    fixture.permitted.set("bob:ws-1", new Set(["public", "finance", "stale", "chunk-public", "chunk-finance", "chunk-stale"]));
    fixture.permitted.set("alice:ws-2", new Set(["foreign", "chunk-foreign"]));
  });

  it("counts only current receipts in the caller's workspace and domains", async () => {
    article("public", "ws-1");
    article("finance", "ws-1", "FINANCE");
    article("stale", "ws-1", "WORKSPACE", false);
    article("unknown", "ws-1");
    article("foreign", "ws-2");
    expect(await countReadableKnowledgeChunks(alice, "ws-1")).toBe(2);
    expect(await countReadableKnowledgeChunks(bob, "ws-1")).toBe(1);
    expect(await countReadableKnowledgeChunks(alice, "ws-2")).toBe(1);
    fixture.domains.set("alice:ws-1", ["WORKSPACE"]);
    expect(await countReadableKnowledgeChunks(alice, "ws-1")).toBe(1);
  });
});

describe("child manifest count admission", () => {
  it("excludes private or unknown child ancestry despite a readable parent", async () => {
    fixture.sources.length = 0; fixture.chunks.length = 0;
    article("parent", "ws-1");
    fixture.domains.set("alice:ws-1", ["WORKSPACE"]);
    fixture.permitted.set("alice:ws-1", new Set(["parent"]));
    expect(await countReadableKnowledgeChunks(alice, "ws-1")).toBe(0);
    fixture.permitted.get("alice:ws-1")!.add("chunk-parent");
    expect(await countReadableKnowledgeChunks(alice, "ws-1")).toBe(1);
  });

  it("rejects a changed input before releasing the aggregate", async () => {
    fixture.sources.length = 0; fixture.chunks.length = 0;
    article("parent", "ws-1");
    fixture.domains.set("alice:ws-1", ["WORKSPACE"]);
    fixture.permitted.set("alice:ws-1", new Set(["parent", "chunk-parent"]));
    const {isArtifactInputProofReadable} = await import("@corgtex/domain");
    vi.mocked(isArtifactInputProofReadable).mockResolvedValueOnce(false);
    await expect(countReadableKnowledgeChunks(alice, "ws-1")).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });
});
