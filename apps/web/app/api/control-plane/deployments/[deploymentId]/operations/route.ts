import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getControlPlaneDeployment, recordBreakGlassSupportNote, runCustomerSupportOperation } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

const operationSchema = z.object({
  action: z.enum([
    "members.list",
    "members.invite",
    "members.deactivate",
    "integrations.list",
    "data_feeds.list",
    "data_feeds.sync",
    "agents.list_runs",
    "runtime.list_jobs",
    "runtime.list_failed_jobs",
    "runtime.retry_failed_job",
    "runtime.discard_failed_job",
    "documents.upload_text",
  ]),
  reason: z.string().trim().min(1).optional(),
  remoteWorkspaceId: z.string().trim().min(1).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).nullable().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const breakGlassSchema = z.object({
  action: z.literal("support.break_glass_note"),
  reason: z.string().trim().min(1),
  notes: z.string().trim().min(1),
});

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const deployment = await getControlPlaneDeployment(actor, deploymentId);
    return NextResponse.json({ operations: deployment.supportOperations });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const raw = await request.clone().json();
    const operation = raw?.action === "support.break_glass_note"
      ? await recordBreakGlassSupportNote(actor, { deploymentId, ...breakGlassSchema.parse(raw) })
      : await runCustomerSupportOperation(actor, { deploymentId, ...operationSchema.parse(raw) });
    return NextResponse.json({ operation }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
