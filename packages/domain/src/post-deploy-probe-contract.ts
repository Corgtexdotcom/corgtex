import type { AgentScope } from "./agent-auth";
import { getMcpToolCapability, type McpToolName } from "./mcp-tool-capabilities";

type JsonRecord = Record<string, unknown>;

export type PostDeployCustomerReadProbe = {
  key: string;
  label: string;
  toolName: McpToolName;
  arguments: JsonRecord;
  blocksRelease: boolean;
};

export const POST_DEPLOY_CUSTOMER_READ_PROBES = [
  { key: "daily_overview", label: "Daily overview", toolName: "daily_overview", arguments: { windowHours: 72 }, blocksRelease: true },
  { key: "brain_context", label: "Brain context", toolName: "get_company_context", arguments: {}, blocksRelease: true },
  { key: "actions", label: "Actions", toolName: "list_actions", arguments: { take: 1 }, blocksRelease: true },
  { key: "tensions", label: "Tensions", toolName: "list_tensions", arguments: { take: 1 }, blocksRelease: true },
  { key: "meetings", label: "Meetings", toolName: "list_meetings", arguments: {}, blocksRelease: true },
  { key: "proposals", label: "Proposals", toolName: "list_proposals", arguments: { take: 1 }, blocksRelease: true },
] as const satisfies readonly PostDeployCustomerReadProbe[];

export function getRequiredScopesForPostDeployReadProbe(probe: PostDeployCustomerReadProbe): AgentScope[] {
  const capability = getMcpToolCapability(probe.toolName);
  if (!capability) {
    throw new Error(`Post-deploy probe ${probe.key} references MCP tool without capability metadata: ${probe.toolName}`);
  }
  return [...capability.scopes];
}

export function getRequiredScopesForPostDeployReadProbes(
  probes: readonly PostDeployCustomerReadProbe[] = POST_DEPLOY_CUSTOMER_READ_PROBES,
): AgentScope[] {
  const scopes = new Set<AgentScope>();
  for (const probe of probes) {
    if (!probe.blocksRelease) continue;
    for (const scope of getRequiredScopesForPostDeployReadProbe(probe)) {
      scopes.add(scope);
    }
  }
  return [...scopes];
}

export function getMissingPostDeployReadProbeScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly AgentScope[] = getRequiredScopesForPostDeployReadProbes(),
): AgentScope[] {
  const granted = new Set(grantedScopes);
  return requiredScopes.filter((scope) => !granted.has(scope));
}
