import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listAiWorkspaceToolProviders,
  listMcpOAuthConnectionStatuses,
  requireWorkspaceMembership,
  type McpOAuthProviderKey,
  verifyAiWorkspaceProviderConnection,
  listMcpWorkspaceConnections,
  revokeMcpWorkspaceConnection,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { checkApiDemoGuard } from "@/lib/demo-guard";

type Params = {
  params: Promise<{ workspaceId: string }>;
};

const connectionActionSchema = z.discriminatedUnion("action", [z.object({
  action: z.literal("verify"),
  providerKey: z.string().min(1),
}), z.object({ action: z.literal("revoke"), connectionId: z.string().min(1) })]);

type ConnectionResponse = {
  providerKey: string;
  connected: boolean;
  connectedAt: string | null;
  source: string | null;
  clientName?: string | null;
};

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });

    const providers = listAiWorkspaceToolProviders();
    const providerKeys = providers.map((provider) => provider.key);
    const oauthStatuses = actor.kind === "user"
      ? await listMcpOAuthConnectionStatuses({ userId: actor.user.id, workspaceId })
      : [];
    const statusByProvider = new Map(oauthStatuses.map((status) => [status.providerKey, status]));
    const connections: ConnectionResponse[] = providerKeys.map((providerKey) => {
      const status = statusByProvider.get(providerKey as McpOAuthProviderKey);
      return {
        providerKey,
        connected: Boolean(status?.connected),
        connectedAt: status?.connectedAt?.toISOString() ?? null,
        source: status?.connected ? `mcp_oauth:${providerKey}` : null,
        clientName: status?.clientName ?? null,
      };
    });
    const signals = Object.fromEntries(connections.map((connection) => [
      connection.providerKey,
      {
        connected: connection.connected,
        connectedAt: connection.connectedAt,
        source: connection.source,
      },
    ]));
    const claudeSignal = signals.claude ?? {
      connected: false,
      connectedAt: null,
      source: null,
    };
    const claude = {
      connected: claudeSignal.connected,
      connectedAt: claudeSignal.connectedAt,
    };

    return NextResponse.json(
      {
        claude,
        connections,
        signals,
        grants: actor.kind === "user" ? await listMcpWorkspaceConnections(actor, workspaceId) : [],
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    await checkApiDemoGuard(workspaceId);
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const parsed = await validateBody(request, connectionActionSchema);
    if (parsed.action === "revoke") return NextResponse.json(await revokeMcpWorkspaceConnection(actor, workspaceId, parsed.connectionId));

    const result = await verifyAiWorkspaceProviderConnection(actor, {
      workspaceId,
      providerKey: parsed.providerKey,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
