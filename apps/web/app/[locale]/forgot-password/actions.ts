"use server";

import { renderPasswordResetEmail, renderPasswordResetEmailText, requestPasswordReset } from "@corgtex/domain";
import { sendEmail } from "@corgtex/shared";
import { logPasswordResetDiagnostic } from "@/lib/password-reset-observability";
import type { ForgotPasswordState } from "./state";

const PASSWORD_RESET_SOURCE = "forgot_password_action";

export async function forgotPasswordAction(
  _previousState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  try {
    const result = await requestPasswordReset(email);

    if (result) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const resetUrl = `${appUrl}/reset-password/${result.token}`;

      try {
        const sendResult = await sendEmail({
          to: result.user.email,
          subject: "Reset your Corgtex password",
          html: renderPasswordResetEmail({
            resetUrl,
            displayName: result.user.displayName,
            kind: "self-service",
          }),
          text: renderPasswordResetEmailText({
            resetUrl,
            displayName: result.user.displayName,
            kind: "self-service",
          }),
          tracking: {
            emailType: "password_reset",
            userId: result.user.id,
            metadata: {
              kind: "self-service",
              source: "forgot_password_action",
            },
          },
        });
        logPasswordResetDiagnostic({
          email,
          outcome: sendResult.status === "SENT" ? "email_sent" : "email_skipped",
          sendResult,
          source: PASSWORD_RESET_SOURCE,
          userId: result.user.id,
        });
      } catch (emailError) {
        logPasswordResetDiagnostic({
          email,
          error: emailError,
          outcome: "email_failed",
          source: PASSWORD_RESET_SOURCE,
          userId: result.user.id,
        });
      }
    } else {
      logPasswordResetDiagnostic({
        email,
        outcome: "no_account",
        source: PASSWORD_RESET_SOURCE,
      });
    }

    // Always show success — prevents email enumeration
    return {
      email,
      error: null,
      success: true,
    };
  } catch (error) {
    logPasswordResetDiagnostic({
      email,
      error,
      outcome: "action_failed",
      source: PASSWORD_RESET_SOURCE,
    });
    return {
      email,
      error: "Something went wrong. Please try again.",
      success: false,
    };
  }
}
