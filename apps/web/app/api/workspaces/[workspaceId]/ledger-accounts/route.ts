import { NextRequest, NextResponse } from "next/server";
import { createLedgerAccount, listLedgerAccounts, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const ledgerAccounts = await listLedgerAccounts(workspaceId);
    return NextResponse.json({ ledgerAccounts });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      name?: unknown;
      currency?: unknown;
      type?: unknown;
      balanceCents?: unknown;
    };
    const ledgerAccount = await createLedgerAccount(actor, {
      workspaceId,
      name: String(body.name ?? ""),
      currency: String(body.currency ?? ""),
      type: typeof body.type === "string" ? body.type : null,
      balanceCents: body.balanceCents !== undefined ? Number.parseInt(String(body.balanceCents), 10) : 0,
    });
    return NextResponse.json({ ledgerAccount }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
