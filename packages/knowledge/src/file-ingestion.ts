import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { PDFParse } from "pdf-parse";
import { defaultStorage } from "@corgtex/storage";
import {
  appendEvents,
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  duplicateGuardContentHash,
  duplicateGuardMergeText,
  assertTrialStorageCapacity,
  lockAndAssertTrialStorageCapacity,
  requireWorkspaceMembership,
  AppError,
  getStorageUsageSummary,
  isGlobalOperator,
  type DuplicateGuardOptions,
} from "@corgtex/domain";
import mammoth from "mammoth";
import {
  extractPptxText,
  PPTX_MIME_TYPE,
  PptxExtractionError,
} from "./pptx-extraction";

function asRecord(value: Record<string, unknown> | undefined) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function optionalTrimmed(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sizeFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const size = (metadata as Record<string, unknown>).size;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadedContentHash(fileBuffer: Buffer, textContent: string | null, authoritativeContentHash?: string) {
  return authoritativeContentHash ?? (textContent?.trim()
    ? duplicateGuardContentHash(textContent)
    : createHash("sha256").update(fileBuffer).digest("hex"));
}

type PptxExtractionResult = Awaited<ReturnType<typeof extractPptxText>>;

type CachedPptxExtraction = {
  fileName: string;
  mimeType: string;
  maxExtractBytes: number;
  maxTextLength: number;
  fingerprint: string;
  result: Readonly<PptxExtractionResult>;
};

const pptxExtractionCache = new WeakMap<Buffer, CachedPptxExtraction>();

function clonePptxExtraction(result: Readonly<PptxExtractionResult>): PptxExtractionResult {
  return {
    textContent: result.textContent,
    contentHash: result.contentHash,
    extraction: { ...result.extraction },
  };
}

async function extractPptxTextCached(params: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  maxExtractBytes: number;
  maxTextLength: number;
}) {
  const fingerprint = createHash("sha256").update(params.fileBuffer).digest("hex");
  const cached = pptxExtractionCache.get(params.fileBuffer);
  if (
    cached
    && cached.fileName === params.fileName
    && cached.mimeType === params.mimeType
    && cached.maxExtractBytes === params.maxExtractBytes
    && cached.maxTextLength === params.maxTextLength
    && cached.fingerprint === fingerprint
  ) {
    return clonePptxExtraction(cached.result);
  }

  const extracted = await extractPptxText(params.fileBuffer, {
    maxInputBytes: params.maxExtractBytes,
    maxTextLength: params.maxTextLength,
  });
  const frozen = Object.freeze({
    textContent: extracted.textContent,
    contentHash: extracted.contentHash,
    extraction: Object.freeze({ ...extracted.extraction }),
  }) as Readonly<PptxExtractionResult>;
  pptxExtractionCache.set(params.fileBuffer, {
    fileName: params.fileName,
    mimeType: params.mimeType,
    maxExtractBytes: params.maxExtractBytes,
    maxTextLength: params.maxTextLength,
    fingerprint,
    result: frozen,
  });
  return clonePptxExtraction(frozen);
}

function buildBrainSourceContent(params: {
  documentTitle: string;
  fileName: string;
  mimeType: string;
  size: number;
  textContent: string | null;
  extractionSupported: boolean;
  ingestionGuidanceMd?: string;
}) {
  const header = [
    `Uploaded file: ${params.documentTitle}`,
    `File name: ${params.fileName}`,
    `MIME type: ${params.mimeType}`,
    `Size: ${formatFileSize(params.size)}`,
  ];

  const guidance = params.ingestionGuidanceMd
    ? [`User guidance for this upload:`, params.ingestionGuidanceMd]
    : [];

  if (params.textContent?.trim()) {
    return [
      ...header,
      "",
      params.textContent.trim(),
      ...(guidance.length > 0 ? ["", ...guidance] : []),
    ].join("\n");
  }

  const extractionStatus = params.extractionSupported
    ? "Text extraction was attempted, but no readable body text was found."
    : "Text extraction is not available for this file type. The original file is stored and linked; no file body text was parsed.";

  return [
    ...header,
    `Text extraction: ${extractionStatus}`,
    ...(guidance.length > 0 ? ["", ...guidance] : []),
  ].join("\n");
}

async function loadDocumentWithSource(workspaceId: string, documentId: string) {
  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId },
  });
  if (!document) {
    throw new AppError(404, "NOT_FOUND", "Document not found.");
  }

  const source = await prisma.brainSource.findFirst({
    where: {
      workspaceId,
      sourceType: { in: ["DOC", "FILE_UPLOAD"] },
      metadata: { path: ["documentId"], equals: document.id },
    },
  });
  return { document, source };
}

async function updateDuplicateUploadedDocument(actor: AppActor, params: {
  workspaceId: string;
  documentId: string;
  documentTitle: string;
  source: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  textContent: string | null;
  brainSourceContent: string;
  contentHash: string | null;
  authoritativeContentHash?: string;
  ingestionGuidanceMd?: string;
  authorMemberId?: string;
  metadata: Record<string, unknown>;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.document.findFirst({
      where: { id: params.documentId, workspaceId: params.workspaceId, archivedAt: null },
    });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Document not found.");
    }

    await lockAndAssertTrialStorageCapacity(tx, params.workspaceId, params.size, {
      replacingDocumentId: existing.id,
    });
    const mergedText = duplicateGuardMergeText(existing.textContent, params.textContent);
    const mergedSourceContent = mergedText ? [params.documentTitle, mergedText].join("\n\n") : params.brainSourceContent;
    const contentHash = params.authoritativeContentHash
      ?? (mergedText ? duplicateGuardContentHash(mergedText) : params.contentHash);
    const document = await tx.document.update({
      where: { id: existing.id },
      data: {
        title: existing.title || params.documentTitle,
        storageKey: params.storageKey,
        mimeType: params.mimeType,
        textContent: mergedText,
        metadata: {
          ...(typeof existing.metadata === "object" && existing.metadata !== null && !Array.isArray(existing.metadata)
            ? existing.metadata as Record<string, unknown>
            : {}),
          ...params.metadata,
          fileName: params.fileName,
          size: params.size,
          storageKey: params.storageKey,
          ...(params.ingestionGuidanceMd ? { ingestionGuidanceMd: params.ingestionGuidanceMd } : {}),
          ...(contentHash ? { contentHash } : {}),
          duplicateGuardUpdatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    const existingSource = await tx.brainSource.findFirst({
      where: {
        workspaceId: params.workspaceId,
        sourceType: { in: ["DOC", "FILE_UPLOAD"] },
        archivedAt: null,
        metadata: { path: ["documentId"], equals: document.id },
      },
    });
    const source = existingSource
      ? await tx.brainSource.update({
        where: { id: existingSource.id },
        data: {
          content: mergedSourceContent,
          title: existingSource.title || params.documentTitle,
          channel: existingSource.channel || params.source,
          ingestionGuidanceMd: params.ingestionGuidanceMd ?? existingSource.ingestionGuidanceMd,
          fileStorageKey: params.storageKey,
          fileName: params.fileName,
          fileMimeType: params.mimeType,
          fileSizeBytes: params.size,
          absorbedAt: null,
          metadata: {
            ...(typeof existingSource.metadata === "object" && existingSource.metadata !== null && !Array.isArray(existingSource.metadata)
              ? existingSource.metadata as Record<string, unknown>
              : {}),
            documentId: document.id,
            storageKey: params.storageKey,
            fileName: params.fileName,
            mimeType: params.mimeType,
            size: params.size,
            ...(params.metadata.extraction ? { extraction: params.metadata.extraction } : {}),
            ...(contentHash ? { contentHash } : {}),
            duplicateGuardUpdatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      : await tx.brainSource.create({
        data: {
          workspaceId: params.workspaceId,
          sourceType: "FILE_UPLOAD",
          tier: 2,
          content: mergedSourceContent,
          title: params.documentTitle,
          authorMemberId: params.authorMemberId ?? null,
          channel: params.source,
          ingestionGuidanceMd: params.ingestionGuidanceMd ?? null,
          fileStorageKey: params.storageKey,
          fileName: params.fileName,
          fileMimeType: params.mimeType,
          fileSizeBytes: params.size,
          metadata: {
            documentId: document.id,
            storageKey: params.storageKey,
            ...(params.metadata.extraction ? { extraction: params.metadata.extraction } : {}),
            ...(contentHash ? { contentHash } : {}),
          } as Prisma.InputJsonValue,
        },
      });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "document.updated",
        entityType: "Document",
        entityId: document.id,
        meta: { reason: "duplicate_guard_file_update" },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "document.updated",
        aggregateType: "Document",
        aggregateId: document.id,
        payload: { documentId: document.id, title: document.title, source: document.source },
      },
      {
        workspaceId: params.workspaceId,
        type: "brain-source.created",
        aggregateType: "BrainSource",
        aggregateId: source.id,
        payload: { sourceId: source.id },
      },
    ]);

    return { document, source };
  });
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
  let extraction: Record<string, unknown> | undefined;
  let contentHash: string | undefined;

  const mimeType = params.mimeType.split(";")[0]?.trim().toLowerCase() || "";
  const isPptxName = lowerName.endsWith(".pptx");
  const isPptxMime = mimeType === PPTX_MIME_TYPE;
  const isGenericMime = !mimeType || mimeType === "application/octet-stream";
  const isZipContainerMime = mimeType === "application/zip" || mimeType === "application/x-zip-compressed";
  const isSniffablePptxMime = isGenericMime || isZipContainerMime;
  const hasNamedExtension = /\.[^./]+$/.test(lowerName);
  if ((isPptxName && !isSniffablePptxMime && !isPptxMime) || (isPptxMime && hasNamedExtension && !isPptxName)) {
    throw new AppError(422, "PPTX_FILE_TYPE_MISMATCH", "The presentation filename and content type do not match.");
  }
  const looksLikeZip = params.fileBuffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const shouldTryPptx = isPptxName || isPptxMime || (isGenericMime && looksLikeZip);
  if (shouldTryPptx) {
    try {
      const result = await extractPptxTextCached({
        fileBuffer: params.fileBuffer,
        fileName,
        mimeType,
        maxExtractBytes,
        maxTextLength,
      });
      textContent = result.textContent;
      supported = true;
      truncated = result.extraction.truncated;
      extraction = result.extraction;
      contentHash = result.contentHash;
    } catch (error) {
      if (error instanceof PptxExtractionError && error.code === "NOT_PPTX" && !isPptxName && !isPptxMime) {
        // Generic binary ZIP uploads remain unsupported unless package validation proves PPTX.
      } else if (error instanceof PptxExtractionError) {
        const status = error.code === "FILE_TOO_LARGE" || error.code === "EXTRACTION_LIMIT_EXCEEDED"
          ? 413
          : error.code === "EXTRACTION_BUSY" || error.code === "EXTRACTION_FAILED"
            ? 503
            : 422;
        throw new AppError(status, `PPTX_${error.code}`, error.message);
      } else {
        throw new AppError(422, "PPTX_EXTRACTION_FAILED", "Presentation text extraction could not be completed safely.");
      }
    }
  }

  if (!supported && size <= maxExtractBytes) {
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
    contentHash,
    extraction: extraction ?? {
      supported,
      hasTextContent: Boolean(textContent?.trim()),
      truncated,
    },
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
  ingestionGuidanceMd?: string;
  duplicateGuard?: DuplicateGuardOptions | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const authorMemberId = params.authorMemberId || (actor.kind === "user" && !isGlobalOperator(actor) ? membership?.id : undefined);
  const fileName = params.fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "-") || "upload.bin";
  const source = params.uploadSource?.trim() || "upload";
  const documentTitle = params.documentTitle?.trim() || fileName;
  const ingestionGuidanceMd = optionalTrimmed(params.ingestionGuidanceMd);
  const size = params.fileBuffer.byteLength;
  const documentMetadata = asRecord(params.documentMetadata) ?? {};
  const sourceUrl = stringFromRecord(documentMetadata, "sourceUrl")
    ?? stringFromRecord(documentMetadata, "url")
    ?? stringFromRecord(documentMetadata, "externalUrl");

  // 0. Safety check: Prevent exceeding the 10GB free tier
  const usage = await getStorageUsageSummary(actor, params.workspaceId);
  if (usage.isOverLimit) {
    throw new AppError(403, "STORAGE_LIMIT_EXCEEDED", `Workspace storage exceeds the boundary maximum allowance. File ingestion is frozen.`);
  }

  // 1. Extract text before writing the blob so duplicate stops do not create orphaned storage.
  const { textContent, supported, truncated, extraction, contentHash: authoritativeContentHash } = await extractTextFromFileBuffer({
    fileBuffer: params.fileBuffer,
    fileName,
    mimeType: params.mimeType,
  });
  const brainSourceContent = buildBrainSourceContent({
    documentTitle,
    fileName,
    mimeType: params.mimeType,
    size,
    textContent,
    extractionSupported: supported,
    ingestionGuidanceMd,
  });
  const contentHash = uploadedContentHash(params.fileBuffer, textContent, authoritativeContentHash);
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Document",
    title: documentTitle,
    body: textContent ?? brainSourceContent,
    content: textContent ?? brainSourceContent,
    source,
    sourceUrl,
    contentHash,
  }, params.duplicateGuard);
  if (duplicateDecision?.resolution === "use_existing") {
    return loadDocumentWithSource(params.workspaceId, duplicateDecision.match.entityId);
  }
  if (duplicateDecision?.resolution === "update_existing") {
    const existing = await prisma.document.findFirst({
      where: {
        id: duplicateDecision.match.entityId,
        workspaceId: params.workspaceId,
        archivedAt: null,
      },
      select: { metadata: true },
    });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Document not found.");
    }
    await assertTrialStorageCapacity(
      params.workspaceId,
      Math.max(0, size - sizeFromMetadata(existing.metadata)),
    );
    const storageKey = `workspaces/${params.workspaceId}/uploads/${randomUUID()}/${fileName}`;
    await defaultStorage.put(storageKey, params.fileBuffer, { contentType: params.mimeType });
    try {
      return await updateDuplicateUploadedDocument(actor, {
        workspaceId: params.workspaceId,
        documentId: duplicateDecision.match.entityId,
        documentTitle,
        source,
        storageKey,
        fileName,
        mimeType: params.mimeType,
        size,
        textContent,
        brainSourceContent,
        contentHash,
        authoritativeContentHash,
        ingestionGuidanceMd,
        authorMemberId,
        metadata: {
          ...documentMetadata,
          extraction,
        },
      });
    } catch (error) {
      await defaultStorage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  await assertTrialStorageCapacity(params.workspaceId, size);

  // 2. Upload to Blob Storage
  const storageKey = `workspaces/${params.workspaceId}/uploads/${randomUUID()}/${fileName}`;
  await defaultStorage.put(storageKey, params.fileBuffer, { contentType: params.mimeType });

  try {
    return await prisma.$transaction(async (tx) => {
      await lockAndAssertTrialStorageCapacity(tx, params.workspaceId, size);
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
            ...documentMetadata,
            fileName,
            size,
            ...(contentHash ? { contentHash } : {}),
            ...(ingestionGuidanceMd ? { ingestionGuidanceMd } : {}),
            extraction,
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
          meta: { source, storageKey, ...duplicateGuardAuditMeta(duplicateDecision) },
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

      // 4. Ingest to Brain. Non-extractable files get a metadata stub instead of body text.
      const brainSource = await tx.brainSource.create({
        data: {
          workspaceId: params.workspaceId,
          sourceType: "FILE_UPLOAD",
          tier: 2,
          content: brainSourceContent,
          title: documentTitle,
          authorMemberId: authorMemberId || null,
          channel: source,
          ingestionGuidanceMd: ingestionGuidanceMd ?? null,
          fileStorageKey: storageKey,
          fileName,
          fileMimeType: params.mimeType,
          fileSizeBytes: size,
          metadata: {
            documentId: document.id,
            ...(contentHash ? { contentHash } : {}),
            extraction,
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
          meta: {
            sourceType: brainSource.sourceType,
            tier: brainSource.tier,
            hasIngestionGuidance: Boolean(ingestionGuidanceMd),
            hasExtractedText: Boolean(textContent?.trim()),
            extractionSupported: supported,
          },
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

      return { document, source: brainSource };
    });
  } catch (error) {
    await defaultStorage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}
