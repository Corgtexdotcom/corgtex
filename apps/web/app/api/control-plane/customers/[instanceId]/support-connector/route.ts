import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { configureSupportConnector } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const connectorSchema = z.object({
  supportBaseUrl: z.string().trim().min(1).nullable().optional(),
  supportMcpUrl: z.string().trim().min(1).nullable().optional(),
  supportCredential: z.string().trim().min(1).nullable().optional(),
  supportCredentialLabel: z.string().trim().min(1).nullable().optional(),
  supportNotes: z.string().trim().min(1).nullable().optional(),
});

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const body = await validateBody(request, connectorSchema);
    const customer = await configureSupportConnector(actor, {
      instanceId,
      ...body,
    });
    return NextResponse.json({ customer });
  } catch (error) {
    return handleRouteError(error);
  }
}
