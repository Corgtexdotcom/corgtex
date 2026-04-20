import { afterEach, describe, expect, it, vi } from "vitest";

const {
  createDocument,
  ingestFile,
  listDocuments,
  requireWorkspaceMembership,
  resolveRequestActor,
  handleRouteError,
} = vi.hoisted(() => ({
  createDocument: vi.fn(),
  ingestFile: vi.fn(),
  listDocuments: vi.fn(),
  requireWorkspaceMembership: vi.fn(),
  resolveRequestActor: vi.fn(),
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

vi.mock("@/lib/http", () => ({
  handleRouteError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/[workspaceId]/documents", () => {
  it("accepts multipart uploads from the chat composer", async () => {
    resolveRequestActor.mockResolvedValue({ kind: "user", user: { id: "user-1" } });
    ingestFile.mockResolvedValue({ document: { id: "doc-1" } });

    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["hello world"], "notes.txt", { type: "text/plain" }));
    formData.set("source", "chat-upload");

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
      }),
    );
    expect(handleRouteError).not.toHaveBeenCalled();
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
      },
    );
    expect(handleRouteError).not.toHaveBeenCalled();
  });
});
