import { NextRequest, NextResponse } from "next/server";
import {
  AppError,
  createFinanceReportImportUpload,
  FINANCE_REPORT_IMPORT_MAX_FILE_BYTES,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

type RouteContext = { params: Promise<{ workspaceId: string }> };

function requireMultipart(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError(400, "INVALID_INPUT", "Must be multipart/form-data.");
  }
}

function requireReportFile(formData: FormData) {
  const entries = formData.getAll("file");
  if (entries.length !== 1 || !(entries[0] instanceof File) || entries[0].size === 0) {
    throw new AppError(400, "INVALID_INPUT", "Exactly one report file is required.");
  }
  if (entries[0].size > FINANCE_REPORT_IMPORT_MAX_FILE_BYTES) {
    throw new AppError(413, "FILE_TOO_LARGE", "The report file exceeds the supported size limit.");
  }
  return entries[0];
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  let workspaceId: string | undefined;
  try {
    const actor = await resolveRequestActor(request);
    ({ workspaceId } = await params);
    await checkApiDemoGuard(workspaceId);
    requireMultipart(request);
    const file = requireReportFile(await request.formData());
    const result = await createFinanceReportImportUpload(actor, {
      workspaceId,
      fileBuffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
    });
    return NextResponse.json({
      batch: {
        id: result.batch.id,
        stage: result.batch.stage,
        safeErrorCode: result.batch.safeErrorCode,
        safeErrorMessage: result.batch.safeErrorMessage,
      },
      reused: result.reused,
    }, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_report_import", workspaceId });
  }
}
