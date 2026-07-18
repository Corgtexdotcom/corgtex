import { sha256, type EmailSendResult } from "@corgtex/shared";

type PasswordResetSource = "forgot_password_action" | "api_auth_forgot_password";
type PasswordResetOutcome = "no_account" | "email_sent" | "email_skipped" | "email_failed" | "action_failed";

export type PasswordResetDiagnostic = {
  source: PasswordResetSource;
  outcome: PasswordResetOutcome;
  email: string;
  userId?: string | null;
  sendResult?: EmailSendResult | null;
  error?: unknown;
};

export function passwordResetEmailFingerprint(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const [, domain = ""] = normalizedEmail.split("@");

  return {
    emailDomain: domain,
    emailHash: normalizedEmail ? sha256(normalizedEmail).slice(0, 16) : null,
  };
}

export function logPasswordResetDiagnostic(params: PasswordResetDiagnostic) {
  const sendResult = params.sendResult ?? null;

  console.info("[auth] password_reset", {
    ...passwordResetEmailFingerprint(params.email),
    errorClass: errorClass(params.error),
    outcome: params.outcome,
    providerMessageId: sendResult?.status === "SENT" ? sendResult.providerMessageId : null,
    skipReason: sendResult?.status === "SKIPPED" ? sendResult.reason : null,
    source: params.source,
    userId: params.userId ?? null,
  });
}

function errorClass(error: unknown) {
  if (!error) return null;
  if (error instanceof Error) return error.name || "Error";
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return typeof error;
}
