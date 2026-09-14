const RESOURCE_PATH = "/mcp/workspaces/";
const METADATA_PATH = "/.well-known/oauth-protected-resource";

export function isWorkspaceMcpId(value: string): boolean {
  // Opaque, case-sensitive IDs, not names or UUID-only identifiers.
  return /^[A-Za-z0-9_~.-]+$/.test(value) && value !== "." && value !== "..";
}

/** Resolve only operator configuration, never request/forwarded headers. */
export function workspaceMcpOrigin(config: {
  mcpPublicUrl?: string;
  appUrl: string;
  allowLocalHttp?: boolean;
}): string {
  const value = config.mcpPublicUrl ?? config.appUrl;
  const url = new URL(value);
  const localHttp = config.allowLocalHttp === true && url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowedPaths = config.mcpPublicUrl === undefined
    ? ["", "/"] : ["", "/", "/mcp", "/mcp/", "/api/mcp", "/api/mcp/"];
  const suffix = value.slice(url.origin.length);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password ||
      url.search || url.hash || !value.startsWith(url.origin) || !allowedPaths.includes(suffix)) {
    throw new Error("Invalid canonical MCP origin configuration");
  }
  return url.origin;
}

export function workspaceMcpResource(origin: string, workspaceId: string): string {
  if (!isWorkspaceMcpId(workspaceId)) throw new Error("Invalid workspace MCP identifier");
  const canonicalOrigin = workspaceMcpOrigin({ appUrl: origin, allowLocalHttp: true });
  if (canonicalOrigin !== origin) throw new Error("Expected canonical MCP origin");
  return `${origin}${RESOURCE_PATH}${workspaceId}`;
}

export function workspaceMcpMetadataUrl(origin: string, workspaceId: string): string {
  const resource = workspaceMcpResource(origin, workspaceId);
  return `${origin}${METADATA_PATH}${resource.slice(origin.length)}`;
}

/** Exact wire identity: do not normalize an untrusted OAuth resource into a match. */
export function parseWorkspaceMcpResource(resource: string, origin: string): string | null {
  const prefix = `${origin}${RESOURCE_PATH}`;
  if (!resource.startsWith(prefix)) return null;
  const workspaceId = resource.slice(prefix.length);
  if (!isWorkspaceMcpId(workspaceId)) return null;
  return workspaceMcpResource(origin, workspaceId) === resource ? workspaceId : null;
}
