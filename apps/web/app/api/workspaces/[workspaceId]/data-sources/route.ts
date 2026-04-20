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

export const GET = withWorkspaceRoute(async (request, { workspaceId, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sources = await prisma.externalDataSource.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: dataSourceSelect,
  });

  return NextResponse.json(sources);
});

const createSchema = z.object({
  label: z.string().min(1),
  driverType: z.literal("postgres"),
  connectionString: z.string().min(1),
  selectedTables: z.array(z.string().min(1)).min(1),
  pullCadenceMinutes: z.number().int().min(5).default(60),
  cursorColumn: z.string().min(1).default("updated_at"),
});

export const POST = withWorkspaceRoute(async (request, { workspaceId, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const json = await request.json();
  const parsed = createSchema.parse(json);

  const source = await prisma.externalDataSource.create({
    data: {
      workspaceId,
      label: parsed.label,
      driverType: parsed.driverType,
      connectionStringEnc: encrypt(parsed.connectionString),
      selectedTables: parsed.selectedTables,
      pullCadenceMinutes: parsed.pullCadenceMinutes,
      cursorColumn: parsed.cursorColumn,
    },
    select: dataSourceSelect,
  });

  return NextResponse.json(source);
});
