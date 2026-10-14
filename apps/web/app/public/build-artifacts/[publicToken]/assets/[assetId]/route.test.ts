import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("public build artifact asset route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(undefined);
    resolvePublicBuildArtifactAsset.mockResolvedValue({ signedUrl: null, file: { data: Buffer.from("synthetic proof") }, authorize });
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
    expect(authorize).toHaveBeenCalledTimes(2); // initial authorization and one final delivery fence
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
    resolvePublicBuildArtifactAsset.mockResolvedValue({ signedUrl: null, file: { data: Buffer.alloc(128 * 1024, 65) }, authorize });
    const response = await GET(new NextRequest("http://localhost/public/build-artifacts/token/assets/asset-1"),
      { params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }) });
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toHaveLength(64 * 1024);
    const admittedChecks = authorize.mock.calls.length;
    revoked = true;
    await expect(reader.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(authorize).toHaveBeenCalledTimes(admittedChecks + 1);
  });
});
