import { NextRequest, NextResponse } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin, getPublicRequestUrl } from "@/lib/public-origin";
import { createCorgtexMcpServer, authenticateMcpRequest, McpInsufficientScopeError } from "@corgtex/mcp";
import { AppError, MCP_CONNECTOR_DEFAULT_SCOPES, MCP_TOOL_CAPABILITIES, getMcpPublicUrl } from "@corgtex/domain";

function protectedResourceMetadataUrl(request: NextRequest) {
  return `${getPublicOrigin(request)}/.well-known/oauth-protected-resource`;
}

function bearerChallenge(params: {
  error: "invalid_token" | "insufficient_scope";
  resourceMetadataUrl: string;
  scopes: string[];
}) {
  return [
    `Bearer error="${params.error}"`,
    `resource_metadata="${params.resourceMetadataUrl}"`,
    `scope="${[...new Set(params.scopes)].join(" ")}"`,
  ].join(", ");
}

function mcpAuthErrorResponse(request: NextRequest, error: AppError, challengeScopes: string[]) {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    {
      status: error.status,
      headers: {
        "WWW-Authenticate": bearerChallenge({
          error: error.status === 403 ? "insufficient_scope" : "invalid_token",
          resourceMetadataUrl: protectedResourceMetadataUrl(request),
          scopes: challengeScopes,
        }),
      },
    },
  );
}

function toolCallName(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const candidate = message as { method?: unknown; params?: { name?: unknown } };
  return candidate.method === "tools/call" && typeof candidate.params?.name === "string"
    ? candidate.params.name
    : null;
}

function oauthToolScopeError(sessionCtx: Awaited<ReturnType<typeof authenticateMcpRequest>>, body: unknown) {
  if (sessionCtx.authKind !== "oauth") return null;
  const grantedScopes = sessionCtx.scopes ?? [];
  const messages = Array.isArray(body) ? body : [body];

  for (const message of messages) {
    const name = toolCallName(message);
    if (!name || !Object.prototype.hasOwnProperty.call(MCP_TOOL_CAPABILITIES, name)) continue;
    const capability = MCP_TOOL_CAPABILITIES[name as keyof typeof MCP_TOOL_CAPABILITIES];
    const missingScope = capability.scopes.find((scope) => !grantedScopes.includes(scope));
    if (missingScope) {
      return new McpInsufficientScopeError({
        workspaceId: sessionCtx.workspaceId,
        requiredScope: missingScope,
        grantedScopes,
      });
    }
  }

  return null;
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
      resourceUrl: getPublicRequestUrl(request),
    });
    const body = await request.json();

    const missingScope = oauthToolScopeError(sessionCtx, body);
    if (missingScope) {
      throw missingScope;
    }

    server = createCorgtexMcpServer(sessionCtx);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session persistence
      enableJsonResponse: true, // return JSON instead of SSE for stateless mode
    });

    await server.connect(transport);

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
    if (error instanceof McpInsufficientScopeError) {
      return mcpAuthErrorResponse(request, error, [...error.grantedScopes, error.requiredScope]);
    }
    if (error instanceof AppError && error.status === 401) {
      return mcpAuthErrorResponse(request, error, MCP_CONNECTOR_DEFAULT_SCOPES);
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
    const origin = getPublicOrigin(request);
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
