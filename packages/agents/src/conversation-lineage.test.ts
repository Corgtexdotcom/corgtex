import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "../../domain/src/errors";

const fixture = vi.hoisted(() => ({
  capture: vi.fn(), readable: vi.fn(), chunks: vi.fn(),
  membershipActive: true,
  allowed: new Set<string>(),
}));
vi.mock("../../domain/src/source-lineage", () => ({ captureArtifactInputProof: fixture.capture, isArtifactInputProofReadable: fixture.readable }));
vi.mock("@corgtex/shared", () => ({ prisma: { knowledgeChunk: { findMany: fixture.chunks } } }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/conversation-lineage"),
  AppError: (await import("../../domain/src/errors")).AppError,
}));
import { createConversationLineageCollector } from "./conversation-lineage";

const actor = { kind: "user", user: { id: "synthetic-user-a", email: "a@example.test", displayName: null } } as AppActor;
const workspaceId = "synthetic-workspace-a";
const root = { kind: "BrainSource" as const, id: "source-public", fingerprint: "a".repeat(64) };
const privateRoot = { kind: "BrainSource" as const, id: "source-private", fingerprint: "b".repeat(64) };
const chunk = {
  id: "chunk-a", workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: "article-a", sourceTitle: "Synthetic public title",
  chunkIndex: 0, content: "Synthetic permitted article content", metadata: { sourceContentHash: "a".repeat(64) },
  accessDomain: "GENERAL", sensitivity: "INTERNAL",
};
const result = { chunkId: chunk.id, sourceId: chunk.sourceId, sourceType: chunk.sourceType,
  title: chunk.sourceTitle, chunkIndex: chunk.chunkIndex, snippet: chunk.content, score: 0.7 };

beforeEach(() => {
  vi.resetAllMocks();
  fixture.membershipActive = true;
  fixture.allowed = new Set(["source-public", "source-private", "chunk-a", "turn-a", "profile-a"]);
  fixture.capture.mockImplementation(async (_actor, ws, inputs) => {
    if (!fixture.membershipActive) throw new AppError(403, "NOT_A_MEMBER", "Synthetic departed member");
    if (ws !== workspaceId || inputs.some((input: { id: string }) => !fixture.allowed.has(input.id))) {
      throw new AppError(409, "UNKNOWN_LINEAGE", "Synthetic unknown or unavailable input");
    }
    return inputs.map((input: { id: string; kind: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
  });
  fixture.readable.mockImplementation(async (_actor, ws, roots) => {
    if (!fixture.membershipActive) throw new AppError(403, "NOT_A_MEMBER", "Synthetic departed member");
    return ws === workspaceId && roots.every((input: { id: string }) => fixture.allowed.has(input.id));
  });
  fixture.chunks.mockResolvedValue([structuredClone(chunk)]);
});

describe("conversation complete context collector", () => {
  it("keeps every supplied source even when the model cites only the public one", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    await collector.captureTrusted("Both public and private synthetic content", [root, privateRoot]);
    expect(await collector.roots()).toEqual([root, privateRoot]);
    fixture.allowed.delete(privateRoot.id);
    await expect(collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("omits unknown memories, restricted profiles and prior turns before using their text or counts", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    const rows = [{ id: "legacy-memory", content: "Unknown legacy content" }, { id: "profile-a", content: "Known synthetic profile" }];
    expect(await collector.admitRecords("BrainArticle", rows)).toEqual([rows[1]]);
    expect(await collector.roots()).toEqual([{ kind: "BrainArticle", id: "profile-a", fingerprint: "a".repeat(64) }]);
    expect(await collector.admitRecords("ConversationTurn", [{ id: "revoked-turn", assistantMessage: "Restricted old reply" },
      { id: "turn-a", assistantMessage: "Known independent reply" }])).toEqual([{ id: "turn-a", assistantMessage: "Known independent reply" }]);
    expect(fixture.capture).toHaveBeenCalledWith(actor, workspaceId, [{ kind: "ConversationTurn", id: "turn-a",
      snapshot: { id: "turn-a", assistantMessage: "Known independent reply" } }], undefined);
  });

  it("does not hide membership failures as optional missing context", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    fixture.membershipActive = false;
    await expect(collector.admitRecords("BrainArticle", [{ id: "profile-a" }])).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("requires joined labels to have their own contributing input proofs", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    const joined = { id: "profile-a", bodyMd: "Permitted body", authorName: "Restricted joined label" };
    expect(await collector.admitRecords("BrainArticle", [joined], () => [{ kind: "Member", id: "restricted-member" }])).toEqual([]);
    await expect(collector.roots()).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.allowed.add("restricted-member");
    expect(await collector.admitRecords("BrainArticle", [joined], () => [{ kind: "Member", id: "restricted-member" }])).toEqual([joined]);
    expect(await collector.roots()).toEqual([
      { kind: "BrainArticle", id: "profile-a", fingerprint: "a".repeat(64) },
      { kind: "Member", id: "restricted-member", fingerprint: "a".repeat(64) },
    ]);
  });

  it("rejects a cross-workspace source and never calls its content a valid context", async () => {
    const collector = createConversationLineageCollector(actor, "synthetic-workspace-b");
    expect(await collector.admitRecords("BrainArticle", [{ id: "profile-a", bodyMd: "Other tenant content" }])).toEqual([]);
    await expect(collector.roots()).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("checks current SQL receipts and records every eagerly supplied chunk before returning it", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    expect(await collector.admitKnowledgeResults([result])).toEqual([result]);
    expect(fixture.chunks).toHaveBeenCalledWith({ where: { workspaceId, id: { in: [chunk.id] } } });
    expect(fixture.capture).toHaveBeenCalledWith(actor, workspaceId, [{ kind: "KnowledgeChunk", id: chunk.id, snapshot: chunk }], undefined);
    expect(await collector.roots()).toEqual([{ kind: "KnowledgeChunk", id: chunk.id, fingerprint: "a".repeat(64) }]);
  });

  it.each([
    { snippet: "Forged provider text" }, { title: "Forged title" }, { sourceId: "other-source" },
    { sourceType: "DOCUMENT" }, { chunkIndex: 7 }, { score: Number.NaN },
  ])("omits stale/forged retrieval metadata %j before model use", async (override) => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    expect(await collector.admitKnowledgeResults([{ ...result, ...override }])).toEqual([]);
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it("drops extra provider text and permits only verified result fields", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    const admitted = await collector.admitKnowledgeResults([{ ...result, externalText: "Restricted unreceipted provider text" }]);
    expect(admitted).toEqual([result]);
    expect(admitted[0]).not.toHaveProperty("externalText");
  });

  it("permits the existing Untitled formatting only for an untitled SQL chunk", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    fixture.chunks.mockResolvedValue([{ ...chunk, sourceTitle: null }]);
    expect(await collector.admitKnowledgeResults([{ ...result, title: "Untitled" }])).toEqual([{ ...result, title: "Untitled" }]);
  });

  it("excludes currently unreadable chunks before ranking or counts are passed on", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    fixture.allowed.delete(chunk.id);
    expect(await collector.admitKnowledgeResults([result])).toEqual([]);
    await expect(collector.roots()).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("does not certify unreceipted external tool text using a later SQL lookup", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    collector.markIncomplete();
    await collector.admitKnowledgeResults([result]);
    await expect(collector.roots()).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    await expect(collector.assertReadable()).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("requires a minted exact tool result receipt, not an arbitrary source-shaped object", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    await expect(collector.addReceipt({ sourceId: root.id, text: "Unproven text" },
      { type: "conversation-input-receipt", payloadHash: "a".repeat(64) })).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
  });

  it("blocks response release and persistence when membership or uncited source access changes during the model", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    await collector.captureTrusted("Synthetic onboarding from both sources", [root, privateRoot]);
    await collector.assertReadable();
    fixture.membershipActive = false;
    await expect(collector.roots()).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("detects modification of the actual admitted tool scalar values", async () => {
    const collector = createConversationLineageCollector(actor, workspaceId);
    const actual = { total: 1, title: "Synthetic permitted title" };
    await collector.captureTrusted(actual, [root]);
    actual.total = 10;
    await expect(collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
