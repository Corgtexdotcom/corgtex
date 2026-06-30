import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listExternalMcpConnections,
  upsertExternalMcpConnection,
} from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const connectionSchema = z.object({
  providerKey: z.enum(["box", "notion"]),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  expiresIn: z.number().int().positive().optional().nullable(),
  providerAccountId: z.string().optional().nullable(),
  providerEmail: z.string().email().optional().nullable(),
  scopes: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId }) => {
  const items = await listExternalMcpConnections(actor, workspaceId);
  return NextResponse.json({ items });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const parsed = await validateBody(request, connectionSchema);
  await upsertExternalMcpConnection(actor, {
    workspaceId,
    providerKey: parsed.providerKey,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
    expiresIn: parsed.expiresIn,
    providerAccountId: parsed.providerAccountId,
    providerEmail: parsed.providerEmail,
    scopes: parsed.scopes,
    capabilities: parsed.capabilities,
  });

  const items = await listExternalMcpConnections(actor, workspaceId);
  const item = items.find((connection) => connection.providerKey === parsed.providerKey) ?? null;
  return NextResponse.json({ item }, { status: 201 });
});
