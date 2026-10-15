import { NextRequest, NextResponse } from "next/server";
import { AppError, inspectLegacyRecovery, recoverLegacyArtifact } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };
function selection(workspaceId: string, kind: unknown, id: unknown) {
  if (!["Action", "ConversationSession", "ConversationTurn", "Document", "BrainSource"].includes(String(kind))
    || typeof id !== "string" || !id || id.length > 191) throw new AppError(400, "INVALID_INPUT", "Select a supported historical record.");
  return {workspaceId,kind:kind as "Action" | "ConversationSession" | "ConversationTurn" | "Document" | "BrainSource",id};
}
/** Inspect metadata/fingerprint only; original private bodies never enter URLs or responses. */
export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request), {workspaceId} = await context.params;
    return NextResponse.json(await inspectLegacyRecovery(actor,selection(workspaceId,request.nextUrl.searchParams.get("kind"),request.nextUrl.searchParams.get("id"))),
      {headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {return handleRouteError(error);}
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request), {workspaceId} = await context.params;
    const body: unknown = await request.json().catch(()=>{throw new AppError(400,"INVALID_INPUT","Provide a recovery selection.");});
    if(!body || typeof body!=="object" || Array.isArray(body)) throw new AppError(400,"INVALID_INPUT","Provide a recovery selection.");
    const fields=body as Record<string,unknown>;
    const recovered = await recoverLegacyArtifact(actor,{...selection(workspaceId,fields.kind,fields.id),
      expectedFingerprint:String(fields.expectedFingerprint ?? ""),requestId:String(fields.requestId ?? ""),consent:fields.consent as "RESTORE_SELECTED_HISTORY"});
    const {rebuildRecoveredHistory} = await import("@/lib/legacy-recovery-projection");
    const projection = await rebuildRecoveredHistory(actor,workspaceId,recovered);
    return NextResponse.json({...recovered,projection},{headers:{"Cache-Control":"private, no-store"}});
  } catch(error) {return handleRouteError(error);}
}
