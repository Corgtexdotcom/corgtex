"use server";

import { renderPasswordResetEmail, renderPasswordResetEmailText, requestPasswordReset } from "@corgtex/domain";
import { sendEmail } from "@corgtex/shared";
import type { ForgotPasswordState } from "./state";

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
        await sendEmail({
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
      } catch (emailError) {
        // Log but don't fail — the token was created, user just won't receive the email
        console.error("Failed to send password reset email:", emailError);
      }
    }

    // Always show success — prevents email enumeration
    return {
      email,
      error: null,
      success: true,
    };
  } catch (error) {
    console.error("Forgot password action failed:", error);
    return {
      email,
      error: "Something went wrong. Please try again.",
      success: false,
    };
  }
}
