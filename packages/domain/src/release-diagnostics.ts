import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";

export const RELEASE_DIAGNOSTIC_JOB_TYPE = "runtime.release-diagnostic.v1";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const releaseDiagnosticRequestSchema = z.object({
  operationId: z.string().uuid(), expectedGitSha: sha,
}).strict();
export const releaseDiagnosticPayloadSchema = releaseDiagnosticRequestSchema.extend({
  schemaVersion: z.literal(1), jobId: z.string().uuid(), workspaceId: z.string().uuid(),
  nonce: z.string().uuid(), webGitSha: sha,
}).strict();
export const releaseDiagnosticReceiptSchema = releaseDiagnosticPayloadSchema.extend({
  workerGitSha: sha, workerId: z.string().min(1).max(200), completedAt: z.string().datetime(),
}).strict();
export type ReleaseDiagnosticRequest = z.infer<typeof releaseDiagnosticRequestSchema>;

// This file is written during image construction, never from runtime configuration.
// Missing identity in older/local images is an explicit unsupported capability.
export function readReleaseBuildSha(role: "web" | "worker") {
  let value: unknown;
  try { value = JSON.parse(readFileSync("/app/release-build.json", "utf8")); } catch { value = null; }
  const result = z.object({ schemaVersion: z.literal(1), role: z.literal(role), gitSha: sha }).strict().safeParse(value);
  invariant(result.success, 409, "RELEASE_BUILD_UNAVAILABLE", "Immutable release build identity is unavailable.");
  return result.data.gitSha;
}

async function requireDiagnosticAccess(actor: AppActor, workspaceId: string, write: boolean) {
  if (actor.kind === "agent" && actor.authProvider !== "bootstrap") {
    invariant(actor.scopes?.includes(write ? "runtime:write" : "runtime:read"), 403, "FORBIDDEN", "Runtime permission is required.");
  }
  await requireWorkspaceMembership({ actor, workspaceId, ...(actor.kind === "user" ? { allowedRoles: ["ADMIN", "FACILITATOR"] as ("ADMIN" | "FACILITATOR")[] } : {}) });
}

function diagnosticView(job: { id: string; workspaceId: string | null; type: string; status: string; payload: unknown }, request: ReleaseDiagnosticRequest) {
  const raw = job.payload as Record<string, unknown> | null;
  const { receipt: rawReceipt, ...input } = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const payload = releaseDiagnosticPayloadSchema.safeParse(input);
  invariant(payload.success && job.type === RELEASE_DIAGNOSTIC_JOB_TYPE && payload.data.jobId === job.id
    && payload.data.workspaceId === job.workspaceId && payload.data.operationId === request.operationId
    && payload.data.expectedGitSha === request.expectedGitSha, 409, "RELEASE_DIAGNOSTIC_CONFLICT", "Diagnostic identity does not match the operation.");
  const receipt = releaseDiagnosticReceiptSchema.safeParse(rawReceipt);
  const accepted = job.status === "COMPLETED" && receipt.success
    && Object.entries(payload.data).every(([key, value]) => receipt.data[key as keyof typeof receipt.data] === value)
    && receipt.data.workerGitSha === request.expectedGitSha && payload.data.webGitSha === request.expectedGitSha;
  return { jobId: job.id, workspaceId: job.workspaceId, operationId: request.operationId,
    nonce: payload.data.nonce, expectedGitSha: request.expectedGitSha, webGitSha: payload.data.webGitSha,
    status: job.status, accepted, receipt: accepted && receipt.success ? receipt.data : null };
}

export async function dispatchReleaseDiagnostic(actor: AppActor, workspaceId: string, input: ReleaseDiagnosticRequest) {
  await requireDiagnosticAccess(actor, workspaceId, true);
  const request = releaseDiagnosticRequestSchema.parse(input);
  const webGitSha = readReleaseBuildSha("web");
  invariant(webGitSha === request.expectedGitSha, 409, "RELEASE_BUILD_MISMATCH", "The serving web build differs from the requested release.");
  const id = randomUUID();
  const payload = { ...request, schemaVersion: 1 as const, jobId: id, workspaceId, nonce: randomUUID(), webGitSha };
  // A lost response is retried with the same operation ID. Upsert never replaces
  // the original nonce/job or schedules a second diagnostic.
  const job = await prisma.workflowJob.upsert({
    where: { dedupeKey: `${RELEASE_DIAGNOSTIC_JOB_TYPE}:${workspaceId}:${request.operationId}` }, update: {},
    create: { id, workspaceId, type: RELEASE_DIAGNOSTIC_JOB_TYPE, payload,
      dedupeKey: `${RELEASE_DIAGNOSTIC_JOB_TYPE}:${workspaceId}:${request.operationId}` },
    select: { id: true, workspaceId: true, type: true, status: true, payload: true },
  });
  return diagnosticView(job, request);
}

export async function getReleaseDiagnostic(actor: AppActor, workspaceId: string, input: ReleaseDiagnosticRequest) {
  await requireDiagnosticAccess(actor, workspaceId, false);
  const request = releaseDiagnosticRequestSchema.parse(input);
  const webGitSha = readReleaseBuildSha("web");
  invariant(webGitSha === request.expectedGitSha, 409, "RELEASE_BUILD_MISMATCH", "The serving web build differs from the requested release.");
  const job = await prisma.workflowJob.findUnique({
    where: { dedupeKey: `${RELEASE_DIAGNOSTIC_JOB_TYPE}:${workspaceId}:${request.operationId}` },
    select: { id: true, workspaceId: true, type: true, status: true, payload: true },
  });
  invariant(job && job.workspaceId === workspaceId, 404, "NOT_FOUND", "Release diagnostic not found.");
  return diagnosticView(job, request);
}
