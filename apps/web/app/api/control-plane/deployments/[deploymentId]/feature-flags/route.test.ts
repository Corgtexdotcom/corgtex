import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listControlPlaneFeatureFlags: vi.fn(),
  resolveControlPlaneRequestActor: vi.fn(),
  setControlPlaneFeatureFlag: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
  listControlPlaneFeatureFlags: mocks.listControlPlaneFeatureFlags,
  setControlPlaneFeatureFlag: mocks.setControlPlaneFeatureFlag,
}));
vi.mock("@/lib/auth", () => ({ resolveControlPlaneRequestActor: mocks.resolveControlPlaneRequestActor }));
vi.mock("@/lib/control-plane-guard", () => ({ requireControlPlaneDeploymentMode: () => null }));
vi.mock("@/lib/http", () => ({
  validateBody: async (request: Request, schema: { safeParse: (value: unknown) => any }) => {
    const parsed = schema.safeParse(await request.json());
    if (parsed.success) return parsed.data;
    throw Object.assign(new Error(parsed.error.issues.map((issue: { message: string }) => issue.message).join("; ")), { status: 400, code: "VALIDATION_ERROR" });
  },
  handleRouteError: (error: Error & { status?: number; code?: string }) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }),
}));

function request(body: unknown) {
  return new Request("http://localhost/api/control-plane/deployments/inst-1/feature-flags", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("control-plane deployment feature-flags API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveControlPlaneRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
  });

  it("forwards guarded Finance updates, rejects mixed modes, and preserves conflicts", async () => {
    const { PATCH } = await import("./route");
    const props = { params: Promise.resolve({ deploymentId: "inst-1" }) };
    const body = {
      flag: "FINANCE", reportImportsEnabled: true, expectedConfigIdentity: "a".repeat(64), reason: "Enable the approved pilot.",
    };
    mocks.setControlPlaneFeatureFlag.mockResolvedValueOnce({ status: "updated", configIdentity: "b".repeat(64) });

    expect((await PATCH(request(body) as never, props)).status).toBe(200);
    expect(mocks.setControlPlaneFeatureFlag).toHaveBeenCalledWith(expect.any(Object), { deploymentId: "inst-1", ...body });

    mocks.setControlPlaneFeatureFlag.mockRejectedValueOnce(Object.assign(new Error(`Current identity: ${"c".repeat(64)}.`), { status: 409, code: "FEATURE_CONFIG_CONFLICT" }));
    const conflict = await PATCH(request(body) as never, props);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "FEATURE_CONFIG_CONFLICT", message: expect.stringContaining("c".repeat(64)) } });

    const mixed = await PATCH(request({ ...body, enabled: true }) as never, props);
    expect(mixed.status).toBe(400);
    expect(mocks.setControlPlaneFeatureFlag).toHaveBeenCalledTimes(2);
  });
});
