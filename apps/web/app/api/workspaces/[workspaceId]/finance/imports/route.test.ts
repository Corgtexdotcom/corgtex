import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createUpload, demoGuard, handleRouteError, resolveActor } = vi.hoisted(() => ({
  createUpload: vi.fn(),
  demoGuard: vi.fn(),
  handleRouteError: vi.fn((error: { status?: number; code?: string; message?: string }) => NextResponse.json({
    error: { code: error.code, message: error.message },
  }, { status: error.status ?? 500 })),
  resolveActor: vi.fn(),
}));

class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  createFinanceReportImportUpload: createUpload,
  FINANCE_REPORT_IMPORT_MAX_FILE_BYTES: 25 * 1024 * 1024,
}));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: resolveActor }));
vi.mock("@/lib/demo-guard", () => ({ checkApiDemoGuard: demoGuard }));
vi.mock("@/lib/http", () => ({ handleRouteError }));

const actor = { kind: "user", user: { id: "user-1" } };
const batch = {
  id: "batch-1",
  stage: "UPLOADED",
  safeErrorCode: null,
  safeErrorMessage: null,
  fileHash: "private-hash",
  originalFilename: "Board report.csv",
};

function context() {
  return { params: Promise.resolve({ workspaceId: "workspace-1" }) };
}

function request(formData: FormData) {
  return new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports", {
    method: "POST",
    body: formData,
  });
}

describe("POST /api/workspaces/[workspaceId]/finance/imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActor.mockResolvedValue(actor);
    demoGuard.mockResolvedValue(undefined);
    createUpload.mockResolvedValue({ batch, reused: false });
  });

  it("stores one supported file and returns only sanitized batch status", async () => {
    const formData = new FormData();
    formData.set("file", new File(["Account,Amount"], "Board report.csv", { type: "text/csv" }));
    const { POST } = await import("./route");
    const response = await POST(request(formData), context());

    expect(response.status).toBe(201);
    expect(demoGuard).toHaveBeenCalledWith("workspace-1");
    expect(createUpload).toHaveBeenCalledWith(actor, {
      workspaceId: "workspace-1",
      fileBuffer: expect.any(Buffer),
      fileName: "Board report.csv",
      mimeType: "text/csv",
    });
    expect(createUpload.mock.calls[0][1].fileBuffer.toString("utf8")).toBe("Account,Amount");
    expect(await response.json()).toEqual({
      batch: { id: "batch-1", stage: "UPLOADED", safeErrorCode: null, safeErrorMessage: null },
      reused: false,
    });
  });

  it("returns 200 for an exact reused batch without exposing file identity", async () => {
    createUpload.mockResolvedValueOnce({ batch, reused: true });
    const formData = new FormData();
    formData.set("file", new File(["Account,Amount"], "report.csv", { type: "text/csv" }));
    const { POST } = await import("./route");
    const response = await POST(request(formData), context());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("private-hash");
    expect(JSON.stringify(body)).not.toContain("Board report");
  });

  it("rejects invalid multipart input before domain persistence", async () => {
    const { POST } = await import("./route");
    const noFile = new FormData();
    expect((await POST(request(noFile), context())).status).toBe(400);

    const duplicate = new FormData();
    duplicate.append("file", new File(["a"], "a.csv", { type: "text/csv" }));
    duplicate.append("file", new File(["b"], "b.csv", { type: "text/csv" }));
    expect((await POST(request(duplicate), context())).status).toBe(400);

    const json = new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await POST(json, context())).status).toBe(400);
    expect(createUpload).not.toHaveBeenCalled();
  });

  it("accepts case-insensitive multipart media types and maps malformed bodies to 400", async () => {
    const { POST } = await import("./route");
    const formData = new FormData();
    formData.set("file", new File(["Account,Amount"], "report.csv", { type: "text/csv" }));
    const mixedCase = request(formData);
    mixedCase.headers.set(
      "content-type",
      mixedCase.headers.get("content-type")!.replace("multipart/form-data", "Multipart/Form-Data"),
    );
    expect((await POST(mixedCase, context())).status).toBe(201);

    const malformed = new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "truncated",
    });
    expect((await POST(malformed, context())).status).toBe(400);
  });

  it("authenticates before parsing private report bytes", async () => {
    resolveActor.mockRejectedValueOnce(new MockAppError(401, "UNAUTHORIZED", "Sign in required."));
    const formData = vi.fn();
    const guardedRequest = {
      headers: new Headers({ "content-type": "multipart/form-data; boundary=test" }),
      formData,
    } as unknown as NextRequest;
    const { POST } = await import("./route");
    const response = await POST(guardedRequest, context());
    expect(response.status).toBe(401);
    expect(formData).not.toHaveBeenCalled();
    expect(demoGuard).not.toHaveBeenCalled();
    expect(createUpload).not.toHaveBeenCalled();
  });

  it("bounds the multipart request and rejects an oversized File before reading its bytes", async () => {
    const oversized = new File([new Uint8Array((25 * 1024 * 1024) + 1)], "report.csv", { type: "text/csv" });
    const arrayBuffer = vi.spyOn(File.prototype, "arrayBuffer");
    const formData = new FormData();
    formData.set("file", oversized);
    const { POST } = await import("./route");
    expect((await POST(request(formData), context())).status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const boundary = "bounded-proof";
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    );
    let chunks = 0;
    const bounded = new NextRequest("http://localhost/api/workspaces/workspace-1/finance/imports", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(chunks++ === 0 ? prefix : new Uint8Array(1024 * 1024));
        },
      }),
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);
    expect((await POST(bounded, context())).status).toBe(413);
    expect(createUpload).not.toHaveBeenCalled();
  });
});
