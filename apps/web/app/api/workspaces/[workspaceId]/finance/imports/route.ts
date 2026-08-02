import { NextRequest, NextResponse } from "next/server";
import {
  AppError,
  createFinanceReportImportUpload,
  FINANCE_REPORT_IMPORT_MAX_FILE_BYTES,
  listFinanceReportImports,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

type RouteContext = { params: Promise<{ workspaceId: string }> };
const MAX_MULTIPART_ENVELOPE_BYTES = FINANCE_REPORT_IMPORT_MAX_FILE_BYTES + (64 * 1024);

export async function GET(request: NextRequest, { params }: RouteContext) {
  let workspaceId: string | undefined;
  try {
    const actor = await resolveRequestActor(request);
    ({ workspaceId } = await params);
    return NextResponse.json({ batches: await listFinanceReportImports(actor, workspaceId) });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_report_import", workspaceId });
  }
}

function invalidMultipart() {
  return new AppError(400, "INVALID_INPUT", "The multipart report upload is invalid.");
}

function fileTooLarge() {
  return new AppError(413, "FILE_TOO_LARGE", "The report file exceeds the supported size limit.");
}

function requireMultipart(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
    throw new AppError(400, "INVALID_INPUT", "Must be multipart/form-data.");
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength) {
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw invalidMultipart();
    if (contentLength > MAX_MULTIPART_ENVELOPE_BYTES) throw fileTooLarge();
  }
  return contentType;
}

async function parseMultipart(request: NextRequest, contentType: string) {
  const reader = request.body?.getReader();
  if (!reader) throw invalidMultipart();
  let byteLength = 0;
  let tooLarge = false;
  const boundedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) return controller.close();
        byteLength += chunk.value.byteLength;
        if (byteLength > MAX_MULTIPART_ENVELOPE_BYTES) {
          tooLarge = true;
          await reader.cancel();
          return controller.error(fileTooLarge());
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  try {
    return await new Response(boundedBody, { headers: { "content-type": contentType } }).formData();
  } catch {
    if (tooLarge) throw fileTooLarge();
    throw invalidMultipart();
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
    const contentType = requireMultipart(request);
    const file = requireReportFile(await parseMultipart(request, contentType));
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
