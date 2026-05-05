import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AppError, configureControlPlaneMeetingRecorderIntegration, getControlPlaneIntegrationStatus } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

function requiredBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new AppError(400, "INVALID_INPUT", `${label} must be a boolean.`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(400, "INVALID_INPUT", `${label} must be a finite number.`);
  }
  return value;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, "INVALID_INPUT", `${label} is required.`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

async function parseJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const integrations = await getControlPlaneIntegrationStatus(actor, instanceId);
    return NextResponse.json({ integrations });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const body = await parseJson(request);
    if (body?.integrationKey !== "meeting_recorders") {
      throw new AppError(400, "INVALID_INPUT", "Only meeting recorder integration configuration is supported.");
    }
    const result = await configureControlPlaneMeetingRecorderIntegration(actor, {
      instanceId,
      entitlementEnabled: requiredBoolean(body.entitlementEnabled, "entitlementEnabled"),
      enabled: requiredBoolean(body.enabled, "enabled"),
      autoRecordEnabled: requiredBoolean(body.autoRecordEnabled, "autoRecordEnabled"),
      defaultProvider: requiredString(body.defaultProvider, "defaultProvider"),
      fallbackProvider: optionalString(body.fallbackProvider),
      monthlyMinuteCap: requiredNumber(body.monthlyMinuteCap, "monthlyMinuteCap"),
      botName: optionalString(body.botName),
      entryMessage: optionalString(body.entryMessage),
      reason: optionalString(body.reason),
    });
    return NextResponse.json({ integration: result });
  } catch (error) {
    return handleRouteError(error);
  }
}
