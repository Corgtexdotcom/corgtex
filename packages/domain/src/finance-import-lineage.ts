import type { FinanceImportBatch, Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { requireFinanceReportImportHumanWriteAccess } from "./finance";
import { captureArtifactInputProof, isArtifactInputProofReadable, type LineageRoot } from "./source-lineage";

export type FinanceExtractionLease = { lockedBy: string; lockedAt: Date };
export type FinanceExtractionReceipt = Readonly<{ kind: "FINANCE_REPORT_EXTRACTION" }>;
type ReceiptState = {
  actor: AppActor; workspaceId: string; batchId: string; workflowJobId: string;
  version: number; attempts: number; expectedLease: FinanceExtractionLease; roots: LineageRoot[];
};
const receipts = new WeakMap<FinanceExtractionReceipt, ReceiptState>();

export async function captureFinanceUploadInputs(actor: AppActor, batch: FinanceImportBatch, tx: Prisma.TransactionClient = prisma) {
  await requireFinanceReportImportHumanWriteAccess(actor, batch.workspaceId);
  invariant(actor.kind === "user", 403, "HUMAN_REVIEW_REQUIRED", "A human Finance writer is required.");
  const input = await tx.financeReportUploadInput.findFirst({ where: { workspaceId: batch.workspaceId, batchId: batch.id } });
  invariant(input && input.uploadedByUserId === batch.uploadedByUserId && input.documentId === batch.documentId
    && input.brainSourceId === batch.brainSourceId && input.fileHash === batch.fileHash
    && input.mimeType === batch.mimeType && input.fileSizeBytes === batch.fileSizeBytes && input.originalFilename === batch.originalFilename,
  409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report has no verified upload input.");
  const [document, source] = await Promise.all([
    tx.document.findFirst({ where: { id: input.documentId, workspaceId: batch.workspaceId } }),
    tx.brainSource.findFirst({ where: { id: input.brainSourceId, workspaceId: batch.workspaceId } }),
  ]);
  invariant(document && source && document.storageKey === input.storageKey && source.fileStorageKey === input.storageKey
    && document.mimeType === input.mimeType && source.fileMimeType === input.mimeType && source.fileSizeBytes === input.fileSizeBytes,
  409, "FINANCE_REPORT_FILE_CHANGED", "The report upload identity changed.");
  await captureArtifactInputProof(actor, batch.workspaceId, [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx);
  const roots = await captureArtifactInputProof(actor, batch.workspaceId, [
    { kind: "FinanceReportUploadInput", id: input.id, snapshot: input },
    { kind: "Document", id: document.id, snapshot: document },
    { kind: "BrainSource", id: source.id, snapshot: source },
  ], tx);
  return { actor, input, document, source, roots };
}

/** The immutable input was minted only by the authenticated upload transaction. */
export async function resolveFinanceUploadInputs(batch: FinanceImportBatch, tx: Prisma.TransactionClient) {
  const input = await tx.financeReportUploadInput.findFirst({ where: { workspaceId: batch.workspaceId, batchId: batch.id } });
  invariant(input, 409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report has no verified upload input.");
  const user = await tx.user.findUnique({ where: { id: input.uploadedByUserId },
    select: { id: true, email: true, displayName: true, globalRole: true, isSupportAccount: true } });
  invariant(user, 409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report uploader is no longer available.");
  return captureFinanceUploadInputs({ kind: "user", user }, batch, tx);
}

export async function assertFinanceExtractionLease(tx: Prisma.TransactionClient, params: {
  workspaceId: string; batchId: string; workflowJobId: string; attempts: number; expectedLease?: FinanceExtractionLease;
}) {
  const lease = params.expectedLease;
  invariant(lease?.lockedBy && lease.lockedAt instanceof Date && Number.isFinite(lease.lockedAt.valueOf()),
    409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report worker lease is unavailable.");
  // Hold the exact job lease row through every transaction containing effects.
  await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id = ${params.workflowJobId} AND "workspaceId" = ${params.workspaceId} FOR UPDATE`;
  const job = await tx.workflowJob.findFirst({ where: { id: params.workflowJobId, workspaceId: params.workspaceId } });
  invariant(job && job.type === "finance-report-import.extract" && job.status === "RUNNING"
    && job.attempts === params.attempts && job.lockedBy === lease.lockedBy
    && job.lockedAt?.valueOf() === lease.lockedAt.valueOf()
    && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) && job.payload.batchId === params.batchId,
  409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The report worker lease changed.");
}

/** Internal minting reloads authority itself; serialized actors and roots are never accepted. */
export async function createFinanceExtractionReceipt(tx: Prisma.TransactionClient, identity: {
  workspaceId: string; batchId: string; workflowJobId: string; version: number;
  attempts: number; expectedLease: FinanceExtractionLease;
}): Promise<FinanceExtractionReceipt> {
  await assertFinanceExtractionLease(tx, identity);
  const batch = await tx.financeImportBatch.findUnique({ where: { id_workspaceId: { id: identity.batchId, workspaceId: identity.workspaceId } } });
  invariant(batch && batch.stage === "EXTRACTING" && batch.version === identity.version && batch.workflowJobId === identity.workflowJobId,
    409, "FINANCE_REPORT_EXTRACTION_CONFLICT", "The Finance report extraction changed. Please retry.");
  const captured = await resolveFinanceUploadInputs(batch, tx);
  const batchRoots = await captureArtifactInputProof(captured.actor, identity.workspaceId,
    [{ kind: "FinanceImportBatch", id: batch.id, snapshot: batch }], tx);
  const receipt = Object.freeze({ kind: "FINANCE_REPORT_EXTRACTION" as const });
  receipts.set(receipt, { ...identity, actor: captured.actor, roots: structuredClone([...captured.roots, ...batchRoots]),
    expectedLease: { ...identity.expectedLease, lockedAt: new Date(identity.expectedLease.lockedAt) } });
  return receipt;
}

export async function validateFinanceExtractionReceipt(receipt: FinanceExtractionReceipt | undefined,
  identity: { workspaceId: string; batchId: string; workflowJobId: string; expectedVersion: number }, tx: Prisma.TransactionClient) {
  const state = receipt && receipts.get(receipt);
  invariant(state && state.workspaceId === identity.workspaceId && state.batchId === identity.batchId
    && state.workflowJobId === identity.workflowJobId && state.version === identity.expectedVersion,
  409, "FINANCE_REPORT_SOURCE_NOT_READY", "The report input receipt is unavailable.");
  await assertFinanceExtractionLease(tx, state);
  await requireFinanceReportImportHumanWriteAccess(state.actor, state.workspaceId);
  invariant(await isArtifactInputProofReadable(state.actor, state.workspaceId, state.roots, tx),
    409, "SOURCE_CHANGED", "The report inputs or permissions changed.");
  return state;
}
