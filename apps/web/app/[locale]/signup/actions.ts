"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { AppError, createProcurementTrial, requestPasswordResetForActiveMember } from "@corgtex/domain";
import { sendEmail } from "@corgtex/shared";
import { rateLimitProcurementTrialCreateForHeaders } from "@/lib/procurement-api";
import { getPublicOrigin } from "@/lib/public-origin";
import type { SignupErrorKey, SignupState } from "./state";

const ACCEPTED_TERMS_VERSION = "self-serve-signup-2026-05";

function stringField(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

type HeaderReader = Pick<Headers, "get">;

function publicOrigin(requestHeaders: HeaderReader) {
  const originHeaders = new Headers();
  for (const name of ["x-forwarded-host", "host", "x-forwarded-proto"]) {
    const value = requestHeaders.get(name);
    if (value) originHeaders.set(name, value);
  }

  return getPublicOrigin(new Request("https://app.corgtex.com/signup", {
    headers: originHeaders,
  }));
}

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
        Corgtex
      </p>
    </div>
  `;
}

function withError(previousState: SignupState, updates: Partial<SignupState>, errorKey: SignupErrorKey): SignupState {
  return {
    ...previousState,
    ...updates,
    errorKey,
    status: "idle",
  };
}

export async function signupAction(
  previousState: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const companyName = stringField(formData, "companyName");
  const adminName = stringField(formData, "adminName");
  const adminEmail = stringField(formData, "adminEmail").toLowerCase();
  const acceptedTerms = formData.get("acceptedTerms") === "on";
  const idempotencyKey = stringField(formData, "idempotencyKey") || previousState.idempotencyKey || randomUUID();
  const formState = {
    adminEmail,
    adminName,
    companyName,
    idempotencyKey,
  };

  if (!companyName) {
    return withError(previousState, formState, "companyRequired");
  }
  if (!adminEmail || !adminEmail.includes("@")) {
    return withError(previousState, formState, "emailRequired");
  }
  if (!acceptedTerms) {
    return withError(previousState, formState, "termsRequired");
  }

  try {
    const requestHeaders = await headers();
    const rateLimit = await rateLimitProcurementTrialCreateForHeaders(requestHeaders, {
      adminEmail,
      companyName,
    });
    if (rateLimit) {
      return withError(previousState, formState, "rateLimited");
    }
    const origin = publicOrigin(requestHeaders);

    const existingAccountReset = await requestPasswordResetForActiveMember(adminEmail);
    if (existingAccountReset) {
      const resetUrl = `${origin}/reset-password/${existingAccountReset.token}`;
      try {
        await sendEmail({
          to: existingAccountReset.user.email,
          subject: "Reset your Corgtex password",
          html: buildResetEmailHtml(resetUrl, existingAccountReset.user.displayName),
        });
      } catch (emailError) {
        console.error("Failed to send existing-account password reset email:", emailError);
      }

      return {
        ...formState,
        errorKey: null,
        status: "existingAccount",
      };
    }

    const result = await createProcurementTrial({
      idempotencyKey,
      input: {
        companyName,
        adminEmail,
        adminName: adminName || undefined,
        acceptedTermsVersion: ACCEPTED_TERMS_VERSION,
        sourceAgent: {
          kind: "app-signup",
          surface: "/signup",
        },
      },
      origin,
    });

    return {
      ...formState,
      errorKey: null,
      status: result.statusCode === 202 ? "review" : "active",
    };
  } catch (error) {
    if (error instanceof AppError && (error.code === "INVALID_INPUT" || error.code === "TERMS_REQUIRED")) {
      return withError(previousState, formState, "emailRequired");
    }
    console.error("Signup action failed.", error);
    return withError(previousState, formState, "unavailable");
  }
}
