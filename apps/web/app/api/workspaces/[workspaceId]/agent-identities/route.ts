import { NextRequest, NextResponse } from "next/server";
import type { AgentMemberType } from "@prisma/client";
import { AppError, createAgentIdentity, listAgentIdentities } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

function requiredString(value: unknown, field: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new AppError(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  return text;
}

function optionalString(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function optionalNonNegativeInteger(value: unknown, field: string) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new AppError(400, "VALIDATION_ERROR", `${field} must be a non-negative integer.`);
  }
  return numberValue;
}

function agentMemberType(value: unknown): AgentMemberType | undefined {
  if (value == null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (normalized === "AI_AGENT") return "INTERNAL";
  if (normalized === "INTERNAL" || normalized === "EXTERNAL") return normalized;
  throw new AppError(400, "VALIDATION_ERROR", "memberType must be INTERNAL or EXTERNAL.");
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const identities = await listAgentIdentities(actor, workspaceId);
    return NextResponse.json({ identities });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const identity = await createAgentIdentity(actor, {
      workspaceId,
      agentKey: requiredString(body.agentKey, "agentKey"),
      displayName: requiredString(body.displayName, "displayName"),
      memberType: agentMemberType(body.memberType),
      avatarUrl: optionalString(body.avatarUrl),
      purposeMd: optionalString(body.purposeMd),
      behaviorMd: optionalString(body.behaviorMd),
      linkedCredentialId: optionalString(body.linkedCredentialId),
      maxSpendPerRunCents: optionalNonNegativeInteger(body.maxSpendPerRunCents, "maxSpendPerRunCents"),
      maxRunsPerDay: optionalNonNegativeInteger(body.maxRunsPerDay, "maxRunsPerDay"),
      maxRunsPerHour: optionalNonNegativeInteger(body.maxRunsPerHour, "maxRunsPerHour"),
    });
    return NextResponse.json(identity, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
