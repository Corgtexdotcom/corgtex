import { describe, expect, it } from "vitest";

import {
  latestOnboardingByRoleMember,
  roleKanbanColumnId,
  roleMatchesMemberFilter,
  roleMatchesStaffingFilter,
  type RoleDirectoryRole,
} from "./role-directory";

function role(overrides: Partial<RoleDirectoryRole>): RoleDirectoryRole {
  return {
    id: "role-1",
    name: "Lead",
    purposeMd: null,
    accountabilities: [],
    artifacts: [],
    coreRoleType: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    circle: { id: "circle-1", name: "General" },
    assignments: [],
    ...overrides,
  };
}

function assignment(memberId: string, overrides: Partial<RoleDirectoryRole["assignments"][number]> = {}) {
  return {
    id: `assignment-${memberId}`,
    memberId,
    expiresAt: null,
    transferReason: null,
    member: {
      id: memberId,
      kind: "HUMAN" as const,
      isActive: true,
      user: {
        id: `user-${memberId}`,
        email: `${memberId}@example.com`,
        displayName: memberId,
      },
    },
    ...overrides,
  };
}

describe("role directory view model", () => {
  it("classifies open, staffed, multi-holder, and onboarding roles", () => {
    const onboarding = latestOnboardingByRoleMember([
      {
        roleId: "role-onboarding",
        memberId: "member-1",
        conversationId: "conversation-1",
        status: "ACTIVE",
      },
    ]);
    const openRole = role({ id: "role-open" });
    const staffedRole = role({ id: "role-staffed", assignments: [assignment("member-1")] });
    const multiHolderRole = role({ id: "role-multi", assignments: [assignment("member-1"), assignment("member-2")] });
    const onboardingRole = role({ id: "role-onboarding", assignments: [assignment("member-1")] });

    expect(roleKanbanColumnId(openRole, onboarding)).toBe("OPEN");
    expect(roleKanbanColumnId(staffedRole, onboarding)).toBe("STAFFED");
    expect(roleKanbanColumnId(multiHolderRole, onboarding)).toBe("MULTI_HOLDER");
    expect(roleKanbanColumnId(onboardingRole, onboarding)).toBe("NEEDS_ONBOARDING");
  });

  it("filters mine and member matches by active human assignments only", () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    const directoryRole = role({
      assignments: [
        assignment("member-active"),
        assignment("member-expired", { expiresAt: new Date("2026-01-01T00:00:00.000Z") }),
        assignment("member-system", {
          member: {
            id: "member-system",
            kind: "SYSTEM",
            isActive: true,
            user: {
              id: "user-system",
              email: "system+agent@example.com",
              displayName: "System agent",
            },
          },
        }),
      ],
    });

    expect(roleMatchesStaffingFilter({
      role: directoryRole,
      filter: "MINE",
      currentMemberId: "member-active",
      onboardingByRoleMember: new Map(),
      now,
    })).toBe(true);
    expect(roleMatchesStaffingFilter({
      role: directoryRole,
      filter: "MINE",
      currentMemberId: "member-expired",
      onboardingByRoleMember: new Map(),
      now,
    })).toBe(false);
    expect(roleMatchesMemberFilter(directoryRole, ["member-active"], now)).toBe(true);
    expect(roleMatchesMemberFilter(directoryRole, ["member-expired", "member-system"], now)).toBe(false);
  });
});
