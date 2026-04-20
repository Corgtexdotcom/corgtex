"use server";

import { redirect } from "next/navigation";
import { AppError, listActorWorkspaces, loginUserWithPassword } from "@corgtex/domain";
import { setSessionCookie } from "@/lib/auth";
import type { LoginActionState } from "./state";

function loginErrorState(email: string, error: string): LoginActionState {
  return {
    email,
    error,
  };
}

function messageForLoginError(error: unknown) {
  if (error instanceof AppError && (error.status === 400 || error.status === 401)) {
    return error.message;
  }

  console.error("Login action failed.", error);
  return "Login is temporarily unavailable. Try again.";
}

export async function loginAction(
  _previousState: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  let result;
  try {
    result = await loginUserWithPassword({ email, password });
  } catch (error) {
    return loginErrorState(email, messageForLoginError(error));
  }

  const actor = {
    kind: "user" as const,
    user: result.user,
  };

  let workspaces;
  try {
    workspaces = await listActorWorkspaces(actor);
  } catch (error) {
    console.error("Login workspace lookup failed.", error);
    return loginErrorState(email, "Login is temporarily unavailable. Try again.");
  }

  await setSessionCookie(result.token, result.expiresAt);
  redirect(workspaces[0] ? `/workspaces/${workspaces[0].id}` : "/workspaces/create");
}
