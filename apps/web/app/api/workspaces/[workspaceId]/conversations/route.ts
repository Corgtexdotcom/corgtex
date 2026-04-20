import { NextRequest, NextResponse } from "next/server";
import { listConversations, createConversation } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const result = await listConversations(actor, workspaceId);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      agentKey?: string;
      topic?: string;
    };
    const session = await createConversation(actor, {
      workspaceId,
      agentKey: body.agentKey,
      topic: body.topic,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
