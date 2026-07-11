import { describe, expect, it } from "vitest";
import { activeRoleAssignmentWhere, isRoleAssignmentActive } from "./role-assignment-activity";

describe("role assignment activity helpers", () => {
  it("builds the shared active-assignment Prisma predicate", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");

    expect(activeRoleAssignmentWhere(now)).toEqual({
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    });
  });

  it("treats missing and future expiries as active", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");

    expect(isRoleAssignmentActive({}, now)).toBe(true);
    expect(isRoleAssignmentActive({ expiresAt: "2026-07-12T12:00:00.000Z" }, now)).toBe(true);
  });

  it("treats past and invalid expiries as inactive", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");

    expect(isRoleAssignmentActive({ expiresAt: "2026-07-10T12:00:00.000Z" }, now)).toBe(false);
    expect(isRoleAssignmentActive({ expiresAt: "not-a-date" }, now)).toBe(false);
  });
});
