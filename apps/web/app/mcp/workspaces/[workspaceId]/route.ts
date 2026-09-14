import { NextRequest, NextResponse } from "next/server";
import { authenticateMcpRequest } from "@corgtex/mcp";
import { AppError, getWorkspaceMcpOrigin, MCP_CONNECTOR_DEFAULT_SCOPES } from "@corgtex/domain";
import { isWorkspaceMcpId, workspaceMcpResource, workspaceMcpMetadataUrl } from "@corgtex/shared/workspace-mcp-resource";
import { POST as handlePost, mcpAuthErrorResponse } from "@/lib/mcp-transport";
import { handleRouteError } from "@/lib/http";
import { withWorkspaceMcpCors, workspaceMcpPreflight } from "@/lib/workspace-mcp-cors";

type Context = { params: Promise<{ workspaceId: string }> };

async function scope(request: NextRequest, context: Context) {
  const { workspaceId } = await context.params;
  if (!isWorkspaceMcpId(workspaceId)) throw new AppError(404, "NOT_FOUND", "Not found.");
  const origin = getWorkspaceMcpOrigin();
  const resourceUrl = workspaceMcpResource(origin, workspaceId);
  const url = new URL(request.url);
  if (url.search || url.hash || url.pathname !== new URL(resourceUrl).pathname || request.headers.has("x-workspace-id")) {
    throw new AppError(400, "INVALID_INPUT", "Workspace identity must use the canonical endpoint only.");
  }
  return { workspaceId, resourceUrl, metadataUrl: workspaceMcpMetadataUrl(origin, workspaceId) };
}

export async function POST(request: NextRequest, context: Context) {
  return withWorkspaceMcpCors(request, async () => {
    try { return await handlePost(request, await scope(request, context)); }
    catch (error) { return handleRouteError(error); }
  });
}

async function authenticate(request: NextRequest, context: Context) {
  try {
    const scoped = await scope(request, context);
    try {
      await authenticateMcpRequest(request.headers.get("authorization"), scoped);
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        return mcpAuthErrorResponse(request, error, MCP_CONNECTOR_DEFAULT_SCOPES, scoped.metadataUrl);
      }
      throw error;
    }
    return new NextResponse(null, { status: request.method === "DELETE" ? 204 : 405, headers: { Allow: "POST, DELETE" } });
  } catch (error) { return handleRouteError(error); }
}

export const GET = (request: NextRequest, context: Context) => withWorkspaceMcpCors(request, () => authenticate(request, context));
export const DELETE = GET;
export const OPTIONS = (request: NextRequest) => workspaceMcpPreflight(request);
