import { AsyncLocalStorage } from "node:async_hooks";
import type { AppActor } from "./types";

export type SupportOrigin = { userId: string; workspaceId: string; version: number };
type AuthorizationContext = { supportUserId?: string; origin?: SupportOrigin };
const authorizationContext = new AsyncLocalStorage<AuthorizationContext>();

// Called synchronously at authentication entry, before the caller awaits resolution.
export function beginAuthorizationContext() {
  authorizationContext.enterWith({});
}

export function setSupportAuthorizationActor(actor: AppActor) {
  if (!authorizationContext.getStore()) authorizationContext.enterWith({});
  if (actor.kind === "agent" && actor.supportOrigin) {
    const context = authorizationContext.getStore() ?? {};
    context.supportUserId = actor.supportOrigin.userId;
    context.origin = actor.supportOrigin;
    authorizationContext.enterWith(context);
    return;
  }
}

export function setSupportAuthorizationGrant(origin: SupportOrigin) {
  const context = authorizationContext.getStore();
  if (!context) throw new Error("AUTHORIZATION_CONTEXT_REQUIRED");
  context.supportUserId = origin.userId;
  context.origin ??= origin;
}

export function getSupportAuthorizationContext() {
  return authorizationContext.getStore();
}

export function runWithSupportOrigin<T>(origin: SupportOrigin | undefined, run: () => PromiseLike<T>): Promise<T> {
  // Adopt lazy Prisma promises inside the context, not in the awaiting caller.
  return authorizationContext.run(origin ? { supportUserId: origin.userId, origin } : {}, async () => await run());
}
