import { describe, expect, it } from "vitest";

import {
  activeHumanRoleAssignments,
  flattenRoleStaffingCards,
  roleAssignmentDisplayName,
  roleStaffingSort,
  roleStaffingStatus,
  type RoleStaffingCircle,
} from "./role-staffing";

describe("role staffing helpers", () => {
  it("classifies roles by existing holder count", () => {
    expect(roleStaffingStatus(0)).toBe("open");
    expect(roleStaffingStatus(1)).toBe("staffed");
    expect(roleStaffingStatus(2)).toBe("shared");
  });

  it("flattens nested circles into staffing cards", () => {
    const circles: RoleStaffingCircle[] = [
      {
        id: "circle-1",
        name: "Product",
        roles: [
          {
            id: "role-open",
            name: "Research Lead",
            accountabilities: ["Interview users"],
            assignments: [],
          },
        ],
        childCircles: [
          {
            id: "circle-2",
            name: "Design",
            roles: [
              {
                id: "role-shared",
                name: "Design Ops",
                accountabilities: ["System hygiene", "Review queue"],
                assignments: [
                  { member: { user: { email: "ada@example.com", displayName: "Ada" } } },
                  { member: { user: { email: "grace@example.com", displayName: null } } },
                ],
              },
            ],
          },
        ],
      },
    ];

    const cards = flattenRoleStaffingCards(circles);

    expect(cards).toMatchObject([
      {
        id: "role-open",
        status: "open",
        circle: { id: "circle-1", name: "Product" },
        holderCount: 0,
        holderNames: [],
        accountabilityCount: 1,
      },
      {
        id: "role-shared",
        status: "shared",
        circle: { id: "circle-2", name: "Design" },
        holderCount: 2,
        holderNames: ["Ada", "grace@example.com"],
        accountabilityCount: 2,
      },
    ]);
  });

  it("uses display name before email for holder labels", () => {
    expect(roleAssignmentDisplayName({
      member: { user: { email: "ada@example.com", displayName: " Ada " } },
    })).toBe("Ada");
    expect(roleAssignmentDisplayName({
      member: { user: { email: "grace@example.com", displayName: " " } },
    })).toBe("grace@example.com");
  });

  it("counts only active human assignments as staffing holders", () => {
    const assignments = [
      { member: { kind: "HUMAN" as const, isActive: true, user: { email: "ada@example.com", displayName: "Ada" } } },
      { member: { kind: "HUMAN" as const, isActive: false, user: { email: "inactive@example.com", displayName: "Inactive" } } },
      { member: { kind: "SYSTEM" as const, isActive: true, user: { email: "system+bot@corgtex.local", displayName: "System" } } },
      { member: { isActive: true, user: { email: "support@example.com", displayName: "Corgtex Support" } } },
    ];

    expect(activeHumanRoleAssignments(assignments)).toHaveLength(1);

    const [card] = flattenRoleStaffingCards([
      {
        id: "circle-1",
        name: "Product",
        roles: [
          {
            id: "role-staffed",
            name: "Staffed",
            assignments,
          },
        ],
      },
    ]);

    expect(card).toMatchObject({
      status: "staffed",
      holderCount: 1,
      holderNames: ["Ada"],
    });
  });

  it("sorts open roles ahead of staffed roles by default priority", () => {
    const openSort = roleStaffingSort({
      id: "role-open",
      status: "open",
      role: { id: "role-open", name: "Open", accountabilities: ["A"] },
      circle: { id: "circle-1", name: "Product" },
      holderCount: 0,
      holderNames: [],
      accountabilityCount: 1,
    });
    const staffedSort = roleStaffingSort({
      id: "role-staffed",
      status: "staffed",
      role: { id: "role-staffed", name: "Staffed", accountabilities: ["A", "B"] },
      circle: { id: "circle-1", name: "Product" },
      holderCount: 1,
      holderNames: ["Ada"],
      accountabilityCount: 2,
    });

    expect(openSort.priority).toBeGreaterThan(staffedSort.priority);
  });
});
