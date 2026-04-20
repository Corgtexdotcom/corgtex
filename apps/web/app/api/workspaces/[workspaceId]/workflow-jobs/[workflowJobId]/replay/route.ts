import { NextRequest, NextResponse } from "next/server";
import { replayWorkflowJob } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; workflowJobId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, workflowJobId } = await params;
    const workflowJob = await replayWorkflowJob(actor, {
      workspaceId,
      workflowJobId,
    });
    return NextResponse.json({ workflowJob }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
