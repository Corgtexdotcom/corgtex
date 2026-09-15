import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceMcpResource, getMcpCanonicalOrigin, MCP_CONNECTOR_DEFAULT_SCOPES } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    return NextResponse.json({ resource: getWorkspaceMcpResource(workspaceId), resource_name: `Corgtex workspace ${workspaceId}`,
      authorization_servers: [getMcpCanonicalOrigin()], scopes_supported: MCP_CONNECTOR_DEFAULT_SCOPES, bearer_methods_supported: ["header"] },
    { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) { return handleRouteError(error); }
}
