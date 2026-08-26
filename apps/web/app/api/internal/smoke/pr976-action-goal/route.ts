import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getPr976ActionGoalValidationStatus,
  provisionPr976ActionGoalValidation,
  recordPr976ActionGoalFeatureProof,
  terminalizePr976ActionGoalValidation,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const operationKey = z.literal("pr976-action-goal-production-validation");
const workflowRunId = z.string().min(1).max(80);
const workflowRunAttempt = z.number().int().positive().max(100);

const provisionSchema = z.strictObject({
  operation: z.literal("provision"),
  operationKey,
  deployedSha: sha,
  ancestorSha: z.literal("086cec6d25f3457ce7b6858aa8c8f31ceb0cc771"),
  workflowRunId,
  workflowRunAttempt,
});

const statusSchema = z.strictObject({
  operation: z.literal("status"),
  operationKey,
  workflowRunId,
  workflowRunAttempt,
});

const featureProofSchema = z.strictObject({
  operation: z.literal("feature_proof"),
  operationKey,
  workflowRunId,
  workflowRunAttempt,
  actionObservedBodyMd: z.string().min(1).max(4_000),
  actionObservedVersion: z.number().int().positive(),
  goalObservedProgress: z.number().int().min(0).max(100),
  goalObservedVersion: z.number().int().positive(),
});

const terminalizeSchema = z.strictObject({
  operation: z.literal("terminalize"),
  operationKey,
  workflowRunId,
  workflowRunAttempt,
  mode: z.enum(["all", "action", "goal", "credential"]).optional(),
  failureCode: z.string().min(1).max(80).optional().nullable(),
  failureMessage: z.string().min(1).max(500).optional().nullable(),
});

const requestSchema = z.discriminatedUnion("operation", [
  provisionSchema,
  statusSchema,
  featureProofSchema,
  terminalizeSchema,
]);

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, requestSchema);
    if (body.operation === "provision") {
      return NextResponse.json(await provisionPr976ActionGoalValidation(actor, body));
    }
    if (body.operation === "status") {
      return NextResponse.json(await getPr976ActionGoalValidationStatus(actor, body));
    }
    if (body.operation === "feature_proof") {
      return NextResponse.json(await recordPr976ActionGoalFeatureProof(actor, body));
    }
    return NextResponse.json(await terminalizePr976ActionGoalValidation(actor, body));
  } catch (error) {
    return handleRouteError(error);
  }
}
