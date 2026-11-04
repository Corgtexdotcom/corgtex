import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { brainSourceContentFingerprint } from "../../../../../../../../../../packages/domain/src/brain-derivation";

const mocks = vi.hoisted(() => ({
  recovery: vi.fn(), source: vi.fn(), upload: vi.fn(), document: vi.fn(), signed: vi.fn(), stream: vi.fn(), error: vi.fn(),
  domains: vi.fn(), actor: vi.fn(), support: vi.fn(), supportContext: vi.fn(), runSupport: vi.fn(), capture: vi.fn(), readable: vi.fn(),
}));
class MockAppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
vi.mock("@corgtex/domain", () => ({ AppError: MockAppError, resolveKnowledgeAccessDomains: mocks.domains,
  getWorkspaceSupportGrant: mocks.support, legacyRecoveryFileBinding: mocks.recovery, captureArtifactInputProof: mocks.capture, isArtifactInputProofReadable: mocks.readable }));
vi.mock("@corgtex/shared", () => ({ getSupportAuthorizationContext: mocks.supportContext, runWithSupportOrigin: mocks.runSupport,
  prisma: { brainSource: { findFirst: mocks.source }, financeReportUploadInput: { findFirst: mocks.upload }, document: { findFirst: mocks.document } } }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: { getSignedUrl: mocks.signed, getStream: mocks.stream } }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: mocks.actor }));
vi.mock("@/lib/http", () => ({ handleRouteError: mocks.error }));
const GET = async (...args: Parameters<typeof import("./route").GET>) => (await import("./route")).GET(...args);

const actor = { kind: "user", user: { id: "user-1" } };
const bytes = new TextEncoder().encode("synthetic raw file bytes");
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
let source: any, allowed: boolean, known: boolean, supportVersion: number;
const nativeRows = new Map<string, any>();
const request = (signal?: AbortSignal) => new Request("http://localhost/api/workspaces/workspace-1/brain/sources/source-1/file", { signal }) as never;
const context = () => ({ params: Promise.resolve({ workspaceId: "workspace-1", sourceId: "source-1" }) });
function fixture(overrides: Record<string, unknown> = {}) {
  return { id: "source-1", workspaceId: "workspace-1", accessDomain: "WORKSPACE", sourceType: "FILE_UPLOAD", tier: 2,
    title: "Synthetic source", channel: "upload", content: "Normalized extracted fixture text", ingestionGuidanceMd: null,
    metadata: { fileContentHash: sha(bytes) }, authorMemberId: "member-1", fileStorageKey: "sources/source-1/report.pdf",
    fileName: "report.pdf", fileMimeType: "application/pdf", fileSizeBytes: bytes.byteLength, externalId: null,
    archivedAt: null, createdAt: new Date("2026-10-13T12:00:00Z"), ...overrides };
}
function body(data = bytes) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
}
const supportOrigin = { userId: "user-1", workspaceId: "workspace-1", version: 1 };

beforeEach(() => {
  vi.resetAllMocks(); nativeRows.clear(); source = fixture(); allowed = true; known = true; supportVersion = 1;
  mocks.actor.mockResolvedValue(actor); mocks.domains.mockResolvedValue(["WORKSPACE"]);
  mocks.support.mockResolvedValue(null); mocks.supportContext.mockReturnValue(undefined);
  mocks.runSupport.mockImplementation(async (origin, run) => {
    if (origin.version !== supportVersion) throw new MockAppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "Revoked.");
    return run();
  });
  mocks.source.mockImplementation(async () => source);
  mocks.recovery.mockResolvedValue(null); mocks.upload.mockResolvedValue(null); mocks.document.mockResolvedValue(null);
  mocks.stream.mockImplementation(async () => ({ body: body() }));
  mocks.capture.mockImplementation(async (_actor, _workspaceId, inputs) => {
    if (!known) throw new MockAppError(409, "UNKNOWN_LINEAGE", "Unproved source.");
    return inputs.map((input: any) => {
      nativeRows.set(`${input.kind}:${input.id}`, input.snapshot);
      return { kind: input.kind, id: input.id,
        fingerprint: input.kind === "BrainSource" ? brainSourceContentFingerprint(input.snapshot) : sha(new TextEncoder().encode(JSON.stringify(input.snapshot))) };
    });
  });
  mocks.readable.mockImplementation(async (_actor, _workspaceId, roots) => allowed && !source.archivedAt
    && roots.every((root: any) => root.kind === "BrainSource" ? root.fingerprint === brainSourceContentFingerprint(source)
      : root.fingerprint === sha(new TextEncoder().encode(JSON.stringify(nativeRows.get(`${root.kind}:${root.id}`))))));
  mocks.error.mockImplementation((error: unknown) => Response.json({ code: error instanceof MockAppError ? error.code : "INTERNAL_ERROR" },
    { status: error instanceof MockAppError ? error.status : 500 }));
});

describe("source byte-bound authorized proxy", () => {
  it("captures the full source and serves only verified bytes without signed URLs", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(new TextDecoder().decode(bytes));
    expect(mocks.source).toHaveBeenCalledWith({ where: { id: "source-1", workspaceId: "workspace-1", archivedAt: null, accessDomain: { in: ["WORKSPACE"] } } });
    expect(mocks.capture).toHaveBeenCalledWith(actor, "workspace-1", [{ kind: "BrainSource", id: "source-1", snapshot: expect.objectContaining({ metadata: { fileContentHash: sha(bytes) }, fileSizeBytes: bytes.length, content: "Normalized extracted fixture text" }) }]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("location")).toBeNull(); expect(mocks.signed).not.toHaveBeenCalled();
  });

  it("keeps ordinary membership downloads on the same protected proxy despite account metadata", async () => {
    mocks.actor.mockResolvedValue({ ...actor, user: { ...actor.user, isSupportAccount: true } });
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(await response.text()).toBe(new TextDecoder().decode(bytes));
    expect(mocks.signed).not.toHaveBeenCalled();
  });

  it("preserves the exact support epoch through verification and delivery", async () => {
    mocks.supportContext.mockReturnValue({ origin: supportOrigin }); mocks.support.mockResolvedValue({ role: "FULL", isActive: true, version: 1 });
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(await response.text()).toBe(new TextDecoder().decode(bytes));
    expect(mocks.runSupport).toHaveBeenCalledWith(supportOrigin, expect.any(Function));
    expect(mocks.signed).not.toHaveBeenCalled();
  });

  it.each([null, { fileStorageKey: null }])("returns not found for missing source/file before storage", async value => {
    mocks.source.mockResolvedValue(value);
    const response = await GET(request(), context());
    expect(response.status).toBe(404); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("does not query source or storage after membership/domain denial", async () => {
    mocks.domains.mockRejectedValue(new MockAppError(403, "NOT_A_MEMBER", "Departed."));
    const response = await GET(request(), context());
    expect(response.status).toBe(403); expect(mocks.source).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("withholds unknown lineage without opening storage or altering the original", async () => {
    known = false; const original = structuredClone(source);
    const response = await GET(request(), context());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "UNKNOWN_LINEAGE" });
    expect(mocks.stream).not.toHaveBeenCalled(); expect(source).toEqual(original);
  });

  it.each([{}, { contentHash: sha(bytes) }, { fileContentHash: "unproved" }])("withholds missing raw-byte hash and never treats extracted text hash as proof: %j", async metadata => {
    source.metadata = metadata;
    const response = await GET(request(), context());
    expect(response.status).toBe(404); expect(mocks.stream).not.toHaveBeenCalled(); expect(mocks.signed).not.toHaveBeenCalled();
  });

  it("rejects replaced bytes at the same authorized key before download headers or bytes", async () => {
    const cancel = vi.fn();
    mocks.stream.mockResolvedValue({ body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.length).fill(1)); }, cancel }) });
    const response = await GET(request(), context());
    expect(response.status).toBe(404); expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({ code: "SOURCE_FILE_CHANGED" }); expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([bytes.length - 1, bytes.length + 1])("rejects incorrect exact byte size %s before response headers", async size => {
    source.fileSizeBytes = size;
    const response = await GET(request(), context());
    expect(response.status).toBe(404); expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({ code: "SOURCE_FILE_CHANGED" });
  });

  it("enforces explicit 100 MiB bound before opening storage", async () => {
    source.fileSizeBytes = 100 * 1024 * 1024 + 1;
    const response = await GET(request(), context());
    expect(response.status).toBe(413); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("validates a 65 MiB file completely before headers and checks every client delivery", async () => {
    const block = new Uint8Array(64 * 1024); const hash = createHash("sha256");
    for (let count = 0; count < 65 * 16; count++) hash.update(block);
    source.fileSizeBytes = 65 * 1024 * 1024; source.metadata.fileContentHash = hash.digest("hex");
    let produced = 0;
    mocks.stream.mockResolvedValue({ body: new ReadableStream<Uint8Array>({ pull(controller) {
      if (produced === 65 * 16) { controller.close(); return; }
      produced++; controller.enqueue(block);
    } }, { highWaterMark: 0 }) });
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(produced).toBe(65 * 16);
    const callsBeforeDelivery = mocks.readable.mock.calls.length;
    const reader = response.body!.getReader(); let delivered = 0;
    for (;;) {
      const priorChecks = mocks.readable.mock.calls.length;
      const next = await reader.read(); if (next.done) break;
      expect(next.value.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(mocks.readable.mock.calls.length).toBe(priorChecks + 1);
      delivered += next.value.byteLength;
    }
    expect(delivered).toBe(65 * 1024 * 1024);
    expect(mocks.readable.mock.calls.length - callsBeforeDelivery).toBe(17); // one fresh full authorization per verified delivery, each at most 4 MiB
    expect(mocks.signed).not.toHaveBeenCalled();
  });

  it.each(["privacy", "archive", "fingerprint"])("withholds source %s revocation during provider verification before headers", async change => {
    const cancel = vi.fn();
    mocks.stream.mockResolvedValue({ body: new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(bytes);
      if (change === "privacy") allowed = false;
      if (change === "archive") source.archivedAt = new Date();
      if (change === "fingerprint") source.fileStorageKey = "replaced-key";
    }, cancel }, { highWaterMark: 0 }) });
    const response = await GET(request(), context());
    expect(response.status).toBe(404); expect(response.headers.get("content-disposition")).toBeNull(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects source membership revocation during verification", async () => {
    mocks.stream.mockImplementation(async () => { mocks.readable.mockRejectedValue(new MockAppError(403, "NOT_A_MEMBER", "Departed.")); return { body: body() }; });
    expect((await GET(request(), context())).status).toBe(403);
  });

  it("withholds resumed normal delivery after privacy revocation at the next verified delivery", async () => {
    const fileBytes = new Uint8Array(8 * 1024 * 1024); source.fileSizeBytes = fileBytes.length; source.metadata.fileContentHash = sha(fileBytes);
    mocks.stream.mockResolvedValue({ body: body(fileBytes) });
    const response = await GET(request(), context()); const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBe(4 * 1024 * 1024); allowed = false;
    await expect(reader.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("withholds support revoke/regrant after a paused delivery using the captured epoch", async () => {
    mocks.supportContext.mockReturnValue({ origin: supportOrigin });
    const fileBytes = new Uint8Array(8 * 1024 * 1024); source.fileSizeBytes = fileBytes.length; source.metadata.fileContentHash = sha(fileBytes);
    mocks.stream.mockResolvedValue({ body: body(fileBytes) });
    const response = await GET(request(), context()); const reader = response.body!.getReader();
    await reader.read(); supportVersion = 3;
    await expect(reader.read()).rejects.toMatchObject({ code: "SUPPORT_AUTHORIZATION_REVOKED" });
  });

  it("cannot upgrade missing or mismatched support epoch before opening storage", async () => {
    mocks.support.mockResolvedValue({ role: "FULL", isActive: true, version: 3 });
    expect((await GET(request(), context())).status).toBe(403); expect(mocks.stream).not.toHaveBeenCalled();
    mocks.supportContext.mockReturnValue({ origin: { ...supportOrigin, workspaceId: "other" } });
    expect((await GET(request(), context())).status).toBe(403);
  });

  it("accepts finance raw hash only from an exact proven native upload tuple", async () => {
    source = fixture({ accessDomain: "FINANCE", fileName: "report.pdf", metadata: { financeImportBatchId: "batch", fileHash: sha(bytes) } });
    mocks.domains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    const upload = { id: "upload", workspaceId: "workspace-1", batchId: "batch", brainSourceId: source.id, documentId: "document", storageKey: source.fileStorageKey,
      mimeType: source.fileMimeType, fileSizeBytes: source.fileSizeBytes, originalFilename: source.fileName, fileHash: sha(bytes) };
    const document = { id: "document", workspaceId: "workspace-1", accessDomain: "FINANCE", archivedAt: null, storageKey: source.fileStorageKey, mimeType: source.fileMimeType };
    mocks.upload.mockResolvedValue(upload); mocks.document.mockResolvedValue(document);
    const response = await GET(request(), context());
    expect(response.status).toBe(200); expect(await response.text()).toBe(new TextDecoder().decode(bytes));
    expect(mocks.capture).toHaveBeenCalledWith(actor, "workspace-1", [{ kind: "FinanceReportUploadInput", id: "upload", snapshot: upload }, { kind: "Document", id: "document", snapshot: document }]);
  });

  it("rechecks native finance upload tuple versions during file verification", async () => {
    source = fixture({ accessDomain: "FINANCE", metadata: { financeImportBatchId: "batch", fileHash: sha(bytes) } });
    mocks.domains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    const upload = { id: "upload", workspaceId: "workspace-1", batchId: "batch", brainSourceId: source.id, documentId: "document", storageKey: source.fileStorageKey,
      mimeType: source.fileMimeType, fileSizeBytes: source.fileSizeBytes, originalFilename: source.fileName, fileHash: sha(bytes) };
    const document = { id: "document", workspaceId: "workspace-1", accessDomain: "FINANCE", archivedAt: null, storageKey: source.fileStorageKey, mimeType: source.fileMimeType };
    mocks.upload.mockResolvedValue(upload); mocks.document.mockResolvedValue(document);
    const cancel = vi.fn();
    mocks.stream.mockResolvedValue({ body: new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes); upload.fileHash = "b".repeat(64); }, cancel }, { highWaterMark: 0 }) });
    const response = await GET(request(), context());
    expect(response.status).toBe(404); expect(response.headers.get("content-disposition")).toBeNull(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("withholds finance metadata hash without a matching native tuple", async () => {
    source = fixture({ accessDomain: "FINANCE", metadata: { fileHash: sha(bytes) } });
    mocks.upload.mockResolvedValue({ id: "wrong-upload", storageKey: "other", fileHash: sha(bytes) });
    expect((await GET(request(), context())).status).toBe(404); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("cancels a pending provider read on client abort before headers", async () => {
    const cancel = vi.fn(); mocks.stream.mockResolvedValue({ body: new ReadableStream({ cancel }, { highWaterMark: 0 }) });
    const abort = new AbortController(); const pending = GET(request(abort.signal), context());
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce());
    abort.abort(); const response = await pending;
    expect(response.status).not.toBe(200); expect(response.headers.get("content-disposition")).toBeNull(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels buffered delivery after headers without releasing more bytes", async () => {
    const abort = new AbortController(); const response = await GET(request(abort.signal), context());
    abort.abort(); await expect(response.body!.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sanitizes storage errors before they reach route error handling", async () => {
    mocks.stream.mockRejectedValue(new Error("https://storage.invalid/?secret=private"));
    const response = await GET(request(), context());
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ code: "DOWNLOAD_FAILED" });
    expect((mocks.error.mock.calls[0][0] as Error).message).toBe("File download failed.");
  });
});
