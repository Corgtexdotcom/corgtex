import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeEnterpriseAppSessionToken } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const introspectSchema = z.object({
  token: z.string().min(1),
  audience: z.string().optional().nullable(),
  workspaceId: z.string().optional().nullable(),
  appInstallationId: z.string().optional().nullable(),
});

export const POST = withRoute(async (request) => {
  const body = await validateBody(request, introspectSchema);
  const session = await consumeEnterpriseAppSessionToken(body);
  return NextResponse.json({ session });
});
