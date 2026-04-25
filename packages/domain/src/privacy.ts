import type { AppActor, MembershipSummary } from "@corgtex/shared";

/**
 * Privacy filter for models with authorUserId (Action, Tension, Proposal).
 * Agents never see private items.
 */
export function privacyFilter(actor: AppActor, membership?: MembershipSummary | null) {
  if (actor.kind === "user" && (actor.user.globalRole === "OPERATOR" || membership?.role === "ADMIN")) {
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
