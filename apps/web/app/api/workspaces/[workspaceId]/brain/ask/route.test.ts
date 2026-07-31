import { beforeEach, describe, expect, it, vi } from "vitest";

const { answerKnowledgeQuestion, handleRouteError, resolveKnowledgeAccessDomains, resolveRequestActor } = vi.hoisted(() => ({
  answerKnowledgeQuestion: vi.fn(),
  handleRouteError: vi.fn(),
  resolveKnowledgeAccessDomains: vi.fn(),
  resolveRequestActor: vi.fn(),
}));

class MockAppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, resolveKnowledgeAccessDomains }));
vi.mock("@corgtex/knowledge", () => ({ answerKnowledgeQuestion }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor }));
vi.mock("@/lib/http", () => ({ handleRouteError }));

const actor = { kind: "user", user: { id: "user-1" } };
const context = () => ({ params: Promise.resolve({ workspaceId: "workspace-1" }) });

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/workspaces/workspace-1/brain/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/workspaces/[workspaceId]/brain/ask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue(actor);
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    answerKnowledgeQuestion.mockResolvedValue({ answer: "Grounded", citations: [] });
    handleRouteError.mockImplementation((error: unknown) => {
      const status = error instanceof MockAppError ? error.status : 500;
      const code = error instanceof MockAppError ? error.code : "INTERNAL_ERROR";
      return Response.json({ code }, { status });
    });
  });

  it("passes Finance-authorized actor domains into answers and citations", async () => {
    resolveKnowledgeAccessDomains.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);
    const { POST } = await import("./route");

    const response = await POST(
      request({ question: "What changed in the forecast?", limit: 6 }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(actor, "workspace-1");
    expect(answerKnowledgeQuestion).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      question: "What changed in the forecast?",
      limit: 6,
      accessDomains: ["WORKSPACE", "FINANCE"],
      sourceTypes: ["BRAIN_ARTICLE", "DOCUMENT", "MEETING"],
    });
  });

  it("keeps workspace-only actors on the workspace domain", async () => {
    const { POST } = await import("./route");

    await POST(request({ question: "What is our policy?" }), context());

    expect(answerKnowledgeQuestion).toHaveBeenCalledWith(expect.objectContaining({
      accessDomains: ["WORKSPACE"],
    }));
  });

  it("rejects a missing question before resolving domains", async () => {
    const { POST } = await import("./route");

    const response = await POST(request({ question: " " }), context());

    expect(response.status).toBe(400);
    expect(resolveKnowledgeAccessDomains).not.toHaveBeenCalled();
    expect(answerKnowledgeQuestion).not.toHaveBeenCalled();
  });

  it("does not answer when domain resolution rejects the actor", async () => {
    resolveKnowledgeAccessDomains.mockRejectedValueOnce(
      new MockAppError(403, "FORBIDDEN", "Access denied."),
    );
    const { POST } = await import("./route");

    const response = await POST(request({ question: "Forecast?" }), context());

    expect(response.status).toBe(403);
    expect(answerKnowledgeQuestion).not.toHaveBeenCalled();
  });
});
