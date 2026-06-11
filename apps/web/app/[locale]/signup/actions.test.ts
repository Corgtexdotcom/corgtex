import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimitMock, createProcurementTrialMock, headersMock, requestPasswordResetForActiveMemberMock, sendEmailMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  createProcurementTrialMock: vi.fn(),
  headersMock: vi.fn(),
  requestPasswordResetForActiveMemberMock: vi.fn(),
  sendEmailMock: vi.fn(),
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

vi.mock("next/headers", () => ({
  headers: headersMock,
}));

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  createProcurementTrial: createProcurementTrialMock,
  renderPasswordResetEmail: (params: { resetUrl: string; kind?: string }) => `reset email ${params.kind ?? ""} ${params.resetUrl}`,
  requestPasswordResetForActiveMember: requestPasswordResetForActiveMemberMock,
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    checkRateLimit: checkRateLimitMock,
    sendEmail: sendEmailMock,
  };
});

function state() {
  return {
    adminEmail: "",
    adminName: "",
    companyName: "",
    errorKey: null,
    idempotencyKey: "idem-signup-1",
    status: "idle" as const,
  };
}

function form(overrides: Record<string, string | boolean> = {}) {
  const formData = new FormData();
  formData.set("companyName", String(overrides.companyName ?? "Acme Corp"));
  formData.set("adminName", String(overrides.adminName ?? "Ada Admin"));
  formData.set("adminEmail", String(overrides.adminEmail ?? "Admin@Acme.test"));
  formData.set("idempotencyKey", String(overrides.idempotencyKey ?? "idem-signup-1"));
  if (overrides.acceptedTerms !== false) {
    formData.set("acceptedTerms", "on");
  }
  return formData;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  requestPasswordResetForActiveMemberMock.mockResolvedValue(null);
  sendEmailMock.mockResolvedValue({ status: "SENT", providerMessageId: "email-1" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("signupAction", () => {
  it("creates a procurement trial without returning connector secrets to the client state", async () => {
    headersMock.mockResolvedValue(new Headers({
      host: "app.test",
      "x-forwarded-for": "203.0.113.8",
      "x-forwarded-proto": "https",
    }));
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAtMs: Date.now() + 60_000,
    });
    createProcurementTrialMock.mockResolvedValue({
      statusCode: 201,
      body: {
        connector: { token: "agentc-secret" },
        trialId: "trial-1",
      },
    });

    const { signupAction } = await import("./actions");
    const result = await signupAction(state(), form());

    expect(result).toEqual({
      adminEmail: "admin@acme.test",
      adminName: "Ada Admin",
      companyName: "Acme Corp",
      errorKey: null,
      idempotencyKey: "idem-signup-1",
      status: "active",
    });
    expect(JSON.stringify(result)).not.toContain("agentc-secret");
    expect(createProcurementTrialMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "idem-signup-1",
      input: expect.objectContaining({
        acceptedTermsVersion: "self-serve-signup-2026-05",
        adminEmail: "admin@acme.test",
        companyName: "Acme Corp",
        sourceAgent: expect.objectContaining({
          kind: "app-signup",
          surface: "/signup",
        }),
      }),
      origin: "https://app.test",
    }));
  });

  it("keeps review-gated trial requests on a safe confirmation state", async () => {
    headersMock.mockResolvedValue(new Headers({ host: "app.test" }));
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAtMs: Date.now() + 60_000,
    });
    createProcurementTrialMock.mockResolvedValue({
      statusCode: 202,
      body: { status: "REVIEW_REQUIRED" },
    });

    const { signupAction } = await import("./actions");
    await expect(signupAction(state(), form())).resolves.toMatchObject({
      errorKey: null,
      status: "review",
    });
  });

  it("sends a password reset and skips trial creation for an existing active member", async () => {
    headersMock.mockResolvedValue(new Headers({
      host: "app.test",
      "x-forwarded-proto": "https",
    }));
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAtMs: Date.now() + 60_000,
    });
    requestPasswordResetForActiveMemberMock.mockResolvedValueOnce({
      token: "reset-token",
      user: {
        email: "admin@acme.test",
        displayName: "Ada Admin",
      },
    });

    const { signupAction } = await import("./actions");
    const result = await signupAction(state(), form());

    expect(result).toEqual({
      adminEmail: "admin@acme.test",
      adminName: "Ada Admin",
      companyName: "Acme Corp",
      errorKey: null,
      idempotencyKey: "idem-signup-1",
      status: "existingAccount",
    });
    expect(createProcurementTrialMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
	      to: "admin@acme.test",
	      subject: "Reset your Corgtex password",
	      html: expect.stringContaining("existing-account https://app.test/reset-password/reset-token"),
	    }));
	  });

  it("normalizes proxy-chain forwarded headers before creating a trial origin", async () => {
    headersMock.mockResolvedValue(new Headers({
      host: "internal.proxy.test",
      "x-forwarded-for": "203.0.113.8",
      "x-forwarded-host": "app.corgtex.com, internal.proxy.test",
      "x-forwarded-proto": "https, http",
    }));
    checkRateLimitMock.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAtMs: Date.now() + 60_000,
    });
    createProcurementTrialMock.mockResolvedValue({
      statusCode: 201,
      body: { trialId: "trial-1" },
    });

    const { signupAction } = await import("./actions");
    await signupAction(state(), form());

    expect(createProcurementTrialMock).toHaveBeenCalledWith(expect.objectContaining({
      origin: "https://app.corgtex.com",
    }));
  });

  it("requires explicit terms acceptance before creating a trial", async () => {
    const { signupAction } = await import("./actions");

    await expect(signupAction(state(), form({ acceptedTerms: false }))).resolves.toMatchObject({
      errorKey: "termsRequired",
      status: "idle",
    });
    expect(createProcurementTrialMock).not.toHaveBeenCalled();
  });
});
