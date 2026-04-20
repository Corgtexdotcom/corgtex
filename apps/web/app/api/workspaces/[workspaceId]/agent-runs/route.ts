import { NextRequest, NextResponse } from "next/server";
import { listAgentRuns, triggerAgentRun } from "@corgtex/domain";
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
    const body = (await request.json()) as {
      agentKey?: unknown;
      prompt?: unknown;
      meetingId?: unknown;
      proposalId?: unknown;
      spendId?: unknown;
    };
    const job = await triggerAgentRun(actor, {
      workspaceId,
      agentKey: String(body.agentKey ?? "") as "inbox-triage" | "meeting-summary" | "action-extraction" | "proposal-drafting" | "constitution-update-trigger" | "finance-reconciliation-prep",
      prompt: typeof body.prompt === "string" ? body.prompt : null,
      meetingId: typeof body.meetingId === "string" ? body.meetingId : null,
      proposalId: typeof body.proposalId === "string" ? body.proposalId : null,
      spendId: typeof body.spendId === "string" ? body.spendId : null,
    });
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
