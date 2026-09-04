import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { listControlPlaneSupportOperations, recordBreakGlassSupportNote, runCustomerSupportOperation } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const operationSchema = z.object({
  action: z.enum([
    "members.list",
    "members.invite",
    "members.deactivate",
    "integrations.list",
    "data_feeds.list",
    "data_feeds.sync",
    "tool_links.list",
    "tool_links.upsert",
    "tool_links.archive",
    "agents.list_runs",
    "runtime.list_jobs",
    "brain.source_recovery",
    "brain.reconcile_source",
    "runtime.list_failed_jobs",
    "runtime.retry_failed_job",
    "runtime.discard_failed_job",
    "documents.upload_text",
    "context_graph.import_map",
    "proposals.list",
    "proposals.get",
    "proposals.create",
    "proposals.update",
    "proposals.submit",
    "proposals.resolve",
    "proposals.return_to_draft",
    "proposals.reopen_resolved",
    "actions.list",
    "actions.create",
    "actions.update",
    "actions.complete",
    "actions.return_to_draft",
    "tensions.list",
    "tensions.create",
    "tensions.update",
    "tensions.return_to_draft",
    "meetings.list",
    "meetings.get",
    "meetings.upload",
    "newspaper.diagnostics",
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
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const operations = await listControlPlaneSupportOperations(actor, deploymentId);
    return NextResponse.json({ operations });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

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
