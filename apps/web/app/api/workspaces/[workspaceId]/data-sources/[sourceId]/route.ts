import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { encrypt } from "@corgtex/connectors-sql";

export const dynamic = "force-dynamic";

const dataSourceSelect = {
  id: true,
  workspaceId: true,
  label: true,
  driverType: true,
  selectedTables: true,
  pullCadenceMinutes: true,
  cursorColumn: true,
  lastSyncAt: true,
  lastSyncError: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const GET = withWorkspaceRoute(async (request, { workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }
  
  const sourceId = params.sourceId;

  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId, workspaceId },
    select: {
      ...dataSourceSelect,
      syncLogs: {
        orderBy: { startedAt: "desc" },
        take: 10,
      },
    },
  });

  if (!source) {
    throw new AppError(404, "NOT_FOUND", "Data source not found");
  }

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

export const PATCH = withWorkspaceRoute(async (request, { workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sourceId = params.sourceId;
  const json = await request.json();
  const parsed = updateSchema.parse(json);

  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId, workspaceId },
  });

  if (!source) {
    throw new AppError(404, "NOT_FOUND", "Data source not found");
  }

  const updated = await prisma.externalDataSource.update({
    where: { id: sourceId },
    data: {
      ...(parsed.label && { label: parsed.label }),
      ...(parsed.connectionString && { connectionStringEnc: encrypt(parsed.connectionString) }),
      ...(parsed.selectedTables && { selectedTables: parsed.selectedTables }),
      ...(parsed.pullCadenceMinutes !== undefined && { pullCadenceMinutes: parsed.pullCadenceMinutes }),
      ...(parsed.cursorColumn && { cursorColumn: parsed.cursorColumn }),
      ...(parsed.isActive !== undefined && { isActive: parsed.isActive }),
    },
    select: dataSourceSelect,
  });

  return NextResponse.json(updated);
});

export const DELETE = withWorkspaceRoute(async (request, { workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sourceId = params.sourceId;
  
  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId, workspaceId },
  });

  if (!source) {
    throw new AppError(404, "NOT_FOUND", "Data source not found");
  }

  await prisma.knowledgeChunk.deleteMany({
    where: {
      workspaceId,
      sourceType: "EXTERNAL_DATABASE",
      sourceId: {
        startsWith: `byodb:${sourceId}:`,
      },
    },
  });

  await prisma.externalDataSource.delete({
    where: { id: sourceId },
  });

  return new NextResponse(null, { status: 204 });
});
