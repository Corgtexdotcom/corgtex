import { NextRequest, NextResponse } from "next/server";
import { listArticleVersions } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; slug: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, slug } = await params;
    const versions = await listArticleVersions(actor, { workspaceId, slug });
    return NextResponse.json({ versions });
  } catch (error) {
    return handleRouteError(error);
  }
}
