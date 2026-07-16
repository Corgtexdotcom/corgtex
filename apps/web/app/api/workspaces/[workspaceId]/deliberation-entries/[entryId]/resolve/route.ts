import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveDeliberationEntry } from "@corgtex/domain";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const resolveDeliberationEntrySchema = z.object({
  resolvedNote: z.string().trim().min(1),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const parsed = await validateBody(request, resolveDeliberationEntrySchema);
  await checkApiDemoGuard(workspaceId);

  const entry = await resolveDeliberationEntry(actor, {
    workspaceId,
    entryId: params.entryId,
    resolvedNote: parsed.resolvedNote,
  });

  return NextResponse.json({ entry });
});
