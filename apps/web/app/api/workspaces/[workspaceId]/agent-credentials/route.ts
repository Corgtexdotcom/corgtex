import { NextRequest, NextResponse } from "next/server";
import { issueAgentCredential, listAgentCredentials } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const credentials = await listAgentCredentials(actor, workspaceId);
    return NextResponse.json({ credentials });
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
    const body = (await request.json()) as {
      label?: unknown;
      scopes?: unknown;
      catalogItemId?: unknown;
      reasonMd?: unknown;
      monthlyBudgetCents?: unknown;
      dailyCallLimit?: unknown;
    };
    const result = await issueAgentCredential(actor, {
      workspaceId,
      label: String(body.label ?? ""),
      scopes: Array.isArray(body.scopes) ? body.scopes.map((value) => String(value)) : [],
      catalogItemId: typeof body.catalogItemId === "string" ? body.catalogItemId : null,
      reasonMd: typeof body.reasonMd === "string" ? body.reasonMd : null,
      monthlyBudgetCents: typeof body.monthlyBudgetCents === "number" ? body.monthlyBudgetCents : null,
      dailyCallLimit: typeof body.dailyCallLimit === "number" ? body.dailyCallLimit : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
