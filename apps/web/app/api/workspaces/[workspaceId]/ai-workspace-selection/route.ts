import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getAiWorkspaceSelectionState,
  setActiveAiWorkspaceProvider,
} from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const selectionSchema = z.object({
  providerKey: z.string().min(1),
});

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId }) => {
  const state = await getAiWorkspaceSelectionState(actor, workspaceId);
  return NextResponse.json(state, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, selectionSchema);
  const state = await setActiveAiWorkspaceProvider(actor, {
    workspaceId,
    providerKey: parsed.providerKey,
  });
  return NextResponse.json(state);
});
