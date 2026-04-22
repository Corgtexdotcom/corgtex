"use server";

import { redirect } from "next/navigation";
import { AppError, consumePasswordReset } from "@corgtex/domain";
import type { ResetPasswordState } from "./state";

export async function setupAccountAction(
  _previousState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  try {
    await consumePasswordReset({ token, newPassword: password });
  } catch (error) {
    if (error instanceof AppError) {
      return { error: error.message };
    }
    console.error("Setup account action failed:", error);
    return { error: "Something went wrong. Please try again." };
  }

  redirect("/login?message=account-ready");
}
