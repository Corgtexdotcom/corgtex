import type { AppActor, MembershipSummary } from "@corgtex/shared";

/**
 * Privacy filter for models with authorUserId (Action, Tension, Proposal).
 * Agents never see private items.
 */
export function privacyFilter(actor: AppActor, _membership?: MembershipSummary | null) {
  // Workspace admins still only see their own private items; global operators are explicit support actors.
  if (actor.kind === "user" && actor.user.globalRole === "OPERATOR") {
    return {};
  }

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
