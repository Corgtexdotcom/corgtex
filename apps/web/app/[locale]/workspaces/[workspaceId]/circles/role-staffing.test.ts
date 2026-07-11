import { describe, expect, it } from "vitest";

import {
  activeHumanRoleAssignments,
  flattenRoleStaffingCards,
  roleAssignmentDisplayName,
  roleStaffingSort,
  roleStaffingStatus,
  type RoleStaffingCircle,
} from "./role-staffing";
import { collectCircleMembers, type CircleGraphCircle } from "./circleGraphHelpers";

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
    const now = new Date("2026-07-11T12:00:00.000Z");
    const assignments = [
      { member: { kind: "HUMAN" as const, isActive: true, user: { email: "ada@example.com", displayName: "Ada" } } },
      { expiresAt: "2026-07-10T12:00:00.000Z", member: { kind: "HUMAN" as const, isActive: true, user: { email: "expired@example.com", displayName: "Expired" } } },
      { member: { kind: "HUMAN" as const, isActive: false, user: { email: "inactive@example.com", displayName: "Inactive" } } },
      { member: { kind: "SYSTEM" as const, isActive: true, user: { email: "system+bot@corgtex.local", displayName: "System" } } },
      { member: { isActive: true, user: { email: "support@example.com", displayName: "Corgtex Support" } } },
    ];

    expect(activeHumanRoleAssignments(assignments, now)).toHaveLength(1);

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
    ], now);

    expect(card).toMatchObject({
      status: "staffed",
      holderCount: 1,
      holderNames: ["Ada"],
    });
  });

  it("omits expired assignments from circle member summaries", () => {
    const circle: CircleGraphCircle = {
      id: "circle-1",
      workspaceId: "workspace-1",
      name: "Product",
      parentCircleId: null,
      purposeMd: null,
      domainMd: null,
      maturityStage: "GETTING_STARTED",
      roles: [
        {
          id: "role-1",
          name: "Lead",
          assignments: [
            {
              id: "assignment-active",
              expiresAt: "2026-07-12T12:00:00.000Z",
              member: {
                id: "member-active",
                kind: "HUMAN",
                user: { id: "user-active", email: "active@example.com", displayName: "Active" },
              },
            },
            {
              id: "assignment-expired",
              expiresAt: "2026-07-10T12:00:00.000Z",
              member: {
                id: "member-expired",
                kind: "HUMAN",
                user: { id: "user-expired", email: "expired@example.com", displayName: "Expired" },
              },
            },
          ],
        },
      ],
      childCircles: [],
    };

    expect(collectCircleMembers(circle, new Date("2026-07-11T12:00:00.000Z"))).toMatchObject([
      {
        memberId: "member-active",
        displayName: "Active",
        roleNames: ["Lead"],
      },
    ]);
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
