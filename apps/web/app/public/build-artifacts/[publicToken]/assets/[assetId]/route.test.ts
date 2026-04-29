import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolvePublicBuildArtifactAsset = vi.fn();

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
    resolvePublicBuildArtifactAsset.mockResolvedValue({ signedUrl: "https://signed.example/proof.png" });
  });

  it("redirects valid public proof links to signed storage URLs", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost/public/build-artifacts/token/assets/asset-1"),
      { params: Promise.resolve({ publicToken: "token", assetId: "asset-1" }) },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://signed.example/proof.png");
    expect(resolvePublicBuildArtifactAsset).toHaveBeenCalledWith({
      publicToken: "token",
      assetId: "asset-1",
    });
  });
});
