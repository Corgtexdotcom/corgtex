import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@corgtex/domain";
import { connectReadOnly, listTables } from "@corgtex/connectors-sql";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  driverType: z.literal("postgres"),
  connectionString: z.string().min(1),
});

export const POST = withWorkspaceRoute(async (request, { membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const parsed = testSchema.parse(await request.json());
  const client = await connectReadOnly(parsed.connectionString);

  try {
    const tables = await listTables(client);
    return NextResponse.json({ success: true, tables });
  } finally {
    await client.end();
  }
});
