/** Internal transport from the real outbox UPDATE RETURNING. This module is not
 * exported from the domain package and must not be used by request/model adapters. */
declare const claimBrand: unique symbol;
export type MeetingTranscriptWorkflowClaim = Readonly<{[claimBrand]: true}>;
type ClaimedJob = Readonly<{id: string; workspaceId: string | null; type: string;
  payload: unknown; attempts: number; lockedBy: string; lockedAt: Date}>;
type Binding = Readonly<{jobId: string; workspaceId: string | null; jobType: string;
  payload: string; attempt: number; owner: string}>;
const claims = new WeakMap<MeetingTranscriptWorkflowClaim, Binding>();

/** Called only on actual successfully claimed rows, never reconstructed job JSON. */
export function registerClaimedMeetingTranscriptWorkflow(job: ClaimedJob): MeetingTranscriptWorkflowClaim {
  const claim = Object.freeze({}) as MeetingTranscriptWorkflowClaim;
  claims.set(claim, Object.freeze({jobId: job.id, workspaceId: job.workspaceId, jobType: job.type,
    payload: JSON.stringify(job.payload), attempt: job.attempts, owner: job.lockedBy}));
  return claim;
}
export function consumeMeetingTranscriptWorkflowClaim(claim: MeetingTranscriptWorkflowClaim | undefined) {
  if (!claim) return null;
  const binding = claims.get(claim) ?? null;
  claims.delete(claim);
  return binding;
}
export function revokeMeetingTranscriptWorkflowClaim(claim: MeetingTranscriptWorkflowClaim | undefined) {
  if (claim) claims.delete(claim);
}
