import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createControlPlaneCustomerMember,
  isDatabaseUnavailableError,
  listControlPlaneCustomerMembers,
  resolveControlPlaneRequestActor,
} = vi.hoisted(() => ({
  createControlPlaneCustomerMember: vi.fn(),
  isDatabaseUnavailableError: vi.fn(),
  listControlPlaneCustomerMembers: vi.fn(),
  resolveControlPlaneRequestActor: vi.fn(),
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

vi.mock("@/lib/auth", () => ({
  resolveControlPlaneRequestActor,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  createControlPlaneCustomerMember,
  listControlPlaneCustomerMembers,
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    get CONTROL_PLANE_MODE() {
      return process.env.CONTROL_PLANE_MODE === "true" || process.env.CONTROL_PLANE_MODE === "1";
    },
  },
  isDatabaseUnavailableError,
}));

function request(body: unknown) {
  return new Request("http://localhost/api/control-plane/deployments/inst-1/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("control-plane deployment members API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.clearAllMocks();
    resolveControlPlaneRequestActor.mockResolvedValue({ kind: "user", user: { id: "operator-1" } });
    isDatabaseUnavailableError.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires an explicit role when creating a customer member", async () => {
    const { POST } = await import("./route");

    const response = await POST(request({
      email: "new@example.com",
      reason: "Customer approved onboarding.",
    }) as never, { params: Promise.resolve({ deploymentId: "inst-1" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "role: Invalid option: expected one of \"CONTRIBUTOR\"|\"FACILITATOR\"|\"FINANCE_STEWARD\"|\"ADMIN\"",
      },
    });
    expect(createControlPlaneCustomerMember).not.toHaveBeenCalled();
  });
});
