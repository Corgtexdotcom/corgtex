import { NextResponse } from "next/server";
import { z } from "zod";
import { createExecutionRequest, listExecutionRequests } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const writebackTargetSchema = z.object({
  type: z.string().min(1),
  id: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
}).optional().nullable();

const createExecutionRequestSchema = z.object({
  goal: z.string().min(1),
  provider: z.string().optional().nullable(),
  actor: z.unknown().optional(),
  context: z.unknown().optional(),
  allowedScopes: z.array(z.string()).optional().nullable(),
  policyConstraints: z.unknown().optional(),
  expectedOutput: z.unknown().optional(),
  approvalRule: z.string().optional().nullable(),
  writebackTarget: writebackTargetSchema,
  writebackTargetType: z.string().optional().nullable(),
  writebackTargetId: z.string().optional().nullable(),
  writebackTargetLabel: z.string().optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
});

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const status = request.nextUrl.searchParams.get("status");
  const takeParam = request.nextUrl.searchParams.get("take");
  const take = takeParam ? Number(takeParam) : undefined;
  const items = await listExecutionRequests(actor, {
    workspaceId,
    status,
    take: Number.isFinite(take) ? take : undefined,
  });
  return NextResponse.json({ items });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const body = await validateBody(request, createExecutionRequestSchema);
  const writebackTarget = body.writebackTarget ?? null;
  const executionRequest = await createExecutionRequest(actor, {
    workspaceId,
    goal: body.goal,
    provider: body.provider,
    actor: body.actor,
    context: body.context,
    allowedScopes: body.allowedScopes,
    policyConstraints: body.policyConstraints,
    expectedOutput: body.expectedOutput,
    approvalRule: body.approvalRule,
    writebackTargetType: body.writebackTargetType ?? writebackTarget?.type ?? null,
    writebackTargetId: body.writebackTargetId ?? writebackTarget?.id ?? null,
    writebackTargetLabel: body.writebackTargetLabel ?? writebackTarget?.label ?? null,
    idempotencyKey: body.idempotencyKey,
  });
  return NextResponse.json({ executionRequest }, { status: 201 });
});
