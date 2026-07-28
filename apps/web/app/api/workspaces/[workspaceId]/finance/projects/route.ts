import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createFinanceProject } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const createProjectSchema = z.object({
  name: z.string().trim().min(1),
  clientId: z.string().trim().min(1).optional().nullable(),
  budgetCents: z.number().int().nonnegative().optional().nullable(),
  currency: z.string().trim().length(3).optional().nullable(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createProjectSchema);
    const project = await createFinanceProject(actor, {
      workspaceId,
      name: body.name,
      clientId: body.clientId ?? null,
      budgetCents: body.budgetCents ?? null,
      currency: body.currency ?? null,
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_projects" });
  }
}
