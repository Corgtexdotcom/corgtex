import type { AppActor } from "@corgtex/shared";

/** Preserve the authenticated object's server-owned WeakMap capabilities while
 * preventing changes across awaits. Current database grants are still checked. */
export function sealArtifactInputActor(actor: AppActor): AppActor {
  if (actor.kind === "user") Object.freeze(actor.user);
  else {
    if (actor.scopes) Object.freeze(actor.scopes);
    if (actor.workspaceIds) Object.freeze(actor.workspaceIds);
    if (actor.supportOrigin) Object.freeze(actor.supportOrigin);
  }
  return Object.freeze(actor);
}
