import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestPasswordResetMock, sendEmailMock } = vi.hoisted(() => ({
  requestPasswordResetMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@corgtex/domain", () => ({
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

function form(email = "User@Example.com") {
  const formData = new FormData();
  formData.set("email", email);
  return formData;
}

function initialState() {
  return {
    email: "",
    error: null,
    success: false,
  };
}

describe("forgotPasswordAction", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
    requestPasswordResetMock.mockResolvedValue(null);
    sendEmailMock.mockResolvedValue({ status: "SENT", providerMessageId: "email-1" });
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("logs no-account requests without exposing whether the account exists", async () => {
    const { forgotPasswordAction } = await import("./actions");

    await expect(forgotPasswordAction(initialState(), form())).resolves.toEqual({
      email: "user@example.com",
      error: null,
      success: true,
    });

    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      emailDomain: "example.com",
      emailHash: expect.any(String),
      outcome: "no_account",
      source: "forgot_password_action",
      userId: null,
    }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleInfoSpy.mock.calls)).not.toContain("user@example.com");
  });

  it("logs sent and skipped email outcomes for matched accounts", async () => {
    requestPasswordResetMock.mockResolvedValue({
      token: "reset-token",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    });
    const { forgotPasswordAction } = await import("./actions");

    await expect(forgotPasswordAction(initialState(), form())).resolves.toMatchObject({
      error: null,
      success: true,
    });

    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      outcome: "email_sent",
      providerMessageId: "email-1",
      source: "forgot_password_action",
      userId: "user-1",
    }));
    expect(JSON.stringify(consoleInfoSpy.mock.calls)).not.toContain("reset-token");

    consoleInfoSpy.mockClear();
    sendEmailMock.mockResolvedValueOnce({ status: "SKIPPED", reason: "RESEND_API_KEY missing" });

    await expect(forgotPasswordAction(initialState(), form())).resolves.toMatchObject({
      error: null,
      success: true,
    });

    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      outcome: "email_skipped",
      skipReason: "RESEND_API_KEY missing",
      source: "forgot_password_action",
      userId: "user-1",
    }));
  });

  it("logs send failures while keeping the public response generic", async () => {
    requestPasswordResetMock.mockResolvedValue({
      token: "reset-token",
      user: {
        id: "user-1",
        email: "user@example.com",
        displayName: "User",
      },
    });
    sendEmailMock.mockRejectedValueOnce(new Error("provider down"));
    const { forgotPasswordAction } = await import("./actions");

    await expect(forgotPasswordAction(initialState(), form())).resolves.toEqual({
      email: "user@example.com",
      error: null,
      success: true,
    });

    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      errorClass: "Error",
      outcome: "email_failed",
      source: "forgot_password_action",
      userId: "user-1",
    }));
  });

  it("logs action failures and returns the existing generic error state", async () => {
    requestPasswordResetMock.mockRejectedValueOnce(new Error("database down"));
    const { forgotPasswordAction } = await import("./actions");

    await expect(forgotPasswordAction(initialState(), form())).resolves.toEqual({
      email: "user@example.com",
      error: "Something went wrong. Please try again.",
      success: false,
    });

    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      errorClass: "Error",
      outcome: "action_failed",
      source: "forgot_password_action",
      userId: null,
    }));
  });
});
