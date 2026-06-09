import { NextRequest, NextResponse } from "next/server";
import { listGoogleDriveDocuments, selectGoogleDriveDocumentsForSync } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const result = await listGoogleDriveDocuments(actor, {
      workspaceId,
      query: request.nextUrl.searchParams.get("q"),
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await checkApiDemoGuard(workspaceId);
    const body = await request.json() as { documentIds?: unknown };
    const documentIds = Array.isArray(body.documentIds)
      ? body.documentIds.filter((id): id is string => typeof id === "string")
      : [];
    const result = await selectGoogleDriveDocumentsForSync(actor, {
      workspaceId,
      documentIds,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

