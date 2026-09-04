import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  PR976_ACTION_PROVEN_BODY,
  PR976_GOAL_PROVEN_PROGRESS,
  getPr976ActionGoalValidationStatus,
  provisionPr976ActionGoalValidation,
  recordPr976ActionGoalFeatureProof,
  terminalizePr976ActionGoalValidation,
} from "@corgtex/domain";
// Production validation must exercise these exact web actions, not lower-level helpers.
// eslint-disable-next-line no-restricted-imports
import { editActionAction } from "@/app/[locale]/workspaces/[workspaceId]/actions/actions";
// eslint-disable-next-line no-restricted-imports
import { updateGoalFormAction } from "@/app/[locale]/workspaces/[workspaceId]/goals/actions";
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

const serverActionSchema = z.strictObject({
  operation: z.enum(["prove_action", "prove_action_stale", "prove_goal", "prove_goal_stale"]),
  operationKey,
  workflowRunId,
  workflowRunAttempt,
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
  serverActionSchema,
  featureProofSchema,
  terminalizeSchema,
]);

function formDataFrom(entries: Record<string, string | number>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    formData.set(key, String(value));
  }
  return formData;
}

function isNextRedirect(error: unknown) {
  return error instanceof Error
    && "digest" in error
    && typeof error.digest === "string"
    && error.digest.startsWith("NEXT_REDIRECT");
}

async function runFixedServerAction(actor: Awaited<ReturnType<typeof resolveRequestActor>>, body: z.infer<typeof serverActionSchema>) {
  const status = await getPr976ActionGoalValidationStatus(actor, body);
  const { receipt } = status;
  if (!receipt.actionId || !receipt.goalId || receipt.actionBaselineVersion === null || receipt.goalBaselineVersion === null) {
    return NextResponse.json({ error: { code: "NOT_PROVISIONED", message: "Production validation receipt has not been provisioned." } }, { status: 409 });
  }

  if (body.operation === "prove_action" || body.operation === "prove_action_stale") {
    const result = await editActionAction({ status: "idle" }, formDataFrom({
      workspaceId: receipt.workspaceId,
      actionId: receipt.actionId,
      bodyMd: body.operation === "prove_action" ? PR976_ACTION_PROVEN_BODY : `${PR976_ACTION_PROVEN_BODY}:forbidden-stale`,
      expectedVersion: receipt.actionBaselineVersion,
    }));
    if (result.status === "conflict") {
      return NextResponse.json({ status: "VERSION_CONFLICT" });
    }
    const after = await getPr976ActionGoalValidationStatus(actor, body);
    return NextResponse.json({ action: after.action });
  }

  try {
    await updateGoalFormAction(formDataFrom({
      workspaceId: receipt.workspaceId,
      goalId: receipt.goalId,
      progressPercent: body.operation === "prove_goal" ? PR976_GOAL_PROVEN_PROGRESS : 99,
      expectedVersion: receipt.goalBaselineVersion,
    }));
  } catch (error) {
    if (isNextRedirect(error)) {
      return NextResponse.json({ status: "VERSION_CONFLICT" });
    }
    throw error;
  }
  const after = await getPr976ActionGoalValidationStatus(actor, body);
  return NextResponse.json(after.goal);
}

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
    if (body.operation === "prove_action" || body.operation === "prove_action_stale" || body.operation === "prove_goal" || body.operation === "prove_goal_stale") {
      return runFixedServerAction(actor, body);
    }
    if (body.operation === "feature_proof") {
      return NextResponse.json(await recordPr976ActionGoalFeatureProof(actor, body));
    }
    return NextResponse.json(await terminalizePr976ActionGoalValidation(actor, body));
  } catch (error) {
    return handleRouteError(error);
  }
}
