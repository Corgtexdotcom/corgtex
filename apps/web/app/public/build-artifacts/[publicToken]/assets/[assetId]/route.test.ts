import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolvePublicBuildArtifactAsset = vi.fn();
const authorize = vi.fn();

vi.mock("@corgtex/domain", () => ({
  resolvePublicBuildArtifactAsset,
  AppError: class AppError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function publicAsset(bytes: Buffer, mimeType?: string) {
  return { signedUrl: null, file: { data: bytes }, mimeType, authorize,
    byteBinding: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength } };
}

describe("public build artifact asset route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(undefined);
    resolvePublicBuildArtifactAsset.mockResolvedValue(publicAsset(Buffer.from("synthetic proof")));
  });

  it("serves proof bytes through the bearer route without exposing a storage URL", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/public/build-artifacts/token/assets/asset-1"),
      { params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("synthetic proof");
    expect(authorize).toHaveBeenCalledTimes(2); // verified response and fresh delivery fences
    expect(resolvePublicBuildArtifactAsset).toHaveBeenCalledWith({
      publicToken: "token",
      assetId: "asset-1",
    });
  });

  it("stops the next delivery immediately after bearer/source authorization is revoked", async () => {
    const { AppError } = await import("@corgtex/domain");
    const { GET } = await import("./route");
    let revoked = false;
    authorize.mockImplementation(async () => { if (revoked) throw new AppError(404, "NOT_FOUND", "Public proof link not found."); });
    resolvePublicBuildArtifactAsset.mockResolvedValue(publicAsset(Buffer.alloc(8 * 1024 * 1024 + 64 * 1024, 65)));
    const response = await GET(new NextRequest("http://localhost/public/build-artifacts/token/assets/asset-1"),
      { params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }) });
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toHaveLength(4 * 1024 * 1024);
    const admittedChecks = authorize.mock.calls.length;
    revoked = true;
    await expect(reader.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(authorize).toHaveBeenCalledTimes(admittedChecks + 1);
  });
  it.each(["image/png", "image/jpeg", "image/webp"])("renders %s inline without bypassing delivery authorization", async (mimeType) => {
    const provider = resolvePublicBuildArtifactAsset;
    provider.mockResolvedValue(publicAsset(Buffer.from("synthetic image"), mimeType));
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
    resolvePublicBuildArtifactAsset.mockResolvedValue(publicAsset(Buffer.from("synthetic upload"), mimeType));
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), {
      params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }),
    } as never);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(await response.text()).toBe("synthetic upload");
  });

  it.each([50, 64])("bounds allocations and delivery proofs for a %i MiB public asset", async (mib) => {
    const sizeBytes = mib * 1024 * 1024;
    const bytes = Buffer.alloc(sizeBytes, 65);
    resolvePublicBuildArtifactAsset.mockResolvedValue({ file: { data: bytes }, authorize,
      byteBinding: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength } });
    const { GET } = await import("./route");
    const allocations: number[] = [];
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args) {
        const result = Reflect.construct(target, args) as Uint8Array;
        if (typeof args[0] === "number" || ArrayBuffer.isView(args[0])) allocations.push(result.byteLength);
        return result;
      },
    }));
    const response = await GET(new NextRequest("http://localhost/public/build-artifacts/token/assets/asset-1"),
      { params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }) });
    let size = 0, deliveries = 0;
    const reader = response.body!.getReader();
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

  it("rejects a mismatched bound asset before returning any response", async () => {
    const proof = publicAsset(Buffer.from("expected bytes"));
    resolvePublicBuildArtifactAsset.mockResolvedValue({ ...proof, file: { data: Buffer.from("tampered bytes") } });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/public/build-artifacts/token/assets/asset-1"),
      { params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }) });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("tampered bytes");
  });

});
