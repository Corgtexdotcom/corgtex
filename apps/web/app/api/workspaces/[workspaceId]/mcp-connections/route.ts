import { NextRequest, NextResponse } from "next/server";
import { getClaudeMcpConnectionStatus, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = {
  params: Promise<{ workspaceId: string }>;
};

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
