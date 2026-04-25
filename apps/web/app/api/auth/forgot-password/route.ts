import { NextRequest, NextResponse } from "next/server";
import { requestPasswordReset } from "@corgtex/domain";
import { sendEmail } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { rateLimitPasswordReset } from "@/lib/rate-limit-middleware";

function buildResetEmailHtml(resetUrl: string, displayName: string | null) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #111; margin-bottom: 8px;">Reset your password</h2>
      <p style="color: #555; line-height: 1.6;">
        Hi${displayName ? ` ${displayName}` : ""},
      </p>
      <p style="color: #555; line-height: 1.6;">
        We received a request to reset your Corgtex password. Click the button below to choose a new password.
      </p>
      <div style="margin: 32px 0;">
        <a href="${resetUrl}"
          style="background-color: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 500;">
          Reset Password
        </a>
      </div>
      <p style="color: #888; font-size: 14px; line-height: 1.5;">
        This link expires in 15 minutes. If you didn't request a password reset, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
      <p style="color: #aaa; font-size: 12px;">
        Corgtex — Internal Governance Platform
      </p>
    </div>
  `;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { email?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();

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
          html: buildResetEmailHtml(resetUrl, result.user.displayName),
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
