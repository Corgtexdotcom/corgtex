import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  brainSourceFindFirst,
  getSignedUrl,
  handleRouteError,
  resolveKnowledgeAccessDomains,
  resolveRequestActor,
  getWorkspaceSupportGrant,
  getSupportAuthorizationContext,
  runWithSupportOrigin,
  getStream,
} = vi.hoisted(() => ({
  getWorkspaceSupportGrant: vi.fn(), getSupportAuthorizationContext: vi.fn(), runWithSupportOrigin: vi.fn(), getStream: vi.fn(),
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
  getWorkspaceSupportGrant,
}));

vi.mock("@corgtex/shared", () => ({
  getSupportAuthorizationContext,
  runWithSupportOrigin,
  prisma: {
    brainSource: {
      findFirst: brainSourceFindFirst,
    },
  },
}));

vi.mock("@corgtex/storage", () => ({
  defaultStorage: {
    getSignedUrl,
    getStream,
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

function request(signal?: AbortSignal) {
  return new Request("http://localhost/api/workspaces/workspace-1/brain/sources/source-1/file", { signal }) as never;
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
    getWorkspaceSupportGrant.mockReset().mockResolvedValue(null);
    getSupportAuthorizationContext.mockReset().mockReturnValue(undefined);
    runWithSupportOrigin.mockReset().mockImplementation((_origin, run) => run());
    getStream.mockReset().mockImplementation(async () => ({ body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("fixture bytes")); c.close(); } }) }));
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

  it("uses this workspace's Full grant, not an account flag, to avoid issuing a bearer download URL", async () => {
    getSupportAuthorizationContext.mockReturnValue({ origin: { userId: "user-1", workspaceId: "workspace-1", version: 1 } });
    getWorkspaceSupportGrant.mockResolvedValue({ role: "FULL", isActive: true, version: 1 });
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(runWithSupportOrigin).toHaveBeenCalledWith({ userId: "user-1", workspaceId: "workspace-1", version: 1 }, expect.any(Function));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fixture bytes");
  });

  it("does not restrict an ordinary membership's downloads because of historical account metadata", async () => {
    resolveRequestActor.mockResolvedValue({ ...actor, user: { ...actor.user, isSupportAccount: true } });
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(302);
    expect(getSignedUrl).toHaveBeenCalledOnce();
    expect(getStream).not.toHaveBeenCalled();
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

  it("streams a generated 65 MiB source with bounded authorization checks and no signed URL", async () => {
    getSupportAuthorizationContext.mockReturnValue({ origin: { userId: "user-1", workspaceId: "workspace-1", version: 1 } });
    let produced = 0;
    getStream.mockResolvedValue({ body: new ReadableStream<Uint8Array>({ pull(c) {
      if (produced === 65 * 16) { c.close(); return; }
      produced++; c.enqueue(new Uint8Array(64 * 1024));
    } }, { highWaterMark: 0 }) });
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(produced).toBe(0);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("location")).toBeNull();
    let bytes = 0;
    const reader = response.body!.getReader();
    for (;;) { const r = await reader.read(); if (r.done) break; bytes += r.value.byteLength; }
    expect(bytes).toBe(65 * 1024 * 1024);
    expect(resolveKnowledgeAccessDomains.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect(resolveKnowledgeAccessDomains.mock.calls.length).toBeLessThan(30);
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(getStream).toHaveBeenCalledWith("sources/source-1/report.pdf", { signal: expect.any(AbortSignal) });
  });

  it("preserves the captured epoch when a revoke/regrant happens during source lookup", async () => {
    const origin = { userId: "user-1", workspaceId: "workspace-1", version: 1 };
    getSupportAuthorizationContext.mockReturnValue({ origin });
    const cancel = vi.fn();
    getStream.mockResolvedValue({ body: new ReadableStream({ cancel }) });
    getWorkspaceSupportGrant.mockResolvedValue({ role: "FULL", version: 3, isActive: true });
    runWithSupportOrigin.mockImplementation(async (captured, run) => {
      expect(captured).toEqual(origin);
      resolveKnowledgeAccessDomains.mockRejectedValueOnce(new MockAppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "Revoked."));
      return run();
    });
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(403); expect(cancel).toHaveBeenCalledOnce();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("revalidates the source workspace, storage key and current access domains before releasing bytes", async () => {
    getSupportAuthorizationContext.mockReturnValue({ origin: { userId: "user-1", workspaceId: "workspace-1", version: 1 } });
    const cancel = vi.fn();
    getStream.mockResolvedValue({ body: new ReadableStream({ cancel }) });
    brainSourceFindFirst.mockResolvedValueOnce({ fileStorageKey: "sources/source-1/report.pdf" }).mockResolvedValueOnce(null);
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(brainSourceFindFirst).toHaveBeenLastCalledWith({ where: { id: "source-1", workspaceId: "workspace-1", fileStorageKey: "sources/source-1/report.pdf", accessDomain: { in: ["WORKSPACE"] } }, select: { fileStorageKey: true } });
    expect(response.status).toBe(404); expect(cancel).toHaveBeenCalledOnce();
  });

  it("cannot upgrade a request without an already captured support epoch", async () => {
    getWorkspaceSupportGrant.mockResolvedValue({ role: "FULL", version: 3, isActive: true });
    const { GET } = await import("./route");
    expect((await GET(request(), context())).status).toBe(403);
    expect(getStream).not.toHaveBeenCalled(); expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("keeps a support-derived agent on the proxy with its exact workspace epoch", async () => {
    const origin = { userId: "support-1", workspaceId: "workspace-1", version: 1 };
    resolveRequestActor.mockResolvedValue({ kind: "agent", workspaceIds: ["workspace-1"], supportOrigin: origin });
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(await response.text()).toBe("fixture bytes");
    expect(runWithSupportOrigin).toHaveBeenCalledWith(origin, expect.any(Function)); expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects a mismatched workspace epoch without opening storage", async () => {
    getSupportAuthorizationContext.mockReturnValue({ origin: { userId: "user-1", workspaceId: "other", version: 1 } });
    const { GET } = await import("./route");
    expect((await GET(request(), context())).status).toBe(403);
    expect(getStream).not.toHaveBeenCalled(); expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("cancels the provider body on client abort after headers", async () => {
    getSupportAuthorizationContext.mockReturnValue({ origin: { userId: "user-1", workspaceId: "workspace-1", version: 1 } });
    const cancel = vi.fn();
    getStream.mockResolvedValue({ body: new ReadableStream({ cancel }) });
    const abort = new AbortController();
    const { GET } = await import("./route");
    const response = await GET(request(abort.signal), context());
    abort.abort();
    await expect(response.body!.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
