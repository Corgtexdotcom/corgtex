import { NextRequest, NextResponse } from "next/server";
import type { AgentMemberType } from "@prisma/client";
import { AppError, getAgentIdentity, updateAgentIdentity, deactivateAgentIdentity } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type RouteParams = { params: Promise<{ workspaceId: string; agentId: string }> };

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

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    const identity = await getAgentIdentity(actor, workspaceId, agentId);
    return NextResponse.json(identity);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const updated = await updateAgentIdentity(actor, {
      workspaceId,
      agentIdentityId: agentId,
      ...(body.displayName !== undefined && { displayName: String(body.displayName) }),
      ...(body.avatarUrl !== undefined && { avatarUrl: optionalString(body.avatarUrl) }),
      ...(body.purposeMd !== undefined && { purposeMd: optionalString(body.purposeMd) }),
      ...(body.memberType !== undefined && { memberType: agentMemberType(body.memberType) }),
      ...(body.linkedCredentialId !== undefined && { linkedCredentialId: optionalString(body.linkedCredentialId) }),
      ...(body.maxSpendPerRunCents !== undefined && { maxSpendPerRunCents: optionalNonNegativeInteger(body.maxSpendPerRunCents, "maxSpendPerRunCents") }),
      ...(body.maxRunsPerDay !== undefined && { maxRunsPerDay: optionalNonNegativeInteger(body.maxRunsPerDay, "maxRunsPerDay") }),
      ...(body.maxRunsPerHour !== undefined && { maxRunsPerHour: optionalNonNegativeInteger(body.maxRunsPerHour, "maxRunsPerHour") }),
      ...(body.isActive !== undefined && { isActive: Boolean(body.isActive) }),
    });
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    await deactivateAgentIdentity(actor, workspaceId, agentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
