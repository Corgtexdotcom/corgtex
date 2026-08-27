import { describe, expect, it } from "vitest";
import {
  classifyMemberIdentity,
  humanMemberIdentityWhere,
  isHumanMemberIdentity,
  isSystemMemberIdentity,
  systemActorMemberIdentityWhere,
  systemMemberIdentityWhere,
} from "./member-identity";

describe("member identity classification", () => {
  it("treats explicit system members as system identities", () => {
    expect(classifyMemberIdentity({
      kind: "SYSTEM",
      user: { email: "person@example.com", displayName: "Person" },
    })).toBe("SYSTEM");
  });

  it("infers legacy system and support accounts from existing identity conventions", () => {
    expect(isSystemMemberIdentity({ user: { email: "system+workspace@corgtex.local" } })).toBe(true);
    expect(isSystemMemberIdentity({ user: { email: "support+workspace@corgtex.local" } })).toBe(true);
    expect(isSystemMemberIdentity({ user: { email: "support@example.com", displayName: "Corgtex Support" } })).toBe(true);
  });

  it("treats persisted human kind as authoritative over user-controlled identity fields", () => {
    expect(classifyMemberIdentity({
      kind: "HUMAN",
      user: { email: "support+person@example.com", displayName: "Corgtex Support" },
    })).toBe("HUMAN");
  });

  it("does not classify people as system identities just because agent appears in their name or email", () => {
    expect(isHumanMemberIdentity({ user: { email: "agentina@example.com", displayName: "Agentina Example" } })).toBe(true);
  });

  it("exposes reusable Prisma filters for member queries", () => {
    expect(systemMemberIdentityWhere()).toEqual({ kind: "SYSTEM" });
    expect(humanMemberIdentityWhere()).toEqual({
      kind: "HUMAN",
      NOT: [{ OR: [{ kind: "SYSTEM" }] }],
    });
    expect(systemActorMemberIdentityWhere()).toEqual({ kind: "SYSTEM" });
  });
});
