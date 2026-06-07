import type { MembershipSummary } from "@corgtex/shared";

export function persistedMemberId(membership: MembershipSummary | null | undefined) {
  return membership?.id === "global-operator" ? null : membership?.id ?? null;
}
