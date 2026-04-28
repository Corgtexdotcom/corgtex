import { type NextRequest, NextResponse } from "next/server";
import { suspendHostedInstance } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { instanceId } = await props.params;
    const instance = await suspendHostedInstance(actor, instanceId);
    return NextResponse.json({ instance });
  } catch (error) {
    return handleRouteError(error);
  }
}
