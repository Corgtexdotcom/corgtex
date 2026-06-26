import { beforeEach, describe, expect, it, vi } from "vitest";

const { emailsSendMock, emailDeliveryUpsertMock } = vi.hoisted(() => ({
  emailsSendMock: vi.fn(),
  emailDeliveryUpsertMock: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function Resend() {
    return {
      emails: {
        send: emailsSendMock,
      },
    };
  }),
}));

vi.mock("./db", () => ({
  prisma: {
    emailDelivery: {
      upsert: emailDeliveryUpsertMock,
    },
  },
}));

describe("sendEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "Corgtex <notifications@auth.corgtex.com>");
    vi.stubEnv("EMAIL_REPLY_TO", "support@corgtex.com");
    emailsSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
    emailDeliveryUpsertMock.mockResolvedValue({});
  });

  it("passes text alternatives to Resend", async () => {
    const { sendEmail } = await import("./email");

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Reset your Corgtex password",
      html: "<p>Reset</p>",
      text: "Reset your password",
    });

    expect(result).toEqual({ status: "SENT", providerMessageId: "email-1" });
    expect(emailsSendMock).toHaveBeenCalledWith(expect.objectContaining({
      html: "<p>Reset</p>",
      text: "Reset your password",
    }));
    expect(emailDeliveryUpsertMock).not.toHaveBeenCalled();
  });

  it("stores delivery metadata when tracking is provided", async () => {
    const { sendEmail } = await import("./email");

    await sendEmail({
      to: "Ada Lovelace <ADA@Example.com>",
      subject: "Reset your Corgtex password",
      html: "<p>Reset</p>",
      text: "Reset your password at https://app.example/reset-password/token",
      tracking: {
        emailType: "password_reset",
        userId: "user-1",
        metadata: {
          kind: "self-service",
          source: "api_auth_forgot_password",
        },
      },
    });

    expect(emailDeliveryUpsertMock).toHaveBeenCalledWith({
      where: { providerMessageId: "email-1" },
      update: expect.objectContaining({
        emailType: "password_reset",
        toEmail: "ada@example.com",
        toDomain: "example.com",
        subject: "Reset your Corgtex password",
        status: "SENT",
        userId: "user-1",
        workspaceId: null,
        metadata: {
          kind: "self-service",
          source: "api_auth_forgot_password",
        },
      }),
      create: expect.objectContaining({
        provider: "resend",
        providerMessageId: "email-1",
        emailType: "password_reset",
        toEmail: "ada@example.com",
        toDomain: "example.com",
        subject: "Reset your Corgtex password",
        status: "SENT",
        userId: "user-1",
        workspaceId: null,
        metadata: {
          kind: "self-service",
          source: "api_auth_forgot_password",
        },
      }),
    });
  });

  it("does not fail email sending when tracking storage fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emailDeliveryUpsertMock.mockRejectedValueOnce(new Error("database unavailable"));
    const { sendEmail } = await import("./email");

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Reset your Corgtex password",
      html: "<p>Reset</p>",
      tracking: {
        emailType: "password_reset",
      },
    });

    expect(result).toEqual({ status: "SENT", providerMessageId: "email-1" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[email] Failed to record email delivery metadata:",
      expect.any(Error),
    );
  });
});
