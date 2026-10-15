import { NextRequest, NextResponse } from "next/server";
import { AppError, captureArtifactInputProof, isArtifactInputProofReadable, getWorkspaceSupportGrant, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { getSupportAuthorizationContext, prisma, runWithSupportOrigin } from "@corgtex/shared";
import { defaultStorage } from "@corgtex/storage";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { authorizedDownloadStream, MAX_BOUND_DOWNLOAD_BYTES, type DownloadByteBinding } from "@/lib/authorized-download-stream";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; sourceId: string }> }
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, sourceId } = await params;
    const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
    const origin = getSupportAuthorizationContext()?.origin ?? (actor.kind === "agent" ? actor.supportOrigin : undefined);

    const source = await prisma.brainSource.findFirst({
      where: {
        id: sourceId,
        workspaceId,
        archivedAt: null,
        accessDomain: { in: accessDomains },
      },
    });

    if (!source || !source.fileStorageKey) {
      throw new AppError(404, "NOT_FOUND", "File not found for this source.");
    }
    let roots = await captureArtifactInputProof(actor, workspaceId, [{ kind: "BrainSource", id: sourceId, snapshot: source }]);

    if (origin || (actor.kind === "user" && await getWorkspaceSupportGrant(actor, workspaceId))) {
      if (!origin || origin.workspaceId !== workspaceId || (actor.kind === "user" && origin.userId !== actor.user.id)) {
        throw new AppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
      }
    }
    const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {};
    const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
    let binding: DownloadByteBinding;
    if (validHash(metadata.fileContentHash) && Number.isSafeInteger(source.fileSizeBytes) && source.fileSizeBytes !== null && source.fileSizeBytes >= 0) {
      binding = { sha256: metadata.fileContentHash, sizeBytes: source.fileSizeBytes };
    } else {
      // Finance uploads have a separate immutable raw-byte input; normalized
      // extracted text hashes or arbitrary metadata.fileHash are not byte proof.
      if (source.accessDomain !== "FINANCE") {
        const { legacyRecoveryFileBinding } = await import("@corgtex/domain");
        const recovered = metadata.fileContentHash === undefined ? await legacyRecoveryFileBinding(actor, workspaceId, source.id) : null;
        if (!recovered) throw new AppError(404, "SOURCE_FILE_UNPROVEN", "The file has no verified byte identity.");
        binding = recovered;
      } else {
      if (metadata.fileContentHash !== undefined) throw new AppError(404, "SOURCE_FILE_UNPROVEN", "The file has no verified byte identity.");
      const upload = await prisma.financeReportUploadInput.findFirst({ where: { workspaceId, brainSourceId: source.id } });
      if (!upload || !validHash(upload.fileHash) || upload.storageKey !== source.fileStorageKey
        || upload.mimeType !== source.fileMimeType || upload.fileSizeBytes !== source.fileSizeBytes
        || upload.originalFilename !== source.fileName || !Number.isSafeInteger(upload.fileSizeBytes) || upload.fileSizeBytes < 0
        || (metadata.financeImportBatchId !== undefined && metadata.financeImportBatchId !== upload.batchId)
        || (metadata.fileHash !== undefined && metadata.fileHash !== upload.fileHash)) {
        throw new AppError(404, "SOURCE_FILE_UNPROVEN", "The file has no verified upload identity.");
      }
      const document = await prisma.document.findFirst({ where: { id: upload.documentId, workspaceId, archivedAt: null, accessDomain: "FINANCE" } });
      if (!document || document.storageKey !== upload.storageKey || document.mimeType !== upload.mimeType) throw new AppError(404, "SOURCE_FILE_UNPROVEN", "The file has no verified upload identity.");
      roots = [...roots, ...await captureArtifactInputProof(actor, workspaceId, [
        { kind: "FinanceReportUploadInput", id: upload.id, snapshot: upload },
        { kind: "Document", id: document.id, snapshot: document },
      ])];
      binding = { sha256: upload.fileHash, sizeBytes: upload.fileSizeBytes };
      }
    }
    if (binding.sizeBytes > MAX_BOUND_DOWNLOAD_BYTES) throw new AppError(413, "DOWNLOAD_TOO_LARGE", "The file exceeds the download byte limit.");
    const authorize = async () => {
      if (!await isArtifactInputProofReadable(actor, workspaceId, roots)) throw new AppError(404, "NOT_FOUND", "File not found for this source.");
    };
    await authorize();
    request.signal.throwIfAborted();
    let file;
    try { file = await defaultStorage.getStream(source.fileStorageKey, { signal: request.signal }); }
    catch {
      request.signal.throwIfAborted();
      throw new AppError(502, "DOWNLOAD_FAILED", "File download failed.");
    }
    if (!file) throw new AppError(404, "NOT_FOUND", "File not found.");
    const body = await authorizedDownloadStream(file.body,
      () => origin ? runWithSupportOrigin(origin, authorize) : authorize(), request.signal, { authorizeEveryDelivery: true, byteBinding: binding });
    return new NextResponse(body, { headers: {
      "Content-Type": "application/octet-stream", "Content-Disposition": "attachment",
      "Content-Length": String(binding.sizeBytes),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    return handleRouteError(error);
  }
}
