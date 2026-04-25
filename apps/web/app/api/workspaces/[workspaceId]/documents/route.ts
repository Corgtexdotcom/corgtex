import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { AppError, createDocument, listDocuments, requireWorkspaceMembership } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { ingestFile } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
    const documents = await listDocuments(workspaceId, { archiveFilter: archiveFilter ?? undefined });
    return NextResponse.json({ documents });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
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
      const providedTitle = typeof formData.get("title") === "string" ? String(formData.get("title")).trim() : "";
      const providedSource = typeof formData.get("source") === "string" ? String(formData.get("source")).trim() : "";
      const parsedMetadata = parseDocumentMetadata(formData.get("metadata"));

      const buffer = Buffer.from(await file.arrayBuffer());

      const result = await ingestFile(actor, {
        workspaceId,
        fileBuffer: buffer,
        fileName: originalName || normalizedName,
        mimeType: file.type || "application/octet-stream",
        uploadSource: providedSource || "upload",
        documentTitle: providedTitle || originalName || normalizedName,
        documentMetadata:
          parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)
            ? (parsedMetadata as Record<string, unknown>)
            : undefined,
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
    });

    return NextResponse.json(document, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
