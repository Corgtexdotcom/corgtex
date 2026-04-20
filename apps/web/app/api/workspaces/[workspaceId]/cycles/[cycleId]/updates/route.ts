import { NextRequest, NextResponse } from "next/server";
import { listCycleUpdates, requireWorkspaceMembership, upsertCycleUpdate } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; cycleId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const updates = await listCycleUpdates(workspaceId, cycleId);
    return NextResponse.json({ updates });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId } = await params;
    const body = (await request.json()) as {
      updateMd?: unknown;
      cashPaidCents?: unknown;
      cashPaidCurrency?: unknown;
      valueEstimateCents?: unknown;
      valueEstimateCurrency?: unknown;
      valueConfidence?: unknown;
    };
    const cycleUpdate = await upsertCycleUpdate(actor, {
      workspaceId,
      cycleId,
      updateMd: String(body.updateMd ?? ""),
      cashPaidCents: body.cashPaidCents !== undefined && body.cashPaidCents !== null ? Number.parseInt(String(body.cashPaidCents), 10) : undefined,
      cashPaidCurrency: typeof body.cashPaidCurrency === "string" ? body.cashPaidCurrency : null,
      valueEstimateCents: body.valueEstimateCents !== undefined && body.valueEstimateCents !== null ? Number.parseInt(String(body.valueEstimateCents), 10) : undefined,
      valueEstimateCurrency: typeof body.valueEstimateCurrency === "string" ? body.valueEstimateCurrency : null,
      valueConfidence: typeof body.valueConfidence === "string" ? body.valueConfidence : null,
    });
    return NextResponse.json({ cycleUpdate }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
