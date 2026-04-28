import { beforeEach, describe, expect, it, vi } from "vitest";

const { bulkInviteMock } = vi.hoisted(() => ({
  bulkInviteMock: vi.fn(),
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
  bulkInviteSelfServeSetupMembers: bulkInviteMock,
}));

async function resetRateLimits() {
  const { resetAllRateLimits } = await import("@corgtex/shared");
  resetAllRateLimits();
}

function request(headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/procurement/v1/setup-sessions/setup-1/members/bulk-invite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-1",
      ...headers,
    },
    body: JSON.stringify({
      members: [{ email: "person@acme.test" }],
    }),
  }) as never;
}

describe("POST /api/procurement/v1/setup-sessions/[sessionId]/members/bulk-invite", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await resetRateLimits();
    bulkInviteMock.mockResolvedValue({ invited: [{ email: "person@acme.test" }] });
  });

  it("requires the setup session token", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(), { params: Promise.resolve({ sessionId: "setup-1" }) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
    expect(bulkInviteMock).not.toHaveBeenCalled();
  });

  it("passes the bearer setup token and idempotency key to the domain layer", async () => {
    const { POST } = await import("./route");
    const response = await POST(request({
      authorization: "Bearer setup_token",
    }), { params: Promise.resolve({ sessionId: "setup-1" }) });

    expect(response.status).toBe(200);
    expect(bulkInviteMock).toHaveBeenCalledWith({
      sessionId: "setup-1",
      token: "setup_token",
      idempotencyKey: "idem-1",
      members: [{ email: "person@acme.test" }],
    });
  });
});
