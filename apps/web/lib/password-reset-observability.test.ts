import { describe, expect, it, vi } from "vitest";
import { logPasswordResetDiagnostic, passwordResetEmailFingerprint } from "./password-reset-observability";

describe("password reset observability", () => {
  it("redacts email addresses to domain and stable hash", () => {
    const fingerprint = passwordResetEmailFingerprint(" Ada@Example.COM ");

    expect(fingerprint).toEqual({
      emailDomain: "example.com",
      emailHash: expect.any(String),
    });
    expect(fingerprint.emailHash).toHaveLength(16);
    expect(JSON.stringify(fingerprint)).not.toContain("Ada@Example.COM");
    expect(JSON.stringify(fingerprint)).not.toContain("ada@example.com");
  });

  it("logs diagnostic metadata without raw email or reset tokens", () => {
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logPasswordResetDiagnostic({
      email: "user@example.com",
      outcome: "email_sent",
      sendResult: { status: "SENT", providerMessageId: "email-1" },
      source: "forgot_password_action",
      userId: "user-1",
    });

    expect(consoleInfoSpy).toHaveBeenCalledWith("[auth] password_reset", expect.objectContaining({
      emailDomain: "example.com",
      emailHash: expect.any(String),
      outcome: "email_sent",
      providerMessageId: "email-1",
      source: "forgot_password_action",
      userId: "user-1",
    }));
    const payload = JSON.stringify(consoleInfoSpy.mock.calls);
    expect(payload).not.toContain("user@example.com");
    expect(payload).not.toContain("reset-password");

    consoleInfoSpy.mockRestore();
  });
});
