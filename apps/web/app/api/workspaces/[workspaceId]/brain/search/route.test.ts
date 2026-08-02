import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleRouteError, resolveKnowledgeAccessDomains, resolveRequestActor, searchIndexedKnowledge } = vi.hoisted(() => ({
  handleRouteError: vi.fn(),
  resolveKnowledgeAccessDomains: vi.fn(),
  resolveRequestActor: vi.fn(),
  searchIndexedKnowledge: vi.fn(),
}));

class MockAppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, resolveKnowledgeAccessDomains }));
vi.mock("@corgtex/knowledge", () => ({ searchIndexedKnowledge }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor }));
vi.mock("@/lib/http", () => ({ handleRouteError }));

const actor = { kind: "user", user: { id: "user-1" } };
const context = () => ({ params: Promise.resolve({ workspaceId: "workspace-1" }) });

describe("GET /api/workspaces/[workspaceId]/brain/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue(actor);
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    searchIndexedKnowledge.mockResolvedValue([]);
    handleRouteError.mockImplementation((error: unknown) => {
      const status = error instanceof MockAppError ? error.status : 500;
      const code = error instanceof MockAppError ? error.code : "INTERNAL_ERROR";
      return Response.json({ code }, { status });
    });
  });

  it("passes Finance-authorized actor domains to privacy-safe Brain search", async () => {
    resolveKnowledgeAccessDomains.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-1/brain/search?q=forecast&limit=12") as never,
      context(),
    );

    expect(response.status).toBe(200);
    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(actor, "workspace-1");
    expect(searchIndexedKnowledge).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "forecast",
      limit: 12,
      accessDomains: ["WORKSPACE", "FINANCE"],
      sourceTypes: ["BRAIN_ARTICLE", "DOCUMENT", "MEETING"],
    });
  });

  it("keeps workspace-only actors on the workspace domain", async () => {
    const { GET } = await import("./route");

    await GET(
      new Request("http://localhost/api/workspaces/workspace-1/brain/search?q=policy") as never,
      context(),
    );

    expect(searchIndexedKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      accessDomains: ["WORKSPACE"],
    }));
  });

  it("rejects a missing query before resolving domains", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-1/brain/search") as never,
      context(),
    );

    expect(response.status).toBe(400);
    expect(resolveKnowledgeAccessDomains).not.toHaveBeenCalled();
    expect(searchIndexedKnowledge).not.toHaveBeenCalled();
  });

  it("does not search when domain resolution rejects the actor", async () => {
    resolveKnowledgeAccessDomains.mockRejectedValueOnce(
      new MockAppError(403, "FORBIDDEN", "Access denied."),
    );
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-1/brain/search?q=forecast") as never,
      context(),
    );

    expect(response.status).toBe(403);
    expect(searchIndexedKnowledge).not.toHaveBeenCalled();
  });
});
