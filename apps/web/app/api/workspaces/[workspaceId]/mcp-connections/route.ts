import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getClaudeMcpConnectionStatus,
  markAiWorkspaceProviderConnected,
  requireWorkspaceMembership,
  verifyAiWorkspaceProviderConnection,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = {
  params: Promise<{ workspaceId: string }>;
};

const connectionActionSchema = z.object({
  action: z.enum(["verify", "mark_connected"]),
  providerKey: z.string().min(1),
});

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });

    const claude = actor.kind === "user"
      ? await getClaudeMcpConnectionStatus({ userId: actor.user.id, workspaceId })
      : { connected: false, connectedAt: null };

    return NextResponse.json(
      {
        claude: {
          connected: claude.connected,
          connectedAt: claude.connectedAt?.toISOString() ?? null,
        },
        signals: {
          claude: {
            connected: claude.connected,
            connectedAt: claude.connectedAt?.toISOString() ?? null,
            source: claude.connected ? "claude_oauth" : null,
          },
        },
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
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const parsed = await validateBody(request, connectionActionSchema);

    if (parsed.action === "mark_connected") {
      const state = await markAiWorkspaceProviderConnected(actor, {
        workspaceId,
        providerKey: parsed.providerKey,
        source: "manual",
      });
      return NextResponse.json({
        providerKey: parsed.providerKey,
        verified: true,
        connectedAt: new Date().toISOString(),
        message: "Connection marked as complete.",
        state,
      });
    }

    const result = await verifyAiWorkspaceProviderConnection(actor, {
      workspaceId,
      providerKey: parsed.providerKey,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
