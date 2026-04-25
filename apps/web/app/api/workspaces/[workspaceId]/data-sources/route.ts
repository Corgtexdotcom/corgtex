import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, createExternalDataSource, listExternalDataSources } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { encrypt } from "@corgtex/connectors-sql";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sources = await listExternalDataSources(actor, workspaceId);
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

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const json = await request.json();
  const parsed = createSchema.parse(json);

  const source = await createExternalDataSource(actor, {
    workspaceId,
    label: parsed.label,
    driverType: parsed.driverType,
    connectionStringEnc: encrypt(parsed.connectionString),
    selectedTables: parsed.selectedTables,
    pullCadenceMinutes: parsed.pullCadenceMinutes,
    cursorColumn: parsed.cursorColumn,
  });

  return NextResponse.json(source);
});
