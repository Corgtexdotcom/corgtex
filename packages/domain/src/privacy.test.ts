import { describe, expect, it } from "vitest";
import type { AppActor, MembershipSummary } from "@corgtex/shared";
import { privacyFilter } from "./privacy";

const membership: MembershipSummary = { id: "member-1", workspaceId: "ws-1", userId: "owner", role: "ADMIN", isActive: true };
describe("credential private draft envelope", () => {
  it.each(["credential", "bootstrap", "control-plane"] as const)("does not grant %s the credential creator's or synthetic admin's private drafts", authProvider => {
    const actor: AppActor = { kind: "agent", authProvider, label: "trusted-looking-label", credentialId: "credential-a",
      workspaceIds: ["ws-1"], scopes: ["actions:read", "support:write"], supportOrigin: { userId: "owner", workspaceId: "ws-1", version: 1 } };
    expect(privacyFilter(actor, membership)).toEqual({ isPrivate: false });
  });
  it("preserves current human author and administrator envelopes", () => {
    const actor: AppActor = { kind: "user", user: { id: "owner", email: "owner@example.test", displayName: "Owner" } };
    expect(privacyFilter(actor, { ...membership, role: "CONTRIBUTOR" })).toEqual({ OR: [
      { isPrivate: false }, { isPrivate: true, status: "DRAFT", authorUserId: "owner" },
    ] });
    expect(privacyFilter(actor, membership)).toEqual({ OR: [{ isPrivate: false }, { isPrivate: true, status: "DRAFT" }] });
  });
});
