import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, requireWorkspaceMembershipMock } = vi.hoisted(() => ({
  prismaMock: {
    constitution: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    constitutionSourceReference: {findMany: vi.fn()},
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

const lineage = vi.hoisted(() => ({
  capture: vi.fn(async (_actor, _workspaceId, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }))),
  readable: vi.fn(async (_actor, _workspaceId, _kind, rows) => new Set(rows.map((row: { id: string }) => row.id))),
}));
vi.mock("./source-lineage", async importOriginal => ({
  mergeLineageInputRoot: (await importOriginal<typeof import("./source-lineage")>()).mergeLineageInputRoot,
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({value: await read(), heads: new Map()}),
  withArtifactCountReleaseSnapshot: async (_actor: unknown, _ws: string, _roots: unknown, remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {await remote();return finish({});},
  captureArtifactInputProof: lineage.capture,
  isArtifactInputProofReadable: vi.fn().mockResolvedValue(true),
  readableArtifactIds: lineage.readable,
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
    prismaMock.constitution.findMany.mockResolvedValue([{ id: "constitution-current", version: 3 }]);
    prismaMock.constitutionSourceReference.findMany.mockImplementation(async () => (await prismaMock.constitution.findMany.mock.results.at(-1)?.value ?? []).flatMap((row: {sourceReferences?: unknown[]}) => row.sourceReferences ?? []));
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
    expect(prismaMock.constitution.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: 50,
    });
    expect(prismaMock.policyCorpus.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "ws-1" },
      include: { circle: true },
      orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
      take: 100,
    }));
    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: "ws-1",
        archivedAt: null,
        isPrivate: false,
        authority: { in: [...AGREEMENT_BRAIN_ARTICLE_AUTHORITIES] },
        type: { in: [...AGREEMENT_BRAIN_ARTICLE_TYPES] },
      },
      include: expect.objectContaining({ ownerMember: expect.any(Object) }),
      take: 50,
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
    prismaMock.constitution.findMany.mockResolvedValue([{
      id: "constitution-current",
      version: 3,
      sourceReferences: [
        { id: "reference-public", pointOrder: 1, sourceOrder: 1, sourceKind: "PROPOSAL", proposalId: "public-proposal", tensionId: null, labelSnapshot: "Old public title" },
        { id: "reference-private", pointOrder: 1, sourceOrder: 2, sourceKind: "TENSION", proposalId: null, tensionId: "private-tension", labelSnapshot: "Do not disclose" },
      ],
    }]);
    prismaMock.proposal.findMany.mockResolvedValue([{ id: "public-proposal", title: "Current proposal title" }]);

    const result = await listWorkspaceAgreements(actor, { workspaceId: "ws-1" });

    expect(prismaMock.proposal.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: "ws-1", archivedAt: null, publishedAt: { not: null }, isPrivate: false, OR: expect.any(Array) }),
    });
    expect(prismaMock.tension.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: "ws-1", archivedAt: null, publishedAt: { not: null }, isPrivate: false, OR: expect.any(Array) }),
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

  it("gates complete reference rows before resolving target identities or exposing positions", async () => {
    const { AppError } = await import("./errors");
    const denied = { id: "denied-reference", constitutionId: "constitution-current", pointOrder: 1, sourceOrder: 1, sourceKind: "TENSION", tensionId: "secret-tension", proposalId: null, labelSnapshot: "Hidden label" };
    const allowed = { id: "allowed-reference", constitutionId: "constitution-current", pointOrder: 1, sourceOrder: 2, sourceKind: "PROPOSAL", proposalId: "public-proposal", tensionId: null, labelSnapshot: "Permitted old label" };
    prismaMock.constitution.findMany.mockResolvedValue([{ id: "constitution-current", version: 3, sourceReferences: [denied, allowed] }]);
    lineage.capture.mockImplementation(async (_actor, _ws, inputs) => {
      if (inputs.some((input: { id: string }) => input.id === denied.id)) throw new AppError(409, "SOURCE_RESTRICTED", "Reference source revoked");
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    try {
      const result = await listWorkspaceAgreements(actor, { workspaceId: "ws-1" });
      expect(lineage.capture).toHaveBeenCalledWith(actor, "ws-1", [{ kind: "ConstitutionSourceReference", id: denied.id, snapshot: denied }]);
      expect(prismaMock.tension.findMany).not.toHaveBeenCalled();
      expect(result.currentConstitution?.sourceReferences).toEqual([{ pointOrder: 1, sourceOrder: 1, sourceKind: "PROPOSAL", targetId: "public-proposal", title: "Current proposal title" }]);
      expect(JSON.stringify(result)).not.toContain("secret-tension");
      expect(JSON.stringify(result)).not.toContain("Hidden label");
    } finally {
      lineage.capture.mockImplementation(async (_actor, _ws, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    }
  });

  it("hides unpublished private origins for both members and admins", async () => {
    prismaMock.constitution.findMany.mockResolvedValue([{
      id: "constitution-current",
      version: 3,
      sourceReferences: [{ id: "reference-private", pointOrder: 2, sourceOrder: 1, sourceKind: "TENSION", proposalId: null, tensionId: "private-tension", labelSnapshot: "Old private title" }],
    }]);
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

  it("keeps complete policy history beyond 5000 unknown policies and bounds joined title queries", async () => {
    const {AppError}=await import("./errors");
    const rows=Array.from({length:5001},(_,index) => ({id:`hidden-${String(index).padStart(5,"0")}`,proposalId:`proposal-${index}`,title:"Hidden",bodyMd:"Unknown",acceptedAt:new Date(5002-index),circle:null}));
    rows.push({id:"visible-last",proposalId:"public-proposal",title:"Permitted",bodyMd:"Proved",acceptedAt:new Date(0),circle:null});
    prismaMock.policyCorpus.findMany.mockImplementation(async ({where,take}) => rows.filter(row => !where.OR || row.acceptedAt < where.OR[0].acceptedAt.lt).slice(0,take));
    lineage.capture.mockImplementation(async (_actor,_ws,inputs) => {
      if(inputs.some((input:{id:string}) => input.id.startsWith("hidden-"))) throw new AppError(409,"UNKNOWN_LINEAGE","Unknown");
      return inputs.map((input:{kind:string;id:string}) => ({kind:input.kind,id:input.id,fingerprint:"a".repeat(64)}));
    });
    const result=await listWorkspaceAgreements(actor,{workspaceId:"ws-1"});
    expect(result.policyCorpus.map(row => row.id)).toEqual(["visible-last"]);
    expect(prismaMock.policyCorpus.findMany.mock.calls.every(([args]) => args.take === 100)).toBe(true);
    expect(prismaMock.proposal.findMany.mock.calls.every(([args]) => args.where.id.in.length <= 100)).toBe(true);
  });

  it("performs no agreement reads when workspace membership fails", async () => {
    requireWorkspaceMembershipMock.mockRejectedValueOnce(new Error("NOT_A_MEMBER"));

    await expect(listWorkspaceAgreements(actor, { workspaceId: "ws-1" })).rejects.toThrow("NOT_A_MEMBER");
    expect(prismaMock.constitution.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.proposal.findMany).not.toHaveBeenCalled();
  });

  it("replenishes denied constitution and Brain rows before applying their windows", async () => {
    const { AppError } = await import("./errors");
    const hiddenConstitutions = Array.from({ length: 50 }, (_, index) => ({ id: `hidden-constitution-${index}`, version: 100 - index, bodyMd: "Hidden constitution", sourceReferences: [] }));
    prismaMock.constitution.findMany.mockResolvedValueOnce(hiddenConstitutions).mockResolvedValueOnce([{ id: "allowed-constitution", version: 1, bodyMd: "Permitted", sourceReferences: [] }]);
    const hiddenArticles = Array.from({ length: 50 }, (_, index) => ({ id: `hidden-article-${index}`, bodyMd: "Hidden article", authority: "AUTHORITATIVE", updatedAt: new Date("2026-09-26"), archivedAt: null }));
    prismaMock.brainArticle.findMany.mockResolvedValueOnce(hiddenArticles).mockResolvedValueOnce([{ id: "allowed-article", bodyMd: "Permitted article", authority: "REFERENCE", updatedAt: new Date("2026-09-25") }]);
    lineage.capture.mockImplementation(async (_actor, _workspace, inputs) => {
      if (inputs.some((input: { id: string }) => input.id.startsWith("hidden"))) throw new AppError(409, "UNKNOWN_LINEAGE", "Unknown proof");
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    try {
      const result = await listWorkspaceAgreements(actor, { workspaceId: "ws-1", constitutionVersionTake: 1, brainArticleTake: 1 });
      expect(result.currentConstitution?.id).toBe("allowed-constitution");
      expect(result.brainArticles.map((row) => row.id)).toEqual(["allowed-article"]);
      expect(JSON.stringify(result)).not.toContain("Hidden");
      expect(prismaMock.constitution.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { workspaceId: "ws-1", OR: [{ version: { lt: 51 } }, { version: 51, id: { lt: "hidden-constitution-49" } }] }, take: 50 }));
      expect(prismaMock.brainArticle.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 50, orderBy: [{ authority: "asc" }, { updatedAt: "desc" }, { id: "desc" }] }));
    } finally {
      lineage.capture.mockImplementation(async (_actor, _workspace, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    }
  });

  it("withholds copied policy text when its current source proof is revoked", async () => {
    const { AppError } = await import("./errors");
    lineage.capture.mockImplementation(async (_actor, _workspace, inputs) => {
      if (inputs.some((input: { kind: string }) => input.kind === "PolicyCorpus")) throw new AppError(409, "SOURCE_RESTRICTED", "Source revoked");
      return inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) }));
    });
    try {
      const result = await listWorkspaceAgreements(actor, { workspaceId: "ws-1" });
      expect(result.policyCorpus).toEqual([]);
      expect(result.counts.policies).toBe(0);
      expect(JSON.stringify(result)).not.toContain("Accepted policy");
    } finally {
      lineage.capture.mockImplementation(async (_actor, _workspace, inputs) => inputs.map((input: { kind: string; id: string }) => ({ kind: input.kind, id: input.id, fingerprint: "a".repeat(64) })));
    }
  });

});
