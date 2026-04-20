import { NextRequest, NextResponse } from "next/server";
import { deleteDocument } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; documentId: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, documentId } = await params;
    await deleteDocument(actor, { workspaceId, documentId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
