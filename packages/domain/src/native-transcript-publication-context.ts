import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";
import type { LineageRoot } from "./source-lineage";
import type { PermissionEpochProof } from "./source-permission-epochs";

// Private process capability state only. No database, model, extractor or publisher
// module is loaded by ordinary authorization checking whether a scope exists.
export type CompanyTranscriptPublicationHooks = { before(tx: Prisma.TransactionClient): Promise<void>; after(tx: Prisma.TransactionClient, meetingId: string): Promise<void> };
type Scope = { actor: AppActor; workspaceId: string; inputId: string; fingerprint: string;
  roots: readonly LineageRoot[]; hooks?: CompanyTranscriptPublicationHooks; callerEpochs: PermissionEpochProof; active: boolean; published: boolean };
const scopes = new AsyncLocalStorage<Scope>();

/** Internal authenticated receipt scope. No serialized input can mint this purpose. */
export async function withCompanyTranscriptPublication<T>(params: Omit<Scope, "active" | "published">, work: () => Promise<T>) {
  const scope: Scope = { ...params, active: true, published: false };
  try { return await scopes.run(scope, work); }
  finally { scope.active = false; }
}
export function currentCompanyTranscriptPublicationScope(actor: AppActor, workspaceId: string, inputId?: string) {
  const scope = scopes.getStore();
  return scope?.active && scope.actor === actor && scope.workspaceId === workspaceId
    && (!inputId || scope.inputId === inputId) ? scope : null;
}
export function hasCompanyTranscriptPublicationScope(actor: AppActor, workspaceId: string) { return Boolean(currentCompanyTranscriptPublicationScope(actor, workspaceId)); }
export function hasPendingCompanyTranscript(actor: AppActor, workspaceId: string, inputId: string) {
  const scope = currentCompanyTranscriptPublicationScope(actor, workspaceId, inputId);
  return Boolean(scope && !scope.published);
}

