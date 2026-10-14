import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { invariant } from "./errors";
import { sealArtifactInputActor } from "./artifact-input-actor";

type Purpose = Readonly<{workspaceId: string; sourceId: string; receiptId: string; jobId: string; owner: string; attempt: number; payload: string}>;
const purposes = new WeakMap<AppActor, Purpose>();
export function getBrainExportWorkerPurpose(actor: AppActor, workspaceId: string) {
  const purpose = purposes.get(actor);
  return purpose?.workspaceId === workspaceId ? purpose : null;
}
/** Live execution authority, never a durable source permission or an impersonated author. */
export async function isBrainExportWorkerCurrent(actor: AppActor, workspaceId: string, receiptId: string,
  db: Prisma.TransactionClient = prisma) {
  const purpose = getBrainExportWorkerPurpose(actor, workspaceId);
  if (!purpose || purpose.receiptId !== receiptId) return false;
  const rows = await db.$queryRaw<Array<{id: string}>>(Prisma.sql`SELECT id FROM "WorkflowJob" WHERE id=${purpose.jobId}
    AND "workspaceId"=${workspaceId} AND type='agent.brain-absorb' AND status='RUNNING'
    AND attempts=${purpose.attempt} AND "lockedBy"=${purpose.owner}
    AND "lockedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
    AND payload=${purpose.payload}::jsonb ${db === prisma ? Prisma.empty : Prisma.sql`FOR SHARE`}`);
  return rows.length === 1;
}
export async function assertBrainExportWorkerCurrent(actor: AppActor, workspaceId: string, db: Prisma.TransactionClient = prisma) {
  const purpose = getBrainExportWorkerPurpose(actor, workspaceId);
  if (purpose) invariant(await isBrainExportWorkerCurrent(actor, workspaceId, purpose.receiptId, db),
    409, "BRAIN_EXPORT_JOB_LOST", "The confirmed Brain export job is no longer current.");
}
/** Only a real claimed job selecting an authenticated export can mint this purpose.
 * Labels, payload flags, serialized actor copies and source author IDs cannot. */
export async function withBrainExportWorker<T>(params: {workspaceId: string; sourceId: string; jobId: string; owner: string; attempt: number},
  work: (actor: AppActor) => Promise<T>): Promise<T> {
  invariant(params.owner && Number.isSafeInteger(params.attempt) && params.attempt > 0, 409, "BRAIN_EXPORT_JOB_LOST", "A claimed export job is required.");
  const job = await prisma.workflowJob.findFirst({where: {id: params.jobId, workspaceId: params.workspaceId, type: "agent.brain-absorb"}});
  const payload = job?.payload as Record<string, unknown> | null;
  invariant(job && payload?.sourceId === params.sourceId, 409, "BRAIN_EXPORT_JOB_LOST", "The export job does not select this source.");
  const source = await prisma.brainSource.findFirst({where: {id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null}});
  const metadata = source?.metadata as Record<string, unknown> | null;
  invariant(source?.channel === "chat-consent" && typeof metadata?.brainExportReceiptId === "string",
    409, "BRAIN_CONSENT_REQUIRED", "An authenticated output receipt is required.");
  const receipt = await prisma.conversationOperationOutcome.findFirst({where: {id: metadata.brainExportReceiptId, workspaceId: params.workspaceId}});
  const {decodeBrainExportConsent} = await import("./conversation-brain-consent");
  const consent = receipt && decodeBrainExportConsent(receipt);
  invariant(consent?.sourceId === source.id, 409, "BRAIN_CONSENT_REQUIRED", "The output receipt does not bind this source.");
  const actor = sealArtifactInputActor({kind: "agent", authProvider: "bootstrap", label: "brain-absorb", workspaceIds: [params.workspaceId]});
  const purpose: Purpose = Object.freeze({...params, receiptId: consent.receiptId, payload: JSON.stringify(job.payload)});
  purposes.set(actor, purpose);
  let pending: Promise<void> | undefined;
  const renew = async () => {
    const updated = await prisma.$executeRaw`UPDATE "WorkflowJob" SET "lockedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
      WHERE id=${purpose.jobId} AND "workspaceId"=${purpose.workspaceId} AND type='agent.brain-absorb'
      AND status='RUNNING' AND attempts=${purpose.attempt} AND "lockedBy"=${purpose.owner}
      AND "lockedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes' AND payload=${purpose.payload}::jsonb`;
    if (updated !== 1) purposes.delete(actor);
  };
  const timer = setInterval(() => { if (!pending) pending = renew().catch(() => {purposes.delete(actor);}).finally(() => {pending = undefined;}); }, 60_000);
  timer.unref();
  try {
    invariant(await isBrainExportWorkerCurrent(actor, params.workspaceId, consent.receiptId), 409, "BRAIN_EXPORT_JOB_LOST", "The confirmed export claim is no longer current.");
    return await work(actor);
  } finally { clearInterval(timer); await pending; purposes.delete(actor); }
}
