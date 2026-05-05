"use server";

import { AppError, isGlobalOperator, listActorWorkspaces, loginUserWithPassword } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { setSessionCookie } from "@/lib/auth";
import type { LoginActionState } from "./state";

function loginErrorState(email: string, error: string): LoginActionState {
  return {
    email,
    error,
    redirectTo: null,
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

  if (env.CONTROL_PLANE_MODE && isGlobalOperator(actor)) {
    await setSessionCookie(result.token, result.expiresAt);
    return {
      email,
      error: null,
      redirectTo: "/control-plane",
    };
  }

  let workspaces;
  try {
    workspaces = await listActorWorkspaces(actor);
  } catch (error) {
    console.error("Login workspace lookup failed.", error);
    return loginErrorState(email, "Login is temporarily unavailable. Try again.");
  }

  await setSessionCookie(result.token, result.expiresAt);
  return {
    email,
    error: null,
    redirectTo: workspaces[0] ? `/workspaces/${workspaces[0].id}` : "/workspaces/create",
  };
}
