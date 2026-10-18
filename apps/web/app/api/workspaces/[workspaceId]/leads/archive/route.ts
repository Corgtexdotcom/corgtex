import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, listContacts, listCrmAccounts, listCrmActivities, listDeals } from "@corgtex/domain";
import { getMcpOrigin } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";
import { serializeCrmDirectReadResult } from "../../../../../../../../packages/domain/src/crm-direct-original-read";

export const dynamic = "force-dynamic";
const query = z.object({
  family: z.enum(["accounts", "contacts", "deals", "activities"]),
  archiveFilter: z.enum(["archived", "all"]).default("archived"),
  take: z.coerce.number().int().min(0).max(5000).default(50),
  skip: z.coerce.number().int().min(0).max(5000).default(0),
});
function originIdentity() {
  const origin = getMcpOrigin();
  return JSON.stringify(origin ? [origin.kind, origin.id, origin.workspaceId, origin.credentialVersion ?? null,
    origin.scopeHash ?? null, origin.grantEpoch ?? null] : null);
}
/** Native presentation transport only. No model tool or source receipt is exposed. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const expectedOrigin = originIdentity();
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const parsed = query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid archive filters.");
    const filters = parsed.data;
    await requireWorkspaceFeature(workspaceId, "RELATIONSHIPS");
    if (expectedOrigin !== originIdentity()) throw new AppError(403, "MCP_AUTHORIZATION_REVOKED", "Presentation authority changed.");
    const options = { archiveFilter: filters.archiveFilter, take: filters.take, skip: filters.skip };
    const result = filters.family === "accounts" ? await listCrmAccounts(actor, workspaceId, options)
      : filters.family === "contacts" ? await listContacts(actor, workspaceId, options)
        : filters.family === "deals" ? await listDeals(actor, workspaceId, options)
          : await listCrmActivities(actor, workspaceId, options);
    if (expectedOrigin !== originIdentity()) throw new AppError(403, "MCP_AUTHORIZATION_REVOKED", "Presentation authority changed.");
    const body = await serializeCrmDirectReadResult(actor, result);
    // No await, formatting, cache or label lookup may follow the final delivery fence.
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    return handleRouteError(error);
  }
}
