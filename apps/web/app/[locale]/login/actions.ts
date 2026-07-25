"use server";

import { AppError, isGlobalOperator, listActorWorkspaces, loginUserWithPassword } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { setSessionCookie } from "@/lib/auth";
import { filterWorkspacesForDeploymentScope } from "@/lib/deployment-workspace-scope";
import type { LoginActionState } from "./state";

const LOGIN_ACTION_TIMEOUT_MS = 15_000;

function localizedRedirect(path: string, locale: string) {
  return locale === "es" ? `/es${path}` : path;
}

function loginErrorState(email: string, error: string): LoginActionState {
  return {
    email,
    error,
    redirectTo: null,
  };
}

function loginTimeoutError(label: string) {
  return new AppError(503, "LOGIN_TIMEOUT", `${label} timed out. Try again.`);
}

function withLoginTimeout<T>(operation: Promise<T>, label: string) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(loginTimeoutError(label));
    }, LOGIN_ACTION_TIMEOUT_MS);
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function messageForLoginError(error: unknown) {
  if (error instanceof AppError && (error.status === 400 || error.status === 401 || error.status === 503)) {
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
  const locale = String(formData.get("locale") ?? "").trim().toLowerCase() === "es" ? "es" : "en";

  let result;
  try {
    result = await withLoginTimeout(loginUserWithPassword({ email, password }), "Login");
  } catch (error) {
    return loginErrorState(email, messageForLoginError(error));
  }

  const actor = {
    kind: "user" as const,
    user: result.user,
  };

  if (env.CONTROL_PLANE_MODE && isGlobalOperator(actor)) {
    try {
      await withLoginTimeout(setSessionCookie(result.token, result.expiresAt), "Session setup");
    } catch (error) {
      return loginErrorState(email, messageForLoginError(error));
    }
    return {
      email,
      error: null,
      redirectTo: localizedRedirect("/control-plane", locale),
    };
  }

  let workspaces;
  try {
    workspaces = filterWorkspacesForDeploymentScope(
      await withLoginTimeout(listActorWorkspaces(actor), "Workspace lookup"),
    );
  } catch (error) {
    return loginErrorState(email, messageForLoginError(error));
  }

  try {
    await withLoginTimeout(setSessionCookie(result.token, result.expiresAt), "Session setup");
  } catch (error) {
    return loginErrorState(email, messageForLoginError(error));
  }
  return {
    email,
    error: null,
    redirectTo: localizedRedirect(
      workspaces.length > 1
        ? "/find-account"
        : workspaces[0]
          ? `/workspaces/${workspaces[0].id}`
          : "/workspaces/create",
      locale,
    ),
  };
}
