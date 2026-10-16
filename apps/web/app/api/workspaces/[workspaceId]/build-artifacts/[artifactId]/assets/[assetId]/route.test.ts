import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { actor, getAsset, authorize, disabled } = vi.hoisted(() => ({ actor: { kind: "user", user: { id: "synthetic-user" } },
  getAsset: vi.fn(), authorize: vi.fn(), disabled: vi.fn() }));
vi.mock("@corgtex/domain", () => ({ getBuildArtifactAssetSignedUrl: getAsset, AppError: class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("@corgtex/shared", () => ({ getSupportAuthorizationContext: () => null, runWithSupportOrigin: (_origin: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/route-handler", () => ({ withWorkspaceRoute: (work: any) => (request: NextRequest) => work(request,
  { actor, workspaceId: "synthetic-workspace", params: { artifactId: "artifact", assetId: "asset" } }) }));
vi.mock("@/lib/workspace-feature-route", () => ({ disabledWorkspaceFeatureResponse: disabled }));
import { GET } from "./route";
beforeEach(() => {
  vi.clearAllMocks(); disabled.mockResolvedValue(null); authorize.mockResolvedValue(undefined);
  getAsset.mockResolvedValue({ signedUrl: null, file: { data: Buffer.from("synthetic bytes") }, authorize });
});
describe("protected build asset delivery", () => {
  it("serves bytes with a live proof at every delivery and no redirect capability", async () => {
    const response = await GET(new NextRequest("https://synthetic.example.test/assets"), { params: Promise.resolve({}) } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("synthetic bytes");
    expect(authorize).toHaveBeenCalledTimes(2); // initial authorization and one final delivery fence
    expect(getAsset).toHaveBeenCalledWith(actor, { workspaceId: "synthetic-workspace", artifactId: "artifact", assetId: "asset" });
  });
});
