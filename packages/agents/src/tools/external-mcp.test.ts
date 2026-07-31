import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveKnowledgeAccessDomainsMock,
  searchConnectedExternalMcpContextMock,
  searchIndexedKnowledgeMock,
} = vi.hoisted(() => ({
  resolveKnowledgeAccessDomainsMock: vi.fn(),
  searchConnectedExternalMcpContextMock: vi.fn(),
  searchIndexedKnowledgeMock: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  executeExternalMcpTool: vi.fn(),
  fetchConnectedExternalMcpContext: vi.fn(),
  listExternalMcpConnections: vi.fn(),
  resolveKnowledgeAccessDomains: resolveKnowledgeAccessDomainsMock,
  searchConnectedExternalMcpContext: searchConnectedExternalMcpContextMock,
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge: searchIndexedKnowledgeMock,
}));

import { searchConnectedContextAction } from "./external-mcp";
import { INTERACTIVE_KNOWLEDGE_SOURCE_TYPES } from "./knowledge";

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: "User",
  },
};

describe("connected context Corgtex retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveKnowledgeAccessDomainsMock.mockResolvedValue(["WORKSPACE"]);
    searchIndexedKnowledgeMock.mockResolvedValue([]);
    searchConnectedExternalMcpContextMock.mockResolvedValue({
      results: [],
      errors: [],
    });
  });

  it("uses server-derived Finance domains for the Corgtex result set", async () => {
    resolveKnowledgeAccessDomainsMock.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);
    searchIndexedKnowledgeMock.mockResolvedValueOnce([{
      chunkId: "chunk-1",
      sourceId: "document-1",
      sourceType: "DOCUMENT",
      title: "Finance report",
      chunkIndex: 0,
      snippet: "Revenue increased.",
      score: 0.91,
    }]);

    const result = await searchConnectedContextAction(
      actor,
      { workspaceId: "workspace-1" },
      { query: "revenue", limit: 5 },
    );

    expect(resolveKnowledgeAccessDomainsMock).toHaveBeenCalledWith(actor, "workspace-1");
    expect(searchIndexedKnowledgeMock).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "revenue",
      limit: 5,
      sourceTypes: INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
      accessDomains: ["WORKSPACE", "FINANCE"],
    });
    expect(result.results[0]).toMatchObject({
      source: "corgtex",
      externalId: "chunk-1",
      metadata: {
        sourceType: "DOCUMENT",
        sourceId: "document-1",
      },
    });
  });

  it("does not resolve Corgtex authorization when Corgtex results are excluded", async () => {
    await searchConnectedContextAction(
      actor,
      { workspaceId: "workspace-1" },
      { query: "revenue", includeCorgtex: false },
    );

    expect(resolveKnowledgeAccessDomainsMock).not.toHaveBeenCalled();
    expect(searchIndexedKnowledgeMock).not.toHaveBeenCalled();
    expect(searchConnectedExternalMcpContextMock).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      query: "revenue",
      providerKey: undefined,
      limit: 5,
    });
  });

  it("does not search Corgtex or external providers when authorization fails", async () => {
    resolveKnowledgeAccessDomainsMock.mockRejectedValueOnce(new Error("FORBIDDEN"));

    await expect(searchConnectedContextAction(
      actor,
      { workspaceId: "workspace-1" },
      { query: "revenue" },
    )).rejects.toThrow("FORBIDDEN");

    expect(searchIndexedKnowledgeMock).not.toHaveBeenCalled();
    expect(searchConnectedExternalMcpContextMock).not.toHaveBeenCalled();
  });
});
