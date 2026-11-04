import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { actor, getAsset, authorize, disabled, supportContext, withOrigin } = vi.hoisted(() => ({ actor: { kind: "user", user: { id: "synthetic-user" } },
  getAsset: vi.fn(), authorize: vi.fn(), disabled: vi.fn(), supportContext: vi.fn(),
  withOrigin: vi.fn((_origin: unknown, fn: () => unknown) => fn()) }));
vi.mock("@corgtex/domain", () => ({ getBuildArtifactAssetSignedUrl: getAsset, AppError: class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("@corgtex/shared", () => ({ getSupportAuthorizationContext: supportContext, runWithSupportOrigin: withOrigin }));
vi.mock("@/lib/route-handler", () => ({ withWorkspaceRoute: (work: any) => (request: NextRequest) => work(request,
  { actor, workspaceId: "synthetic-workspace", params: { artifactId: "artifact", assetId: "asset" } }) }));
vi.mock("@/lib/workspace-feature-route", () => ({ disabledWorkspaceFeatureResponse: disabled }));
import { GET } from "./route";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function privateAsset(bytes: Buffer, mimeType?: string) {
  return { signedUrl: null, file: { data: bytes }, mimeType, authorize,
    byteBinding: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength } };
}

beforeEach(() => {
  vi.clearAllMocks(); disabled.mockResolvedValue(null); authorize.mockResolvedValue(undefined); supportContext.mockReturnValue(null);
  getAsset.mockResolvedValue(privateAsset(Buffer.from("synthetic bytes")));
});
describe("protected build asset delivery", () => {
  it("serves bytes with a live proof at every delivery and no redirect capability", async () => {
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), { params: Promise.resolve({}) } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("synthetic bytes");
    expect(authorize).toHaveBeenCalledTimes(2); // verified response and fresh delivery fences
    expect(getAsset).toHaveBeenCalledWith(actor, { workspaceId: "synthetic-workspace", artifactId: "artifact", assetId: "asset" });
  });
  it.each(["image/png", "image/jpeg", "image/webp"])("renders %s inline without bypassing delivery authorization", async (mimeType) => {
    const provider = getAsset;
    provider.mockResolvedValue(privateAsset(Buffer.from("synthetic image"), mimeType));
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), {
      params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }),
    } as never);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("synthetic image");
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it.each(["text/html", "image/svg+xml", "application/pdf"])("keeps executable or non-preview %s downloadable", async (mimeType) => {
    getAsset.mockResolvedValue(privateAsset(Buffer.from("synthetic upload"), mimeType));
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), {
      params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }),
    } as never);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(await response.text()).toBe("synthetic upload");
  });

  it.each([50, 64])("bounds allocations and delivery proofs for a %i MiB private asset", async (mib) => {
    const sizeBytes = mib * 1024 * 1024;
    const bytes = Buffer.alloc(sizeBytes, 65);
    getAsset.mockResolvedValue(privateAsset(bytes));
    const allocations: number[] = [];
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args) {
        const result = Reflect.construct(target, args) as Uint8Array;
        if (typeof args[0] === "number" || ArrayBuffer.isView(args[0])) allocations.push(result.byteLength);
        return result;
      },
    }));
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), { params: Promise.resolve({}) } as never);
    const reader = response.body!.getReader();
    let size = 0, deliveries = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(next.value[0]).toBe(65);
      size += next.value.byteLength; deliveries++;
    }
    expect(size).toBe(sizeBytes);
    const fullFileAllocations = allocations.filter(length => length >= sizeBytes);
    expect(fullFileAllocations).toEqual([]);
    expect(bytes.byteLength).toBe(0); // storage ownership was transferred, invalidating aliases
    expect(deliveries).toBe(Math.ceil(mib / 4));
    expect(authorize.mock.calls.length).toBe(deliveries + 1);
  });

  it("stops the next delivery immediately after current authorization is revoked", async () => {
    const { AppError } = await import("@corgtex/domain");
    let revoked = false;
    authorize.mockImplementation(async () => { if (revoked) throw new AppError(404, "NOT_FOUND", "Build artifact asset not found."); });
    getAsset.mockResolvedValue(privateAsset(Buffer.alloc(8 * 1024 * 1024 + 64 * 1024, 65)));
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), { params: Promise.resolve({}) } as never);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toHaveLength(4 * 1024 * 1024);
    const admittedChecks = authorize.mock.calls.length;
    revoked = true;
    await expect(reader.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(authorize).toHaveBeenCalledTimes(admittedChecks + 1);
  });

  it("retains support origin for verification and every delivery authorization", async () => {
    const origin = { kind: "synthetic-support-origin" };
    supportContext.mockReturnValue({ origin });
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), { params: Promise.resolve({}) } as never);
    expect(await response.text()).toBe("synthetic bytes");
    expect(withOrigin).toHaveBeenCalledTimes(2);
    for (const call of withOrigin.mock.calls) expect(call).toEqual([origin, authorize]);
  });

  it.each(["hash", "size"])("rejects a changed bound asset %s before returning a response", async (mismatch) => {
    const proof = privateAsset(Buffer.from("expected bytes"));
    getAsset.mockResolvedValue({ ...proof, file: { data: Buffer.from(mismatch === "hash" ? "tampered bytes" : "short") } });
    await expect(GET(new NextRequest("https://synthetic.example.test/assets"), { params: Promise.resolve({}) } as never))
      .rejects.toMatchObject({ code: "SOURCE_FILE_CHANGED" });
  });

});
