import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { deleteCircle, listCircles, listCircleTree, suggestMaturityUpgrade, updateCircle } from "./circles";
import { prisma } from "@corgtex/shared";
import { readableArtifactIds } from "./source-lineage";

vi.mock("./source-lineage", async () => ({
  sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
  isLineageKind: (value: unknown) => ["Circle", "Role"].includes(String(value)),
  assertArtifactInputWriteFence: vi.fn().mockResolvedValue(undefined),
  // This lifecycle fixture has no known content receipt to advance.
  advanceArchivedArtifactEnvelopeLineage: vi.fn().mockResolvedValue(false),
  captureArtifactInputProof: vi.fn().mockResolvedValue([]),
  readableArtifactIds: vi.fn(),
}));

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return { ...actual, requireWorkspaceMembership: (params: Parameters<typeof actual.requireWorkspaceMembership>[0]) => {
    // Operator fixtures also have an explicit ADMIN membership.
    if (params.actor.kind === "user" && params.actor.user.globalRole === "OPERATOR") {
      return actual.requireWorkspaceMembership({ ...params, resolvedMembership: {
        id: "fixture-admin", workspaceId: params.workspaceId, userId: params.actor.user.id, role: "ADMIN", isActive: true,
      } });
    }
    return actual.requireWorkspaceMembership(params);
  } };
});

vi.mock("@corgtex/shared", () => ({
  setSupportAuthorizationActor: vi.fn(),
  getMcpOrigin: () => undefined,
  prisma: {
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
    circle: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    role: {
      findMany: vi.fn(),
    },
    roleHolderHistory: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    roleOnboardingSession: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    roleAssignment: {
      deleteMany: vi.fn(),
    },
    circleAgentAssignment: {
      updateMany: vi.fn(),
    },
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  },
  parseAllowedWorkspaceIds: vi.fn(() => new Set<string>()),
  env: {
    SESSION_LAST_SEEN_WRITE_INTERVAL_MS: 5 * 60 * 1000,
  },
}));

vi.mock("./producer-lineage", () => ({
  prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue(undefined),
}));

const actor: AppActor = {
  kind: "user",
  user: {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    globalRole: "OPERATOR",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row) => row.id)));
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);
  vi.mocked(prisma.event.createMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(prisma.workspaceArchiveRecord.create).mockResolvedValue({} as any);
  vi.mocked(prisma.roleHolderHistory.updateMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(prisma.roleOnboardingSession.updateMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(prisma.roleAssignment.deleteMany).mockResolvedValue({ count: 1 } as any);
  vi.mocked(prisma.circleAgentAssignment.updateMany).mockResolvedValue({ count: 1 } as any);
});

describe("suggestMaturityUpgrade", () => {
  const workspaceId = "ws-1";
  const circleId = "circle-1";

  it("suggestMaturityUpgrade returns ready after 5 weeks of consistent tension processing (GETTING_STARTED)", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "GETTING_STARTED",
      tensions: Array.from({ length: 5 }, (_, index) => ({ id: `tension-${index}` })),
    } as any);

    const result = await suggestMaturityUpgrade(actor, workspaceId, circleId);

    expect(result.ready).toBe(true);
    expect(result.reason).toContain("Ready to practice proposals");
  });

  it("suggestMaturityUpgrade returns not ready for new circle", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "GETTING_STARTED",
      tensions: Array.from({ length: 2 }, (_, index) => ({ id: `tension-${index}` })),
    } as any);

    const result = await suggestMaturityUpgrade(actor, workspaceId, circleId);

    expect(result.ready).toBe(false);
  });

  it("suggestMaturityUpgrade returns ready for FULL_O2 after high volume tension processing", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "BUILDING_MUSCLE",
      tensions: Array.from({ length: 20 }, (_, index) => ({ id: `tension-${index}` })),
    } as any);

    const result = await suggestMaturityUpgrade(actor, workspaceId, circleId);

    expect(result.ready).toBe(true);
    expect(result.reason).toContain("Ready for full O2");
  });

  it("suggestMaturityUpgrade returns false if already FULL_O2", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      maturityStage: "FULL_O2",
      tensions: Array(50).fill({}),
    } as any);

    const result = await suggestMaturityUpgrade(actor, workspaceId, circleId);

    expect(result.ready).toBe(false);
  });
});

describe("updateCircle", () => {
  const workspaceId = "ws-1";
  const circleId = "circle-1";

  it("rejects setting a circle as its own parent", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      archivedAt: null,
    } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: circleId,
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it("rejects moving a circle under one of its descendants", async () => {
    vi.mocked(prisma.circle.findUnique)
      .mockResolvedValueOnce({
        id: circleId,
        workspaceId,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "child-2",
        workspaceId,
        parentCircleId: "child-1",
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "child-1",
        workspaceId,
        parentCircleId: circleId,
        archivedAt: null,
      } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: "child-2",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it("rejects a parent circle outside the workspace", async () => {
    vi.mocked(prisma.circle.findUnique)
      .mockResolvedValueOnce({
        id: circleId,
        workspaceId,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "other-workspace-circle",
        workspaceId: "ws-2",
        parentCircleId: null,
        archivedAt: null,
      } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: "other-workspace-circle",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it("updates a valid parent circle", async () => {
    vi.mocked(prisma.circle.findUnique)
      .mockResolvedValueOnce({
        id: circleId,
        workspaceId,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({
        id: "parent-1",
        workspaceId,
        parentCircleId: null,
        archivedAt: null,
      } as any)
      .mockResolvedValueOnce({ id: "parent-1", workspaceId, parentCircleId: null, archivedAt: null } as any);
    vi.mocked(prisma.circle.update).mockResolvedValueOnce({
      id: circleId,
      workspaceId,
      parentCircleId: "parent-1",
    } as any);

    await expect(updateCircle(actor, {
      workspaceId,
      circleId,
      parentCircleId: "parent-1",
    })).resolves.toMatchObject({
      id: circleId,
      parentCircleId: "parent-1",
    });

    expect(prisma.circle.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: circleId },
      data: { parentCircleId: "parent-1" },
    }));
  });
});

describe("listCircleTree", () => {
  it("loads profile fields for visible role fillers", async () => {
    vi.mocked(prisma.circle.findMany).mockResolvedValueOnce([
      {
        id: "circle-1",
        workspaceId: "ws-1",
        parentCircleId: null,
        name: "Product",
        roles: [
          {
            id: "role-1",
            assignments: [
              {
                id: "assignment-1",
                member: {
                  id: "member-1",
                  user: {
                    id: "user-1",
                    email: "member@example.com",
                    displayName: "Member One",
                    avatarUrl: "https://example.com/avatar.png",
                    bio: "Design and delivery.",
                  },
                },
              },
            ],
          },
        ],
      },
    ] as any);

    const result = await listCircleTree(actor, "ws-1");

    expect(prisma.circle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        roles: expect.objectContaining({
          include: expect.objectContaining({
            assignments: {
              include: {
                member: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        email: true,
                        displayName: true,
                        avatarUrl: true,
                        bio: true,
                      },
                    },
                  },
                },
              },
            },
          }),
        }),
      }),
    }));
    expect(result[0]?.roles[0]?.assignments[0]?.member.user).toMatchObject({
      avatarUrl: "https://example.com/avatar.png",
      bio: "Design and delivery.",
    });
  });
});

describe("deleteCircle", () => {
  it("archives the circle and closes role lifecycle records for roles in that circle only", async () => {
    vi.mocked(prisma.circle.findFirst).mockResolvedValueOnce({
      id: "circle-1",
      workspaceId: "ws-1",
      name: "Product",
      archivedAt: null,
    } as any);
    vi.mocked(prisma.circle.update).mockResolvedValueOnce({
      id: "circle-1",
      workspaceId: "ws-1",
      archivedAt: new Date("2026-06-02T12:00:00.000Z"),
    } as any);
    vi.mocked(prisma.role.findMany).mockResolvedValueOnce([
      { id: "role-1" },
    ] as any);

    await expect(deleteCircle(actor, {
      workspaceId: "ws-1",
      circleId: "circle-1",
    })).resolves.toEqual({ id: "circle-1" });

    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: {
        circleId: "circle-1",
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "ws-1",
        roleId: { in: ["role-1"] },
        endedAt: null,
      }),
    }));
    expect(prisma.roleOnboardingSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "ws-1",
        roleId: { in: ["role-1"] },
        status: { in: ["PENDING", "ACTIVE"] },
      }),
      data: expect.objectContaining({
        status: "DISMISSED",
        dismissedAt: expect.any(Date),
      }),
    }));
    expect(prisma.roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { roleId: { in: ["role-1"] } },
    });
    expect(prisma.circleAgentAssignment.updateMany).toHaveBeenCalledWith({
      where: { roleId: { in: ["role-1"] } },
      data: { roleId: null },
    });
  });
});


describe("circle source permission readers", () => {
  function circle(id: string, sortOrder = 0) {
    return { id, workspaceId: "ws-1", name: id, purposeMd: `Purpose ${id}`, domainMd: null,
      maturityStage: "GETTING_STARTED", parentCircleId: null, parentCircle: null,
      sortOrder, createdAt: new Date("2026-10-01T12:00:00Z"), updatedAt: new Date("2026-10-01T12:00:00Z"), roles: [] };
  }

  it("filters unknown/restricted circles and roles before list order and role counts", async () => {
    vi.mocked(prisma.circle.findMany).mockResolvedValue([
      { ...circle("public-child", 2), parentCircleId: "finance", parentCircle: circle("finance"), roles: [
        { id: "role-private", name: "Private", sortOrder: 0, createdAt: new Date() },
        { id: "role-public", name: "Public", sortOrder: 1, createdAt: new Date() },
      ] }, circle("legacy"), circle("finance"), circle("public-first", 1),
    ] as any);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(rows
      .filter((row) => kind === "Circle" ? !["legacy", "finance"].includes(row.id) : row.id !== "role-private")
      .map((row) => row.id)));
    const result = await listCircles(actor, "ws-1");
    expect(result.map((row) => row.id)).toEqual(["public-first", "public-child"]);
    expect(result[1]?.parentCircleId).toBeNull();
    expect(result[1]?.roles.map((role) => role.id)).toEqual(["role-public"]);
    expect(JSON.stringify(result)).not.toContain("finance");
    expect(vi.mocked(prisma.circle.findMany).mock.calls[0]?.[0]).not.toHaveProperty("orderBy");
  });

  it("builds trees from permitted circles and redacts hidden parent affiliation", async () => {
    const publicRoot = circle("public-root");
    const child = { ...circle("public-child"), parentCircleId: publicRoot.id, parentCircle: publicRoot };
    const detached = { ...circle("original-child", 1), parentCircleId: "finance", parentCircle: circle("finance") };
    vi.mocked(prisma.circle.findMany).mockResolvedValue([circle("finance"), child, detached, publicRoot] as any);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows
      .filter((row) => row.id !== "finance").map((row) => row.id)));
    const result = await listCircleTree(actor, "ws-1");
    expect(result.map((row) => row.id)).toEqual(["public-root", "original-child"]);
    expect(result[0]?.childCircles.map((row) => row.id)).toEqual(["public-child"]);
    expect(result[1]).toMatchObject({ parentCircleId: null, parentCircle: null, childCircles: [] });
    expect(JSON.stringify(result)).not.toContain("finance");
  });

  it("filters tree roles and member profiles before exposing assignment counts", async () => {
    const assignment = (id: string) => ({ id, assignedAt: new Date(),
      member: { id: `member-${id}`, user: { id: `user-${id}`, email: `${id}@example.test`, displayName: id, bio: null } },
    });
    vi.mocked(prisma.circle.findMany).mockResolvedValue([{ ...circle("public"), roles: [
      { id: "role-private", name: "Private", assignments: [assignment("private")], sortOrder: 0, createdAt: new Date() },
      { id: "role-public", name: "Public", assignments: [assignment("revoked"), assignment("public")], sortOrder: 1, createdAt: new Date() },
    ] }] as any);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(rows
      .filter((row) => kind === "Role" ? row.id !== "role-private" : kind === "Member" ? row.id !== "member-revoked" : true)
      .map((row) => row.id)));
    const result = await listCircleTree(actor, "ws-1");
    expect(result[0]?.roles.map((role) => role.id)).toEqual(["role-public"]);
    expect(result[0]?.roles[0]?.assignments.map((row: { id: string }) => row.id)).toEqual(["public"]);
    expect(JSON.stringify(result)).not.toContain("revoked");
    expect(JSON.stringify(result)).not.toContain("Private");
  });

  it("does not count restricted or unknown resolved tensions toward a maturity upgrade", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValue({ ...circle("public"), tensions: [
      { id: "public-1" }, { id: "public-2" }, { id: "public-3" }, { id: "finance" }, { id: "legacy" },
    ] } as any);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(rows
      .filter((row) => kind !== "Tension" || !["finance", "legacy"].includes(row.id)).map((row) => row.id)));
    await expect(suggestMaturityUpgrade(actor, "ws-1", "public")).resolves.toEqual({
      ready: false, reason: "Not enough recent activity to suggest upgrade.",
    });
  });

  it("withholds a maturity suggestion if the circle lineage is unknown", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValue({ ...circle("legacy"), tensions: [] } as any);
    vi.mocked(readableArtifactIds).mockResolvedValue(new Set());
    await expect(suggestMaturityUpgrade(actor, "ws-1", "legacy")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("preserves the stored parent when a partial circle edit omits it", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValue({ ...circle("public"), parentCircleId: "finance", archivedAt: null } as any);
    vi.mocked(prisma.circle.update).mockResolvedValue({ ...circle("public"), name: "Edited", parentCircleId: "finance" } as any);
    await updateCircle(actor, { workspaceId: "ws-1", circleId: "public", name: "Edited" });
    expect(prisma.circle.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "Edited" } }));
    expect(vi.mocked(prisma.circle.findUnique).mock.calls[0]?.[0]).toEqual({ where: { id: "public" } });
  });

  it("redacts an unreadable parent from mutation responses while preserving the persisted relationship", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValue({ ...circle("public"), parentCircleId: "finance", archivedAt: null } as any);
    vi.mocked(prisma.circle.update).mockResolvedValue({ ...circle("public"), name: "Edited", parentCircleId: "finance" } as any);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows
      .filter((row) => row.id === "public").map((row) => row.id)));
    const result = await updateCircle(actor, { workspaceId: "ws-1", circleId: "public", name: "Edited" });
    expect(result).toMatchObject({ id: "public", name: "Edited", parentCircleId: null });
    expect(prisma.circle.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "Edited" } }));
  });

  it("withholds stale or unknown content in mutation responses after writing safe fields", async () => {
    vi.mocked(prisma.circle.findUnique).mockResolvedValue({ ...circle("legacy"), archivedAt: null } as any);
    vi.mocked(prisma.circle.update).mockResolvedValue({ ...circle("legacy"), name: "Edited" } as any);
    vi.mocked(readableArtifactIds).mockResolvedValue(new Set());
    await expect(updateCircle(actor, { workspaceId: "ws-1", circleId: "legacy", name: "Edited" }))
      .resolves.toEqual({ id: "legacy", contentWithheld: true });
    expect(prisma.circle.update).toHaveBeenCalled();
  });
});
