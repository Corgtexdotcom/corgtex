/** Internal credential material. Do not return or log this object. */
export type RecallWorkspaceBinding = {
  apiKey: string | null;
  webhookSecret: string | null;
  region: string;
  providerWorkspaceId: string | null;
  workspaceId?: string;
  source: "workspace" | "legacy";
};
export type RecallBindingEnvironment = {
  readonly RECALL_WORKSPACE_BINDINGS_JSON?: string;
  readonly RECALL_API_KEY?: string;
  readonly RECALL_WEBHOOK_SECRET?: string;
  readonly RECALL_REGION?: string;
};
export class RecallBindingError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string);
}
export function recallWorkspaceBindingsEnabledInEnv(env: RecallBindingEnvironment): boolean;
export function resolveRecallWorkspaceBinding(env: RecallBindingEnvironment, workspaceId?: string): RecallWorkspaceBinding | null;
export function requireRecallWorkspaceBindingFromEnv(env: RecallBindingEnvironment, workspaceId?: string): RecallWorkspaceBinding & { apiKey: string };
