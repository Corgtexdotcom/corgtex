import { NextRequest, NextResponse } from "next/server";
import { authenticateMcpRequest } from "@corgtex/mcp";
import { beginAuthorizationContext } from "@corgtex/shared";
import { AppError, getWorkspaceMcpResource, getWorkspaceMcpMetadataUrl } from "@corgtex/domain";
import { POST as handlePost, assertCanonicalMcpEndpoint } from "@/lib/mcp-handler";
import { handleRouteError } from "@/lib/http";

type Context = { params: Promise<{ workspaceId: string }> };
export async function POST(request: NextRequest, { params }: Context) {
  return handlePost(request, (await params).workspaceId);
}
export async function GET(request: NextRequest, { params }: Context) {
  beginAuthorizationContext();
  const { workspaceId } = await params;
  try {
    assertCanonicalMcpEndpoint(request, workspaceId);
    await authenticateMcpRequest(request.headers.get("authorization"), { workspaceId, resourceUrl: getWorkspaceMcpResource(workspaceId) });
    return new NextResponse(null, { status: 405, headers: { Allow: "POST, DELETE" } });
  } catch (error) {
    if (error instanceof AppError && error.status === 401) return NextResponse.json({ error: "invalid_token" }, {
      status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${getWorkspaceMcpMetadataUrl(workspaceId)}"` },
    });
    return handleRouteError(error);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  const result = await GET(request, context);
  return result.status === 405 ? new NextResponse(null, { status: 204 }) : result;
}
