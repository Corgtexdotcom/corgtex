import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const constitution = { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() };
  const tx = { $executeRaw: vi.fn(), constitution, policyCorpus: { findMany: vi.fn() } };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn(),
      constitution,
      policyCorpus: tx.policyCorpus,
      approvalPolicy: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
    requireWorkspaceMembershipMock: vi.fn(),
  };
});

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

import { readableArtifactIds, recordArtifactInputLineage, invalidateArtifactInputLineage } from "./source-lineage";
import { prepareProducerLineage, finishProducerLineage } from "./producer-lineage";
vi.mock("./source-lineage", () => ({
  captureArtifactInputProof: vi.fn().mockResolvedValue([]),
  readableArtifactIds: vi.fn().mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id))),
  recordArtifactInputLineage: vi.fn().mockResolvedValue({}), invalidateArtifactInputLineage: vi.fn().mockResolvedValue({}),
}));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: vi.fn().mockResolvedValue({ mode: "DERIVED", inputs: [], roots: [] }),
  finishProducerLineage: vi.fn().mockResolvedValue({}) }));

import {
  createConstitutionVersion,
  listConstitutionVersions, getCurrentConstitution, loadConstitutionCorpusSnapshot, listPolicyCorpus,
  fingerprintConstitutionCorpus,
  updateApprovalPolicy,
} from "./constitutions";

const createParams = {
  workspaceId: "ws-1",
  bodyMd: "# Constitution",
  modelUsed: "gpt-test",
};
const acceptedAt = new Date("2026-05-02T00:00:00.000Z");
const publishedAt = new Date("2026-05-01T00:00:00.000Z");
const policy = {
  id: "policy-1",
  proposalId: "proposal-1",
  title: "Switch to Slack",
  bodyMd: "Use Slack for operating communication.",
  circleId: null,
  acceptedAt,
  circle: null,
  proposal: {
    id: "proposal-1",
    title: "Switch to Slack",
    workspaceId: "ws-1",
    isPrivate: false,
    publishedAt,
    tensions: [{ id: "tension-1", title: "Fragmented communication", publishedAt }],
  },
};

describe("createConstitutionVersion", () => {
  beforeEach(() => {
    txMock.$executeRaw.mockReset().mockResolvedValue(0);
    txMock.constitution.findFirst.mockReset().mockResolvedValue(null);
    txMock.constitution.create.mockReset();
    vi.mocked(recordArtifactInputLineage).mockClear();
    vi.mocked(invalidateArtifactInputLineage).mockClear();
    txMock.policyCorpus.findMany.mockReset().mockResolvedValue([]);
    prismaMock.$transaction.mockReset().mockImplementation((callback) => callback(txMock));
  });

  it("retries mixed-deployment conflicts with lock-first read-committed snapshots", async () => {
    txMock.constitution.findFirst
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 })
      .mockResolvedValueOnce({ version: 3 });

    txMock.constitution.create
      .mockRejectedValueOnce({ code: "P2034" })
      .mockRejectedValueOnce({
        code: "P2002",
        meta: {
          target: ["workspaceId", "version"],
        },
      })
      .mockResolvedValueOnce({
        id: "constitution-4",
        sourceReferences: [],
        version: 4,
      });

    await expect(createConstitutionVersion(createParams)).resolves.toEqual({
      id: "constitution-4",
      version: 4, contentWithheld: true,
    });

    expect(txMock.constitution.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        workspaceId: "ws-1",
        version: 2,
      }),
      include: { sourceReferences: true },
    });
    expect(txMock.constitution.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        workspaceId: "ws-1",
        version: 3,
      }),
      include: { sourceReferences: true },
    });
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: "ReadCommitted" });
  });

  it("derives snapshots and creates version-owned references atomically", async () => {
    const references = [
      { pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const },
      { pointOrder: 1, sourceOrder: 2, policyCorpusId: "policy-1", sourceKind: "TENSION" as const, tensionId: "tension-1" },
    ];
    txMock.policyCorpus.findMany.mockResolvedValue([policy]);
    txMock.constitution.create.mockRejectedValueOnce(new Error("reference write failed"));
    await expect(createConstitutionVersion({ ...createParams, references }))
      .rejects.toThrow("reference write failed");
    txMock.constitution.create.mockResolvedValue({ id: "constitution-1", version: 1, sourceReferences: [] });

    await createConstitutionVersion({
      ...createParams,
      references,
    });

    expect(txMock.constitution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 1,
        sourceReferences: {
          create: [
            expect.objectContaining({ pointKey: "point-1", labelSnapshot: "Switch to Slack", proposalId: "proposal-1", tensionId: null, acceptedAtSnapshot: acceptedAt }),
            expect.objectContaining({ pointKey: "point-1", labelSnapshot: "Fragmented communication", proposalId: null, tensionId: "tension-1", acceptedAtSnapshot: acceptedAt }),
          ],
        },
      }),
      include: { sourceReferences: true },
    });
  });

  it("fails closed before the version write for forbidden or drifting sources", async () => {
    txMock.policyCorpus.findMany.mockResolvedValue([policy]);
    const invalidReferenceSets = [
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "TENSION" as const, tensionId: "private-tension" }],
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "other-workspace", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1" }],
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const, proposalId: "wrong-proposal" }],
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1", tensionId: "tension-1" }],
      [1, 2].map((sourceOrder) => ({ pointOrder: 1, sourceOrder, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1" })),
    ];
    for (const references of invalidReferenceSets) {
      await expect(createConstitutionVersion({ ...createParams, references }))
        .rejects.toThrow("Invalid Constitution source reference.");
    }

    const proposalReference = [{
      pointOrder: 1,
      sourceOrder: 1,
      policyCorpusId: "policy-1",
      sourceKind: "PROPOSAL" as const,
      proposalId: "proposal-1",
    }];
    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, proposal: { ...policy.proposal, isPrivate: true } }]);
    await expect(createConstitutionVersion({ ...createParams, references: proposalReference }))
      .rejects.toThrow("Invalid Constitution source reference.");
    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, proposal: { ...policy.proposal, publishedAt: null } }]);
    await expect(createConstitutionVersion({ ...createParams, references: proposalReference }))
      .rejects.toThrow("Invalid Constitution source reference.");
    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, proposal: { ...policy.proposal, workspaceId: "ws-2" } }]);
    await expect(createConstitutionVersion({ ...createParams, references: proposalReference }))
      .rejects.toThrow("Invalid Constitution source reference.");
    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, proposal: { ...policy.proposal, workspaceId: "ws-2" } }]);
    await expect(createConstitutionVersion({
      ...createParams,
      references: [{
        pointOrder: 1,
        sourceOrder: 1,
        policyCorpusId: "policy-1",
        sourceKind: "TENSION",
        tensionId: "tension-1",
      }],
    })).rejects.toThrow("Invalid Constitution source reference.");

    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, title: "Changed" }]);
    await expect(createConstitutionVersion({
      ...createParams,
      expectedCorpusFingerprint: fingerprintConstitutionCorpus([policy]),
    })).rejects.toThrow("Constitution policy corpus changed during synthesis.");
    expect(txMock.constitution.create).not.toHaveBeenCalled();

    expect(txMock.policyCorpus.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        proposal: expect.objectContaining({
          include: expect.objectContaining({
            tensions: expect.objectContaining({
              where: {
                workspaceId: "ws-1",
                isPrivate: false,
                publishedAt: { not: null },
                archivedAt: null,
              },
            }),
          }),
        }),
      }),
    }));
  });
});

describe("fingerprintConstitutionCorpus", () => {
  it("hashes only Policy Corpus-owned synthesis data and changes with material policy data", () => {
    const secondPolicy = {
      ...policy,
      id: "policy-2",
      proposalId: "proposal-2",
      title: "Second policy",
      proposal: { ...policy.proposal, id: "proposal-2", title: "Second proposal", tensions: [] },
    };
    const corpus = [policy, secondPolicy];
    const reordered = [
      { ...secondPolicy, ignoredCallerField: "ignored" },
      { ...policy, proposal: { ...policy.proposal, tensions: [...policy.proposal.tensions].reverse() } },
    ];
    const callerWithRelations = {
      ...policy,
      circle: { id: "foreign-circle", name: "Foreign circle" },
      proposal: { ...policy.proposal, title: "Foreign proposal", tensions: [] },
    };
    expect(fingerprintConstitutionCorpus(corpus)).toBe(fingerprintConstitutionCorpus(reordered));
    expect(fingerprintConstitutionCorpus(corpus)).toBe(fingerprintConstitutionCorpus([
      callerWithRelations,
      secondPolicy,
    ]));
    expect(fingerprintConstitutionCorpus(corpus)).not.toBe(
      fingerprintConstitutionCorpus([{ ...policy, bodyMd: "Changed" }, secondPolicy]),
    );
  });
});

describe("updateApprovalPolicy", () => {
  beforeEach(() => {
    requireWorkspaceMembershipMock.mockReset().mockResolvedValue({
      workspaceId: "ws-1",
      userId: "user-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.approvalPolicy.findUnique.mockReset().mockResolvedValue({
      id: "policy-1",
    });
    prismaMock.approvalPolicy.update.mockReset().mockResolvedValue({
      id: "policy-1",
      mode: "MAJORITY",
    });
  });

  it("requires facilitator or admin membership before mutating governance policy", async () => {
    const actor = {
      kind: "user" as const,
      user: {
        id: "user-1",
        email: "admin@example.com",
        displayName: "Admin",
      },
    };

    await updateApprovalPolicy(actor, {
      workspaceId: "ws-1",
      subjectType: "PROPOSAL",
      mode: "MAJORITY",
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
      allowedRoles: ["FACILITATOR", "ADMIN"],
    });
  });
});


describe("Constitution input proof and readers", () => {
  const actor = { kind: "user" as const, user: { id: "reader-1", email: "reader@example.test", displayName: "Reader" } };
  const roots = [{ kind: "PolicyCorpus" as const, id: "policy-1", fingerprint: "a".repeat(64) }];
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({ id: "member-1", workspaceId: "ws-1", userId: actor.user.id, isActive: true });
    prismaMock.$transaction.mockImplementation((callback) => callback(txMock));
    txMock.constitution.findFirst.mockResolvedValue(null);
    txMock.constitution.findMany.mockResolvedValue([]);
    txMock.policyCorpus.findMany.mockResolvedValue([]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row) => row.id)));
    vi.mocked(recordArtifactInputLineage).mockResolvedValue({} as any);
  });

  it("records actorless producer bodies and copied references as UNKNOWN atomically", async () => {
    txMock.policyCorpus.findMany.mockResolvedValue([policy]);
    txMock.constitution.create.mockResolvedValue({ id: "legacy", version: 1, bodyMd: "Unproven output", sourceReferences: [
      { id: "ref-1", pointOrder: 1, sourceOrder: 1, labelSnapshot: "Switch to Slack" },
    ] });
    expect(await createConstitutionVersion({ ...createParams, references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL" }] }))
      .toEqual({ id: "legacy", version: 1, contentWithheld: true });
    expect(invalidateArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: txMock, artifact: { kind: "Constitution", id: "legacy" } }));
    expect(invalidateArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: txMock, artifact: { kind: "ConstitutionSourceReference", id: "ref-1" } }));
    expect(recordArtifactInputLineage).not.toHaveBeenCalled();
  });

  it("atomically snapshots consumed prior versions and propagates copied label plus parent proof to each reference", async () => {
    txMock.policyCorpus.findMany.mockResolvedValue([policy]);
    const row = { id: "constitution-1", version: 1, bodyMd: "Known output", sourceReferences: [
      { id: "ref-1", pointOrder: 1, sourceOrder: 1, labelSnapshot: policy.proposal.title },
    ] };
    txMock.constitution.create.mockResolvedValue(row);
    await createConstitutionVersion({ ...createParams, lineageActor: actor, lineageRoots: roots,
      references: [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: policy.id, sourceKind: "PROPOSAL" }] });
    expect(recordArtifactInputLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: txMock, actor,
      artifact: { kind: "Constitution", id: row.id }, origin: "DERIVED", inputs: [], inheritedRoots: roots,
      transitiveOnlyKinds: ["Constitution"] }));
    expect(prepareProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: txMock, actor,
      copied: true, completeCopy: true, dependencies: [
        { kind: "Constitution", id: row.id, snapshot: row },
        { kind: "PolicyCorpus", id: policy.id, snapshot: policy },
        { kind: "Proposal", id: policy.proposal.id, snapshot: policy.proposal },
      ] }));
    expect(finishProducerLineage).toHaveBeenCalledWith(expect.objectContaining({ tx: txMock, artifact: { kind: "ConstitutionSourceReference", id: "ref-1" } }));
  });

  it("rejects stale captured receipts in the same transaction as the version write", async () => {
    txMock.constitution.create.mockResolvedValue({ id: "candidate", version: 1, sourceReferences: [] });
    vi.mocked(recordArtifactInputLineage).mockRejectedValueOnce(Object.assign(new Error("Changed"), { code: "SOURCE_CHANGED" }));
    await expect(createConstitutionVersion({ ...createParams, lineageActor: actor, lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(finishProducerLineage).not.toHaveBeenCalled();
  });

  it("filters unknown and restricted version bodies before current selection, pagination, and totals", async () => {
    txMock.constitution.findMany.mockResolvedValue([
      { id: "private", version: 5, bodyMd: "Hidden" }, { id: "legacy", version: 4, bodyMd: "Unknown" },
      { id: "public-old", version: 1, bodyMd: "Old known" }, { id: "public-current", version: 3, bodyMd: "Current known" },
    ]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, _kind, rows) => new Set(rows
      .filter((row) => row.id.startsWith("public")).map((row) => row.id)));
    expect(await listConstitutionVersions(actor, "ws-1", { take: 1, skip: 1 })).toMatchObject({ items: [{ id: "public-old" }], total: 2 });
    expect(await getCurrentConstitution(actor, "ws-1")).toMatchObject({ id: "public-current", bodyMd: "Current known" });
    expect(txMock.constitution.findMany).toHaveBeenCalledWith({ where: { workspaceId: "ws-1" } });
  });

  it("loads only provably readable policy rows before sort and fingerprint", async () => {
    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, id: "legacy", bodyMd: "Hidden" }, policy]);
    vi.mocked(readableArtifactIds).mockResolvedValueOnce(new Set([policy.id]));
    const snapshot = await loadConstitutionCorpusSnapshot(actor, txMock as any, "ws-1");
    expect(snapshot.corpus).toEqual([policy]);
    expect(snapshot.fingerprint).toBe(fingerprintConstitutionCorpus([policy]));
    expect(readableArtifactIds).toHaveBeenCalledWith(actor, "ws-1", "PolicyCorpus", expect.arrayContaining([
      expect.objectContaining({ id: policy.id, bodyMd: policy.bodyMd, proposalId: policy.proposalId }),
    ]), txMock);
  });

  it("redacts withheld policy circle and proposal paths without exposing related labels", async () => {
    txMock.policyCorpus.findMany.mockResolvedValue([{ ...policy, circleId: "circle-secret", circle: { id: "circle-secret", name: "Secret" } }]);
    vi.mocked(readableArtifactIds).mockImplementation(async (_actor, _workspaceId, kind, rows) => new Set(kind === "PolicyCorpus" ? rows.map((row) => row.id) : []));
    const rows = await listPolicyCorpus(actor, "ws-1");
    expect(rows[0]).toMatchObject({ id: policy.id, circleId: null, circle: null, proposalId: null, proposal: null });
    expect(JSON.stringify(rows)).not.toContain("circle-secret");
  });
});
