import { afterEach, expect, it, vi } from "vitest";

const { deleteDocument, resolveRequestActor, findSources, handleRouteError, scan } = vi.hoisted(() => ({
  deleteDocument: vi.fn(), resolveRequestActor: vi.fn(), findSources: vi.fn(), handleRouteError: vi.fn(),
  scan: vi.fn(async ({ load }) => load(undefined, 100)),
}));

class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, deleteDocument, scanSourceReadableRecords: scan }));
vi.mock("@corgtex/shared", () => ({ prisma: { brainSource: { findMany: findSources } } }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor }));
vi.mock("@/lib/http", () => ({ handleRouteError }));

afterEach(() => vi.clearAllMocks());

it("returns tenant-scoped source review links when direct Document DELETE is blocked", async () => {
  const actor = { kind: "user", user: { id: "admin" } };
  resolveRequestActor.mockResolvedValue(actor);
  deleteDocument.mockRejectedValue(new MockAppError(409, "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED", "Review linked sources."));
  findSources.mockResolvedValue([{ id: "source-1" }, { id: "source-2" }]);
  const { DELETE } = await import("./route");
  const { NextRequest } = await import("next/server");
  const response = await DELETE(new NextRequest("http://localhost/api/workspaces/ws-1/documents/doc-1", { method: "DELETE" }),
    { params: Promise.resolve({ workspaceId: "ws-1", documentId: "doc-1" }) });
  expect(response.status).toBe(409);
  expect(deleteDocument).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", documentId: "doc-1" });
  expect(findSources).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", archivedAt: null,
    metadata: { path: ["documentId"], equals: "doc-1" } }, orderBy: { id: "asc" }, take: 100 });
  expect(await response.json()).toMatchObject({ reviewSources: [
    { id: "source-1", href: "/workspaces/ws-1/brain/sources?review=source-1" },
    { id: "source-2", href: "/workspaces/ws-1/brain/sources?review=source-2" },
  ] });
  expect(handleRouteError).not.toHaveBeenCalled();
});

it("returns only current source-admitted review ids and paths", async () => {
  resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "admin" } });
  deleteDocument.mockRejectedValue(new MockAppError(409, "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED", "Review linked sources."));
  findSources.mockResolvedValue([{ id: "unknown" }, { id: "readable" }]);
  scan.mockImplementationOnce(async ({ actor, workspaceId, kind, load }: any) => {
    expect(actor.user.id).toBe("admin"); expect(workspaceId).toBe("ws-1"); expect(kind).toBe("BrainSource");
    return (await load(undefined, 100)).filter((row: any) => row.id === "readable");
  });
  const { DELETE } = await import("./route"); const { NextRequest } = await import("next/server");
  const response = await DELETE(new NextRequest("http://localhost/api/workspaces/ws-1/documents/doc-1", { method: "DELETE" }),
    { params: Promise.resolve({ workspaceId: "ws-1", documentId: "doc-1" }) });
  expect(await response.json()).toMatchObject({ reviewSources: [{ id: "readable", href: "/workspaces/ws-1/brain/sources?review=readable" }] });
});
