import type { AppActor, MembershipSummary } from "@corgtex/shared";

/**
 * Privacy filter for models with authorUserId (Action, Tension, Proposal, Goal).
 * Private drafts are visible to their author, workspace admins, global operators,
 * with a current human principal. Credentials do not delegate their creator.
 * Non-draft private items remain hidden.
 */
export function privacyFilter(actor: AppActor, _membership?: MembershipSummary | null) {
  const privateDrafts = { isPrivate: true, status: "DRAFT" as const };

  if (actor.kind === "agent") return { isPrivate: false };

  if (actor.kind === "user") {
    if (_membership?.role === "ADMIN") {
      return {
        OR: [
          { isPrivate: false },
          privateDrafts,
        ],
      };
    }

    return {
      OR: [
        { isPrivate: false },
        { isPrivate: true, status: "DRAFT" as const, authorUserId: actor.user.id },
      ],
    };
  }
  return { isPrivate: false };
}
