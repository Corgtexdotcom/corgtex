import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handleRouteError } from "@/lib/http";
import { createCorgtexMcpServer, authenticateMcpRequest } from "@corgtex/mcp";
import { AppError, getMcpPublicUrl } from "@corgtex/domain";

function protectedResourceMetadataUrl(request: NextRequest) {
  return `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
}

function mcpAuthErrorResponse(request: NextRequest, error: AppError) {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    {
      status: error.status,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(request)}"`,
      },
    },
  );
}

/**
 * POST /api/mcp — JSON-RPC endpoint for MCP tool/resource calls.
 *
 * Clients send JSON-RPC requests (initialize, tools/call, resources/read, etc.)
 * and receive JSON-RPC responses, potentially as an SSE stream for
 * long-running operations.
 */
export async function POST(request: NextRequest) {
  let server;
  try {
    const authHeader = request.headers.get("authorization");
    const sessionCtx = await authenticateMcpRequest(authHeader, {
      resourceUrl: request.url,
    });
    server = createCorgtexMcpServer(sessionCtx);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session persistence
      enableJsonResponse: true, // return JSON instead of SSE for stateless mode
    });

    await server.connect(transport);

    const body = await request.json();

    // The SDK requires Accept to include both application/json and text/event-stream.
    // Some proxies (mcp-remote, curl) may not send both, so we patch the header.
    const accept = request.headers.get("accept") ?? "";
    const needsPatch = !accept.includes("text/event-stream") || !accept.includes("application/json");
    let req: Request = request;
    if (needsPatch) {
      const patchedHeaders = new Headers(request.headers);
      patchedHeaders.set("accept", "application/json, text/event-stream");
      req = new Request(request.url, {
        method: request.method,
        headers: patchedHeaders,
        body: JSON.stringify(body),
      });
    }

    const response = await transport.handleRequest(req, { parsedBody: body });
    
    await server.close();
    return response;
  } catch (error) {
    if (server) await server.close().catch(() => {});
    if (error instanceof AppError && error.status === 401) {
      return mcpAuthErrorResponse(request, error);
    }
    return handleRouteError(error);
  }
}

/**
 * GET /api/mcp — Server info endpoint.
 * Returns basic info about the MCP server for discovery.
 */
export async function GET(request: NextRequest) {
  try {
    const origin = new URL(request.url).origin;
    return NextResponse.json({
      name: "corgtex-mcp",
      version: "1.0.0",
      description: "Corgtex MCP Server — connect from ChatGPT, Claude, or Gemini to interact with your organization's governance platform.",
      url: getMcpPublicUrl(origin),
      authorization: {
        protectedResourceMetadataUrl: protectedResourceMetadataUrl(request),
      },
      capabilities: {
        tools: true,
        resources: true,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * DELETE /api/mcp — Session termination (stateless, no-op).
 */
export async function DELETE() {
  try {
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleRouteError(error);
  }
}
