import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAgentIdentity,
  updateAgentIdentity,
  listAgentIdentities,
  deactivateAgentIdentity,
  assignAgentToCircle,
  removeAgentFromCircle,
  updateAgentBehavior,
  getWorkspaceAgentBehavior,
  updateWorkspaceAgentBehavior,
  getOrCreateExternalAgentIdentity,
} from "./agent-identity";
import { prisma } from "@corgtex/shared";
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";
import * as sourceLineage from "./source-lineage";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
vi.mock("./producer-lineage", () => ({
  prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./source-lineage", async (original) => {
  const actual = await original<typeof import("./source-lineage")>();
  return { ...actual, readableArtifactIds: vi.fn(async (_actor, _ws, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id))),
    captureArtifactInputProof: vi.fn().mockResolvedValue([]), recordArtifactInputLineage: vi.fn(),
    currentArtifactInputRoots: vi.fn().mockResolvedValue([]), advanceHumanArtifactInputLineage: vi.fn(),
    invalidateArtifactInputLineage: vi.fn(), isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
    captureArtifactInputSnapshotProof: vi.fn().mockResolvedValue([]) };
});
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["PUBLIC"]) }));

vi.mock("@corgtex/shared", () => ({
  setSupportAuthorizationActor: vi.fn(),
  getMcpOrigin: () => undefined,
  env: { DEPLOYMENT_WORKSPACE_SCOPE_SLUG: undefined },
  prisma: {
    workspaceSupportGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    agentIdentity: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    circleAgentAssignment: {
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    roleHolderHistory: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    circle: {
      findFirst: vi.fn(),
    },
    role: {
      findFirst: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    user: { findFirst: vi.fn() },
    action: { findFirst: vi.fn() },
    artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    artifactInputSnapshot: { findFirst: vi.fn(), create: vi.fn() },
    workspaceArchiveRecord: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (cb) => cb(prisma)),
  },
}));

const adminActor: any = {
  kind: "user",
  user: { id: "u1", email: "admin@test.com", displayName: "Admin" },
};

const wsId = "ws-1";

function mockMembership() {
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "m1",
    workspaceId: wsId,
    userId: "u1",
    role: "ADMIN",
    isActive: true,
    joinedAt: new Date(),
  } as any);
}

describe("agent-identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembership();
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0 as any);
    vi.mocked(prisma.roleHolderHistory.create).mockResolvedValue({} as any);
    vi.mocked(prisma.roleHolderHistory.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(prisma.circleAgentAssignment.updateMany).mockResolvedValue({ count: 1 } as any);
  });

  it("creates an agent identity", async () => {
    const mockIdentity = {
      id: "ai-1",
      workspaceId: wsId,
      agentKey: "test-agent",
      displayName: "Test Agent",
      memberType: "INTERNAL",
      isActive: true,
    };
    vi.mocked(prisma.agentIdentity.create).mockResolvedValue(mockIdentity as any);

    const result = await createAgentIdentity(adminActor, {
      workspaceId: wsId,
      agentKey: "test-agent",
      displayName: "Test Agent",
    });

    expect(result).toEqual(mockIdentity);
    expect(prisma.agentIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: wsId,
          agentKey: "test-agent",
          displayName: "Test Agent",
          createdByUserId: "u1",
        }),
      }),
    );
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: wsId,
          type: "agent-identity.created",
          aggregateType: "AgentIdentity",
          aggregateId: "ai-1",
          payload: expect.objectContaining({ agentIdentityId: "ai-1" }),
        }),
      ],
    });
  });

  it("lists agent identities", async () => {
    vi.mocked(prisma.agentIdentity.findMany).mockResolvedValue([]);

    const result = await listAgentIdentities(adminActor, wsId);
    expect(result).toEqual([]);
    expect(prisma.agentIdentity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: wsId, archivedAt: null },
      }),
    );
  });

  it("updates an agent identity", async () => {
    const existing = { id: "ai-1", workspaceId: wsId, agentKey: "test", displayName: "Old Name" };
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(existing as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ ...existing, displayName: "New Name" } as any);

    const result = await updateAgentIdentity(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      displayName: "New Name",
    });

    expect(result).toMatchObject({ displayName: "New Name" });
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.updated",
          payload: expect.objectContaining({ agentIdentityId: "ai-1" }),
        }),
      ],
    });
  });

  it("emits a deactivation event when updating an agent identity to inactive", async () => {
    const existing = { id: "ai-1", workspaceId: wsId, agentKey: "test", displayName: "Agent", isActive: true };
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(existing as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ ...existing, isActive: false } as any);

    await updateAgentIdentity(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      isActive: false,
    });

    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.deactivated",
          payload: expect.objectContaining({ agentIdentityId: "ai-1" }),
        }),
      ],
    });
  });

  it("deactivates an agent identity", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId, isActive: true } as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ id: "ai-1", isActive: false } as any);

    const result = await deactivateAgentIdentity(adminActor, wsId, "ai-1");
    expect(result).toEqual({ id: "ai-1" });
    expect(prisma.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: wsId,
        agentIdentityId: "ai-1",
        endedAt: null,
      }),
      data: expect.objectContaining({
        endedAt: expect.any(Date),
        endedByUserId: "u1",
      }),
    }));
    expect(prisma.circleAgentAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        agentIdentityId: "ai-1",
        circle: { workspaceId: wsId },
        roleId: { not: null },
      },
      data: { roleId: null },
    });
  });

  it("rejects deactivation of non-existent identity", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(null);

    await expect(deactivateAgentIdentity(adminActor, wsId, "ai-missing")).rejects.toThrow("Agent identity not found.");
  });

  it("assigns an agent to a circle", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId } as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);
    vi.mocked(prisma.circleAgentAssignment.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.circleAgentAssignment.upsert).mockResolvedValue({ id: "ca-1", circleId: "c-1", agentIdentityId: "ai-1", roleId: null } as any);

    const result = await assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
    });

    expect(result.circleId).toBe("c-1");
    expect(prisma.circleAgentAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        circleId_agentIdentityId: {
          circleId: "c-1",
          agentIdentityId: "ai-1",
        },
      },
      update: { roleId: null },
      create: {
        circleId: "c-1",
        agentIdentityId: "ai-1",
        roleId: null,
      },
    }));
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.circle-assigned",
          payload: expect.objectContaining({ agentIdentityId: "ai-1", circleId: "c-1" }),
        }),
      ],
    });
  });

  it("assigns an agent to a role in the same circle", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId } as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);
    vi.mocked(prisma.role.findFirst).mockResolvedValue({ id: "r-1" } as any);
    vi.mocked(prisma.circleAgentAssignment.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.circleAgentAssignment.upsert).mockResolvedValue({
      id: "ca-1",
      circleId: "c-1",
      agentIdentityId: "ai-1",
      roleId: "r-1",
    } as any);

    const result = await assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
      roleId: " r-1 ",
    });

    expect(prisma.role.findFirst).toHaveBeenCalledWith({
      where: {
        id: "r-1",
        circleId: "c-1",
        circle: { workspaceId: wsId },
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.circleAgentAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { roleId: "r-1" },
      create: expect.objectContaining({ roleId: "r-1" }),
    }));
    expect(prisma.roleHolderHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        roleId: "r-1",
        agentIdentityId: "ai-1",
      }),
    }));
    expect(result.roleId).toBe("r-1");
  });

  it("rejects assigning an agent to a role outside the circle", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId } as any);
    vi.mocked(prisma.circle.findFirst).mockResolvedValue({ id: "c-1", workspaceId: wsId } as any);
    vi.mocked(prisma.role.findFirst).mockResolvedValue(null);

    await expect(assignAgentToCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
      roleId: "other-circle-role",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prisma.circleAgentAssignment.create).not.toHaveBeenCalled();
  });

  it("removes an agent from a circle", async () => {
    vi.mocked(prisma.circleAgentAssignment.findUnique).mockResolvedValue({ id: "ca-1", circleId: "c-1", agentIdentityId: "ai-1", roleId: "r-1" } as any);
    vi.mocked(prisma.circleAgentAssignment.delete).mockResolvedValue({ id: "ca-1" } as any);

    const result = await removeAgentFromCircle(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      circleId: "c-1",
    });

    expect(result.id).toBe("ca-1");
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.roleHolderHistory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        roleId: "r-1",
        agentIdentityId: "ai-1",
        endedAt: null,
      }),
    }));
    expect(prisma.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "agent-identity.circle-unassigned",
          payload: expect.objectContaining({ agentIdentityId: "ai-1", circleId: "c-1" }),
        }),
      ],
    });
  });

  it("updates agent behavior markdown", async () => {
    vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue({ id: "ai-1", workspaceId: wsId } as any);
    vi.mocked(prisma.agentIdentity.update).mockResolvedValue({ id: "ai-1", behaviorMd: "Be helpful." } as any);

    const result = await updateAgentBehavior(adminActor, {
      workspaceId: wsId,
      agentIdentityId: "ai-1",
      behaviorMd: "Be helpful.",
    });

    expect(result).toMatchObject({ behaviorMd: "Be helpful." });
  });

  it("returns null for missing workspace behavior", async () => {
    vi.mocked(prisma.agentIdentity.findUnique).mockResolvedValue(null);

    const result = await getWorkspaceAgentBehavior(adminActor, wsId);
    expect(result).toBeNull();
  });

  it("upserts workspace agent behavior", async () => {
    vi.mocked(prisma.agentIdentity.upsert).mockResolvedValue({ id: "ai-ws", behaviorMd: "Global rules." } as any);

    const result = await updateWorkspaceAgentBehavior(adminActor, {
      workspaceId: wsId,
      behaviorMd: "Global rules.",
    });

    expect(result).toMatchObject({ behaviorMd: "Global rules." });
  });

  describe("getOrCreateExternalAgentIdentity", () => {
    it("returns existing identity if it exists", async () => {
      const existing = { id: "ext-1", linkedCredentialId: "cred-1" };
      vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(existing as any);

      const result = await getOrCreateExternalAgentIdentity("ws-1", "cred-1", "Label", null);

      expect(prisma.agentIdentity.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: "ws-1", linkedCredentialId: "cred-1" },
      });
      expect(result).toEqual(existing);
      expect(prisma.agentIdentity.create).not.toHaveBeenCalled();
    });

    it("creates new external identity if it does not exist", async () => {
      vi.mocked(prisma.agentIdentity.findFirst).mockResolvedValue(null);
      const created = { id: "ext-1", linkedCredentialId: "cred-123", agentKey: "ext_cred-123" };
      vi.mocked(prisma.agentIdentity.create).mockResolvedValue(created as any);

      const result = await getOrCreateExternalAgentIdentity("ws-1", "cred-12345678", "My Agent", "user-1");

      expect(prisma.agentIdentity.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "ws-1",
          agentKey: "ext_cred-123",
          memberType: "EXTERNAL",
          displayName: "My Agent",
          linkedCredentialId: "cred-12345678",
          createdByUserId: "user-1",
        },
      });
      expect(result).toEqual(created);
    });
  });
});


describe("agent identity producers with actual lineage receipts", () => {
  const rows: Record<string, any[]> = {};
  const timestamp = new Date("2026-10-12T10:00:00Z");
  let source: typeof import("./source-lineage");
  const relation = (row: any, key: string) => key === "user" ? rows.user.find((user) => user.id === row.userId) : undefined;
  function matches(row: any, where: any): boolean {
    return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (key === "workspaceId_agentKey" || key === "workspaceId_userId") return matches(row, value);
      if (key === "user") return matches(relation(row, key), value);
      if (key === "memberships") return rows.member.some((member) => member.userId === row.id && matches(member, value.some));
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return value.in.includes(row[key]);
        throw new Error(`Unhandled identity test predicate ${key}`);
      }
      return row[key] === value;
    });
  }
  function project(row: any, args: any) {
    if (!row) return null;
    const result = { ...row };
    if (args.include?.user) result.user = project(relation(row, "user"), args.include.user);
    if (args.include?.circleAssignments) result.circleAssignments = [];
    if (args.include?.createdByUser) result.createdByUser = rows.user.find((user) => user.id === row.createdByUserId) ?? null;
    return args.select ? Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]])) : result;
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    source = await vi.importActual<typeof import("./source-lineage")>("./source-lineage");
    const producer = await vi.importActual<typeof import("./producer-lineage")>("./producer-lineage");
    vi.mocked(prepareProducerLineage).mockImplementation(producer.prepareProducerLineage);
    vi.mocked(finishProducerLineage).mockImplementation(producer.finishProducerLineage);
    for (const name of ["readableArtifactIds", "captureArtifactInputProof", "recordArtifactInputLineage", "currentArtifactInputRoots", "advanceHumanArtifactInputLineage", "invalidateArtifactInputLineage", "isArtifactInputProofReadable", "captureArtifactInputSnapshotProof"] as const) {
      vi.mocked(sourceLineage[name]).mockImplementation(source[name] as any);
    }
    for (const name of ["agentIdentity", "artifactInputLineage", "artifactInputSnapshot", "member", "user", "action"]) {
      rows[name] = [];
      const delegate: any = (prisma as any)[name];
      const find = async (args: any) => project(rows[name].filter((row) => matches(row, args.where)).at(-1), args);
      delegate.findFirst.mockImplementation(find);
      if (delegate.findUnique) delegate.findUnique.mockImplementation(find);
      if (delegate.findMany) delegate.findMany.mockImplementation(async (args: any) => rows[name].filter((row) => matches(row, args.where)).sort((a, b) => name === "artifactInputLineage" ? b.revision - a.revision : 0).map((row) => project(row, args)));
      if (delegate.create) delegate.create.mockImplementation(async ({ data }: any) => {
        const row = { id: `${name}-${rows[name].length}`, archivedAt: null, createdAt: timestamp, updatedAt: timestamp,
          ...(name === "agentIdentity" ? { isActive: true, memberType: "INTERNAL", behaviorMd: null, purposeMd: null, createdByUserId: null } : {}), ...data };
        rows[name].push(row); return { ...row };
      });
      if (delegate.update) delegate.update.mockImplementation(async ({ where, data }: any) => {
        const row = rows[name].find((item) => matches(item, where)); Object.assign(row, data, { updatedAt: new Date(timestamp.getTime() + 1) }); return { ...row };
      });
      if (delegate.upsert) delegate.upsert.mockImplementation(async ({ where, create, update }: any) => {
        const row = rows[name].find((item) => matches(item, where));
        return row ? delegate.update({ where: { id: row.id }, data: update }) : delegate.create({ data: create });
      });
    }
    (prisma as any).$transaction.mockImplementation(async (run: any) => run(prisma));
    (prisma as any).$executeRaw.mockResolvedValue(1);
    rows.user.push({ id: "u1", email: "admin@test.com", displayName: "Admin", bio: null, avatarUrl: null, linkedinUrl: null, websiteUrl: null });
    rows.member.push({ id: "m1", workspaceId: wsId, userId: "u1", role: "ADMIN", isActive: true, joinedAt: timestamp });
    installSourcePermissionEpochFixture(prisma);
  });
  async function originalAction() {
    const row = { id: "source-action", workspaceId: wsId, title: "Complete source", bodyMd: "Complete source body", status: "DRAFT", authorUserId: "u1", isPrivate: true, archivedAt: null as Date | null, createdAt: timestamp, updatedAt: timestamp };
    rows.action.push(row);
    await source.recordArtifactInputLineage({ tx: prisma, actor: adminActor, workspaceId: wsId, artifact: { kind: "Action", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
    return row;
  }
  it("records a human administrator's original identity and preserves its receipt through partial behavior edits", async () => {
    const identity = await createAgentIdentity(adminActor, { workspaceId: wsId, agentKey: "original", displayName: "Original", behaviorMd: "Original behavior" });
    expect(identity).toMatchObject({ behaviorMd: "Original behavior" });
    expect(rows.artifactInputLineage).toMatchObject([{ artifactType: "AgentIdentity", origin: "HUMAN_ORIGINAL", rootsJson: [] }]);
    const updated = await updateAgentBehavior(adminActor, { workspaceId: wsId, agentIdentityId: identity.id, behaviorMd: "Human revision" });
    expect(updated).toMatchObject({ behaviorMd: "Human revision" });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ artifactType: "AgentIdentity", origin: "HUMAN_ORIGINAL", rootsJson: [], revision: 2 });
  });
  it("captures copied content's complete proof and retains it when a human edits safe fields", async () => {
    const input = await originalAction();
    const lineageRoots = await source.captureArtifactInputProof(adminActor, wsId, [{ kind: "Action", id: input.id }]);
    const identity = await createAgentIdentity(adminActor, { workspaceId: wsId, agentKey: "derived", displayName: "Derived", behaviorMd: input.bodyMd, copied: true, lineageRoots });
    await updateAgentIdentity(adminActor, { workspaceId: wsId, agentIdentityId: identity.id, displayName: "Renamed" });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ origin: "DERIVED", rootsJson: [expect.objectContaining({ kind: "Action", id: input.id })] });
    input.archivedAt = new Date();
    expect(await listAgentIdentities(adminActor, wsId)).toEqual([]);
  });
  it("withholds agent/copied creation without proof and never certifies an unknown partial edit", async () => {
    const identity = await createAgentIdentity(adminActor, { workspaceId: wsId, agentKey: "unknown", displayName: "Unproven", behaviorMd: "Unproven body", copied: true });
    expect(identity).toEqual({ id: identity.id, contentWithheld: true });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ origin: "UNKNOWN" });
    expect(await updateAgentIdentity(adminActor, { workspaceId: wsId, agentIdentityId: identity.id, displayName: "Human rename" })).toEqual({ id: identity.id, contentWithheld: true });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ origin: "UNKNOWN" });
  });
  it("rejects changed captured inputs before creating an identity", async () => {
    const input = await originalAction();
    const lineageRoots = await source.captureArtifactInputProof(adminActor, wsId, [{ kind: "Action", id: input.id }]);
    input.bodyMd = "Changed after model input capture";
    await expect(createAgentIdentity(adminActor, { workspaceId: wsId, agentKey: "stale", displayName: "Stale", copied: true, lineageRoots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(rows.agentIdentity).toHaveLength(0);
  });
  it("proves native workspace behavior but holds an unknown prior config through an edit", async () => {
    const original = await updateWorkspaceAgentBehavior(adminActor, { workspaceId: wsId, behaviorMd: "Workspace policy" });
    expect(original).toMatchObject({ behaviorMd: "Workspace policy", isActive: false });
    expect(await getWorkspaceAgentBehavior(adminActor, wsId)).toBe("Workspace policy");
    rows.artifactInputLineage.length = 0;
    expect(await updateWorkspaceAgentBehavior(adminActor, { workspaceId: wsId, behaviorMd: "Replacement only changes behavior" })).toMatchObject({ contentWithheld: true });
    expect(await getWorkspaceAgentBehavior(adminActor, wsId)).toBeNull();
  });
});
