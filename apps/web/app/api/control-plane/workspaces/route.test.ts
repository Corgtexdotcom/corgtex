import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listControlPlaneWorkspaces, resolveControlPlaneRequestActor } = vi.hoisted(() => ({
  listControlPlaneWorkspaces: vi.fn(), resolveControlPlaneRequestActor: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ resolveControlPlaneRequestActor }));
vi.mock("@corgtex/domain", () => ({ listControlPlaneWorkspaces, AppError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("@corgtex/shared", () => ({
  env: { get CONTROL_PLANE_MODE() { return process.env.CONTROL_PLANE_MODE === "true"; } },
  isDatabaseUnavailableError: () => false,
}));
vi.mock("@corgtex/shared/telemetry", () => ({ captureErrorTelemetry: vi.fn() }));

describe("workspace directory API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    resolveControlPlaneRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
    listControlPlaneWorkspaces.mockResolvedValue({ rows: [], nextCursor: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not resolve an actor or read data outside Ops", async () => {
    vi.stubEnv("CONTROL_PLANE_MODE", "false");
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/control-plane/workspaces") as never);
    expect(response.status).toBe(404);
    expect(resolveControlPlaneRequestActor).not.toHaveBeenCalled();
    expect(listControlPlaneWorkspaces).not.toHaveBeenCalled();
  });

  it("passes bounded pagination inputs to the authorized domain query without caching", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/control-plane/workspaces?q=Example&cursor=abc&pageSize=10") as never);
    expect(response.status).toBe(200);
    expect(listControlPlaneWorkspaces).toHaveBeenCalledWith({ kind: "user", user: { id: "operator-1" } },
      { query: "Example", cursor: "abc", pageSize: 10, scope: "all" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("server-timing")).toMatch(/^workspace-directory;dur=\d+\.\d$/);
    await expect(response.json()).resolves.toEqual({ rows: [], nextCursor: null });
  });

  it("stops before querying when authentication fails", async () => {
    resolveControlPlaneRequestActor.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401, code: "UNAUTHORIZED" }));
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/control-plane/workspaces") as never);
    expect(response.status).toBe(401);
    expect(listControlPlaneWorkspaces).not.toHaveBeenCalled();
  });

  it("rejects unknown source filters before querying", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/control-plane/workspaces?scope=other") as never);
    expect(response.status).toBe(400);
    expect(listControlPlaneWorkspaces).not.toHaveBeenCalled();
  });

  it.each([400, 403])("preserves domain validation/access failures (%s)", async (status) => {
    listControlPlaneWorkspaces.mockRejectedValue(Object.assign(new Error("Rejected"), { status, code: "REJECTED" }));
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/control-plane/workspaces?pageSize=NaN") as never);
    expect(response.status).toBe(status);
  });
});
