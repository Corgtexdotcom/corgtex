import { env } from "@corgtex/shared";
import { invariant } from "./errors";

export function getMcpCanonicalOrigin() {
  return new URL(env.MCP_PUBLIC_URL ?? env.APP_URL).origin;
}

export function getWorkspaceMcpResource(workspaceId: string) {
  invariant(/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId), 400, "INVALID_MCP_RESOURCE", "Invalid workspace identifier.");
  return `${getMcpCanonicalOrigin()}/mcp/workspaces/${workspaceId}`;
}

export function workspaceFromMcpResource(resource: string): string | null {
  let url: URL;
  try { url = new URL(resource); } catch { return null; }
  const match = /^\/mcp\/workspaces\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
  return match && resource === getWorkspaceMcpResource(match[1]) ? match[1] : null;
}

export function validateMcpConsentResource(resource: string, workspaceId?: string) {
  const bound = workspaceFromMcpResource(resource);
  const origin = getMcpCanonicalOrigin();
  invariant(bound ? !workspaceId || bound === workspaceId
    : resource === `${origin}/mcp` || resource === `${origin}/api/mcp`,
  400, "INVALID_MCP_RESOURCE", "The MCP resource must identify exactly the requested workspace on this deployment.");
  return bound;
}

export function getWorkspaceMcpMetadataUrl(workspaceId: string) {
  getWorkspaceMcpResource(workspaceId);
  return `${getMcpCanonicalOrigin()}/.well-known/oauth-protected-resource/mcp/workspaces/${workspaceId}`;
}
