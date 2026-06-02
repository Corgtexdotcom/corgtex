import { NextResponse } from "next/server";
import { z } from "zod";
import { submitExecutionResult } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const submitExecutionResultSchema = z.object({
  idempotencyKey: z.string().min(1),
  targetType: z.string().optional().nullable(),
  targetId: z.string().optional().nullable(),
  output: z.unknown().optional(),
  artifacts: z.unknown().optional(),
  errorMessage: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const body = await validateBody(request, submitExecutionResultSchema);
  const result = await submitExecutionResult(actor, {
    workspaceId,
    requestId: params.requestId,
    idempotencyKey: body.idempotencyKey,
    targetType: body.targetType,
    targetId: body.targetId,
    output: body.output,
    artifacts: body.artifacts,
    errorMessage: body.errorMessage,
  });
  return NextResponse.json({ result }, { status: 201 });
});
