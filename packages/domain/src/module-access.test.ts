import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    workspaceFeatureFlag: {
      findMany: vi.fn(),
    },
    workspaceModuleGrant: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    roleAssignment: {
      findMany: vi.fn(),
    },
    circle: {
      findMany: vi.fn(),
    },
    workspaceModuleAccessRequest: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    session: {
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@corgtex/shared", () => ({
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
  prisma: prismaMock,
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  randomOpaqueToken: vi.fn(() => "opaque-token"),
  sha256: vi.fn((value: string) => `sha:${value}`),
  verifyPassword: vi.fn(() => true),
}));

import {
  createModuleAccessRequest,
  decideModuleAccessRequest,
  expandCircleAncestors,
  gatherModuleAccessContext,
  listModuleAccessRequests,
  toAccessLevel,
  toPrismaAccessLevel,
} from "./module-access";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.workspaceFeatureFlag.findMany.mockResolvedValue([]);
  prismaMock.workspaceModuleGrant.findMany.mockResolvedValue([]);
  prismaMock.roleAssignment.findMany.mockResolvedValue([]);
  prismaMock.circle.findMany.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
});

describe("expandCircleAncestors", () => {
  it("includes the base circles and all ancestors up the tree", () => {
    // root <- mid <- leaf
    const parentById = new Map<string, string | null>([
      ["root", null],
      ["mid", "root"],
      ["leaf", "mid"],
    ]);
    expect(new Set(expandCircleAncestors(["leaf"], parentById))).toEqual(new Set(["leaf", "mid", "root"]));
  });

  it("merges ancestors from multiple base circles without duplicates", () => {
    const parentById = new Map<string, string | null>([
      ["root", null],
      ["a", "root"],
      ["b", "root"],
    ]);
    expect(new Set(expandCircleAncestors(["a", "b"], parentById))).toEqual(new Set(["a", "b", "root"]));
  });

  it("terminates on cycles", () => {
    const parentById = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(new Set(expandCircleAncestors(["x"], parentById))).toEqual(new Set(["x", "y"]));
  });

  it("returns an empty list for no base circles", () => {
    expect(expandCircleAncestors([], new Map())).toEqual([]);
  });
});

describe("access level enum mapping", () => {
  it("maps Prisma levels to domain levels", () => {
    expect(toAccessLevel("NONE")).toBe("none");
    expect(toAccessLevel("READ")).toBe("read");
    expect(toAccessLevel("WRITE")).toBe("write");
  });

  it("round-trips domain levels back to Prisma levels", () => {
    expect(toPrismaAccessLevel("none")).toBe("NONE");
    expect(toPrismaAccessLevel("read")).toBe("READ");
    expect(toPrismaAccessLevel("write")).toBe("WRITE");
  });

  it("maps the requestable access levels (read/write) to Prisma enums", () => {
    // The request flow only permits read/write (not none); confirm the mapping
    // used when persisting a request's requestedAccess.
    expect(toPrismaAccessLevel("read")).toBe("READ");
    expect(toPrismaAccessLevel("write")).toBe("WRITE");
  });
});

describe("module access request API surface", () => {
  it("exposes the request, list, and decide functions", () => {
    expect(typeof createModuleAccessRequest).toBe("function");
    expect(typeof listModuleAccessRequests).toBe("function");
    expect(typeof decideModuleAccessRequest).toBe("function");
  });
});

describe("gatherModuleAccessContext", () => {
  it("loads only active role assignments before deriving governance roles and circles", async () => {
    prismaMock.roleAssignment.findMany.mockResolvedValue([
      { roleId: "role-active", role: { circleId: "circle-child" } },
    ]);
    prismaMock.circle.findMany.mockResolvedValue([
      { id: "circle-root", parentCircleId: null },
      { id: "circle-child", parentCircleId: "circle-root" },
    ]);

    const context = await gatherModuleAccessContext({
      workspaceId: "workspace-1",
      memberId: "member-1",
      role: "CONTRIBUTOR",
    });

    expect(prismaMock.roleAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        memberId: "member-1",
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: expect.any(Date) } },
        ],
      }),
    }));
    expect(context.governanceRoleIds).toEqual(["role-active"]);
    expect(new Set(context.circleIds)).toEqual(new Set(["circle-child", "circle-root"]));
  });
});
