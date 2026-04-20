import { NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { decrypt, connectReadOnly, listTables } from "@corgtex/connectors-sql";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (request, { workspaceId, params, membership }) => {
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

  if (source.driverType !== "postgres") {
    throw new AppError(400, "INVALID_INPUT", "Unsupported driver type");
  }

  const connectionString = decrypt(source.connectionStringEnc);
  const client = await connectReadOnly(connectionString);

  try {
    const tables = await listTables(client);
    return NextResponse.json({ success: true, tables });
  } finally {
    await client.end();
  }
});
