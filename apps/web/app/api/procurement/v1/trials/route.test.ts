import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimitMock, createProcurementTrialMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  createProcurementTrialMock: vi.fn(),
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
  createProcurementTrial: createProcurementTrialMock,
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
  };
});


async function resetRateLimits() {
  const { resetAllRateLimits } = await import("@corgtex/shared");
  resetAllRateLimits();
}

function trialRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/procurement/v1/trials", {
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

describe("POST /api/procurement/v1/trials", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 10,
      resetAtMs: Date.now() + 60_000,
    });
    await resetRateLimits();
    createProcurementTrialMock.mockResolvedValue({
      statusCode: 201,
      body: {
        trialId: "trial-1",
        connector: { token: "agentc-secret" },
      },
    });
  });

  it("creates a procurement trial with an idempotency key", async () => {
    const { POST } = await import("./route");
    const response = await POST(trialRequest({
      companyName: "Acme",
      adminEmail: "admin@acme.test",
      acceptedTermsVersion: "2026-04",
    }));

    expect(response.status).toBe(201);
    expect(createProcurementTrialMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "idem-1",
      input: expect.objectContaining({
        companyName: "Acme",
        adminEmail: "admin@acme.test",
      }),
      origin: "https://app.test",
    }));
  });

  it("returns review-gated status without a connector token", async () => {
    createProcurementTrialMock.mockResolvedValueOnce({
      statusCode: 202,
      body: {
        trialId: "trial-review",
        status: "REVIEW_REQUIRED",
      },
    });
    const { POST } = await import("./route");
    const response = await POST(trialRequest({
      companyName: "Acme",
      adminEmail: "person@gmail.com",
      acceptedTermsVersion: "2026-04",
    }));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.connector).toBeUndefined();
  });

  it("requires Idempotency-Key", async () => {
    const { POST } = await import("./route");
    const response = await POST(trialRequest({
      companyName: "Acme",
      adminEmail: "admin@acme.test",
      acceptedTermsVersion: "2026-04",
    }, {
      "idempotency-key": "",
    }));

    expect(response.status).toBe(400);
    expect(createProcurementTrialMock).not.toHaveBeenCalled();
  });
});
