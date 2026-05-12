import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  AppError,
  configureControlPlaneMeetingRecorderIntegration,
  getControlPlaneIntegrationStatus,
  runControlPlaneMeetingRecorderOperation,
} from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

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

function parseTimezoneAwareJoinAt(value: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-]\d{2}:\d{2})$/);
  if (!match) {
    throw new AppError(400, "INVALID_INPUT", "joinAt must include an explicit timezone offset or Z.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || !timezoneAwareTimestampMatchesInput(parsed, match)) {
    throw new AppError(400, "INVALID_INPUT", "joinAt must be a valid timestamp.");
  }
  return parsed;
}

function timezoneAwareTimestampMatchesInput(parsed: Date, match: RegExpMatchArray) {
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = match;
  const offsetMinutes = zone.toUpperCase() === "Z"
    ? 0
    : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone.startsWith("-") ? -1 : 1);
  const local = new Date(parsed.getTime() + offsetMinutes * 60_000);
  return local.getUTCFullYear() === Number(year)
    && local.getUTCMonth() + 1 === Number(month)
    && local.getUTCDate() === Number(day)
    && local.getUTCHours() === Number(hour)
    && local.getUTCMinutes() === Number(minute)
    && local.getUTCSeconds() === Number(second)
    && local.getUTCMilliseconds() === Number(fraction.slice(0, 3).padEnd(3, "0"));
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
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const integrations = await getControlPlaneIntegrationStatus(actor, deploymentId);
    return NextResponse.json({ integrations });
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
    if (body?.integrationKey !== "meeting_recorders") {
      throw new AppError(400, "INVALID_INPUT", "Only meeting recorder integration configuration is supported.");
    }
    const result = await configureControlPlaneMeetingRecorderIntegration(actor, {
      deploymentId,
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
    const body = await parseJson(request);
    if (body?.integrationKey !== "meeting_recorders") {
      throw new AppError(400, "INVALID_INPUT", "Only meeting recorder integration operations are supported.");
    }
    const joinAt = optionalString(body.joinAt);
    const result = await runControlPlaneMeetingRecorderOperation(actor, {
      deploymentId,
      operation: requiredString(body.operation, "operation") as "enqueue_calendar_sync" | "dry_run_scan" | "live_smoke" | "enable_auto_recording_after_smoke",
      meetingUrl: optionalString(body.meetingUrl),
      joinAt: parseTimezoneAwareJoinAt(joinAt),
      provider: optionalString(body.provider),
      reason: optionalString(body.reason),
    });
    return NextResponse.json({ operation: result });
  } catch (error) {
    return handleRouteError(error);
  }
}
