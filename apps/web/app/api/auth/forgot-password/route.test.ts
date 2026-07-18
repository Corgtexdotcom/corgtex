import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { rateLimitPasswordResetMock, requestPasswordResetMock, sendEmailMock } = vi.hoisted(() => ({
  rateLimitPasswordResetMock: vi.fn(),
  requestPasswordResetMock: vi.fn(),
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

vi.mock("@corgtex/domain", () => ({
  AppError: MockAppError,
  renderPasswordResetEmail: (params: { resetUrl: string }) => `reset html ${params.resetUrl}`,
  renderPasswordResetEmailText: (params: { resetUrl: string }) => `reset text ${params.resetUrl}`,
  requestPasswordReset: requestPasswordResetMock,
}));

vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return {
    ...actual,
    sendEmail: sendEmailMock,
  };
});

vi.mock("@/lib/rate-limit-middleware", () => ({
  rateLimitPasswordReset: rateLimitPasswordResetMock,
}));

function request(email = "User@Example.com") {
  return new NextRequest("http://localhost/api/auth/forgot-password", {
    body: JSON.stringify({ email }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("POST /api/auth/forgot-password", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
    rateLimitPasswordResetMock.mockResolvedValue(null);
    requestPasswordResetMock.mockResolvedValue(null);
    sendEmailMock.mockResolvedValue({ status: "SENT", providerMessageId: "email-1" });
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("logs no-account requests while returning the generic response", async () => {
    const { POST } = await import("./route");
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      emailDomain: "example.com",
      emailHash: expect.any(String),
      outcome: "no_account",
      source: "api_auth_forgot_password",
      userId: null,
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleInfoSpy.mock.calls)).not.toContain("user@example.com");
  });

  it("logs sent and skipped outcomes for matched accounts", async () => {
    requestPasswordResetMock.mockResolvedValue({
      token: "reset-token",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    });
    const { POST } = await import("./route");

    const sentResponse = await POST(request());

    expect(sentResponse.status).toBe(200);
    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      outcome: "email_sent",
      providerMessageId: "email-1",
      source: "api_auth_forgot_password",
      userId: "user-1",
    }));
    expect(JSON.stringify(consoleInfoSpy.mock.calls)).not.toContain("reset-token");

    consoleInfoSpy.mockClear();
    sendEmailMock.mockResolvedValueOnce({ status: "SKIPPED", reason: "RESEND_API_KEY missing" });

    const skippedResponse = await POST(request());

    expect(skippedResponse.status).toBe(200);
    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      outcome: "email_skipped",
      skipReason: "RESEND_API_KEY missing",
      source: "api_auth_forgot_password",
      userId: "user-1",
    }));
  });

  it("logs send failures without changing the generic response", async () => {
    requestPasswordResetMock.mockResolvedValue({
      token: "reset-token",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    });
    sendEmailMock.mockRejectedValueOnce(new Error("provider down"));
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      errorClass: "Error",
      outcome: "email_failed",
      source: "api_auth_forgot_password",
      userId: "user-1",
    }));
  });
});
