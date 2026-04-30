import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { PDFParse } from "pdf-parse";
import { defaultStorage } from "@corgtex/storage";
import { appendEvents, requireWorkspaceMembership, AppError, getStorageUsageSummary } from "@corgtex/domain";
import mammoth from "mammoth";

function asRecord(value: Record<string, unknown> | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

async function extractPdfText(fileBuffer: Buffer) {
  const parser = new PDFParse({ data: fileBuffer });
  try {
    const parsed = await parser.getText();
    return parsed.text.trim();
  } finally {
    await parser.destroy();
  }
}

export async function extractTextFromFileBuffer(params: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  maxExtractBytes?: number;
  maxTextLength?: number;
}) {
  const fileName = params.fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "-") || "upload.bin";
  const lowerName = fileName.toLowerCase();
  const size = params.fileBuffer.byteLength;
  const maxExtractBytes = params.maxExtractBytes ?? 25 * 1024 * 1024;
  const maxTextLength = params.maxTextLength ?? 100000;
  let textContent: string | null = null;
  let supported = false;
  let truncated = false;

  if (size <= maxExtractBytes) {
    try {
      if (
        params.mimeType.startsWith("text/")
        || lowerName.endsWith(".txt")
        || lowerName.endsWith(".md")
        || lowerName.endsWith(".csv")
        || lowerName.endsWith(".json")
      ) {
        supported = true;
        textContent = params.fileBuffer.toString("utf-8").trim();
      } else if (params.mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
        supported = true;
        textContent = await extractPdfText(params.fileBuffer);
      } else if (
        params.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        || lowerName.endsWith(".docx")
      ) {
        supported = true;
        const result = await mammoth.extractRawText({ buffer: params.fileBuffer });
        textContent = result.value.trim();
      }
    } catch (error) {
      console.warn("Failed to extract text from file", { fileName, error });
      textContent = null;
    }
  }

  if (textContent && textContent.length > maxTextLength) {
    textContent = `${textContent.slice(0, maxTextLength)}\n...[truncated]`;
    truncated = true;
  }

  return {
    textContent,
    supported,
    truncated,
    size,
    fileName,
  };
}

export async function ingestFile(actor: AppActor, params: {
  workspaceId: string;
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  uploadSource?: string;
  authorMemberId?: string;
  documentTitle?: string;
  documentMetadata?: Record<string, unknown>;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const authorMemberId = params.authorMemberId || membership?.id;
  const fileName = params.fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "-") || "upload.bin";
  const source = params.uploadSource?.trim() || "upload";
  const documentTitle = params.documentTitle?.trim() || fileName;
  const size = params.fileBuffer.byteLength;

  // 0. Safety check: Prevent exceeding the 10GB free tier
  const usage = await getStorageUsageSummary(actor, params.workspaceId);
  if (usage.isOverLimit) {
    throw new AppError(403, "STORAGE_LIMIT_EXCEEDED", `Workspace storage exceeds the boundary maximum allowance. File ingestion is frozen.`);
  }

  // 1. Upload to Blob Storage
  const storageKey = `workspaces/${params.workspaceId}/uploads/${randomUUID()}/${fileName}`;
  await defaultStorage.put(storageKey, params.fileBuffer, { contentType: params.mimeType });

  // 2. Extract Text
  const { textContent } = await extractTextFromFileBuffer({
    fileBuffer: params.fileBuffer,
    fileName,
    mimeType: params.mimeType,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      // 3. Create Document mapping
      const document = await tx.document.create({
        data: {
          workspaceId: params.workspaceId,
          title: documentTitle,
          source,
          storageKey,
          mimeType: params.mimeType,
          textContent,
          metadata: {
            ...asRecord(params.documentMetadata),
            fileName,
            size,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: "document.created",
          entityType: "Document",
          entityId: document.id,
          meta: { source, storageKey },
        },
      });

      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "document.created",
          aggregateType: "Document",
          aggregateId: document.id,
          payload: { documentId: document.id, title: document.title, source: document.source },
        },
      ]);

      // 4. Ingest to Brain if text is available
      let brainSource = null;
      if (textContent && textContent.length > 0) {
        brainSource = await tx.brainSource.create({
          data: {
            workspaceId: params.workspaceId,
            sourceType: "FILE_UPLOAD",
            tier: 2,
            content: textContent,
            title: documentTitle,
            authorMemberId: authorMemberId || null,
            channel: source,
            fileStorageKey: storageKey,
            fileName,
            fileMimeType: params.mimeType,
            fileSizeBytes: size,
            metadata: {
              documentId: document.id,
            } as Prisma.InputJsonValue,
          },
        });

        await tx.auditLog.create({
          data: {
            workspaceId: params.workspaceId,
            actorUserId: actor.kind === "user" ? actor.user.id : null,
            action: "brain-source.created",
            entityType: "BrainSource",
            entityId: brainSource.id,
            meta: { sourceType: brainSource.sourceType, tier: brainSource.tier },
          },
        });

        await appendEvents(tx, [
          {
            workspaceId: params.workspaceId,
            type: "brain-source.created",
            aggregateType: "BrainSource",
            aggregateId: brainSource.id,
            payload: { sourceId: brainSource.id },
          },
        ]);
      }

      return { document, source: brainSource };
    });
  } catch (error) {
    await defaultStorage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}
