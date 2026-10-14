import type { AppActor } from "@corgtex/shared";

export type ExternalProviderWorkerPurpose = Readonly<{ workspaceId: string; sourceId: string; workflowJobId: string;
  userId: string; connectionId: string; bindingHash: string; jobLeaseHash: string; connectionGrantHash: string }>;
const workers = new WeakMap<AppActor, ExternalProviderWorkerPurpose>();
// Internal server authority imports these issuers; no barrel exposes minting or serialized capabilities.
export function registerExternalProviderWorkerPrincipal(actor: AppActor, purpose: ExternalProviderWorkerPurpose) {
  workers.set(actor, Object.freeze({ ...purpose }));
}
export function revokeExternalProviderWorkerPrincipal(actor: AppActor) { workers.delete(actor); }
export function getExternalProviderWorkerPurpose(actor: AppActor) { return workers.get(actor); }
export function getExternalProviderPrincipalUserId(actor: AppActor, workspaceId: string) {
  return actor.kind === "user" ? actor.user.id : workers.get(actor)?.workspaceId === workspaceId ? workers.get(actor)!.userId : null;
}
