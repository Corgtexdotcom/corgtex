import { NextResponse } from "next/server";
import { z } from "zod";
import { updateDeliberationEntry } from "@corgtex/domain";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const updateDeliberationEntrySchema = z.object({
  entryType: z.string().trim().min(1).optional(),
  bodyMd: z.string().trim().min(1).optional(),
}).refine((body) => body.entryType !== undefined || body.bodyMd !== undefined, {
  message: "At least one editable field is required.",
});

export const PATCH = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const parsed = await validateBody(request, updateDeliberationEntrySchema);
  await checkApiDemoGuard(workspaceId);

  const entry = await updateDeliberationEntry(actor, {
    workspaceId,
    entryId: params.entryId,
    entryType: parsed.entryType,
    bodyMd: parsed.bodyMd,
  });

  return NextResponse.json({ entry });
});
