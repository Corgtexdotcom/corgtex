import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSelfServeWorkspaceMock } = vi.hoisted(() => ({
  createSelfServeWorkspaceMock: vi.fn(),
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
  createSelfServeWorkspace: createSelfServeWorkspaceMock,
}));

async function resetRateLimits() {
  const { resetAllRateLimits } = await import("@corgtex/shared");
  resetAllRateLimits();
}

function workspaceRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/procurement/v1/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-1",
      "x-forwarded-for": "203.0.113.10",
      ...headers,
    },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/procurement/v1/workspaces", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await resetRateLimits();
    createSelfServeWorkspaceMock.mockResolvedValue({
      workspace: { id: "ws-1" },
      setupSessionToken: "setup_token",
    });
  });

  afterEach(async () => {
    await resetRateLimits();
  });

  it("creates a self-serve workspace with an idempotency key", async () => {
    const { POST } = await import("./route");
    const response = await POST(workspaceRequest({
      companyName: "Acme",
      adminEmail: "admin@acme.test",
      billingContactEmail: "billing@acme.test",
      acceptedTermsVersion: "2026-04",
    }));

    expect(response.status).toBe(201);
    expect(createSelfServeWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "idem-1",
      input: expect.objectContaining({
        companyName: "Acme",
        adminEmail: "admin@acme.test",
      }),
      origin: "https://app.test",
    }));
  });

  it("validates accepted terms and invite caps before creating the workspace", async () => {
    const { POST } = await import("./route");
    const response = await POST(workspaceRequest({
      companyName: "Acme",
      adminEmail: "admin@acme.test",
      billingContactEmail: "billing@acme.test",
      employees: Array.from({ length: 51 }, (_, index) => ({ email: `person-${index}@acme.test` })),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(createSelfServeWorkspaceMock).not.toHaveBeenCalled();
  });

  it("rejects repeated setup attempts for the same admin email", async () => {
    const { POST } = await import("./route");
    const body = {
      companyName: "Acme",
      adminEmail: "admin@acme.test",
      billingContactEmail: "billing@acme.test",
      acceptedTermsVersion: "2026-04",
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await POST(workspaceRequest(body, {
        "idempotency-key": `idem-${attempt}`,
      }));
      expect(response.status).toBe(201);
    }

    const response = await POST(workspaceRequest(body, {
      "idempotency-key": "idem-4",
    }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });
});
