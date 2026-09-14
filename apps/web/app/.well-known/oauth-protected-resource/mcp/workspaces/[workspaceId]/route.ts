import { NextRequest, NextResponse } from "next/server";
import { MCP_CONNECTOR_DEFAULT_SCOPES } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import {
  isWorkspaceMcpId,
  workspaceMcpMetadataUrl,
  workspaceMcpOrigin,
  workspaceMcpResource,
} from "@corgtex/shared/workspace-mcp-resource";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await context.params;
  if (!isWorkspaceMcpId(workspaceId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  let origin: string;
  try {
    origin = workspaceMcpOrigin({
      mcpPublicUrl: env.MCP_PUBLIC_URL,
      appUrl: env.APP_URL,
      allowLocalHttp: process.env.NODE_ENV !== "production",
    });
  } catch {
    return NextResponse.json({ error: "MCP discovery unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
  const url = new URL(request.url);
  if (url.search || url.hash ||
      url.pathname !== new URL(workspaceMcpMetadataUrl(origin, workspaceId)).pathname) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Deliberately no workspace lookup: discovery is not existence or access proof.
  return NextResponse.json({
    resource: workspaceMcpResource(origin, workspaceId),
    resource_name: "Corgtex",
    resource_documentation: `${origin}/install`,
    resource_policy_uri: `${origin}/install`,
    authorization_servers: [origin],
    scopes_supported: MCP_CONNECTOR_DEFAULT_SCOPES,
    bearer_methods_supported: ["header"],
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}
