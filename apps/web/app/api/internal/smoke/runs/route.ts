import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { upsertSelfServeSmokeRun } from "@corgtex/domain";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const smokeRunSchema = z.object({
  runId: z.string().trim().min(1),
  runKind: z.string().trim().min(1).default("browser"),
  status: z.string().trim().min(1),
  deploymentId: z.string().trim().min(1).nullable().optional(),
  workspaceId: z.string().trim().min(1).nullable().optional(),
  procurementTrialId: z.string().trim().min(1).nullable().optional(),
  baseUrl: z.string().trim().min(1).nullable().optional(),
  siteUrl: z.string().trim().min(1).nullable().optional(),
  summary: z.unknown().optional(),
  artifacts: z.unknown().optional(),
  error: z.string().trim().min(1).nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
}).strict();

function bearerSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, smokeRunSchema);
    const run = await upsertSelfServeSmokeRun({
      secret: bearerSecret(request),
      ...body,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
