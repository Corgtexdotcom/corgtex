import { NextRequest, NextResponse } from "next/server";
import { createCycle, listCycles, requireWorkspaceMembership } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
    const cycles = await listCycles(workspaceId, { archiveFilter: archiveFilter ?? undefined });
    return NextResponse.json({ cycles });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      name?: unknown;
      cadence?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      pointsPerUser?: unknown;
    };
    const cycle = await createCycle(actor, {
      workspaceId,
      name: String(body.name ?? ""),
      cadence: String(body.cadence ?? ""),
      startDate: new Date(String(body.startDate ?? "")),
      endDate: new Date(String(body.endDate ?? "")),
      pointsPerUser: Number.parseInt(String(body.pointsPerUser ?? "0"), 10),
    });
    return NextResponse.json({ cycle }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
