import { consumeMeetingTranscriptWorkflowClaim, type MeetingTranscriptWorkflowClaim } from "./native-meeting-workflow-claim";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { sealArtifactInputActor } from "./artifact-input-actor";
import { invariant } from "./errors";

export const MEETING_TRANSCRIPT_WORKER_JOB_TYPES = [
  "agent.meeting-summary", "meeting.insights.extract", "agent.action-extraction",
] as const;
export function isMeetingTranscriptWorkerJob(type: string) {
  return MEETING_TRANSCRIPT_WORKER_JOB_TYPES.some(candidate => candidate === type);
}

type Purpose = Readonly<{
  workspaceId: string; meetingId: string; jobId: string; owner: string; attempt: number;
  jobType: string; payload: string; transcriptManifestId: string; transcriptFingerprint: string;
  transcriptManifestStamp: string; nativeInputs: readonly Readonly<{id: string; fingerprint: string}>[];
}>;
const purposes = new WeakMap<AppActor, Purpose>();
const issuedActors = new WeakSet<AppActor>();
const stamp = (value: unknown) => createHash("sha256").update(serialize(value)).digest("hex");
export function getMeetingTranscriptWorkerPurpose(actor: AppActor, workspaceId: string) {
  const purpose = purposes.get(actor);
  return purpose?.workspaceId === workspaceId ? purpose : null;
}

type SelectionDb = Pick<Prisma.TransactionClient, "meeting" | "artifactInputLineage">;
async function selection(db: SelectionDb, workspaceId: string, meetingId: string) {
  const meeting = await db.meeting.findFirst({where: {id: meetingId, workspaceId, archivedAt: null}});
  const manifest = await db.artifactInputLineage.findFirst({where: {workspaceId,
    artifactType: "MeetingTranscript", artifactId: meetingId}, orderBy: {revision: "desc"}});
  if (!meeting?.transcript || !manifest || !["HUMAN_ORIGINAL", "DERIVED"].includes(manifest.origin)) return null;
  const {lineageContentFingerprint} = await import("./source-lineage");
  const {meetingTranscriptInputProjection} = await import("./meeting-intelligence-context");
  const fingerprint = lineageContentFingerprint("MeetingTranscript", meetingTranscriptInputProjection(meeting));
  return manifest.contentHash === fingerprint ? {manifest, fingerprint} : null;
}

/** Execution authority only. Native readers separately check the original receipt,
 * company audience, complete epochs and current category/provider permission. */
export async function isMeetingTranscriptWorkerCurrent(actor: AppActor, workspaceId: string,
  selected: {meetingId: string; inputId?: string}, tx?: Prisma.TransactionClient) {
  const purpose = getMeetingTranscriptWorkerPurpose(actor, workspaceId);
  if (!purpose || purpose.meetingId !== selected.meetingId
    || (selected.inputId && !purpose.nativeInputs.some(input => input.id === selected.inputId))) return false;
  const query = Prisma.sql`SELECT id FROM "WorkflowJob" WHERE id=${purpose.jobId}
    AND "workspaceId"=${workspaceId} AND type=${purpose.jobType} AND status='RUNNING'
    AND attempts=${purpose.attempt} AND "lockedBy"=${purpose.owner}
    AND "lockedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
    AND payload=${purpose.payload}::jsonb`;
  const rows = tx ? await tx.$queryRaw<Array<{id: string}>>(Prisma.sql`${query} FOR SHARE`)
    : await prisma.$queryRaw<Array<{id: string}>>(query);
  if (rows.length !== 1) return false;
  const fallback: SelectionDb = prisma;
  const current = await selection(tx ?? fallback, workspaceId, selected.meetingId);
  return current?.manifest.id === purpose.transcriptManifestId
    && current.fingerprint === purpose.transcriptFingerprint
    && stamp(current.manifest) === purpose.transcriptManifestStamp;
}

export async function assertMeetingTranscriptWorkerCurrent(actor: AppActor, workspaceId: string, tx?: Prisma.TransactionClient) {
  const purpose = getMeetingTranscriptWorkerPurpose(actor, workspaceId);
  if (issuedActors.has(actor)) invariant(purpose && await isMeetingTranscriptWorkerCurrent(actor, workspaceId, {meetingId: purpose.meetingId}, tx),
    409, "MEETING_WORKFLOW_JOB_LOST", "The claimed Meeting workflow or its selected transcript changed.");
}

/** Labels, serialized copies, authors and payload job IDs cannot mint this capability. */
export async function withMeetingTranscriptWorker<T>(params: {
  workspaceId: string; meetingId: string; jobId: string; owner: string; attempt: number;
  claim: MeetingTranscriptWorkflowClaim | undefined;
}, work: (actor: AppActor) => Promise<T>): Promise<T> {
  const binding = consumeMeetingTranscriptWorkflowClaim(params.claim);
  invariant(binding && binding.workspaceId === params.workspaceId && binding.jobId === params.jobId
    && binding.owner === params.owner && binding.attempt === params.attempt,
  409, "MEETING_WORKFLOW_JOB_LOST", "An opaque claim from the actual outbox is required.");
  invariant(params.owner && Number.isSafeInteger(params.attempt) && params.attempt > 0,
    409, "MEETING_WORKFLOW_JOB_LOST", "A current claimed Meeting workflow is required.");
  const job = await prisma.workflowJob.findFirst({where: {id: params.jobId, workspaceId: params.workspaceId}});
  invariant(job && job.type === binding.jobType && JSON.stringify(job.payload) === binding.payload
    && isMeetingTranscriptWorkerJob(job.type)
    && (job.payload as {meetingId?: unknown} | null)?.meetingId === params.meetingId,
  409, "MEETING_WORKFLOW_JOB_LOST", "The claimed workflow does not select this Meeting.");
  const claimed = await prisma.$queryRaw<Array<{id: string}>>`SELECT id FROM "WorkflowJob"
    WHERE id=${params.jobId} AND "workspaceId"=${params.workspaceId} AND type=${job.type}
      AND status='RUNNING' AND attempts=${params.attempt} AND "lockedBy"=${params.owner}
      AND "lockedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
      AND payload=${JSON.stringify(job.payload)}::jsonb`;
  invariant(claimed.length === 1, 409, "MEETING_WORKFLOW_JOB_LOST", "The Meeting workflow claim is no longer current.");
  const current = await selection(prisma, params.workspaceId, params.meetingId);
  invariant(current, 409, "MEETING_TRANSCRIPT_UNPROVED", "The Meeting has no current committed transcript receipt.");
  const {inspectStoredArtifactInputDependencies} = await import("./source-lineage");
  const dependencies = await inspectStoredArtifactInputDependencies(prisma, params.workspaceId,
    [{kind: "MeetingTranscript", id: params.meetingId, fingerprint: current.fingerprint}], {maxNodes: 10_000});
  const nativeInputs = dependencies.roots.filter(root => root.kind === "NativeTranscriptInput")
    .map(root => Object.freeze({id: root.id, fingerprint: root.fingerprint}));
  invariant(dependencies.complete,
    409, "MEETING_TRANSCRIPT_UNPROVED", "The transcript has no complete proved ancestry.");
  const actor = sealArtifactInputActor({kind: "agent", authProvider: "bootstrap",
    label: "meeting-transcript-workflow", workspaceIds: [params.workspaceId], scopes: ["meetings:write"]});
  const purpose: Purpose = Object.freeze({workspaceId: params.workspaceId, meetingId: params.meetingId, jobId: params.jobId,
    owner: params.owner, attempt: params.attempt, jobType: job.type, payload: binding.payload,
    transcriptManifestId: current.manifest.id, transcriptFingerprint: current.fingerprint,
    transcriptManifestStamp: stamp(current.manifest), nativeInputs: Object.freeze(nativeInputs)});
  purposes.set(actor, purpose);
  issuedActors.add(actor);
  let pending: Promise<void> | undefined;
  const renew = async () => {
    const updated = await prisma.$executeRaw`UPDATE "WorkflowJob" SET "lockedAt"=(clock_timestamp() AT TIME ZONE 'UTC')
      WHERE id=${purpose.jobId} AND "workspaceId"=${purpose.workspaceId} AND type=${purpose.jobType}
      AND status='RUNNING' AND attempts=${purpose.attempt} AND "lockedBy"=${purpose.owner}
      AND "lockedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
      AND payload=${purpose.payload}::jsonb`;
    if (updated !== 1) purposes.delete(actor);
  };
  const timer = setInterval(() => {
    if (!pending) pending = renew().catch(() => {purposes.delete(actor);}).finally(() => {pending = undefined;});
  }, 60_000);
  timer.unref();
  try {
    await assertMeetingTranscriptWorkerCurrent(actor, params.workspaceId);
    const {parsePermissionEpochProof} = await import("./source-permission-epochs");
    const permissionEpochs = current.manifest.epochProofVersion === 1
      ? parsePermissionEpochProof(current.manifest.permissionEpochsJson) : null;
    const {isArtifactInputProofReadable} = await import("./source-lineage");
    invariant(permissionEpochs && await isArtifactInputProofReadable(actor, params.workspaceId,
      [{kind: "MeetingTranscript", id: params.meetingId, fingerprint: current.fingerprint, permissionEpochs}]),
    409, "MEETING_TRANSCRIPT_RESTRICTED", "The claimed workflow cannot use the selected transcript.");
    await assertMeetingTranscriptWorkerCurrent(actor, params.workspaceId);
    return await work(actor);
  } finally { clearInterval(timer); await pending; purposes.delete(actor); }
}
