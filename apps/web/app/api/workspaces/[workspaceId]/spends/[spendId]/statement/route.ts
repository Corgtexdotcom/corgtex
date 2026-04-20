import { NextRequest, NextResponse } from "next/server";
import { uploadSpendStatement } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; spendId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = (await request.json()) as {
      storageKey?: unknown;
      fileName?: unknown;
      mimeType?: unknown;
    };
    const spend = await uploadSpendStatement(actor, {
      workspaceId,
      spendId,
      storageKey: String(body.storageKey ?? ""),
      fileName: typeof body.fileName === "string" ? body.fileName : null,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
