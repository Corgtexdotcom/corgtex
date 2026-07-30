import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { AppError, createDocument, listDocuments, requireWorkspaceMembership } from "@corgtex/domain";
import type { DuplicateGuardOptions, DuplicateGuardResolution } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { ingestFile } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

function parseDocumentMetadata(value: FormDataEntryValue | null | undefined) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Prisma.InputJsonValue;
    }
  } catch {
    // Ignore malformed metadata and continue without it.
  }

  return undefined;
}

function normalizeUploadFileName(fileName: string) {
  const normalized = fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "upload.bin";
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

const DUPLICATE_GUARD_RESOLUTIONS: DuplicateGuardResolution[] = [
  "use_existing",
  "update_existing",
  "create_new",
];

function duplicateGuardFromValues(resolution: unknown, targetEntityId: unknown, enabled?: unknown): DuplicateGuardOptions | undefined {
  if (typeof resolution !== "string" || !DUPLICATE_GUARD_RESOLUTIONS.includes(resolution as DuplicateGuardResolution)) {
    if (enabled === true || enabled === "true") return {};
    return undefined;
  }
  return {
    resolution: resolution as DuplicateGuardResolution,
    targetEntityId: typeof targetEntityId === "string" && targetEntityId.trim() ? targetEntityId.trim() : null,
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
    const documents = await listDocuments(actor, workspaceId, { archiveFilter: archiveFilter ?? undefined });
    return NextResponse.json({ documents });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await checkApiDemoGuard(workspaceId);
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const fileEntry = formData.get("file");

      if (!(fileEntry instanceof File) || fileEntry.size === 0) {
        throw new AppError(400, "INVALID_INPUT", "file is required.");
      }

      const file = fileEntry;
      const originalName = file.name.trim();
      const normalizedName = normalizeUploadFileName(originalName);
      const providedTitle = formString(formData, "title");
      const providedSource = formString(formData, "source");
      const ingestionGuidanceMd = formString(formData, "ingestionGuidanceMd");
      const parsedMetadata = parseDocumentMetadata(formData.get("metadata"));
      const duplicateGuard = duplicateGuardFromValues(
        formData.get("duplicateResolution"),
        formData.get("duplicateTargetEntityId"),
        formData.get("duplicateGuardEnabled"),
      );

      const buffer = Buffer.from(await file.arrayBuffer());

      const result = await ingestFile(actor, {
        workspaceId,
        fileBuffer: buffer,
        fileName: originalName || normalizedName,
        mimeType: file.type || "application/octet-stream",
        uploadSource: providedSource || "upload",
        documentTitle: providedTitle || originalName || normalizedName,
        ingestionGuidanceMd: ingestionGuidanceMd || undefined,
        documentMetadata:
          parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
            ? (parsedMetadata as Record<string, unknown>)
            : undefined,
        duplicateGuard,
      });

      return NextResponse.json(result.document, { status: 201 });
    }

    const body = (await request.json()) as {
      title?: unknown;
      source?: unknown;
      storageKey?: unknown;
      mimeType?: unknown;
      textContent?: unknown;
      metadata?: unknown;
      duplicateGuardEnabled?: unknown;
      duplicateResolution?: unknown;
      duplicateTargetEntityId?: unknown;
    };

    const document = await createDocument(actor, {
      workspaceId,
      title: String(body.title ?? ""),
      source: String(body.source ?? ""),
      storageKey: String(body.storageKey ?? ""),
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
      textContent: typeof body.textContent === "string" ? body.textContent : null,
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? (body.metadata as Prisma.InputJsonValue)
          : undefined,
      duplicateGuard: duplicateGuardFromValues(body.duplicateResolution, body.duplicateTargetEntityId, body.duplicateGuardEnabled),
    });

    return NextResponse.json(document, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
