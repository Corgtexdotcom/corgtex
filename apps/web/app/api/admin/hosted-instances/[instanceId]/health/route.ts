import { type NextRequest, NextResponse } from "next/server";
import { probeExternalInstanceHealth } from "@corgtex/domain";
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
    await probeExternalInstanceHealth(actor, instanceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
