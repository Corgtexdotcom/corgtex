import { NextResponse, type NextRequest } from "next/server";
import { AppError, applyFinanceReportImport, editFinanceReportImportCandidate, getFinanceReportImport, reviewFinanceReportImport } from "@corgtex/domain";
import { z } from "zod";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError, validateBody } from "@/lib/http";
type Context = { params: Promise<{ workspaceId: string; batchId: string }> };
const version = z.number().int().positive().max(2_147_483_646);
const candidateVersion = z.strictObject({ id: z.string().min(1).max(100), expectedVersion: version });
const edit = z.strictObject({ operation: z.literal("EDIT"), candidateId: z.string().min(1).max(100), expectedVersion: version,
  expectedCandidateVersion: version, proposedAccountPath: z.array(z.string()).max(100).optional(), amountCents: z.number().int().optional(),
  periodStart: z.string().optional(), periodEnd: z.string().optional() });
const review = z.strictObject({ operation: z.enum(["APPROVE", "REJECT", "APPROVE_VERIFIED", "APPROVE_ALL"]), candidateId: z.string().min(1).max(100).optional(),
  expectedVersion: version, candidateVersions: z.array(candidateVersion).min(1).max(1_000), acceptWarnings: z.boolean().optional() });
const application = z.strictObject({ expectedVersion: version, candidateVersions: z.array(z.strictObject({
  id: z.string().trim().min(1).max(100), expectedVersion: version })).min(1).max(1_000) })
  .refine(({ candidateVersions }) => new Set(candidateVersions.map(({ id }) => id)).size === candidateVersions.length,
    { path: ["candidateVersions"], message: "Candidate IDs must be unique." });
export async function GET(request: NextRequest, { params }: Context) {
  let workspaceId: string | undefined;
  try {
    const actor = await resolveRequestActor(request); const route = await params; workspaceId = route.workspaceId;
    return NextResponse.json({ batch: await getFinanceReportImport(actor, route) });
  } catch (error) { return handleRouteError(error, { request, surface: "finance_report_import", workspaceId }); }
}
export async function POST(request: NextRequest, { params }: Context) {
  let workspaceId: string | undefined;
  try {
    const actor = await resolveRequestActor(request); const route = await params; workspaceId = route.workspaceId; await checkApiDemoGuard(workspaceId);
    const body = await validateBody(request, application);
    return NextResponse.json({ application: await applyFinanceReportImport(actor, { ...body, workspaceId: route.workspaceId, batchId: route.batchId }) });
  } catch (error) { return handleRouteError(error, { request, surface: "finance_report_import_application", workspaceId }); }
}
export async function PATCH(request: NextRequest, { params }: Context) {
  let workspaceId: string | undefined;
  try {
    const actor = await resolveRequestActor(request); const route = await params; workspaceId = route.workspaceId; await checkApiDemoGuard(workspaceId);
    const body = await validateBody(request, z.union([edit, review]));
    const result = body.operation === "EDIT"
      ? await editFinanceReportImportCandidate(actor, { ...route, ...body })
      : await reviewFinanceReportImport(actor, { ...route, ...body, mode: body.operation });
    return NextResponse.json({ review: result });
  } catch (error) {
    const safe = error instanceof z.ZodError ? new AppError(400, "VALIDATION_ERROR", "Review input is invalid.") : error;
    return handleRouteError(safe, { request, surface: "finance_report_import_review", workspaceId });
  }
}
