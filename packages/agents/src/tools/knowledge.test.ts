import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveKnowledgeAccessDomainsMock, searchIndexedKnowledgeMock } = vi.hoisted(() => ({
  resolveKnowledgeAccessDomainsMock: vi.fn(),
  searchIndexedKnowledgeMock: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  resolveKnowledgeAccessDomains: resolveKnowledgeAccessDomainsMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: searchIndexedKnowledgeMock,
}));

import {
  INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
  resolveInteractiveKnowledgeAccessDomains,
  searchBrain,
} from "./knowledge";

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

describe("interactive agent knowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE"]);
    searchIndexedKnowledgeMock.mockResolvedValue([]);
  });

  it("fails closed to workspace knowledge without an authenticated actor", async () => {
    await expect(resolveInteractiveKnowledgeAccessDomains(undefined, "workspace-1"))
      .resolves.toEqual(["WORKSPACE"]);
    expect(resolveKnowledgeAccessDomainsMock).not.toHaveBeenCalled();
  });

  it("passes server-derived Finance domains and safe source types to Brain search", async () => {
    resolveKnowledgeAccessDomainsMock.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);
    searchIndexedKnowledgeMock.mockResolvedValueOnce([{
      chunkId: "chunk-1",
      sourceId: "document-1",
      sourceType: "DOCUMENT",
      title: "Finance report",
      chunkIndex: 0,
      snippet: "A".repeat(501),
      score: 0.9,
    }]);

    const result = await searchBrain(actor, "workspace-1", "revenue", 100);

    expect(resolveKnowledgeAccessDomainsMock).toHaveBeenCalledWith(actor, "workspace-1");
    expect(searchIndexedKnowledgeMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "revenue",
      limit: 10,
      sourceTypes: INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
      accessDomains: ["WORKSPACE", "FINANCE"],
    });
    expect(result[0]).toMatchObject({
      sourceId: "document-1",
      snippet: `${"A".repeat(500)}...`,
    });
  });

  it("keeps workspace-only actors limited to workspace knowledge", async () => {
    await searchBrain(actor, "workspace-1", "policy");

    expect(searchIndexedKnowledgeMock).toHaveBeenCalledWith(expect.objectContaining({
      accessDomains: ["WORKSPACE"],
      sourceTypes: INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
    }));
  });

  it("does not search when actor authorization fails", async () => {
    resolveKnowledgeAccessDomainsMock.mockRejectedValueOnce(new Error("FORBIDDEN"));

    await expect(searchBrain(actor, "workspace-1", "revenue"))
      .rejects.toThrow("FORBIDDEN");
    expect(searchIndexedKnowledgeMock).not.toHaveBeenCalled();
  });
});
