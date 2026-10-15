import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationIntent } from "./notifications";
import { captureArtifactInputProof, readableArtifactIds } from "./source-lineage";
import { AppError } from "./errors";

vi.mock("./producer-lineage", () => ({
  prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "HUMAN_ORIGINAL", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue(undefined),
}));

const { prismaMock } = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    tension: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    adviceProcess: {
      findMany: vi.fn(),
    },
    tensionUpvote: {
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    member: {
      findFirst: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    document: {
      findMany: vi.fn(),
    },
    workItemEvidence: {
      createMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    workItemVersion: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  };
  return { prismaMock: prisma };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./notifications", () => ({
  createNotificationIntent: vi.fn().mockResolvedValue({ count: 1 }),
}));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: vi.fn().mockResolvedValue({ id: "mem-1", workspaceId: "ws-1", userId: "u-1", role: "MEMBER", isActive: true }),
  actorUserIdForWorkspace: vi.fn().mockResolvedValue("u-1"),
}));

vi.mock("./source-lineage", () => ({
  assertArtifactInputWriteFence: vi.fn(),
  isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  withArtifactCountReleaseSnapshot: vi.fn(async (_actor, _workspaceId, _roots, _remote, finish) => finish({})),
  captureArtifactInputProof: vi.fn().mockResolvedValue([]),
  readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, records) =>
    new Set(records.map((record: { id: string }) => record.id))),
}));

const actor = { kind: "user", user: { id: "u-1" } } as any;

describe("tensions domain", () => {
  it.each(["credential-a", "credential-b"])("rejects private creation by %s before duplicate reads or writes", async credentialId => {
    const {createTension} = await import("./tensions");
    const credential = {kind: "agent", authProvider: "credential", credentialId, workspaceIds: ["ws-1"], scopes: ["support:write"]} as any;
    await expect(createTension(credential, {workspaceId: "ws-1", title: "Private"})).rejects.toMatchObject({code: "PRIVATE_AGENT_ARTIFACT_UNSUPPORTED"});
    expect(prismaMock.tension.create).not.toHaveBeenCalled();
    expect(prismaMock.tension.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tension.findFirst).not.toHaveBeenCalled();
  });
  it("rejects public agent creation without complete inputs before looking for duplicates", async () => {
    const {createTension} = await import("./tensions");
    await expect(createTension({kind: "agent", workspaceIds: ["ws-1"]} as any, {...{workspaceId: "ws-1", title: "Private"}, isPrivate: false}))
      .rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    expect(prismaMock.tension.create).not.toHaveBeenCalled();
    expect(prismaMock.tension.findMany).not.toHaveBeenCalled();
  });

  it.each(["credential-a", "credential-b"])("does not return a hidden private tension through a no-op update by %s", async credentialId => {
    const {updateTension} = await import("./tensions");
    const credential = {kind: "agent", authProvider: "credential", credentialId, workspaceIds: ["ws-1"], scopes: ["tensions:write"]} as any;
    prismaMock.tension.findUnique.mockResolvedValue({id: "private", workspaceId: "ws-1", status: "DRAFT", isPrivate: true, title: "Private", bodyMd: "Hidden", archivedAt: null});
    vi.mocked(readableArtifactIds).mockResolvedValueOnce(new Set());
    await expect(updateTension(credential, {workspaceId: "ws-1", tensionId: "private"})).rejects.toMatchObject({code: "NOT_FOUND"});
    expect(prismaMock.tension.update).not.toHaveBeenCalled();
    expect(readableArtifactIds).toHaveBeenCalledWith(credential, "ws-1", "Tension", [expect.objectContaining({id: "private"})], prismaMock);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(captureArtifactInputProof).mockReset().mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.$executeRaw.mockResolvedValue({});
    prismaMock.workItemVersion.create.mockResolvedValue({});
    prismaMock.workItemVersion.findUnique.mockResolvedValue(null);
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.member.findFirst.mockResolvedValue({ id: "raised-member-1" });
    prismaMock.tension.count.mockResolvedValue(1);
    prismaMock.tension.create.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "raised-member-1",
    });
    prismaMock.tension.findFirst.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
    });
    prismaMock.tension.findMany.mockResolvedValue([{ id: "t-1" }]);
    prismaMock.tensionUpvote.findMany.mockImplementation(async query => {
      const rows = await prismaMock.tension.findMany.mock.results.at(-1)?.value ?? [];
      return rows.flatMap((row: {id: string; upvotes?: Array<{id: string}>}) => row.id === query.where.tensionId ? row.upvotes ?? [] : [])
        .filter((vote: {id: string}) => !query.where.id?.gt || vote.id > query.where.id.gt)
        .sort((a: {id: string}, b: {id: string}) => a.id.localeCompare(b.id)).slice(0, query.take);
    });
    prismaMock.adviceProcess.findMany.mockResolvedValue([]);
    prismaMock.tension.findUnique.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "DRAFT",
      version: 1,
      publishedAt: null,
      archivedAt: null,
      raisedByMemberId: null,
    });
    prismaMock.tension.update.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "raised-member-1",
    });
    prismaMock.tensionUpvote.upsert.mockResolvedValue({
      id: "upvote-1",
      tensionId: "t-1",
      userId: "u-1",
    });
  });

  it("creates a tension with a valid raised-by member", async () => {
    const { createTension } = await import("./tensions");

    const result = await createTension(actor, {
      workspaceId: "ws-1",
      title: " Test tension ",
      bodyMd: " Details ",
      raisedByMemberId: "raised-member-1",
      priority: 5,
    });

    expect(result.raisedByMemberId).toBe("raised-member-1");
    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: {
        id: "raised-member-1",
        workspaceId: "ws-1",
        isActive: true,
      },
      select: { id: true },
    });
    expect(prismaMock.tension.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        authorUserId: "u-1",
        title: "Test tension",
        bodyMd: "Details",
        raisedByMemberId: "raised-member-1",
        priority: 5,
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      }),
    });
  });

  it("creates a tension with a valid responsible person", async () => {
    prismaMock.member.findFirst.mockResolvedValueOnce({ id: "responsible-member-1" });
    prismaMock.tension.create.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      assigneeMemberId: "responsible-member-1",
    });
    const { createTension } = await import("./tensions");

    const result = await createTension(actor, {
      workspaceId: "ws-1",
      title: "Test tension",
      assigneeMemberId: "responsible-member-1",
    });

    expect(result.assigneeMemberId).toBe("responsible-member-1");
    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "responsible-member-1",
        workspaceId: "ws-1",
        isActive: true,
        NOT: expect.any(Array),
      }),
      select: { id: true },
    });
    expect(prismaMock.tension.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assigneeMemberId: "responsible-member-1",
      }),
    });
  });

  it("rejects responsible people outside the active human workspace membership set", async () => {
    prismaMock.member.findFirst.mockResolvedValueOnce(null);
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: "Test tension",
      assigneeMemberId: "system-member",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.tension.create).not.toHaveBeenCalled();
  });

  it("creates unchecked-private tensions as open public records", async () => {
    prismaMock.tension.create.mockResolvedValueOnce({
      id: "t-public",
      workspaceId: "ws-1",
      title: "Public tension",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-05-26T12:00:00.000Z"),
    });
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: " Public tension ",
      isPrivate: false,
    })).resolves.toMatchObject({
      id: "t-public",
      status: "OPEN",
      isPrivate: false,
    });

    expect(prismaMock.tension.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        title: "Public tension",
        status: "OPEN",
        isPrivate: false,
        publishedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "tension.created",
        entityId: "t-public",
      }),
    }));
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "tension.published",
        entityId: "t-public",
      }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "tension.published",
          aggregateId: "t-public",
          payload: { tensionId: "t-public", actorUserId: "u-1" },
        }),
      ],
    });
  });

  it("rejects raised-by members outside the active workspace", async () => {
    prismaMock.member.findFirst.mockResolvedValueOnce(null);
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: "Test tension",
      raisedByMemberId: "other-workspace-member",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_INPUT",
    });

    expect(prismaMock.tension.create).not.toHaveBeenCalled();
  });

  it("rejects hidden, missing, archived, or cross-workspace linked proposals before creating a tension", async () => {
    prismaMock.proposal.findFirst.mockResolvedValueOnce(null);
    const { createTension } = await import("./tensions");

    await expect(createTension(actor, {
      workspaceId: "ws-1",
      title: "Test tension",
      proposalId: "proposal-missing",
    })).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });

    expect(prismaMock.proposal.findFirst).toHaveBeenCalledWith({
      where: {
        id: "proposal-missing",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
      select: { id: true },
    });
    expect(prismaMock.tension.create).not.toHaveBeenCalled();
  });

  it("preserves a linked proposal when a duplicate tension is updated", async () => {
    const existingTension = {
      id: "t-duplicate",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Clarify pricing handoff",
      bodyMd: "Finance needs the latest buyer context.",
      status: "DRAFT",
      version: 1,
      publishedAt: null,
      archivedAt: null,
      circleId: null,
      assigneeMemberId: null,
      raisedByMemberId: null,
      proposalId: null,
      priority: 1,
      isPrivate: true,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.tension.findMany.mockResolvedValueOnce([existingTension]);
    prismaMock.tension.findFirst.mockResolvedValueOnce({
      ...existingTension,
      author: { id: "u-1", displayName: null, email: "user@example.com" },
      circle: null,
      assigneeMember: null,
      raisedByMember: null,
      proposal: null,
      upvotes: [],
    });
    prismaMock.tension.findUnique.mockResolvedValueOnce(existingTension);
    prismaMock.proposal.findFirst.mockResolvedValueOnce({ id: "proposal-1" });
    prismaMock.tension.update.mockResolvedValueOnce({
      ...existingTension,
      proposalId: "proposal-1",
      priority: 4,
    });

    const { createTension } = await import("./tensions");
    await createTension(actor, {
      workspaceId: "ws-1",
      title: "Clarify pricing handoff",
      bodyMd: "Finance needs the latest buyer context.",
      proposalId: "proposal-1",
      priority: 4,
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "t-duplicate",
      },
    });

    expect(prismaMock.proposal.findFirst).toHaveBeenCalledWith({
      where: {
        id: "proposal-1",
        workspaceId: "ws-1",
        archivedAt: null,
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
      select: { id: true },
    });
    expect(prismaMock.tension.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "t-duplicate" }),
      data: expect.objectContaining({
        proposalId: "proposal-1",
        priority: 4,
      }),
    }));
    expect(prismaMock.tension.create).not.toHaveBeenCalled();
  });

  it("updates a tension raised-by member", async () => {
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: "raised-member-1",
      expectedVersion: 1,
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: {
        id: "raised-member-1",
        workspaceId: "ws-1",
        isActive: true,
      },
      select: { id: true },
    });
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-1",
        version: 1,
        changedFields: ["raisedByMemberId"],
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-1" }),
      data: { raisedByMemberId: "raised-member-1", version: 2 },
    });
  });

  it("updates a tension responsible person", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "DRAFT",
      version: 1,
      publishedAt: null,
      archivedAt: null,
      assigneeMemberId: null,
      raisedByMemberId: null,
    });
    prismaMock.member.findFirst.mockResolvedValueOnce({ id: "responsible-member-1" });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      assigneeMemberId: "responsible-member-1",
      expectedVersion: 1,
    });

    expect(prismaMock.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "responsible-member-1",
        workspaceId: "ws-1",
        isActive: true,
        NOT: expect.any(Array),
      }),
      select: { id: true },
    });
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-1",
        version: 1,
        changedFields: ["assigneeMemberId"],
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-1" }),
      data: { assigneeMemberId: "responsible-member-1", version: 2 },
    });
    expect(createNotificationIntent).not.toHaveBeenCalled();
  });

  it.each(["old-member", null])("notifies a new responsible member when an open public tension moves from %s", async (previousAssigneeMemberId) => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", authorUserId: "u-1", title: "Test tension",
      status: "OPEN", isPrivate: false, version: 1, archivedAt: null,
      assigneeMemberId: previousAssigneeMemberId,
    });
    prismaMock.member.findFirst.mockResolvedValueOnce({ id: "new-member" });
    prismaMock.member.findFirst.mockResolvedValueOnce({ userId: "u-2" });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", title: "Test tension", status: "OPEN",
      isPrivate: false, version: 2, archivedAt: null, assigneeMemberId: "new-member",
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1", tensionId: "t-1", assigneeMemberId: "new-member", expectedVersion: 1,
    });

    expect(createNotificationIntent).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      workspaceId: "ws-1",
      type: "tension.assigned",
      recipientUserIds: ["u-2"],
      actorUserId: "u-1",
      entityType: "Tension",
      entityId: "t-1",
      dedupeKey: "tension-assigned:t-1:2",
    }));
  });

  it("does not add a direct assignment notice when a draft is published with an assignee", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", authorUserId: "u-1", title: "Test tension",
      status: "DRAFT", isPrivate: true, version: 1, archivedAt: null, assigneeMemberId: null,
    });
    prismaMock.member.findFirst.mockResolvedValueOnce({ id: "new-member" });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", title: "Test tension", status: "OPEN",
      isPrivate: false, version: 2, archivedAt: null, assigneeMemberId: "new-member",
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1", tensionId: "t-1", status: "OPEN", assigneeMemberId: "new-member", expectedVersion: 1,
    });

    expect(createNotificationIntent).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ type: "tension.published" })],
    }));
  });

  it("does not notify when an open public tension is unassigned", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", authorUserId: "u-1", title: "Test tension",
      status: "OPEN", isPrivate: false, version: 1, archivedAt: null, assigneeMemberId: "old-member",
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", title: "Test tension", status: "OPEN",
      isPrivate: false, version: 2, archivedAt: null, assigneeMemberId: null,
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, { workspaceId: "ws-1", tensionId: "t-1", assigneeMemberId: null, expectedVersion: 1 });

    expect(createNotificationIntent).not.toHaveBeenCalled();
  });

  it("rechecks the new assignee is active before creating a notice", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", authorUserId: "u-1", title: "Test tension",
      status: "OPEN", isPrivate: false, version: 1, archivedAt: null, assigneeMemberId: "old-member",
    });
    prismaMock.member.findFirst.mockResolvedValueOnce({ id: "new-member" });
    prismaMock.member.findFirst.mockResolvedValueOnce(null);
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", title: "Test tension", status: "OPEN",
      isPrivate: false, version: 2, archivedAt: null, assigneeMemberId: "new-member",
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, { workspaceId: "ws-1", tensionId: "t-1", assigneeMemberId: "new-member", expectedVersion: 1 });

    expect(prismaMock.member.findFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: "new-member", workspaceId: "ws-1", isActive: true }),
      select: { userId: true },
    });
    expect(createNotificationIntent).not.toHaveBeenCalled();
  });

  it("clears a tension raised-by member", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "DRAFT",
      version: 1,
      publishedAt: null,
      archivedAt: null,
      raisedByMemberId: "raised-member-1",
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: null,
      expectedVersion: 1,
    });

    expect(prismaMock.member.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-1" }),
      data: { raisedByMemberId: null, version: 2 },
    });
  });

  it("does not create a version for no-op content updates", async () => {
    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      raisedByMemberId: null,
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "t-1",
      version: 1,
    });

    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.tension.update).not.toHaveBeenCalled();
  });

  it("rejects missing versions for same-value and mixed content intent without effects", async () => {
    prismaMock.tension.findUnique.mockResolvedValue({
      id: "t-1", workspaceId: "ws-1", authorUserId: "u-1",
      title: "Current tension", status: "OPEN", version: 2,
      isPrivate: false, archivedAt: null,
    });
    const { updateTension } = await import("./tensions");

    for (const params of [
      { title: "Current tension" },
      { title: "Changed tension", status: "RESOLVED" as const, resolvedVia: "Done" },
    ]) {
      await expect(updateTension(actor, { workspaceId: "ws-1", tensionId: "t-1", ...params }))
        .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    }

    expect(prismaMock.tension.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("emits one publication event when a draft opens through update", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", authorUserId: "u-1", title: "Visible tension",
      status: "DRAFT", isPrivate: true, version: 1, publishedAt: null, archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1", workspaceId: "ws-1", title: "Visible tension", status: "OPEN", isPrivate: false, version: 1,
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, { workspaceId: "ws-1", tensionId: "t-1", status: "OPEN" });

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "tension.published", entityId: "t-1" }),
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ type: "tension.published", aggregateId: "t-1", payload: { tensionId: "t-1", actorUserId: "u-1" } })],
    }));
    expect(prismaMock.event.createMany).toHaveBeenCalledTimes(2);
  });

  it("allows the author to edit an open tension and preserves the previous version", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      bodyMd: "Old body",
      status: "OPEN",
      version: 1,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
      raisedByMemberId: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      title: "New title",
      status: "OPEN",
      version: 2,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      title: "New title",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "t-open",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-open",
        version: 1,
        changedFields: ["title"],
        previousState: expect.objectContaining({
          title: "Old title",
          version: 1,
        }),
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-open" }),
      data: { title: "New title", version: 2 },
    });
  });

  it("allows the assigned member to edit an open tension and preserves the previous version", async () => {
    const { requireWorkspaceMembership } = await import("./auth");
    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-2",
      workspaceId: "ws-1",
      userId: "u-2",
      role: "MEMBER",
      isActive: true,
    } as any);
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "agent-user",
      assigneeMemberId: "mem-2",
      title: "Old title",
      bodyMd: "Old body",
      status: "OPEN",
      version: 1,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
      raisedByMemberId: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "agent-user",
      assigneeMemberId: "mem-2",
      title: "Assigned update",
      status: "OPEN",
      version: 2,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension({ kind: "user", user: { id: "u-2" } } as any, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      title: "Assigned update",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "t-open",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-open",
        version: 1,
        changedFields: ["title"],
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-open" }),
      data: { title: "Assigned update", version: 2 },
    });
  });

  it("allows any active member to edit a public open tension", async () => {
    const { requireWorkspaceMembership } = await import("./auth");
    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-2",
      workspaceId: "ws-1",
      userId: "u-2",
      role: "MEMBER",
      isActive: true,
    } as any);
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      status: "OPEN",
      version: 1,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Member edit",
      status: "OPEN",
      version: 2,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension({ kind: "user", user: { id: "u-2" } } as any, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      title: "Member edit",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "t-open",
      version: 2,
    });

    expect(prismaMock.workItemVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: "Tension",
        entityId: "t-open",
        version: 1,
        changedFields: ["title"],
      }),
    }));
    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-open" }),
      data: { title: "Member edit", version: 2 },
    });
  });

  it("rejects stale collaborative tension edits when the tension changes before write", async () => {
    const { requireWorkspaceMembership } = await import("./auth");
    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-2",
      workspaceId: "ws-1",
      userId: "u-2",
      role: "MEMBER",
      isActive: true,
    } as any);
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.tension.update.mockRejectedValueOnce({ code: "P2025" });
    const { updateTension } = await import("./tensions");

    await expect(updateTension({ kind: "user", user: { id: "u-2" } } as any, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      title: "Stale member edit",
      expectedVersion: 1,
    })).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      message: "The record changed before this update could be applied. Please refresh and try again.",
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: {
        id: "t-open",
        workspaceId: "ws-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      },
      data: { title: "Stale member edit", version: 2 },
    });
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("honors expectedVersion and succeeds if it matches current version", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      title: "New title",
      status: "OPEN",
      version: 2,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      title: "New title",
      expectedVersion: 1,
    })).resolves.toMatchObject({
      id: "t-1",
      version: 2,
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: {
        id: "t-1",
        workspaceId: "ws-1",
        archivedAt: null,
        status: "OPEN",
        isPrivate: false,
        version: 1,
      },
      data: expect.objectContaining({
        title: "New title",
        version: 2,
      }),
    });
    expect(prismaMock.workItemVersion.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.event.createMany).toHaveBeenCalledTimes(1);
  });

  it("honors expectedVersion and rejects early if it does not match current version without side effects", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      status: "OPEN",
      version: 2,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      title: "New title",
      expectedVersion: 1,
    })).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      message: "The record changed before this update could be applied. Please refresh and try again.",
    });

    expect(prismaMock.tension.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("rejects 0, negative, or fractional expectedVersion as invalid input even on no-op", async () => {
    prismaMock.tension.findUnique.mockResolvedValue({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Old title",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });
    const { updateTension } = await import("./tensions");

    for (const invalidVersion of [0, -1, 1.5]) {
      await expect(updateTension(actor, {
        workspaceId: "ws-1",
        tensionId: "t-1",
        expectedVersion: invalidVersion,
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_INPUT",
      });
    }

    expect(prismaMock.tension.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
  });

  it("locks before the authoritative Tension no-op read and rejects a concurrently advanced version without side effects", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-noop-stale",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Already current",
      status: "OPEN",
      version: 2,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      archivedAt: null,
    });

    const { updateTension } = await import("./tensions");
    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-noop-stale",
      title: "Already current",
      expectedVersion: 1,
    })).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });

    expect(prismaMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "Tension:t-noop-stale");
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prismaMock.tension.findUnique.mock.invocationCallOrder[0]);
    expect(prismaMock.tension.update).not.toHaveBeenCalled();
    expect(prismaMock.workItemVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    expect(prismaMock.event.createMany).not.toHaveBeenCalled();
  });

  it("lists tensions with raised-by metadata", async () => {
    const { listTensions } = await import("./tensions");

    await expect(listTensions(actor, "ws-1")).resolves.toMatchObject({
      items: [{
        id: "t-1",
        inputRequestCount: 0,
        activeInputRequestCount: 0,
      }],
      total: 1,
    });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        raisedByMember: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                email: true,
              },
            },
          },
        },
      }),

    }));
    expect(prismaMock.adviceProcess.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        subjectType: "TENSION",
        subjectId: { in: ["t-1"] },
      },
      select: {
        subjectId: true,
        requests: true,
      },
    });
  });

  it("adds tension input-request counts from advice processes", async () => {
    const { listTensions } = await import("./tensions");

    prismaMock.tension.findMany.mockResolvedValue([{ id: "t-1" }]);
    prismaMock.adviceProcess.findMany.mockResolvedValueOnce([
      {
        subjectId: "t-1",
        requests: [
          { id: "request-active", status: "ACTIVE" },
          { id: "request-canceled", status: "CANCELED" },
          { id: "request-completed", status: "COMPLETED" },
        ],
      },
    ]);

    await expect(listTensions(actor, "ws-1")).resolves.toMatchObject({
      items: [{
        id: "t-1",
        inputRequestCount: 3,
        activeInputRequestCount: 1,
      }],
    });
  });

  it("sorts tensions by title when requested", async () => {
    const { listTensions } = await import("./tensions");

    await listTensions(actor, "ws-1", { sort: "alpha" });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [
        { title: "asc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
    }));
  });

  it("applies opened and closed date filters when listing tensions", async () => {
    const { listTensions } = await import("./tensions");
    const openedFrom = new Date("2026-06-01T00:00:00.000Z");
    const openedTo = new Date("2026-06-02T23:59:59.999Z");
    const closedFrom = new Date("2026-06-03T00:00:00.000Z");
    const closedTo = new Date("2026-06-04T23:59:59.999Z");

    await listTensions(actor, "ws-1", {
      openedFrom,
      openedTo,
      closedFrom,
      closedTo,
    });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        publishedAt: { gte: openedFrom, lte: openedTo },
        resolvedAt: { gte: closedFrom, lte: closedTo },
      }),
    }));
    expect(prismaMock.tension.count).not.toHaveBeenCalled();
  });

  it("sets resolvedAt when resolving a tension", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      resolvedVia: null,
      resolvedAt: null,
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "RESOLVED",
      resolvedVia: "Process changed",
      resolvedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      status: "RESOLVED",
      resolvedVia: " Process changed ",
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-open" }),
      data: expect.objectContaining({
        status: "RESOLVED",
        isPrivate: false,
        resolvedVia: "Process changed",
        resolvedAt: expect.any(Date),
      }),
    });
  });

  it("combines member filters with the existing privacy filter", async () => {
    const { listTensions } = await import("./tensions");
    await listTensions(actor, "ws-1", { memberId: "mem-1", circleId: "circle-1" });

    expect(prismaMock.tension.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "ws-1",
        circleId: "circle-1",
        AND: [
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
            ],
          },
          {
            OR: [
              { assigneeMemberId: { in: ["mem-1"] } },
              { raisedByMemberId: { in: ["mem-1"] } },
              {
                author: {
                  memberships: {
                    some: {
                      id: { in: ["mem-1"] },
                      workspaceId: "ws-1",
                      isActive: true,
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    }));
  });

  it("links resolution evidence when resolving a tension", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "OPEN",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      resolvedVia: null,
      resolvedAt: null,
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-open",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "RESOLVED",
      resolvedVia: "Process changed",
      resolvedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    prismaMock.document.findMany.mockResolvedValueOnce([{ id: "doc-1" }]);
    prismaMock.workItemEvidence.createMany.mockResolvedValueOnce({ count: 1 });
    const { updateTension } = await import("./tensions");

    await updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-open",
      status: "RESOLVED",
      resolvedVia: "Process changed",
      evidenceDocumentIds: ["doc-1", "doc-1"],
    });

    expect(prismaMock.workItemEvidence.createMany).toHaveBeenCalledWith({
      data: [{
        workspaceId: "ws-1",
        entityType: "Tension",
        entityId: "t-open",
        documentId: "doc-1",
        purpose: "resolution_evidence",
      }],
      skipDuplicates: true,
    });
  });

  it("rejects upvotes for non-open public tensions", async () => {
    const { upvoteTension } = await import("./tensions");
    for (const tension of [
      { status: "RESOLVED", isPrivate: false, archivedAt: null },
      { status: "DRAFT", isPrivate: true, archivedAt: null },
      { status: "OPEN", isPrivate: true, archivedAt: null },
      { status: "OPEN", isPrivate: false, archivedAt: new Date("2026-06-01T00:00:00.000Z") },
    ]) {
      vi.clearAllMocks();
      prismaMock.tension.findUnique.mockResolvedValueOnce({
        id: "t-1",
        workspaceId: "ws-1",
        ...tension,
      });

      await expect(upvoteTension(actor, {
        workspaceId: "ws-1",
        tensionId: "t-1",
      })).rejects.toMatchObject({
        status: 400,
        code: "INVALID_STATE",
      });
      expect(prismaMock.tensionUpvote.upsert).not.toHaveBeenCalled();
    }
  });

  it("upvotes open public tensions", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      status: "OPEN",
      isPrivate: false,
      archivedAt: null,
    });
    const { upvoteTension } = await import("./tensions");

    await expect(upvoteTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
    })).resolves.toMatchObject({
      id: "upvote-1",
    });

    expect(prismaMock.tensionUpvote.upsert).toHaveBeenCalledWith({
      where: {
        tensionId_userId: {
          tensionId: "t-1",
          userId: "u-1",
        },
      },
      update: {},
      create: {
        tensionId: "t-1",
        userId: "u-1",
      },
    });
  });

  it("fetches tension details with raised-by metadata and requires membership", async () => {
    const { getTension } = await import("./tensions");
    const { requireWorkspaceMembership } = await import("./auth");

    const result = await getTension(actor, { workspaceId: "ws-1", tensionId: "t-1" });

    expect(requireWorkspaceMembership).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
    });

    expect(prismaMock.tension.findFirst).toHaveBeenCalledWith({
      where: {
        id: "t-1",
        workspaceId: "ws-1",
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT", authorUserId: "u-1" },
        ],
      },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        circle: { select: { id: true, name: true } },
        assigneeMember: { include: { user: { select: { id: true, displayName: true, email: true } } } },
        raisedByMember: { include: { user: { select: { id: true, displayName: true, email: true } } } },
        proposal: true,
        upvotes: true,
      },
    });

    expect(result.title).toBe("Test tension");
  });

  it("does not expose private tensions to non-authors by direct id", async () => {
    const { getTension } = await import("./tensions");

    prismaMock.tension.findFirst.mockResolvedValueOnce(null);

    const otherActor = { kind: "user", user: { id: "u-2" } } as any;
    await expect(getTension(otherActor, { workspaceId: "ws-1", tensionId: "t-private" })).rejects.toThrow("Tension not found.");
  });

  it("lets workspace admins see private tension drafts", async () => {
    const { getTension } = await import("./tensions");
    const { requireWorkspaceMembership } = await import("./auth");

    vi.mocked(requireWorkspaceMembership).mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "u-admin",
      role: "ADMIN",
      isActive: true,
    } as any);
    prismaMock.tension.findFirst.mockResolvedValueOnce({
      id: "t-private",
      workspaceId: "ws-1",
      title: "Private tension",
      authorUserId: "u-1",
      status: "DRAFT",
      isPrivate: true,
    });

    const adminActor = { kind: "user", user: { id: "u-admin", globalRole: "USER" } } as any;
    await expect(getTension(adminActor, { workspaceId: "ws-1", tensionId: "t-private" })).resolves.toMatchObject({
      id: "t-private",
    });

    expect(prismaMock.tension.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "t-private",
        workspaceId: "ws-1",
        OR: [
          { isPrivate: false },
          { isPrivate: true, status: "DRAFT" },
        ],
      },
    }));
  });

  it("returns an open tension to draft", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "OPEN",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      resolvedAt: null,
      resolvedVia: null,
    });

    const { returnTensionToDraft } = await import("./tensions");

    await expect(returnTensionToDraft(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
    })).resolves.toMatchObject({
      id: "t-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-1" }),
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        resolvedVia: null,
        resolvedAt: null,
      },
    });
  });

  it("returns a resolved tension to draft and clears resolution state", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "RESOLVED",
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      resolvedAt: new Date("2026-04-27T12:00:00.000Z"),
      resolvedVia: "Done",
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "DRAFT",
      isPrivate: true,
      publishedAt: null,
      resolvedAt: null,
      resolvedVia: null,
    });

    const { returnTensionToDraft } = await import("./tensions");

    await expect(returnTensionToDraft(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
    })).resolves.toMatchObject({
      id: "t-1",
      status: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-1" }),
      data: {
        status: "DRAFT",
        isPrivate: true,
        publishedAt: null,
        resolvedVia: null,
        resolvedAt: null,
      },
    });
  });

  it("reopens a resolved tension and clears resolution state", async () => {
    prismaMock.tension.findUnique.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      authorUserId: "u-1",
      title: "Test tension",
      status: "RESOLVED",
      version: 1,
      isPrivate: false,
      publishedAt: new Date("2026-04-26T12:00:00.000Z"),
      resolvedAt: new Date("2026-04-27T12:00:00.000Z"),
      resolvedVia: "Done",
      archivedAt: null,
    });
    prismaMock.tension.update.mockResolvedValueOnce({
      id: "t-1",
      workspaceId: "ws-1",
      title: "Test tension",
      status: "OPEN",
      isPrivate: false,
      resolvedAt: null,
      resolvedVia: null,
    });

    const { updateTension } = await import("./tensions");

    await expect(updateTension(actor, {
      workspaceId: "ws-1",
      tensionId: "t-1",
      status: "OPEN",
    })).resolves.toMatchObject({
      id: "t-1",
      status: "OPEN",
    });

    expect(prismaMock.tension.update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "t-1" }),
      data: expect.objectContaining({
        status: "OPEN",
        isPrivate: false,
        resolvedVia: null,
        resolvedAt: null,
      }),
    });
  });

  it("records original tension content inside its creation transaction", async () => {
    const { createTension } = await import("./tensions");
    await createTension(actor, { workspaceId: "ws-1", title: "Synthetic tension" });
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock, copied: false }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock,
      artifact: { kind: "Tension", id: "t-1" } }));
  });

  it("keeps agent input proof, duplicate scan, authorship and native write on the supplied transaction", async () => {
    const { createTension } = await import("./tensions");
    const { requireWorkspaceMembership, actorUserIdForWorkspace } = await import("./auth");
    const { isArtifactInputProofReadable } = await import("./source-lineage");
    const txFindMany = vi.fn().mockResolvedValue([]);
    const txCreate = vi.fn().mockResolvedValue({ id: "tx-tension", workspaceId: "ws-1", title: "Native tension" });
    const txMemberFindFirst = vi.fn().mockResolvedValue({ userId: "system-user" });
    const tx = { ...prismaMock, tension: { ...prismaMock.tension, findMany: txFindMany, create: txCreate },
      member: { ...prismaMock.member, findFirst: txMemberFindFirst } } as any;
    const nativeActor = { kind: "agent", label: "system", authProvider: "bootstrap", workspaceIds: ["ws-1"] } as any;
    const root = { kind: "ExecutionResult", id: "result-1", fingerprint: "a".repeat(64) } as any;
    const result = await createTension(nativeActor, { workspaceId: "ws-1", title: "Native tension",
      isPrivate: false, lineageRoots: [root], duplicateGuard: {} }, tx);
    expect(result.id).toBe("tx-tension");
    expect(requireWorkspaceMembership).toHaveBeenCalledWith(expect.objectContaining({ tx }));
    expect(isArtifactInputProofReadable).toHaveBeenCalledWith(nativeActor, "ws-1", [root], tx);
    expect(txFindMany).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ authorUserId: "system-user" }) });
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx }));
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.tension.findMany).not.toHaveBeenCalled();
    expect(prismaMock.tension.create).not.toHaveBeenCalled();
    expect(actorUserIdForWorkspace).not.toHaveBeenCalled();
  });

  it("rejects duplicate update in a supplied transaction before lookup or writes", async () => {
    const { createTension } = await import("./tensions");
    const txFindMany = vi.fn();
    const txCreate = vi.fn();
    const tx = { ...prismaMock, tension: { ...prismaMock.tension, findMany: txFindMany, create: txCreate } } as any;
    await expect(createTension(actor, { workspaceId: "ws-1", title: "Duplicate",
      duplicateGuard: { resolution: "update_existing", targetEntityId: "t-old" } }, tx))
      .rejects.toMatchObject({ code: "DUPLICATE_GUARD_TRANSACTION_UNSUPPORTED" });
    expect(txFindMany).not.toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it.each(["list", "detail"] as const)("withholds revoked tension %s labels without hiding the independently public body", async (surface) => {
    const tension = { id: "public-tension", workspaceId: "ws-1", title: "Public tension", bodyMd: "Independent body",
      authorUserId: "departed", author: { id: "departed", displayName: "Private profile", email: "private@example.test" },
      circleId: "restricted-circle", circle: { id: "restricted-circle", name: "Private circle" },
      assigneeMemberId: "departed-member", assigneeMember: { id: "departed-member", user: { id: "departed", displayName: "Private profile", email: "private@example.test" } },
      raisedByMemberId: "departed-member", raisedByMember: { id: "departed-member", user: { id: "departed", displayName: "Private profile", email: "private@example.test" } },
      upvotes: [], proposalId: null, proposal: null,
    };
    prismaMock.tension.findMany.mockResolvedValue([tension]);
    prismaMock.tension.findFirst.mockResolvedValue(tension);
    const { getTension, listTensions } = await import("./tensions");
    const read = async () => surface === "list" ? (await listTensions(actor, "ws-1")).items[0] : getTension(actor, { workspaceId: "ws-1", tensionId: tension.id });
    expect(await read()).toMatchObject({ author: tension.author, raisedByMember: tension.raisedByMember });
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor,_workspace,inputs)=>{
      if(inputs.some(input=>["User","Member","Circle"].includes(input.kind))) throw new AppError(403,"SOURCE_RESTRICTED","Source unavailable.");
      return [];
    });
    const output = await read();
    expect(output).toMatchObject({ title: tension.title, bodyMd: tension.bodyMd, authorUserId: null,
      author: { id: "", displayName: null, email: "" }, assigneeMemberId: null, assigneeMember: null,
      raisedByMemberId: null, raisedByMember: null, circleId: null, circle: null });
    expect(JSON.stringify(output)).not.toMatch(/Private profile|Private circle|private@example|departed|restricted-circle/);
  });

  it("filters exact votes and voter access before priority ranking and pagination", async () => {
    const hiddenVotes = [1, 2, 3].map((id) => ({ id: `hidden-vote-${id}`, tensionId: "raw-winner", userId: `other-workspace-user-${id}` }));
    const visibleVote = { id: "permitted-vote", tensionId: "safe-winner", userId: "active-local-user" };
    const rawWinner = { id: "raw-winner", workspaceId: "ws-1", priority: 1, createdAt: new Date("2026-10-12"), upvotes: hiddenVotes };
    const safeWinner = { id: "safe-winner", workspaceId: "ws-1", priority: 1, createdAt: new Date("2026-10-11"), upvotes: [visibleVote] };
    prismaMock.tension.findMany.mockResolvedValue([rawWinner, safeWinner]);
    const { listTensions, getTension } = await import("./tensions");
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_reader, workspaceId, inputs) => {
      expect(workspaceId).toBe("ws-1");
      if (inputs.some((input) => input.kind === "User" && input.id.startsWith("other-workspace-user"))) {
        throw new AppError(403, "SOURCE_RESTRICTED", "Voter not entitled in target workspace.");
      }
      return [];
    });
    const page = await listTensions(actor, "ws-1", { take: 1 });
    expect(page.total).toBe(2); expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "safe-winner", upvotes: [visibleVote] });
    expect(captureArtifactInputProof).toHaveBeenCalledWith(actor, "ws-1", [
      { kind: "TensionUpvote", id: visibleVote.id, snapshot: visibleVote }, { kind: "User", id: visibleVote.userId },
    ]);
    prismaMock.tension.findFirst.mockResolvedValue(rawWinner);
    expect((await getTension(actor, { workspaceId: "ws-1", tensionId: rawWinner.id })).upvotes).toEqual([]);
    vi.mocked(captureArtifactInputProof).mockImplementation(async (_actor,_workspace,inputs)=>{
      if(inputs.some(input=>input.kind==="User")) throw new AppError(403,"SOURCE_RESTRICTED","Voter membership revoked.");
      return [];
    });
    const afterRevocation = await listTensions(actor, "ws-1", { take: 1 });
    expect(afterRevocation.items[0]).toMatchObject({ id: "raw-winner", upvotes: [] });
    expect(JSON.stringify(afterRevocation)).not.toContain("other-workspace-user");
  });

});
