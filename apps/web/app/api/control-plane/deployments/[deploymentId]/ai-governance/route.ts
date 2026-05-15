import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  AppError,
  getControlPlaneAiGovernanceStatus,
  revokeControlPlaneAgentCredential,
  updateControlPlaneAgentCredentialScopes,
  updateControlPlaneAgentPolicy,
  updateControlPlaneModelBudget,
} from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

async function parseJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, "INVALID_INPUT", `${label} is required.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function requiredStringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be an array of strings.`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be a finite number.`);
  }
  return value;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
    const aiGovernance = await getControlPlaneAiGovernanceStatus(actor, deploymentId);
    return NextResponse.json({ aiGovernance });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
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
    const body = await parseJson(request);
    const operation = requiredString(body?.operation, "operation");
    const reason = requiredString(body?.reason, "reason");

    if (operation === "update_credential_scopes") {
      const result = await updateControlPlaneAgentCredentialScopes(actor, {
        deploymentId,
        credentialId: requiredString(body?.credentialId, "credentialId"),
        scopes: requiredStringArray(body?.scopes, "scopes"),
        reason,
      });
      return NextResponse.json({ result });
    }

    if (operation === "revoke_credential") {
      const result = await revokeControlPlaneAgentCredential(actor, {
        deploymentId,
        credentialId: requiredString(body?.credentialId, "credentialId"),
        reason,
      });
      return NextResponse.json({ result });
    }

    if (operation === "update_model_budget") {
      const result = await updateControlPlaneModelBudget(actor, {
        deploymentId,
        monthlyCostCapUsd: requiredNumber(body?.monthlyCostCapUsd, "monthlyCostCapUsd"),
        alertThresholdPct: optionalNumber(body?.alertThresholdPct),
        periodStartDay: optionalNumber(body?.periodStartDay),
        reason,
      });
      return NextResponse.json({ result });
    }

    if (operation === "update_agent_policy") {
      const result = await updateControlPlaneAgentPolicy(actor, {
        deploymentId,
        agentKey: requiredString(body?.agentKey, "agentKey"),
        governancePolicy: optionalString(body?.governancePolicy),
        modelOverride: optionalString(body?.modelOverride),
        reason,
      });
      return NextResponse.json({ result });
    }

    throw new AppError(400, "INVALID_INPUT", "Unsupported AI governance operation.");
  } catch (error) {
    return handleRouteError(error);
  }
}
