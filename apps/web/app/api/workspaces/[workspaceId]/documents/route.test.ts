import { afterEach, describe, expect, it, vi } from "vitest";

const {
  assertCanAttachActionReference,
  attachActionReferenceDocument,
  createDocument,
  ingestFile,
  listDocuments,
  requireWorkspaceMembership,
  resolveRequestActor,
  checkApiDemoGuard,
  handleRouteError,
} = vi.hoisted(() => ({
  assertCanAttachActionReference: vi.fn(),
  attachActionReferenceDocument: vi.fn(),
  createDocument: vi.fn(),
  ingestFile: vi.fn(),
  listDocuments: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
  checkApiDemoGuard: vi.fn(),
  handleRouteError: vi.fn(),
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
  assertCanAttachActionReference,
  attachActionReferenceDocument,
  createDocument,
  listDocuments,
  requireWorkspaceMembership,
}));

vi.mock("@corgtex/knowledge", () => ({
  ingestFile,
}));

vi.mock("@/lib/auth", () => ({
  resolveRequestActor,
}));

vi.mock("@/lib/demo-guard", () => ({
  checkApiDemoGuard,
}));

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/workspaces/[workspaceId]/documents", () => {
  it("passes the resolved actor and archive filter to document listing", async () => {
    const actor = { kind: "user", user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    requireWorkspaceMembership.mockResolvedValue({ id: "member-1" });
    listDocuments.mockResolvedValue([{ id: "doc-1" }]);

    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");
    const response = await GET(
      new NextRequest("http://localhost/api/workspaces/ws-1/documents?archiveFilter=archived"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(200);
    expect(requireWorkspaceMembership).toHaveBeenCalledWith({ actor, workspaceId: "ws-1" });
    expect(listDocuments).toHaveBeenCalledWith(actor, "ws-1", { archiveFilter: "archived" });
    expect(await response.json()).toEqual({ documents: [{ id: "doc-1" }] });
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/[workspaceId]/documents", () => {
  it("authorizes and links a device upload to its Action reference", async () => {
    const actor = { kind: "user", user: { id: "user-1" } };
    resolveRequestActor.mockResolvedValue(actor);
    ingestFile.mockResolvedValue({ document: { id: "doc-action" } });
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["reference"], "reference.txt", { type: "text/plain" }));
    formData.set("actionReferenceId", "action-1");

    const response = await POST(new Request("http://localhost/api/workspaces/ws-1/documents", {
      method: "POST", body: formData,
    }) as never, { params: Promise.resolve({ workspaceId: "ws-1" }) });

    expect(response.status).toBe(201);
    expect(assertCanAttachActionReference).toHaveBeenCalledWith(actor, { workspaceId: "ws-1", actionId: "action-1" });
    expect(assertCanAttachActionReference.mock.invocationCallOrder[0]).toBeLessThan(ingestFile.mock.invocationCallOrder[0]);
    expect(attachActionReferenceDocument).toHaveBeenCalledWith(actor, {
      workspaceId: "ws-1", actionId: "action-1", documentId: "doc-action",
    });
  });

  it("rejects an inaccessible Action before ingesting the uploaded file", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    assertCanAttachActionReference.mockRejectedValueOnce(new MockAppError(403, "FORBIDDEN", "No access"));
    handleRouteError.mockImplementationOnce(() => new Response("Forbidden", { status: 403 }));
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["reference"], "reference.txt", { type: "text/plain" }));
    formData.set("actionReferenceId", "action-1");

    const response = await POST(new Request("http://localhost/api/workspaces/ws-1/documents", {
      method: "POST", body: formData,
    }) as never, { params: Promise.resolve({ workspaceId: "ws-1" }) });

    expect(response.status).toBe(403);
    expect(ingestFile).not.toHaveBeenCalled();
    expect(attachActionReferenceDocument).not.toHaveBeenCalled();
  });

  it("accepts multipart uploads from the chat composer", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    ingestFile.mockResolvedValue({ document: { id: "doc-1" } });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello world"], "notes.txt", { type: "text/plain" }));
    formData.set("source", "chat-upload");
    formData.set("ingestionGuidanceMd", "Overall guidance:\nTrack follow-ups.");

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/documents", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(ingestFile).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        workspaceId: "ws-1",
        fileName: "notes.txt",
        mimeType: "text/plain",
        uploadSource: "chat-upload",
        documentTitle: "notes.txt",
        ingestionGuidanceMd: "Overall guidance:\nTrack follow-ups.",
      }),
    );
    expect(checkApiDemoGuard).toHaveBeenCalledWith("ws-1");
    expect(handleRouteError).not.toHaveBeenCalled();
  });

  it("enables duplicate checks for opted-in browser uploads before a resolution exists", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    ingestFile.mockResolvedValue({ document: { id: "doc-duplicate-check" } });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello world"], "notes.txt", { type: "text/plain" }));
    formData.set("duplicateGuardEnabled", "true");

    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/documents", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(ingestFile).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      expect.objectContaining({
        duplicateGuard: {},
      }),
    );
  });

  it("preserves the existing JSON document payload contract", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    createDocument.mockResolvedValue({ id: "doc-2" });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/workspaces/ws-1/documents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Manual note",
          source: "manual",
          storageKey: "manual://1",
          mimeType: "text/markdown",
          textContent: "# hello",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId: "ws-1" }) },
    );

    expect(response.status).toBe(201);
    expect(createDocument).toHaveBeenCalledWith(
      { kind: "user", user: { id: "user-1" } },
      {
        workspaceId: "ws-1",
        title: "Manual note",
        source: "manual",
        storageKey: "manual://1",
        mimeType: "text/markdown",
        textContent: "# hello",
        metadata: undefined,
        duplicateGuard: undefined,
      },
    );
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
