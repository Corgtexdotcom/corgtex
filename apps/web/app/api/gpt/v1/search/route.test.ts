import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  handleRouteError,
  requireGptAuth,
  resolveKnowledgeAccessDomains,
  searchIndexedKnowledge,
} = vi.hoisted(() => ({
  handleRouteError: vi.fn(),
  requireGptAuth: vi.fn(),
  resolveKnowledgeAccessDomains: vi.fn(),
  searchIndexedKnowledge: vi.fn(),
}));

vi.mock("@/lib/gpt-auth", () => ({
  requireGptAuth,
}));

vi.mock("@corgtex/domain", () => ({
  resolveKnowledgeAccessDomains,
}));

vi.mock("@corgtex/knowledge", () => ({
  searchIndexedKnowledge,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

const actor = {
  kind: "user" as const,
  user: {
    id: "user-1",
    email: "user@example.test",
    displayName: "User",
  },
};

describe("GET /api/gpt/v1/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireGptAuth.mockResolvedValue({
      workspaceId: "workspace-1",
      actor,
      scopes: ["read"],
    });
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    searchIndexedKnowledge.mockResolvedValue([]);
    handleRouteError.mockImplementation((error: unknown) => {
      return Response.json(
        { code: error instanceof Error ? error.message : "INTERNAL_ERROR" },
        { status: 403 },
      );
    });
  });

  it("derives domains from the OAuth user actor", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest(
        "http://localhost/api/gpt/v1/search?query=forecast&limit=7&accessDomains=WORKSPACE",
      ),
    );

    expect(response.status).toBe(200);
    expect(requireGptAuth).toHaveBeenCalledWith(expect.anything(), "read");
    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(actor, "workspace-1");
    expect(searchIndexedKnowledge).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "forecast",
      limit: 7,
      accessDomains: ["WORKSPACE", "FINANCE"],
    });
  });

  it("rejects a missing query before resolving domains", async () => {
    const { GET } = await import("./route");

    const response = await GET(new NextRequest("http://localhost/api/gpt/v1/search"));

    expect(response.status).toBe(400);
    expect(resolveKnowledgeAccessDomains).not.toHaveBeenCalled();
    expect(searchIndexedKnowledge).not.toHaveBeenCalled();
  });

  it("does not search when domain resolution rejects the OAuth actor", async () => {
    resolveKnowledgeAccessDomains.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("http://localhost/api/gpt/v1/search?query=forecast"),
    );

    expect(response.status).toBe(403);
    expect(searchIndexedKnowledge).not.toHaveBeenCalled();
  });
});
