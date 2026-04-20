import type { AppActor } from "@corgtex/shared";

/**
 * Privacy filter for models with authorUserId (Action, Tension, Proposal).
 * Agents never see private items.
 */
export function privacyFilter(actor: AppActor) {
  if (actor.kind === "user") {
    return {
      OR: [
        { isPrivate: false },
        { isPrivate: true, authorUserId: actor.user.id },
      ],
    };
  }
  return { isPrivate: false };
}
