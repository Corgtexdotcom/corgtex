import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    constitution: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    policyCorpus: {
      findMany: vi.fn(),
    },
    brainArticle: {
      findMany: vi.fn(),
    },
    proposal: { findMany: vi.fn() },
    tension: { findMany: vi.fn() },
  },
  requireWorkspaceMembershipMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  requireWorkspaceMembership: requireWorkspaceMembershipMock,
}));

import {
  AGREEMENT_BRAIN_ARTICLE_AUTHORITIES,
  AGREEMENT_BRAIN_ARTICLE_TYPES,
  listWorkspaceAgreements,
} from "./agreements";

describe("listWorkspaceAgreements", () => {
  const actor = {
    kind: "user" as const,
    user: { id: "user-1", email: "member@example.com", displayName: "Member" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembershipMock.mockResolvedValue({
      id: "member-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "CONTRIBUTOR",
      isActive: true,
    });
    prismaMock.constitution.findFirst.mockResolvedValue({ id: "constitution-current", version: 3 });
    prismaMock.constitution.findMany.mockResolvedValue([{ id: "constitution-current", version: 3 }]);
    prismaMock.policyCorpus.findMany.mockResolvedValue([{
      id: "policy-1", title: "Advice process", bodyMd: "Accepted policy", acceptedAt: new Date("2026-08-10"),
      proposalId: "public-proposal", circle: null,
    }]);
    prismaMock.brainArticle.findMany.mockResolvedValue([{ id: "article-1", title: "Working principles" }]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "public-proposal", title: "Current proposal title" }]);
    prismaMock.tension.findMany.mockResolvedValue([]);
  });

  it("composes agreements from constitution, policy corpus, and public Brain articles", async () => {
    const result = await listWorkspaceAgreements(actor, {
      workspaceId: "ws-1",
      brainArticleTake: 7,
      constitutionVersionTake: 4,
    });

    expect(requireWorkspaceMembershipMock).toHaveBeenCalledWith({
      actor,
      workspaceId: "ws-1",
    });
    expect(prismaMock.constitution.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      orderBy: { version: "desc" },
      include: { sourceReferences: { orderBy: [{ pointOrder: "asc" }, { sourceOrder: "asc" }] } },
    });
    expect(prismaMock.constitution.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      orderBy: { version: "desc" },
      take: 4,
    });
    expect(prismaMock.policyCorpus.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      select: {
        id: true,
        title: true,
        bodyMd: true,
        acceptedAt: true,
        proposalId: true,
        circle: { select: { id: true, name: true } },
      },
      orderBy: { acceptedAt: "desc" },
    }));
    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "ws-1",
        archivedAt: null,
        isPrivate: false,
        authority: { in: [...AGREEMENT_BRAIN_ARTICLE_AUTHORITIES] },
        type: { in: [...AGREEMENT_BRAIN_ARTICLE_TYPES] },
      },
      select: expect.objectContaining({
        frontmatterJson: true,
      }),
      take: 7,
    }));
    expect(result.counts).toEqual({
      constitutionVersions: 1,
      policies: 1,
      brainArticles: 1,
    });
    expect(result.policyCorpus[0]?.proposal).toEqual({ id: "public-proposal", title: "Current proposal title" });
    expect(result.policyCorpus[0]).not.toHaveProperty("proposalId");
  });

  it("returns only origin links the current member can open, without hidden snapshots", async () => {
    prismaMock.constitution.findFirst.mockResolvedValue({
      id: "constitution-current",
      version: 3,
      sourceReferences: [
        { pointOrder: 1, sourceOrder: 1, sourceKind: "PROPOSAL", proposalId: "public-proposal", tensionId: null, labelSnapshot: "Old public title" },
        { pointOrder: 1, sourceOrder: 2, sourceKind: "TENSION", proposalId: null, tensionId: "private-tension", labelSnapshot: "Do not disclose" },
      ],
    });
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "public-proposal", title: "Current proposal title" }]);

    const result = await listWorkspaceAgreements(actor, { workspaceId: "ws-1" });

    expect(prismaMock.proposal.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: "ws-1", archivedAt: null, publishedAt: { not: null }, isPrivate: false, OR: expect.any(Array) }),
      select: { id: true, title: true },
    });
    expect(prismaMock.tension.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: "ws-1", archivedAt: null, publishedAt: { not: null }, isPrivate: false, OR: expect.any(Array) }),
      select: { id: true, title: true },
    });
    expect(result.currentConstitution?.sourceReferences).toEqual([{
      pointOrder: 1,
      sourceOrder: 1,
      sourceKind: "PROPOSAL",
      targetId: "public-proposal",
      title: "Current proposal title",
    }]);
    expect(JSON.stringify(result.currentConstitution)).not.toContain("Do not disclose");
    expect(JSON.stringify(result.currentConstitution)).not.toContain("Old public title");
  });

  it("hides unpublished private origins for both members and admins", async () => {
    prismaMock.constitution.findFirst.mockResolvedValue({
      id: "constitution-current",
      version: 3,
      sourceReferences: [{ pointOrder: 2, sourceOrder: 1, sourceKind: "TENSION", proposalId: null, tensionId: "private-tension", labelSnapshot: "Old private title" }],
    });
    const memberResult = await listWorkspaceAgreements(actor, { workspaceId: "ws-1" });
    const memberFilter = prismaMock.tension.findMany.mock.calls[0]?.[0]?.where;
    expect(memberFilter).toMatchObject({ isPrivate: false, publishedAt: { not: null }, archivedAt: null });
    expect(memberFilter.OR).toContainEqual({ isPrivate: true, status: "DRAFT", authorUserId: "user-1" });
    expect(memberResult.currentConstitution?.sourceReferences).toEqual([]);

    requireWorkspaceMembershipMock.mockResolvedValueOnce({ workspaceId: "ws-1", role: "ADMIN", isActive: true });
    const adminResult = await listWorkspaceAgreements({ ...actor, user: { ...actor.user, id: "admin-1" } }, { workspaceId: "ws-1" });
    const adminFilter = prismaMock.tension.findMany.mock.calls[1]?.[0]?.where;
    expect(adminFilter).toMatchObject({ isPrivate: false, publishedAt: { not: null }, archivedAt: null });
    expect(adminFilter.OR).toContainEqual({ isPrivate: true, status: "DRAFT" });
    expect(adminResult.currentConstitution?.sourceReferences).toEqual([]);
    expect(JSON.stringify(adminResult.currentConstitution)).not.toContain("Old private title");
  });

  it("omits an inaccessible policy proposal ID, title, and link target", async () => {
    prismaMock.policyCorpus.findMany.mockResolvedValue([{ id: "policy-1", proposalId: "hidden-proposal", title: "Accepted policy", circle: null }]);
    prismaMock.proposal.findMany.mockResolvedValue([]);

    const result = await listWorkspaceAgreements(actor, { workspaceId: "ws-1" });

    expect(result.policyCorpus[0]?.proposal).toBeNull();
    expect(JSON.stringify(result)).not.toContain("hidden-proposal");
  });

  it("performs no agreement reads when workspace membership fails", async () => {
    requireWorkspaceMembershipMock.mockRejectedValueOnce(new Error("NOT_A_MEMBER"));

    await expect(listWorkspaceAgreements(actor, { workspaceId: "ws-1" })).rejects.toThrow("NOT_A_MEMBER");
    expect(prismaMock.constitution.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.proposal.findMany).not.toHaveBeenCalled();
  });
});
