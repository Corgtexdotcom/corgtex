import type { AppActor, MembershipSummary } from "@corgtex/shared";

/**
 * Privacy filter for models with authorUserId (Action, Tension, Proposal).
 * Private drafts are visible to their author, workspace admins, global operators,
 * and workspace-scoped agents. Non-draft private items remain hidden.
 */
export function privacyFilter(actor: AppActor, _membership?: MembershipSummary | null) {
  // Global operators are explicit support actors and may inspect all workspace records.
  if (actor.kind === "user" && actor.user.globalRole === "OPERATOR") {
    return {};
  }

  const privateDrafts = { isPrivate: true, status: "DRAFT" as const };

  if (actor.kind === "agent") {
    return {
      OR: [
        { isPrivate: false },
        privateDrafts,
      ],
    };
  }

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
