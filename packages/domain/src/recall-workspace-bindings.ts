import { env } from "@corgtex/shared";
import {
  RecallBindingError,
  recallWorkspaceBindingsEnabledInEnv,
  requireRecallWorkspaceBindingFromEnv,
  resolveRecallWorkspaceBinding,
  type RecallWorkspaceBinding,
} from "../../shared/src/recall-workspace-bindings-core.mjs";
import { AppError } from "./errors";

export type { RecallWorkspaceBinding } from "../../shared/src/recall-workspace-bindings-core.mjs";

function asDomainError<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RecallBindingError) throw new AppError(error.status, error.code, error.message);
    throw error;
  }
}

export function recallWorkspaceBindingsEnabled(): boolean {
  return recallWorkspaceBindingsEnabledInEnv(env);
}

export function getRecallWorkspaceBinding(workspaceId?: string): RecallWorkspaceBinding | null {
  return asDomainError(() => resolveRecallWorkspaceBinding(env, workspaceId));
}

export function requireRecallWorkspaceBinding(workspaceId?: string): RecallWorkspaceBinding & { apiKey: string } {
  return asDomainError(() => requireRecallWorkspaceBindingFromEnv(env, workspaceId));
}
