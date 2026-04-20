import { NextRequest, NextResponse } from "next/server";
import { listRuntimeJobs } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const take = Number.parseInt(request.nextUrl.searchParams.get("take") ?? "25", 10);
    const workflowJobs = await listRuntimeJobs(actor, workspaceId, { take });
    return NextResponse.json({ workflowJobs });
  } catch (error) {
    return handleRouteError(error);
  }
}
