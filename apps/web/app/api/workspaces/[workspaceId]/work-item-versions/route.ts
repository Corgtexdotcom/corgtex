import { NextRequest, NextResponse } from "next/server";
import { getWorkItemVersion, listWorkItemVersions } from "@corgtex/domain";
import { AppError } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    const versionParam = searchParams.get("version");
    if (!entityType || !entityId) {
      throw new AppError(400, "VALIDATION_ERROR", "entityType and entityId are required.");
    }

    if (versionParam) {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 1) {
        throw new AppError(400, "VALIDATION_ERROR", "version must be a positive integer.");
      }
      const result = await getWorkItemVersion(actor, {
        workspaceId,
        entityType,
        entityId,
        version,
      });
      return NextResponse.json(result);
    }

    const result = await listWorkItemVersions(actor, {
      workspaceId,
      entityType,
      entityId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
