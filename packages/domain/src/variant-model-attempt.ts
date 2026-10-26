import { createHash } from "node:crypto";
import type { WorkflowJob } from "@prisma/client";
import { invariant } from "./errors";

/** Server-owned controls, structurally compatible with the model gateway contract. */
export type VariantGenerationControls = Readonly<{
  signal: AbortSignal;
  authorizeAttempt: (context: Readonly<{ signal: AbortSignal }>) => Promise<void>;
}>;

type GenerationJob = Pick<WorkflowJob, "id" | "workspaceId" | "type" | "status" | "attempts" | "lockedBy" | "lockedAt" | "startedAt"> & { payload: unknown };

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function variantGenerationClaimStamp(job: GenerationJob): string {
  return createHash("sha256").update(JSON.stringify(canonical([job.id, job.workspaceId, job.type, job.status,
    job.attempts, job.lockedBy, job.lockedAt, job.startedAt, job.payload]))).digest("hex");
}

/** Match the captured generation claim; this does not renew an expired worker lease. */
export function assertVariantGenerationClaim(stamp: string, job: GenerationJob | null): void {
  invariant(job && job.status === "RUNNING" && job.lockedBy && job.lockedAt instanceof Date
    && Number.isFinite(job.lockedAt.getTime()) && job.lockedAt.getTime() > Date.now() - 5 * 60_000
    && variantGenerationClaimStamp(job) === stamp,
  409, "SOURCE_CHANGED", "The variant generation claim is no longer current.");
}

export function createVariantModelControls(assertCurrent: () => Promise<void>) {
  const controller = new AbortController();
  const controls: VariantGenerationControls = Object.freeze({
    signal: controller.signal,
    authorizeAttempt: async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
      try {
        controller.signal.throwIfAborted();
        signal.throwIfAborted();
        await assertCurrent();
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    },
  });
  return { controls, assertActive: () => controller.signal.throwIfAborted() };
}
