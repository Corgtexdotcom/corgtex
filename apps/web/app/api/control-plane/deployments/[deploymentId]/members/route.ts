import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createControlPlaneCustomerMember, listControlPlaneCustomerMembers } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const createMemberSchema = z.object({
  email: z.string().trim().email(),
  displayName: z.string().trim().min(1).nullable().optional(),
  role: z.enum(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]).default("CONTRIBUTOR"),
  reason: z.string().trim().min(1),
}).strict();

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const members = await listControlPlaneCustomerMembers(actor, deploymentId);
    return NextResponse.json({ members });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const body = await validateBody(request, createMemberSchema);
    const member = await createControlPlaneCustomerMember(actor, {
      deploymentId,
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      reason: body.reason,
    });
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
