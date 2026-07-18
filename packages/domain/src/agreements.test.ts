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
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.constitution.findFirst.mockResolvedValue({ id: "constitution-current", version: 3 });
    prismaMock.constitution.findMany.mockResolvedValue([{ id: "constitution-current", version: 3 }]);
    prismaMock.policyCorpus.findMany.mockResolvedValue([{ id: "policy-1", title: "Advice process" }]);
    prismaMock.brainArticle.findMany.mockResolvedValue([{ id: "article-1", title: "Working principles" }]);
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
    });
    expect(prismaMock.constitution.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      orderBy: { version: "desc" },
      take: 4,
    });
    expect(prismaMock.policyCorpus.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      include: {
        proposal: {
          select: { id: true, title: true, status: true },
        },
        circle: {
          select: { id: true, name: true },
        },
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
  });
});
