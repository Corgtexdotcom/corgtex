import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { renderPasswordResetEmail, renderPasswordResetEmailText, requestPasswordReset } from "@corgtex/domain";
import { sendEmail } from "@corgtex/shared";
import { handleRouteError, validateBody } from "@/lib/http";
import { rateLimitPasswordReset } from "@/lib/rate-limit-middleware";

const forgotPasswordSchema = z.object({
  email: z.string().trim().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, forgotPasswordSchema);
    const email = body.email.toLowerCase();

    // Rate limit before doing any work
    const rateLimited = await rateLimitPasswordReset(request, email);
    if (rateLimited) return rateLimited;

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
              source: "api_auth_forgot_password",
            },
          },
        });
      } catch (emailError) {
        console.error("Failed to send password reset email:", emailError);
      }
    }

    // Always return 200 — prevents email enumeration
    return NextResponse.json({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
