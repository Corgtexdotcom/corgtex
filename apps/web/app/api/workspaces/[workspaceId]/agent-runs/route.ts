import { NextRequest, NextResponse } from "next/server";
import { AppError, listAgentRuns, parseManualAgentTrigger, triggerAgentRun } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const status = request.nextUrl.searchParams.get("status");
    const runs = await listAgentRuns(actor, workspaceId, {
      status: status ? status as "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED" : undefined,
    });
    return NextResponse.json({ runs });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError(400, "INVALID_INPUT", "Request body must be valid JSON.");
    }
    const job = await triggerAgentRun(actor, { workspaceId, ...parseManualAgentTrigger(body) });
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
