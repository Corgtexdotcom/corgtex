"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { AppError, createProcurementTrial } from "@corgtex/domain";
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
      origin: publicOrigin(requestHeaders),
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
