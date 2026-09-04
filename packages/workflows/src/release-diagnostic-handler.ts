import { prisma } from "@corgtex/shared";
import { readReleaseBuildSha, RELEASE_DIAGNOSTIC_JOB_TYPE, releaseDiagnosticPayloadSchema, releaseDiagnosticReceiptSchema } from "@corgtex/domain";
import { invariant } from "@corgtex/domain";

export async function handleReleaseDiagnostic(job: { id: string; workspaceId: string | null; payload: unknown }, workerId: string) {
  const payload = releaseDiagnosticPayloadSchema.parse(job.payload);
  invariant(payload.jobId === job.id && payload.workspaceId === job.workspaceId, 409, "RELEASE_DIAGNOSTIC_CONFLICT", "Diagnostic job identity changed.");
  const workerGitSha = readReleaseBuildSha("worker");
  invariant(workerGitSha === payload.expectedGitSha && payload.webGitSha === payload.expectedGitSha,
    409, "RELEASE_BUILD_MISMATCH", "The worker build differs from the requested release.");
  const completedAt = new Date();
  const receipt = releaseDiagnosticReceiptSchema.parse({ ...payload, workerGitSha, workerId, completedAt: completedAt.toISOString() });
  // Completion and the handler-specific receipt are one fenced durable write.
  // A copied payload, expired worker lock or generic unknown-job completion cannot pass.
  const result = await prisma.workflowJob.updateMany({
    where: { id: job.id, workspaceId: payload.workspaceId, type: RELEASE_DIAGNOSTIC_JOB_TYPE,
      status: "RUNNING", lockedBy: workerId, payload: { equals: payload } },
    data: { payload: { ...payload, receipt }, status: "COMPLETED", completedAt, lockedAt: null, lockedBy: null, error: null },
  });
  invariant(result.count === 1, 409, "RELEASE_DIAGNOSTIC_OWNERSHIP_LOST", "Diagnostic worker no longer owns the job.");
}
