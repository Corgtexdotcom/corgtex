import type { AppActor } from "@corgtex/shared";
import type { AgentScope } from "./agent-auth";
import { AppError } from "./errors";
import { MCP_TOOL_CAPABILITIES, getMcpToolCapability, type McpToolCapability } from "./mcp-tool-capabilities";

/** Transport-independent operation policy. REST and domain entry points refer to
 * the same operation keys as MCP rather than maintaining a second scope list. */
export const AGENT_OPERATION_CAPABILITIES = MCP_TOOL_CAPABILITIES;

export function getAgentOperationCapability(operation: string): McpToolCapability | null {
  return getMcpToolCapability(operation);
}

/** Membership establishes a workspace boundary; this establishes operation authority.
 * An absent scope set never grants a credential agent unrestricted authority. Human
 * role checks and the existing trusted bootstrap/control-plane policy remain with
 * their domain operations. */
export function requireAgentOperation(actor: AppActor, operation: string): void {
  if (actor.kind !== "agent" || actor.authProvider !== "credential") return;
  requireScopedOperation(operation, actor.scopes ?? []);
}

/** An authenticated transport's grant ceiling applies even when it represents a
 * human. It cannot replace the domain's membership and role checks. */
export function requireScopedOperation(operation: string, scopes: readonly string[]): void {
  const capability = getAgentOperationCapability(operation);
  if (!capability) {
    throw new AppError(403, "AGENT_OPERATION_UNDECLARED", "This operation is unavailable to agent credentials.");
  }
  for (const scope of capability.scopes) {
    if (!scopes.includes(scope)) {
      throw new AppError(403, "FORBIDDEN", "Agent credential is missing the required scope.");
    }
  }
}

export function scopedHasOperation(operation: string, scopes: readonly string[]): boolean {
  try {
    requireScopedOperation(operation, scopes);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

export function agentHasOperation(actor: AppActor, operation: string): boolean {
  try {
    requireAgentOperation(actor, operation);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

export function requiredAgentOperationScopes(operation: string): readonly AgentScope[] | null {
  return getAgentOperationCapability(operation)?.scopes ?? null;
}
