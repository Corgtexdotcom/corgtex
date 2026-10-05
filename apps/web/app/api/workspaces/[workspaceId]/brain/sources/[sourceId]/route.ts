import { NextRequest, NextResponse } from "next/server";
import { deleteSource } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; sourceId: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, sourceId } = await params;
    const result = await deleteSource(actor, { workspaceId, sourceId });
    if (result.status === "pending") return NextResponse.json({ ok: false, ...result,
      reviewUrl: `/workspaces/${workspaceId}/brain/sources?review=${encodeURIComponent(sourceId)}`,
    }, { status: 202 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}
