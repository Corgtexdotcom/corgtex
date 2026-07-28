import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createFinanceContributionEntry } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const contributionSchema = z.object({
  projectId: z.string().trim().min(1).optional().nullable(),
  consultantId: z.string().trim().min(1).optional().nullable(),
  contributorUserId: z.string().trim().min(1).optional().nullable(),
  type: z.enum(["TIME", "EXPENSE", "CAPITAL"]),
  paymentChoice: z.enum(["CASH", "SLICING_PIE", "CAPITAL"]),
  occurredAt: z.string().datetime().optional().nullable(),
  minutes: z.number().int().positive().optional().nullable(),
  amountCents: z.number().int().positive().optional().nullable(),
  currency: z.string().trim().length(3).optional().nullable(),
  descriptionMd: z.string().optional().nullable(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, contributionSchema);
    const entry = await createFinanceContributionEntry(actor, {
      workspaceId,
      projectId: body.projectId ?? null,
      consultantId: body.consultantId ?? null,
      contributorUserId: body.contributorUserId ?? null,
      type: body.type,
      paymentChoice: body.paymentChoice,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
      minutes: body.minutes ?? null,
      amountCents: body.amountCents ?? null,
      currency: body.currency ?? null,
      descriptionMd: body.descriptionMd ?? null,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_contributions" });
  }
}
