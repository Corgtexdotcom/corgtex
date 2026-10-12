import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const sources: Array<Record<string, any>> = [];
  const chunks: Array<Record<string, any>> = [];
  const domains = new Map<string, string[]>();
  const permitted = new Map<string, Set<string>>();
  const rows = (type: string, where: any) => sources.filter((source) => source.type === type
    && source.workspaceId === where.workspaceId && where.id.in.includes(source.id)
    && (!where.accessDomain || where.accessDomain.in.includes(source.accessDomain))
    && source.archivedAt === null && (where.isPrivate !== false || !source.isPrivate));
  const prisma = {
    knowledgeChunk: { findMany: vi.fn(async ({ where }: any) => chunks.filter((chunk) =>
      chunk.workspaceId === where.workspaceId && where.accessDomain.in.includes(chunk.accessDomain)
      && where.sourceType.in.includes(chunk.sourceType))) },
    brainArticle: { findMany: vi.fn(async ({ where }: any) => rows("BRAIN_ARTICLE", where)) },
    document: { findMany: vi.fn(async ({ where }: any) => rows("DOCUMENT", where)) },
    meeting: { findMany: vi.fn(async ({ where }: any) => rows("MEETING", where)) },
    proposal: { findMany: vi.fn(async ({ where }: any) => rows("PROPOSAL", where)) },
  };
  const hash = (kind: string, row: any) => JSON.stringify([kind, row.title, row.bodyMd ?? row.textContent]);
  return { sources, chunks, domains, permitted, prisma, hash };
});

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma }));
vi.mock("@corgtex/domain", () => ({
  lineageContentFingerprint: fixture.hash,
  resolveKnowledgeAccessDomains: vi.fn(async (actor: AppActor, workspaceId: string) =>
    fixture.domains.get(`${actor.kind === "user" ? actor.user.id : "agent"}:${workspaceId}`) ?? []),
  readableArtifactIds: vi.fn(async (actor: AppActor, workspaceId: string, _kind: string, rows: Array<{ id: string }>) =>
    new Set(rows.filter((row) => fixture.permitted.get(`${actor.kind === "user" ? actor.user.id : "agent"}:${workspaceId}`)?.has(row.id))
      .map((row) => row.id))),
}));

import { countReadableKnowledgeChunks } from "./counts";

const alice: AppActor = { kind: "user", user: { id: "alice", email: "alice@example.test", displayName: "Alice" } };
const bob: AppActor = { kind: "user", user: { id: "bob", email: "bob@example.test", displayName: "Bob" } };

function article(id: string, workspaceId: string, accessDomain = "WORKSPACE", validReceipt = true) {
  const row = { id, workspaceId, type: "BRAIN_ARTICLE", title: id, bodyMd: `Synthetic ${id}`, archivedAt: null, isPrivate: false };
  fixture.sources.push(row);
  fixture.chunks.push({ workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: id, accessDomain,
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
    fixture.permitted.set("alice:ws-1", new Set(["public", "finance", "stale"]));
    fixture.permitted.set("bob:ws-1", new Set(["public", "finance", "stale"]));
    fixture.permitted.set("alice:ws-2", new Set(["foreign"]));
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
