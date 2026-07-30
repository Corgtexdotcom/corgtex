import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  brainSourceFindFirst,
  getSignedUrl,
  handleRouteError,
  resolveKnowledgeAccessDomains,
  resolveRequestActor,
} = vi.hoisted(() => ({
  brainSourceFindFirst: vi.fn(),
  getSignedUrl: vi.fn(),
  handleRouteError: vi.fn(),
  resolveKnowledgeAccessDomains: vi.fn(),
  resolveRequestActor: vi.fn(),
}));

class MockAppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  resolveKnowledgeAccessDomains,
}));

vi.mock("@corgtex/shared", () => ({
  prisma: {
    brainSource: {
      findFirst: brainSourceFindFirst,
    },
  },
}));

vi.mock("@corgtex/storage", () => ({
  defaultStorage: {
    getSignedUrl,
  },
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

const actor = {
  kind: "user",
  user: { id: "user-1" },
};

function request() {
  return new Request("http://localhost/api/workspaces/workspace-1/brain/sources/source-1/file") as never;
}

function context() {
  return {
    params: Promise.resolve({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    }),
  };
}

describe("GET /api/workspaces/[workspaceId]/brain/sources/[sourceId]/file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestActor.mockResolvedValue(actor);
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    brainSourceFindFirst.mockResolvedValue({ fileStorageKey: "sources/source-1/report.pdf" });
    getSignedUrl.mockResolvedValue("https://storage.example.test/signed-report");
    handleRouteError.mockImplementation((error: unknown) => {
      const status = error instanceof MockAppError ? error.status : 500;
      const code = error instanceof MockAppError ? error.code : "INTERNAL_ERROR";
      return Response.json({ code }, { status });
    });
  });

  it("redirects an authorized Finance reader to a one-hour signed URL", async () => {
    resolveKnowledgeAccessDomains.mockResolvedValueOnce(["WORKSPACE", "FINANCE"]);
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(actor, "workspace-1");
    expect(brainSourceFindFirst).toHaveBeenCalledWith({
      where: {
        id: "source-1",
        workspaceId: "workspace-1",
        accessDomain: { in: ["WORKSPACE", "FINANCE"] },
      },
      select: {
        fileStorageKey: true,
      },
    });
    expect(getSignedUrl).toHaveBeenCalledWith("sources/source-1/report.pdf", 3600);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://storage.example.test/signed-report");
  });

  it("returns not found without signing when the source is outside the actor's domains", async () => {
    brainSourceFindFirst.mockResolvedValueOnce(null);
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(brainSourceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "source-1",
        workspaceId: "workspace-1",
        accessDomain: { in: ["WORKSPACE"] },
      },
    }));
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND" });
  });

  it("does not query or sign when access-domain resolution fails", async () => {
    resolveKnowledgeAccessDomains.mockRejectedValueOnce(
      new MockAppError(403, "FORBIDDEN", "Access denied."),
    );
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(brainSourceFindFirst).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN" });
  });

  it("returns not found without signing when the source has no file", async () => {
    brainSourceFindFirst.mockResolvedValueOnce({ fileStorageKey: null });
    const { GET } = await import("./route");

    const response = await GET(request(), context());

    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "NOT_FOUND" });
  });
});
