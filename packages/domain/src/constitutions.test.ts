import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, requireWorkspaceMembershipMock } = vi.hoisted(() => {
  const constitution = { findFirst: vi.fn(), create: vi.fn() };
  const tx = { $executeRaw: vi.fn(), constitution, policyCorpus: { findMany: vi.fn() } };
  return {
    txMock: tx,
    prismaMock: {
      $transaction: vi.fn(),
      constitution,
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

import {
  createConstitutionVersion,
  fingerprintConstitutionCorpus,
  updateApprovalPolicy,
} from "./constitutions";

const createParams = {
  workspaceId: "ws-1",
  bodyMd: "# Constitution",
  modelUsed: "gpt-test",
};
const acceptedAt = new Date("2026-05-02T00:00:00.000Z");
const policy = {
  id: "policy-1",
  acceptedAt,
  proposal: {
    id: "proposal-1",
    title: "Switch to Slack",
    tensions: [{ id: "tension-1", title: "Fragmented communication" }],
  },
};

describe("createConstitutionVersion", () => {
  beforeEach(() => {
    txMock.$executeRaw.mockReset().mockResolvedValue(0);
    txMock.constitution.findFirst.mockReset().mockResolvedValue(null);
    txMock.constitution.create.mockReset();
    txMock.policyCorpus.findMany.mockReset().mockResolvedValue([]);
    prismaMock.$transaction.mockReset().mockImplementation((callback) => callback(txMock));
  });

  it("retries serializable and mixed-deployment version conflicts", async () => {
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
        version: 4,
      });

    await expect(createConstitutionVersion(createParams)).resolves.toEqual({
      id: "constitution-4",
      version: 4,
    });

    expect(txMock.constitution.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        workspaceId: "ws-1",
        version: 2,
      }),
    });
    expect(txMock.constitution.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        workspaceId: "ws-1",
        version: 3,
      }),
    });
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("derives snapshots and creates version-owned references atomically", async () => {
    const references = [
      { pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1" },
      { pointOrder: 1, sourceOrder: 2, policyCorpusId: "policy-1", sourceKind: "TENSION" as const, tensionId: "tension-1" },
    ];
    txMock.policyCorpus.findMany.mockResolvedValue([policy]);
    txMock.constitution.create.mockRejectedValueOnce(new Error("reference write failed"));
    await expect(createConstitutionVersion({ ...createParams, references }))
      .rejects.toThrow("reference write failed");
    txMock.constitution.create.mockResolvedValue({ id: "constitution-1", version: 1 });

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
    });
  });

  it("fails closed before the version write for forbidden or drifting sources", async () => {
    txMock.policyCorpus.findMany.mockResolvedValue([policy]);
    const invalidReferenceSets = [
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "TENSION" as const, tensionId: "private-tension" }],
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "other-workspace", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1" }],
      [{ pointOrder: 1, sourceOrder: 1, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1", tensionId: "tension-1" }],
      [1, 2].map((sourceOrder) => ({ pointOrder: 1, sourceOrder, policyCorpusId: "policy-1", sourceKind: "PROPOSAL" as const, proposalId: "proposal-1" })),
    ];
    for (const references of invalidReferenceSets) {
      await expect(createConstitutionVersion({ ...createParams, references }))
        .rejects.toThrow("Invalid Constitution source reference.");
    }

    txMock.policyCorpus.findMany.mockResolvedValue([{ id: "changed" }]);
    await expect(createConstitutionVersion({
      ...createParams,
      expectedCorpusFingerprint: fingerprintConstitutionCorpus([{ id: "expected" }]),
    })).rejects.toThrow("Constitution policy corpus changed during synthesis.");
    expect(txMock.constitution.create).not.toHaveBeenCalled();
  });
});

describe("fingerprintConstitutionCorpus", () => {
  it("ignores input order but changes with material source data", () => {
    const corpus = [{ id: "a", title: "A", tensions: [{ id: "2" }, { id: "1" }] }, { id: "b" }];
    const reordered = [{ id: "b" }, { tensions: [{ id: "1" }, { id: "2" }], title: "A", id: "a" }];
    expect(fingerprintConstitutionCorpus(corpus)).toBe(fingerprintConstitutionCorpus(reordered));
    expect(fingerprintConstitutionCorpus(corpus)).not.toBe(
      fingerprintConstitutionCorpus([{ ...corpus[0], title: "Changed" }, corpus[1]]),
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
