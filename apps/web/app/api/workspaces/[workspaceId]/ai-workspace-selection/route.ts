import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getAiWorkspaceSelectionState,
  makeDefaultAiWorkspaceProvider,
  setActiveAiWorkspaceProvider,
  startAiWorkspaceProviderSetup,
} from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const selectionSchema = z.object({
  providerKey: z.string().min(1),
  action: z.enum(["start_setup", "make_default"]).optional(),
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
  const params = {
    workspaceId,
    providerKey: parsed.providerKey,
  };
  const state = parsed.action === "start_setup"
    ? await startAiWorkspaceProviderSetup(actor, params)
    : parsed.action === "make_default"
      ? await makeDefaultAiWorkspaceProvider(actor, params)
      : await setActiveAiWorkspaceProvider(actor, params);

  return NextResponse.json(state);
});
