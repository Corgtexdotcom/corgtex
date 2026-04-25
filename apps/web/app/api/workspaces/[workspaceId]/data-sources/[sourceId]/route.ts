import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, deleteExternalDataSource, getExternalDataSource, updateExternalDataSource } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { encrypt } from "@corgtex/connectors-sql";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }
  
  const sourceId = params.sourceId;
  const source = await getExternalDataSource(actor, {
    workspaceId,
    sourceId,
    includeSyncLogs: true,
  });

  return NextResponse.json(source);
});

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  connectionString: z.string().min(1).optional(),
  selectedTables: z.array(z.string()).optional(),
  pullCadenceMinutes: z.number().int().min(5).optional(),
  cursorColumn: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = withWorkspaceRoute(async (request, { actor, workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sourceId = params.sourceId;
  const json = await request.json();
  const parsed = updateSchema.parse(json);

  const updated = await updateExternalDataSource(actor, {
    workspaceId,
    sourceId,
    ...(parsed.label !== undefined ? { label: parsed.label } : {}),
    ...(parsed.connectionString !== undefined ? { connectionStringEnc: encrypt(parsed.connectionString) } : {}),
    ...(parsed.selectedTables !== undefined ? { selectedTables: parsed.selectedTables } : {}),
    ...(parsed.pullCadenceMinutes !== undefined ? { pullCadenceMinutes: parsed.pullCadenceMinutes } : {}),
    ...(parsed.cursorColumn !== undefined ? { cursorColumn: parsed.cursorColumn } : {}),
    ...(parsed.isActive !== undefined ? { isActive: parsed.isActive } : {}),
  });

  return NextResponse.json(updated);
});

export const DELETE = withWorkspaceRoute(async (request, { actor, workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sourceId = params.sourceId;
  await deleteExternalDataSource(actor, { workspaceId, sourceId });

  return new NextResponse(null, { status: 204 });
});
