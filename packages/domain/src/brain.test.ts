import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    informationCategoryPolicy: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    brainArticle: {
      count: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    brainArticleVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    brainSource: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    brainDiscussionThread: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    brainDiscussionComment: { findFirst: vi.fn(), create: vi.fn() },
    member: { findFirst: vi.fn() }, user: { findFirst: vi.fn() }, action: { findFirst: vi.fn() },
    artifactInputLineage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    artifactInputSnapshot: { findFirst: vi.fn(), create: vi.fn() },
    brainBacklink: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    workspacePermalink: {
      upsert: vi.fn(),
    },
    auditLog: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    event: {
      createMany: vi.fn(),
    },
  },
}));

const requireWorkspaceMembership = vi.fn();
const appendEvents = vi.fn();
const resolveKnowledgeAccessDomains = vi.fn();
const archiveWorkspaceArtifact = vi.fn();
const requestBrainSourceRemoval = vi.fn();
const readableArtifactIds = vi.fn(async (_actor, _workspaceId, _kind, records) => new Set(records.map((record: { id: string }) => record.id)));
const prepareArtifactCommitPreflight = vi.fn(async () => Object.freeze({}));
const withArtifactCommitPreflight = vi.fn(async (_actor: unknown, _workspaceId: string, _tx: unknown,
  _roots: unknown, _token: unknown, work: () => Promise<unknown>) => work());

vi.mock("./artifact-commit-preflight", () => ({ prepareArtifactCommitPreflight, withArtifactCommitPreflight }));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("./auth", () => ({
  persistedMemberId: (membership: { id?: string } | null | undefined) => membership?.id === "global-operator" ? null : membership?.id ?? null,
  requireWorkspaceMembership,
}));

vi.mock("./events", () => ({
  appendEvents,
}));

vi.mock("./brain-access", () => ({
  resolveKnowledgeAccessDomains,
}));

vi.mock("./archive", () => ({
  archiveFilterWhere: (filter: "active" | "archived" | "all" = "active") => {
    if (filter === "all") return {};
    if (filter === "archived") return { archivedAt: { not: null } };
    return { archivedAt: null };
  },
  archiveWorkspaceArtifact,
}));

vi.mock("./brain-source-removal", () => ({ requestBrainSourceRemoval }));
vi.mock("./source-lineage", async (original) => ({
  ...await original<typeof import("./source-lineage")>(),
  brainSourceNeedsLineage: (source: { sourceType?: string; channel?: string | null }) =>
    source.sourceType === "CONVERSATION" || source.sourceType === "CONVERSATION_INSIGHT"
      || ["chat-demand", "daily-batch", "daily-digest", "daily-question"].includes(source.channel ?? ""),
  captureArtifactInputProof: vi.fn().mockResolvedValue([]),
  collectWorkItemReadSnapshot: vi.fn(async (_workspaceId, collect) => collect(prismaMock)),
  withArtifactCountReleaseSnapshot: vi.fn(async (_actor, _workspaceId, _roots, _remote, finish) => finish({})),
  recordArtifactInputLineage: vi.fn(),
  copyArtifactInputLineage: vi.fn().mockResolvedValue(true),
  createBrainArticleHistoryVersion: vi.fn(async ({tx, article, version, reason, preserveKnownHistory}) => ({
    version: await tx.brainArticleVersion.create({data: {articleId: article.id, version, bodyMd: article.bodyMd,
      accessEnvelopeJson: {isPrivate: article.isPrivate, ownerMemberId: article.ownerMemberId},
      changeSummary: reason === "BODY_EDIT" ? null : "Previous body before reviewed source regeneration.", agentRunId: null}}),
    preserved: preserveKnownHistory,
  })),
  captureArtifactInputSnapshotProof: vi.fn().mockResolvedValue([{kind: "ArtifactInputSnapshot", id: "old-body-receipt", fingerprint: "1".repeat(64)}]),
  currentArtifactInputRoots: vi.fn().mockResolvedValue([]),
  readableArtifactIds,
  readableBrainSourceIds: vi.fn(async (_actor, _workspaceId, records) =>
    new Set(records.filter((record: { archivedAt?: Date | null }) => !record.archivedAt)
      .map((record: { id: string }) => record.id))),
}));

const ownerActor = {
  kind: "user",
  user: { id: "user-1", email: "owner@example.com", displayName: "Owner" },
} as any;

describe("Brain article draft lifecycle", () => {
  it.each(["credential-a", "credential-b"])("rejects private creation by %s before duplicate reads or writes", async credentialId => {
    const {createArticle} = await import("./brain");
    const credential = {kind: "agent", authProvider: "credential", credentialId, workspaceIds: ["ws-1"], scopes: ["support:write"]} as any;
    await expect(createArticle(credential, {workspaceId: "ws-1", title: "Private", type: "PROJECT" as const, bodyMd: "Private"})).rejects.toMatchObject({code: "PRIVATE_AGENT_ARTIFACT_UNSUPPORTED"});
    expect(prismaMock.brainArticle.create).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.findMany).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.findFirst).not.toHaveBeenCalled();
  });
  it("rejects public agent creation without complete inputs before looking for duplicates", async () => {
    const {createArticle} = await import("./brain");
    await expect(createArticle({kind: "agent", workspaceIds: ["ws-1"]} as any, {...{workspaceId: "ws-1", title: "Private", type: "PROJECT" as const, bodyMd: "Private"}, isPrivate: false}))
      .rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    expect(prismaMock.brainArticle.create).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.findMany).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([]);
    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    appendEvents.mockResolvedValue(undefined);
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    prismaMock.brainArticle.findUnique.mockReset();
    prismaMock.brainArticle.findUnique.mockResolvedValue(null);
    prismaMock.workspacePermalink.upsert.mockResolvedValue({});
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.brainBacklink.findMany.mockResolvedValue([]);
    readableArtifactIds.mockImplementation(async (_actor, _workspaceId, _kind, records) =>
      new Set(records.map((record: { id: string }) => record.id)));
  });

  it("lets workspace admins list private draft articles", async () => {
    const { listArticles } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "mem-admin",
      workspaceId: "ws-1",
      userId: "admin-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.count.mockResolvedValue(0);
    prismaMock.brainBacklink.groupBy.mockResolvedValue([]);

    await listArticles({ kind: "user", user: { id: "admin-1" } } as any, { workspaceId: "ws-1" });

    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: expect.arrayContaining([
          { workspaceId: "ws-1", archivedAt: null },
          {
            OR: [
              { isPrivate: false },
              { isPrivate: true, authority: "DRAFT" },
            ],
          },
      ]) },
    }));
  });

  it("never places private drafts in a credential's article candidate query", async () => {
    const { listArticles } = await import("./brain");
    requireWorkspaceMembership.mockResolvedValue(null);
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.count.mockResolvedValue(0);
    prismaMock.brainBacklink.groupBy.mockResolvedValue([]);
    for (const credentialId of ["credential-a", "credential-b"]) {
      await listArticles({ kind: "agent", authProvider: "credential", credentialId, label: "Connector", workspaceIds: ["ws-1"] }, { workspaceId: "ws-1" });
    }
    for (const [args] of prismaMock.brainArticle.findMany.mock.calls) {
      expect(args.where.AND).toContainEqual({ OR: [{ isPrivate: false }] });
    }
  });

  it("blocks non-managers from editing another owner's draft article", async () => {
    const { updateArticle } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-2",
      workspaceId: "ws-1",
      userId: "user-2",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "draft",
      title: "Draft",
      bodyMd: "Body",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: "mem-1",
      archivedAt: null,
      sourceIds: [],
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    await expect(updateArticle({
      kind: "user",
      user: { id: "user-2", email: "other@example.com", displayName: "Other" },
    } as any, {
      workspaceId: "ws-1",
      slug: "draft",
      title: "Changed",
    })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });

    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });

  it("does not return a hidden article through an empty PATCH", async () => {
    const { updateArticle } = await import("./brain");
    const { readableArtifactIds } = await import("./source-lineage");
    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-hidden", workspaceId: "ws-1", slug: "hidden", title: "Private",
      bodyMd: "Restricted", authority: "DRAFT", isPrivate: true, ownerMemberId: "mem-2",
      archivedAt: null, sourceIds: [], updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    vi.mocked(readableArtifactIds).mockResolvedValueOnce(new Set());

    await expect(updateArticle(ownerActor, { workspaceId: "ws-1", slug: "hidden" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });

  it("keeps draft authorization on the supplied transaction client when updating draft articles", async () => {
    const { updateArticle } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValue({id: "member-admin", workspaceId: "ws-1", userId: ownerActor.user.id, role: "ADMIN", isActive: true});
    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "draft",
      title: "Draft",
      bodyMd: "Body",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: null,
      archivedAt: null,
      sourceIds: [],
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    prismaMock.brainArticle.update.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "draft",
      title: "Changed",
      bodyMd: "Body",
      authority: "DRAFT",
      isPrivate: true,
      ownerMemberId: null,
      archivedAt: null,
    });

    await updateArticle(ownerActor, {
      workspaceId: "ws-1",
      slug: "draft",
      title: "Changed",
      tx: prismaMock as any,
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(requireWorkspaceMembership).toHaveBeenCalledTimes(2);
    expect(requireWorkspaceMembership).toHaveBeenNthCalledWith(1, expect.objectContaining({ tx: prismaMock }));
    expect(requireWorkspaceMembership).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tx: prismaMock,
    }));
  });

  it("returns a public article to draft for the owner", async () => {
    const { returnArticleToDraft } = await import("./brain");

    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1",
      workspaceId: "ws-1",
      slug: "runbook",
      title: "Runbook",
      bodyMd: "Body",
      authority: "AUTHORITATIVE",
      isPrivate: false,
      ownerMemberId: "mem-1",
      archivedAt: null,
      ownerMember: { id: "mem-1", userId: "user-1" },
    });
    prismaMock.brainArticle.update.mockResolvedValue({
      id: "article-1",
      slug: "runbook",
      authority: "DRAFT",
      isPrivate: true,
      publishedAt: null,
    });

    await expect(returnArticleToDraft(ownerActor, {
      workspaceId: "ws-1",
      slug: "runbook",
    })).resolves.toMatchObject({
      id: "article-1",
      authority: "DRAFT",
      isPrivate: true,
    });

    expect(prismaMock.brainArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1" },
      data: {
        authority: "DRAFT",
        isPrivate: true,
        publishedAt: null,
      },
    });
  });

  it("withholds revoked source lineage before publishing or returning a draft", async () => {
    const { publishArticle, returnArticleToDraft } = await import("./brain");
    readableArtifactIds.mockResolvedValue(new Set());
    const article = { id: "article-1", workspaceId: "ws-1", slug: "notes", title: "Restricted notes",
      bodyMd: "Restricted body", authority: "DRAFT", isPrivate: true, ownerMemberId: "mem-1",
      archivedAt: null, ownerMember: { id: "mem-1", userId: "user-1" } };
    prismaMock.brainArticle.findUnique.mockResolvedValue(article);
    await expect(publishArticle(ownerActor, { workspaceId: "ws-1", slug: "notes" }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    prismaMock.brainArticle.findUnique.mockResolvedValue({ ...article, authority: "AUTHORITATIVE", isPrivate: false });
    await expect(returnArticleToDraft(ownerActor, { workspaceId: "ws-1", slug: "notes" }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });

  it("does not persist the synthetic global-operator membership as a private article owner", async () => {
    const { createArticle } = await import("./brain");

    requireWorkspaceMembership.mockResolvedValueOnce({
      id: "global-operator",
      workspaceId: "ws-1",
      userId: "operator-1",
      role: "ADMIN",
      isActive: true,
    });
    prismaMock.brainArticle.create.mockResolvedValue({
      id: "article-1",
      slug: "operator-draft",
      title: "Operator draft",
      type: "RUNBOOK",
      authority: "DRAFT",
      isPrivate: true,
    });

    await createArticle({ kind: "user", user: { id: "operator-1" } } as any, {
      workspaceId: "ws-1",
      title: "Operator draft",
      type: "RUNBOOK",
      bodyMd: "Body",
    });

    expect(prismaMock.brainArticle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerMemberId: null,
      }),
    });
  });

  it.each(["use_existing", "update_existing"] as const)("rechecks a selected duplicate before %s exposes its current body", async resolution => {
    const row = {id: "existing", workspaceId: "ws-1", title: "Existing", slug: "existing", type: "PROJECT", bodyMd: "Old body",
      authority: "DRAFT", isPrivate: false, ownerMemberId: "mem-1", sourceIds: [], archivedAt: null,
      createdAt: new Date("2026-10-12T10:00:00Z"), updatedAt: new Date("2026-10-12T10:00:00Z")};
    prismaMock.brainArticle.findMany.mockResolvedValue([row]);
    prismaMock.brainArticle.findFirst.mockResolvedValue({...row, isPrivate: true, bodyMd: "Now private"});
    readableArtifactIds.mockImplementation(async (_actor, _ws, _kind, records) => new Set(records.filter((record: any) => !record.isPrivate).map((record: any) => record.id)));
    const {createArticle} = await import("./brain");
    await expect(createArticle(ownerActor, {workspaceId: "ws-1", title: "Existing", type: "PROJECT", bodyMd: "New body", isPrivate: false,
      duplicateGuard: {resolution, targetEntityId: row.id}})).rejects.toMatchObject({code: "NOT_FOUND"});
    expect(prismaMock.brainArticle.create).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
    prismaMock.brainArticle.findMany.mockReset();
  });

  it("records verified derivation only for a newly generated article", async () => {
    const { createArticle } = await import("./brain");
    const { brainSourceContentFingerprint } = await import("./brain-derivation");
    const {lineageContentFingerprint} = await import("./source-lineage");
    const source = {
      id: "source-1", workspaceId: "ws-1", informationCategory: "GENERAL", accessDomain: "WORKSPACE",
      sourceType: "DOC", tier: 1, title: "Notes", channel: "upload",
      content: "Original notes", ingestionGuidanceMd: null,
      fileStorageKey: "file-1", fileMimeType: "text/plain", archivedAt: null,
    };
    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    prismaMock.brainSource.findMany.mockResolvedValue([source]);
    prismaMock.artifactInputLineage.findFirst.mockResolvedValue({ workspaceId: "ws-1", artifactType: "BrainSource", artifactId: source.id,
      contentHash: lineageContentFingerprint("BrainSource", source), revision: 1, origin: "HUMAN_ORIGINAL", rootsJson: [], inputsJson: [] });
    prismaMock.brainArticle.create.mockResolvedValue({ id: "article-1", slug: "notes", title: "Notes", type: "PROJECT" });

    await createArticle({ kind: "agent", label: "brain-absorb", workspaceIds: ["ws-1"] } as any, {
      workspaceId: "ws-1", title: "Notes", type: "PROJECT", bodyMd: "Generated notes",
      sourceIds: [source.id], isPrivate: false, completeInputRoots: [{kind: "BrainSource", id: source.id, fingerprint: lineageContentFingerprint("BrainSource", source)}],
      derivation: { sourceId: source.id, sourceFingerprint: brainSourceContentFingerprint(source as any), agentRunId: "run-1" },
    });

    expect(prepareArtifactCommitPreflight).toHaveBeenCalledWith(expect.anything(), "ws-1",
      [expect.objectContaining({ kind: "BrainSource", id: source.id })]);
    expect(withArtifactCommitPreflight).toHaveBeenCalledWith(expect.anything(), "ws-1", prismaMock,
      [expect.objectContaining({ kind: "BrainSource", id: source.id })], expect.anything(), expect.any(Function));

    expect(prismaMock.brainSource.findFirst).toHaveBeenCalledWith({
      where: { id: "source-1", workspaceId: "ws-1", archivedAt: null },
    });
    expect(prismaMock.brainArticle.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sourceIds: ["source-1"],
      derivationJson: {
        version: 1, origin: "brain-absorb", agentRunId: "run-1",
        sources: [{ sourceId: "source-1", fingerprint: brainSourceContentFingerprint(source as any) }],
      },
    }) });
  });

  it("keeps a user-authored source link as a citation and rejects stale generation evidence", async () => {
    const { createArticle } = await import("./brain");
    const { brainSourceContentFingerprint } = await import("./brain-derivation");
    const {lineageContentFingerprint} = await import("./source-lineage");
    const source = {
      id: "source-1", workspaceId: "ws-1", informationCategory: "GENERAL", accessDomain: "WORKSPACE",
      sourceType: "DOC", tier: 1, title: "Notes", channel: "upload",
      content: "Replaced notes", ingestionGuidanceMd: null,
      fileStorageKey: "file-2", fileMimeType: "text/plain", archivedAt: null,
    };
    prismaMock.brainArticle.create.mockResolvedValue({ id: "article-1", slug: "notes", title: "Notes", type: "PROJECT" });
    prismaMock.brainSource.findMany.mockResolvedValue([source]);
    await createArticle(ownerActor, {
      workspaceId: "ws-1", title: "Notes", type: "PROJECT", bodyMd: "Human notes", sourceIds: [source.id],
    });
    expect(prismaMock.brainArticle.create).toHaveBeenCalledWith({ data: expect.not.objectContaining({ derivationJson: expect.anything() }) });

    prismaMock.brainSource.findFirst.mockResolvedValue(source);
    await expect(createArticle({ kind: "agent", label: "brain-absorb", workspaceIds: ["ws-1"] } as any, {
      workspaceId: "ws-1", title: "Other notes", type: "PROJECT", bodyMd: "Stale generation", sourceIds: [source.id], isPrivate: false, completeInputRoots: [{kind: "BrainSource", id: source.id, fingerprint: lineageContentFingerprint("BrainSource", source)}],
      derivation: { sourceId: source.id, sourceFingerprint: brainSourceContentFingerprint({ ...source, content: "Earlier notes" } as any), agentRunId: "run-1" },
    })).rejects.toMatchObject({ status: 409, code: "SOURCE_CHANGED" });
    expect(prismaMock.brainArticle.create).toHaveBeenCalledTimes(1);
  });

  it("keeps generated body history and marks a human edit for review", async () => {
    const { updateArticle } = await import("./brain");
    const article = {
      id: "article-1", workspaceId: "ws-1", slug: "notes", title: "Notes",
      bodyMd: "Generated notes", authority: "DRAFT", isPrivate: true,
      ownerMemberId: "mem-1", archivedAt: null,
      sourceIds: [], updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "run-1", sources: [] },
      humanEditedAt: null,
    };
    prismaMock.brainArticle.findUnique.mockResolvedValue(article);
    prismaMock.brainArticleVersion.findFirst.mockResolvedValue(null);
    prismaMock.brainArticleVersion.create.mockResolvedValue({});
    prismaMock.brainArticle.update.mockResolvedValue({ ...article, bodyMd: "Human notes" });

    await updateArticle(ownerActor, { workspaceId: "ws-1", slug: "notes", bodyMd: "Human notes" });

    expect(prismaMock.brainArticleVersion.create).toHaveBeenCalledWith({ data: {
      articleId: "article-1", version: 1, bodyMd: "Generated notes",
      accessEnvelopeJson: { isPrivate: true, ownerMemberId: "mem-1" },
      changeSummary: null, agentRunId: null,
    } });
    expect(prismaMock.brainArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1" },
      data: { bodyMd: "Human notes", humanEditedAt: expect.any(Date) },
    });
  });

  it.each(["archive", "reviewed regeneration"])("rejects an in-flight draft update after %s wins the article row", async (change) => {
    const { updateArticle } = await import("./brain");
    const old = { id: "article-1", workspaceId: "ws-1", slug: "notes", title: "Notes",
      bodyMd: "Before review", authority: "DRAFT", isPrivate: true, ownerMemberId: "mem-1",
      sourceIds: [], derivationJson: null, archivedAt: null, updatedAt: new Date("2026-04-01T00:00:00.000Z") };
    const current = { ...old, bodyMd: "Reviewed replacement",
      archivedAt: change === "archive" ? new Date("2026-04-02T00:00:00.000Z") : null,
      updatedAt: new Date("2026-04-02T00:00:00.000Z") };
    prismaMock.brainArticle.findUnique.mockResolvedValueOnce(old).mockResolvedValueOnce(current);
    await expect(updateArticle(ownerActor, { workspaceId: "ws-1", slug: "notes", bodyMd: "Stale human edit" }))
      .rejects.toMatchObject({ status: 409, code: "ARTICLE_CHANGED" });
    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });

  it("does not publish an archived draft", async () => {
    const { publishArticle } = await import("./brain");
    prismaMock.brainArticle.findUnique.mockResolvedValue({ id: "article-1", workspaceId: "ws-1", slug: "notes",
      authority: "DRAFT", isPrivate: true, archivedAt: new Date() });
    await expect(publishArticle(ownerActor, { workspaceId: "ws-1", slug: "notes" }))
      .rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });

  it("does not mark an unchanged generated draft as human-edited on form submission", async () => {
    const { updateArticle } = await import("./brain");
    const article = {
      id: "article-1", workspaceId: "ws-1", slug: "notes", title: "Notes",
      type: "PROJECT", bodyMd: "Generated notes", authority: "DRAFT",
      frontmatterJson: { category: "notes" }, ownerMemberId: "mem-1",
      staleAfterDays: 30, sourceIds: [],
      isPrivate: true, archivedAt: null,
      derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "run-1", sources: [] },
      humanEditedAt: null, updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    };
    prismaMock.brainArticle.findUnique.mockResolvedValue(article);
    prismaMock.brainArticle.update.mockResolvedValue(article);

    await updateArticle(ownerActor, {
      workspaceId: "ws-1", slug: "notes", title: " Notes ", type: "PROJECT",
      bodyMd: "Generated notes", authority: "DRAFT",
      frontmatterJson: { category: "notes" }, ownerMemberId: "mem-1",
      staleAfterDays: 30, sourceIds: [],
    });

    expect(prismaMock.brainArticleVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.update).toHaveBeenCalledWith({
      where: { id: "article-1" },
      data: {
        title: "Notes", type: "PROJECT", bodyMd: "Generated notes", authority: "DRAFT",
        frontmatterJson: { category: "notes" }, ownerMemberId: "mem-1",
        staleAfterDays: 30, sourceIds: [],
      },
    });
  });

  it("preserves a DIGEST's type and provenance when saving other draft fields", async () => {
    const { updateArticle } = await import("./brain");
    const current = {
      id: "digest-1", workspaceId: "ws-1", slug: "weekly-digest", title: "Weekly digest",
      type: "DIGEST", bodyMd: "Before", authority: "DRAFT", isPrivate: true,
      ownerMemberId: "mem-1", archivedAt: null, sourceIds: [],
      derivationJson: { version: 1, origin: "brain-absorb", agentRunId: "run-1", sources: [] },
      humanEditedAt: null, updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    };
    prismaMock.brainArticle.findUnique.mockResolvedValue(current);
    prismaMock.brainArticle.update.mockResolvedValue({ ...current, bodyMd: "After" });
    prismaMock.brainArticleVersion.findFirst.mockResolvedValue(null);

    await updateArticle(ownerActor, {
      workspaceId: "ws-1", slug: "weekly-digest", title: "Weekly digest",
      authority: "DRAFT", bodyMd: "Before",
    });
    expect(prismaMock.brainArticle.update).toHaveBeenCalledWith({ where: { id: "digest-1" },
      data: { title: "Weekly digest", authority: "DRAFT", bodyMd: "Before" } });
    expect(prismaMock.brainArticleVersion.create).not.toHaveBeenCalled();

    await updateArticle(ownerActor, { workspaceId: "ws-1", slug: "weekly-digest", bodyMd: "After" });
    expect(prismaMock.brainArticle.update).toHaveBeenLastCalledWith({ where: { id: "digest-1" },
      data: { bodyMd: "After", humanEditedAt: expect.any(Date) } });
    expect(prismaMock.brainArticleVersion.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DIGEST", "PRODUCT"], ["PROJECT", "DIGEST"],
  ])("rejects an unapproved article type conversion from %s to %s", async (existingType, requestedType) => {
    const { updateArticle } = await import("./brain");
    prismaMock.brainArticle.findUnique.mockResolvedValue({
      id: "article-1", workspaceId: "ws-1", slug: "notes", title: "Notes",
      type: existingType, bodyMd: "Notes", authority: "DRAFT", isPrivate: true,
      ownerMemberId: "mem-1", archivedAt: null, sourceIds: [],
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    await expect(updateArticle(ownerActor, { workspaceId: "ws-1", slug: "notes", type: requestedType as "DIGEST" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(prismaMock.brainArticle.update).not.toHaveBeenCalled();
  });
});

describe("Brain status access domains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainArticle.count.mockResolvedValue(0);
    prismaMock.brainSource.count.mockResolvedValue(2);
    prismaMock.brainDiscussionThread.count.mockResolvedValue(0);
    prismaMock.brainDiscussionThread.findMany.mockResolvedValue([]);
    prismaMock.brainSource.findMany.mockResolvedValue([]);
    prismaMock.brainBacklink.findMany.mockResolvedValue([]);
    prismaMock.brainBacklink.groupBy.mockResolvedValue([]);
  });

  it.each([
    [["WORKSPACE"], 2],
    [["WORKSPACE", "FINANCE"], 3],
  ])("scopes unabsorbed source counts to %j", async (domains, count) => {
    resolveKnowledgeAccessDomains.mockResolvedValue(domains);
    prismaMock.brainSource.count.mockResolvedValue(count);
    prismaMock.brainSource.findMany.mockResolvedValue(Array.from({ length: count }, (_, index) => ({ id: `source-${index}`, accessDomain: domains[0] })));
    const { getBrainStatus } = await import("./brain");

    await expect(getBrainStatus(ownerActor, { workspaceId: "ws-1" }))
      .resolves.toMatchObject({ unabsorbedSources: count });

    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(ownerActor, "ws-1");
    expect(prismaMock.brainSource.findMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" }, take: 100,
      where: {
        workspaceId: "ws-1",
        accessDomain: { in: domains },
        archivedAt: null,
        absorbedAt: null,
      },
    });
  });

  it("fails closed before status queries when access resolution fails", async () => {
    const error = new Error("access denied");
    resolveKnowledgeAccessDomains.mockRejectedValue(error);
    const { getBrainStatus } = await import("./brain");

    await expect(getBrainStatus(ownerActor, { workspaceId: "ws-1" }))
      .rejects.toBe(error);

    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
    expect(prismaMock.brainArticle.findMany).not.toHaveBeenCalled();
  });
});

describe("brain source ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    requireWorkspaceMembership.mockResolvedValue({
      id: "mem-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "MEMBER",
      isActive: true,
    });
    appendEvents.mockResolvedValue(undefined);
    prismaMock.auditLog.create.mockResolvedValue({});
    prismaMock.event.createMany.mockResolvedValue({ count: 1 });
    prismaMock.brainSource.create.mockResolvedValue({
      id: "source-1",
      sourceType: "DOC",
      tier: 1,
      ingestionGuidanceMd: "Highlight launch constraints.",
    });
    prismaMock.brainSource.findFirst.mockResolvedValue(null);
    prismaMock.brainSource.findMany.mockResolvedValue([]);
    prismaMock.brainSource.count.mockResolvedValue(0);
    prismaMock.brainSource.update.mockResolvedValue({
      id: "source-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      absorbedAt: null,
    });
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    archiveWorkspaceArtifact.mockResolvedValue({ id: "source-1" });
  });

  it("filters workspace-only source items and totals through the shared access policy", async () => {
    const { listSources } = await import("./brain");

    await expect(listSources(ownerActor, {
      workspaceId: "ws-1",
    })).resolves.toEqual({
      items: [],
      total: 0,
      take: 50,
      skip: 0,
    });

    expect(resolveKnowledgeAccessDomains).toHaveBeenCalledWith(ownerActor, "ws-1", prismaMock);
    const where = {
      workspaceId: "ws-1",
      accessDomain: { in: ["WORKSPACE"] },
      archivedAt: null,
    };
    expect(prismaMock.brainSource.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
  });

  it("preserves source filters and pagination for Finance-authorized domains", async () => {
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE", "FINANCE"]);
    prismaMock.brainSource.count.mockResolvedValue(7);

    const { listSources } = await import("./brain");
    await expect(listSources(ownerActor, {
      workspaceId: "ws-1",
      absorbed: true,
      archiveFilter: "archived",
      take: 12,
      skip: 4,
    })).resolves.toEqual({
      items: [],
      total: 0,
      take: 12,
      skip: 4,
    });

    const where = {
      workspaceId: "ws-1",
      accessDomain: { in: ["WORKSPACE", "FINANCE"] },
      archivedAt: { not: null },
      absorbedAt: { not: null },
    };
    expect(prismaMock.brainSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
  });

  it("does not query sources when access-domain resolution fails", async () => {
    const error = new Error("access denied");
    resolveKnowledgeAccessDomains.mockRejectedValue(error);

    const { listSources } = await import("./brain");
    await expect(listSources(ownerActor, { workspaceId: "ws-1" }))
      .rejects.toBe(error);

    expect(prismaMock.brainSource.findMany).not.toHaveBeenCalled();
    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
  });

  it("persists trimmed ingestion guidance on brain sources", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      ingestionGuidanceMd: " Highlight launch constraints. ",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        content: "Policy text",
        ingestionGuidanceMd: "Highlight launch constraints.",
      }),
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        meta: expect.objectContaining({ hasIngestionGuidance: true }),
      }),
    }));
  });

  it("records the current user membership as the Brain source author", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("defaults explicit null user source authors to the current user membership", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      authorMemberId: null,
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("defaults blank user source authors to the current user membership", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      authorMemberId: "   ",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("ignores spoofed user source author ids", async () => {
    const { ingestSource } = await import("./brain");

    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      content: "Policy text",
      title: "Policy",
      authorMemberId: "other-member",
    });

    expect(prismaMock.brainSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        authorMemberId: "mem-1",
      }),
    });
  });

  it("delegates Brain source removal to the review lifecycle", async () => {
    const { deleteSource } = await import("./brain");
    requestBrainSourceRemoval.mockResolvedValue({ id: "source-1", status: "archived" });

    await expect(deleteSource(ownerActor, {
      workspaceId: "ws-1",
      sourceId: "source-1",
    })).resolves.toEqual({ id: "source-1", status: "archived" });

    expect(requestBrainSourceRemoval).toHaveBeenCalledWith(ownerActor, {
      workspaceId: "ws-1",
      sourceId: "source-1",
    });
  });

  it("resets absorbed state when a duplicate Brain source is updated", async () => {
    const existingSource = {
      id: "source-existing",
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Policy",
      externalId: null,
      content: "Policy text",
      ingestionGuidanceMd: null,
      metadata: {},
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      absorbedAt: new Date("2026-07-20T10:05:00.000Z"),
    };
    prismaMock.brainSource.findMany.mockResolvedValueOnce([existingSource]);
    prismaMock.brainSource.findFirst.mockResolvedValueOnce(existingSource);
    prismaMock.brainSource.update.mockResolvedValueOnce({
      ...existingSource,
      content: "Policy text\n\n---\nAdditional duplicate upload context:\nNew policy detail",
      absorbedAt: null,
    });

    const { ingestSource } = await import("./brain");
    await ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Policy",
      externalId: "source-external-1",
      content: "New policy detail",
      duplicateGuard: {
        resolution: "update_existing",
        targetEntityId: "source-existing",
      },
    });

    expect(prismaMock.brainSource.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "source-existing" },
      data: expect.objectContaining({
        absorbedAt: null,
        externalId: "source-external-1",
      }),
    }));
    expect(prismaMock.brainSource.create).not.toHaveBeenCalled();
  });

  it("uses url metadata when checking Brain source duplicates", async () => {
    const existingSource = {
      id: "source-url",
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Vendor notes",
      content: "Vendor notes content",
      externalId: null,
      metadata: { url: "https://example.com/vendor-notes" },
      archivedAt: null,
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
    };
    prismaMock.brainSource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existingSource]);
    prismaMock.brainSource.findFirst.mockResolvedValueOnce(existingSource);

    const { ingestSource } = await import("./brain");
    await expect(ingestSource(ownerActor, {
      workspaceId: "ws-1",
      sourceType: "DOC",
      tier: 1,
      title: "Vendor notes",
      content: "Vendor notes content",
      metadata: { url: "https://example.com/vendor-notes" },
      duplicateGuard: { onExact: "use_existing" },
    })).resolves.toMatchObject({ id: "source-url" });

    expect(prismaMock.brainSource.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { metadata: { path: ["url"], equals: "https://example.com/vendor-notes" } },
        ]),
      }),
    }));
    expect(prismaMock.brainSource.create).not.toHaveBeenCalled();
  });
});


describe("Brain discussions with actual complete lineage receipts", () => {
  const epochs = new Map<string, bigint>();
  const rows: Record<string, any[]> = {};
  const timestamp = new Date("2026-10-12T10:00:00Z");
  let source: typeof import("./source-lineage");
  const otherActor = { kind: "user", user: { id: "user-2", email: "other@example.test", displayName: "Other" } } as any;
  function relation(row: any, key: string) {
    if (key === "article") return rows.brainArticle.find((item) => item.id === row.articleId);
    if (key === "thread") return rows.brainDiscussionThread.find((item) => item.id === row.threadId);
    if (key === "authorMember" || key === "ownerMember") return rows.member.find((item) => item.id === row[key + "Id"]);
    if (key === "user") return rows.user.find((item) => item.id === row.userId);
    return undefined;
  }
  function matches(row: any, where: any): boolean {
    return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (key === "workspaceId_slug") return matches(row, value);
      if (key === "AND") return (Array.isArray(value) ? value : [value]).every((part: any) => matches(row, part));
      if (key === "OR") return value.some((part: any) => matches(row, part));
      if (["article", "thread", "user"].includes(key)) return matches(relation(row, key), value);
      if (key === "memberships") return rows.member.some((member) => member.userId === row.id && matches(member, value.some));
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return value.in.includes(row[key]);
        if ("gt" in value) return row[key] > value.gt;
        throw new Error(`Unhandled discussion test predicate ${key}`);
      }
      return row[key] === value;
    });
  }
  function project(table: string, row: any, args: any = {}): any {
    if (!row) return null;
    let result = { ...row };
    for (const [key, request] of Object.entries(args.include ?? {}) as [string, any][]) {
      if (["article", "thread", "authorMember", "ownerMember", "user"].includes(key)) {
        const name = key === "article" ? "brainArticle" : key === "thread" ? "brainDiscussionThread" : key === "user" ? "user" : "member";
        result[key] = project(name, relation(row, key), request);
      } else if (key === "discussions") result[key] = rows.brainDiscussionThread.filter((thread) => thread.articleId === row.id && matches(thread, request.where)).map((thread) => project("brainDiscussionThread", thread, request));
      else if (key === "comments") result[key] = rows.brainDiscussionComment.filter((comment) => comment.threadId === row.id).map((comment) => project("brainDiscussionComment", comment, request === true ? {} : request));
      else if (["backlinksTo", "backlinksFrom"].includes(key)) result[key] = [];
      else throw new Error(`Unhandled discussion test include ${table}.${key}`);
    }
    if (args.select) result = Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
    return result;
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    source = await vi.importActual<typeof import("./source-lineage")>("./source-lineage");
    const mocked = await import("./source-lineage");
    for (const name of ["readableArtifactIds", "recordArtifactInputLineage", "copyArtifactInputLineage", "createBrainArticleHistoryVersion", "currentArtifactInputRoots", "captureArtifactInputSnapshotProof", "captureArtifactInputProof", "withArtifactCountReleaseSnapshot"] as const) vi.mocked(mocked[name]).mockImplementation(source[name] as any);
    for (const name of ["brainArticle", "brainArticleVersion", "auditLog", "brainSource", "brainDiscussionThread", "brainDiscussionComment", "member", "user", "action", "artifactInputLineage", "artifactInputSnapshot"]) {
      rows[name] = [];
      const delegate: any = (prismaMock as any)[name];
      const find = async (args: any) => project(name, rows[name].filter((row) => matches(row, args.where)).at(-1), args);
      if (delegate.findFirst) delegate.findFirst.mockImplementation(find);
      if (delegate.findUnique) delegate.findUnique.mockImplementation(find);
      if (delegate.findMany) delegate.findMany.mockImplementation(async (args: any) => rows[name].filter((row) => matches(row, args.where))
        .sort((a, b) => name === "artifactInputLineage" ? b.revision - a.revision : a.id.localeCompare(b.id))
        .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows[name].length)).map((row) => project(name, row, args)));
      if (delegate.create) delegate.create.mockImplementation(async ({ data }: any) => {
        const row = { id: `${name}-${rows[name].length}`, createdAt: timestamp, ...(name === "brainSource" ? { informationCategory: "GENERAL" } : {}), ...(name === "brainDiscussionThread" ? { status: "OPEN", resolvedAt: null, absorbedAt: null } : {}), ...data };
        rows[name].push(row); return { ...row };
      });
      if (delegate.update) delegate.update.mockImplementation(async ({ where, data }: any) => {
        const row = rows[name].find((item) => matches(item, where)); Object.assign(row, data); return { ...row };
      });
      if (delegate.count) delegate.count.mockImplementation(async (args: any) => rows[name].filter((row) => matches(row, args.where)).length);
    }
    prismaMock.$transaction.mockImplementation(async (run: any) => run(prismaMock));
    epochs.clear();
    prismaMock.$executeRaw.mockImplementation(async (query: any) => {
      if (query.strings?.join("").includes('INSERT INTO "SourcePermissionEpoch"')) for (let index = 0; index < query.values.length; index += 4) {
        const [, workspaceId, kind, id] = query.values.slice(index, index + 4); const key = JSON.stringify([workspaceId, kind, id]);
        if (!epochs.has(key)) epochs.set(key, 0n);
      }
      return 1;
    });
    prismaMock.$queryRaw.mockImplementation(async (query: any) => {
      const sql = query.strings?.join("") ?? "";
      if (sql.includes('DISTINCT ON ("artifactId")') && sql.includes('FROM "ArtifactInputLineage"')) {
        const [workspaceId, artifactType, ...ids] = query.values;
        const heads = new Map<string, typeof rows.artifactInputLineage[number]>();
        for (const row of [...rows.artifactInputLineage].sort((a, b) => b.revision - a.revision)) {
          if (row.workspaceId === workspaceId && row.artifactType === artifactType && ids.includes(row.artifactId)
            && !heads.has(row.artifactId)) heads.set(row.artifactId, row);
        }
        return [...heads.values()].map(row => structuredClone(row));
      }
      if (!sql.includes('FROM "SourcePermissionEpoch"')) return [];
      const [workspaceId, ...pairs] = query.values; const result = [];
      for (let index = 0; index < pairs.length; index += 2) {
        const [sourceKind, sourceId] = pairs.slice(index, index + 2); const epoch = epochs.get(JSON.stringify([workspaceId, sourceKind, sourceId]));
        if (epoch !== undefined) result.push({ sourceKind, sourceId, epoch });
      }
      return result;
    });
    prismaMock.brainBacklink.findMany.mockResolvedValue([]); prismaMock.brainBacklink.groupBy.mockResolvedValue([]);
    resolveKnowledgeAccessDomains.mockResolvedValue(["WORKSPACE"]);
    requireWorkspaceMembership.mockImplementation(async ({ actor, workspaceId }: any) => {
      if (actor.kind === "agent") return null;
      const member = rows.member.find((row) => row.workspaceId === workspaceId && row.userId === actor.user.id && row.isActive);
      if (!member) throw Object.assign(new Error("Membership denied"), { code: "NOT_A_MEMBER" });
      return member;
    });
    for (const [id, memberId] of [["user-1", "mem-1"], ["user-2", "mem-2"]]) {
      rows.user.push({ id, email: `${id}@example.test`, displayName: id, bio: null, avatarUrl: null, linkedinUrl: null, websiteUrl: null });
      rows.member.push({ id: memberId, workspaceId: "ws-1", userId: id, role: "CONTRIBUTOR", isActive: true, joinedAt: timestamp });
    }
    const article = { id: "article-original", workspaceId: "ws-1", slug: "original", title: "Original article", bodyMd: "Original article body", isPrivate: false,
      sourceIds: [], type: "REFERENCE", authority: "DRAFT", archivedAt: null, createdAt: timestamp, updatedAt: timestamp, ownerMemberId: null };
    rows.brainArticle.push(article);
    await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: ownerActor, workspaceId: "ws-1", artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "HUMAN_ORIGINAL", inputs: [] });
  });
  async function originalThread() {
    const { createDiscussionThread } = await import("./brain");
    return createDiscussionThread(ownerActor, { workspaceId: "ws-1", slug: "original", targetType: "ARTICLE", bodyMd: "Original discussion comment" });
  }
  async function privateInput() {
    const row = { id: "private-action", workspaceId: "ws-1", title: "Private input", bodyMd: "Private generated input", status: "DRAFT", authorUserId: "user-2", isPrivate: true, archivedAt: null as Date | null, createdAt: timestamp, updatedAt: timestamp };
    rows.action.push(row);
    await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: otherActor, workspaceId: "ws-1", artifact: { kind: "Action", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
    return row;
  }
  it("returns only captured proven list rows and counts when a revision changes during joined reads", async () => {
    const { listArticles } = await import("./brain");
    const originalFind = prismaMock.brainBacklink.findMany.getMockImplementation()!;
    prismaMock.brainBacklink.findMany.mockImplementationOnce(async (...args: any[]) => {
      rows.brainArticle[0].title = "Concurrent unreceipted private title";
      rows.brainArticle[0].bodyMd = "Concurrent unreceipted private body";
      return originalFind(...args);
    });
    const result = await listArticles(ownerActor, { workspaceId: "ws-1" });
    expect(result).toMatchObject({ items: [], total: 0 });
    expect(JSON.stringify(result)).not.toContain("Concurrent");
    expect(prismaMock.brainArticle.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.brainArticle.count).not.toHaveBeenCalled();
  });
  it("rebuilds a generated digest from permitted remaining sources and preserves revoked old body as unknown history", async () => {
    const { updateArticle } = await import("./brain");
    const sourceA = { id: "old-source", workspaceId: "ws-1", informationCategory: "GENERAL", sourceType: "CONVERSATION", accessDomain: "WORKSPACE",
      tier: 1, title: "Old", channel: null, content: "Revoked old content", metadata: {}, archivedAt: null, createdAt: timestamp };
    const sourceB = { ...sourceA, id: "remaining-source", title: "Remaining", content: "Permitted remaining content" };
    rows.brainSource.push(sourceA, sourceB);
    for (const row of [sourceA, sourceB]) await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: ownerActor,
      workspaceId: "ws-1", artifact: { kind: "BrainSource", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
    const article = rows.brainArticle[0];
    Object.assign(article, { type: "DIGEST", humanEditedAt: null, frontmatterJson: { generatedBy: "daily-digest" },
      bodyMd: sourceA.content, sourceIds: [sourceA.id], derivationJson: null });
    await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: ownerActor, workspaceId: "ws-1",
      artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: sourceA.id }] });
    rows.auditLog.push({ id: "created", workspaceId: "ws-1", entityType: "BrainArticle", entityId: article.id,
      action: "brain-article.created", actorUserId: null, createdAt: timestamp });
    sourceA.archivedAt = new Date("2026-10-13T00:00:00Z") as any;
    const actor = {kind: "agent", authProvider: "bootstrap", label: "daily-digest-agent", workspaceIds: ["ws-1"]} as any;
    requireWorkspaceMembership.mockImplementation(async ({ actor: current, workspaceId }: any) => current.kind === "agent" ? null
      : rows.member.find((row) => row.workspaceId === workspaceId && row.userId === current.user.id && row.isActive));
    const fresh = await source.captureArtifactInputProof(actor, "ws-1", [{kind: "BrainSource", id: sourceB.id}]);
    await updateArticle(actor, {workspaceId: "ws-1", slug: "original", title: "Fresh digest", type: "DIGEST", bodyMd: sourceB.content,
      frontmatterJson: {generatedBy: "daily-digest"}, sourceIds: [sourceB.id], completeInputRoots: fresh});
    expect(rows.brainArticle[0]).toMatchObject({title: "Fresh digest", bodyMd: sourceB.content, sourceIds: [sourceB.id]});
    expect(rows.brainArticleVersion[0].bodyMd).toBe(sourceA.content);
    expect(rows.artifactInputLineage.filter((row) => row.artifactType === "BrainArticleVersion").at(-1)).toMatchObject({origin: "UNKNOWN"});
    expect(await source.readableArtifactIds(ownerActor, "ws-1", "BrainArticle", [rows.brainArticle[0]])).toEqual(new Set([article.id]));
    expect(await source.readableArtifactIds(ownerActor, "ws-1", "BrainArticleVersion", rows.brainArticleVersion)).toEqual(new Set());
    expect(JSON.stringify(rows.artifactInputLineage.filter((row) => row.artifactType === "BrainArticle").at(-1).rootsJson)).not.toContain(sourceA.id);
    expect(prismaMock.artifactInputSnapshot.create).not.toHaveBeenCalled();
  });
  it("preserves an original history body independently of the next edit's sources", async () => {
    const { updateArticle } = await import("./brain");
    rows.member.find(row => row.id === "mem-1").role = "ADMIN";
    const input = { id: "new-edit-source", workspaceId: "ws-1", informationCategory: "GENERAL", sourceType: "CONVERSATION", accessDomain: "WORKSPACE",
      tier: 1, title: "New source", content: "New contributed content", channel: null, metadata: {}, archivedAt: null, createdAt: timestamp };
    rows.brainSource.push(input);
    await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: ownerActor, workspaceId: "ws-1",
      artifact: { kind: "BrainSource", id: input.id }, content: input, origin: "HUMAN_ORIGINAL", inputs: [] });
    const roots = await source.captureArtifactInputProof(ownerActor, "ws-1", [{ kind: "BrainSource", id: input.id }], prismaMock as any);
    await updateArticle(ownerActor, { workspaceId: "ws-1", slug: "original", bodyMd: input.content,
      sourceIds: [input.id], additionalInputRoots: roots, changeSummary: "New edit's source text", agentRunId: "new-edit-run" });
    const version = rows.brainArticleVersion[0];
    expect(version).toMatchObject({ bodyMd: "Original article body", changeSummary: null, agentRunId: null });
    expect(rows.artifactInputLineage.filter(row => row.artifactType === "BrainArticleVersion").at(-1))
      .toMatchObject({ origin: "HUMAN_ORIGINAL", rootsJson: [], inputsJson: [] });
    input.archivedAt = new Date("2026-10-13T00:00:00Z") as any;
    expect(await source.readableArtifactIds(otherActor, "ws-1", "BrainArticle", rows.brainArticle)).toEqual(new Set());
    expect(await source.readableArtifactIds(otherActor, "ws-1", "BrainArticleVersion", [version])).toEqual(new Set([version.id]));
  });
  it("writes original human thread and first comment atomically with empty-input receipts", async () => {
    const thread = await originalThread();
    expect(thread).toMatchObject({ articleId: "article-original", status: "OPEN" });
    expect(rows.artifactInputLineage).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactType: "BrainDiscussionThread", artifactId: thread.id, origin: "HUMAN_ORIGINAL", rootsJson: [] }),
      expect.objectContaining({ artifactType: "BrainDiscussionComment", origin: "HUMAN_ORIGINAL", rootsJson: [] }),
    ]));
    const { getArticle } = await import("./brain");
    expect((await getArticle(ownerActor, { workspaceId: "ws-1", slug: "original" })).discussions[0].comments).toMatchObject([{ bodyMd: "Original discussion comment" }]);
  });
  it("withholds copied/agent comments without a complete prompt receipt, including safe mutation response", async () => {
    const thread = await originalThread();
    const { addDiscussionComment, getArticle } = await import("./brain");
    const actor = { kind: "agent", authProvider: "bootstrap", label: "synthetic", workspaceIds: ["ws-1"] } as any;
    const comment = await addDiscussionComment(actor, { workspaceId: "ws-1", threadId: thread.id, bodyMd: "Unproven agent body" });
    expect(comment).toEqual({ id: comment.id, threadId: thread.id, contentWithheld: true });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ artifactType: "BrainDiscussionComment", origin: "UNKNOWN" });
    expect(JSON.stringify(await getArticle(ownerActor, { workspaceId: "ws-1", slug: "original" }))).not.toContain("Unproven agent body");
  });
  it("filters private copied and unknown comments before returning bodies while preserving originals", async () => {
    const thread = await originalThread(), input = await privateInput();
    const lineageRoots = await source.captureArtifactInputProof(otherActor, "ws-1", [{ kind: "Action", id: input.id }]);
    const { addDiscussionComment, getArticle } = await import("./brain");
    await addDiscussionComment(otherActor, { workspaceId: "ws-1", threadId: thread.id, bodyMd: input.bodyMd, copied: true, lineageRoots });
    rows.brainDiscussionComment.push({ id: "legacy-comment", threadId: thread.id, authorMemberId: "mem-2", bodyMd: "Unknown historical body", createdAt: timestamp });
    const visible = await getArticle(ownerActor, { workspaceId: "ws-1", slug: "original" });
    expect(visible.discussions[0].comments.map((comment) => comment.bodyMd)).toEqual(["Original discussion comment"]);
    expect((await getArticle(otherActor, { workspaceId: "ws-1", slug: "original" })).discussions[0].comments).toHaveLength(2);
    input.archivedAt = new Date();
    expect((await getArticle(otherActor, { workspaceId: "ws-1", slug: "original" })).discussions[0].comments).toHaveLength(1);
  });
  it("hides unknown target metadata and discussion counts before article lists and workspace status", async () => {
    await originalThread();
    rows.brainDiscussionThread.push({ id: "legacy-thread", articleId: "article-original", authorMemberId: "mem-2", targetType: "SECTION", targetRef: "Unknown private heading", status: "OPEN", createdAt: timestamp });
    const { getArticle, listArticles, getBrainStatus } = await import("./brain");
    expect(JSON.stringify(await getArticle(ownerActor, { workspaceId: "ws-1", slug: "original" }))).not.toContain("Unknown private heading");
    expect((await listArticles(ownerActor, { workspaceId: "ws-1" })).items[0]._count.discussions).toBe(1);
    expect((await getBrainStatus(ownerActor, { workspaceId: "ws-1" })).openDiscussionThreads).toBe(1);
  });
  it("redacts joined departed authors without suppressing a currently readable original comment", async () => {
    await originalThread();
    const { getArticle } = await import("./brain");
    rows.member.find((row) => row.id === "mem-1").isActive = false;
    const result = await getArticle(otherActor, { workspaceId: "ws-1", slug: "original" });
    expect(result.discussions[0]).toMatchObject({ authorMember: null, authorMemberId: null, comments: [{ authorMember: null, authorMemberId: null, bodyMd: "Original discussion comment" }] });
  });
  it("rejects changed inputs before a copied comment is persisted and advances known thread status without recertifying unknown history", async () => {
    const thread = await originalThread(), input = await privateInput();
    const lineageRoots = await source.captureArtifactInputProof(otherActor, "ws-1", [{ kind: "Action", id: input.id }]);
    input.bodyMd = "Changed after capture";
    const { addDiscussionComment, resolveDiscussionThread } = await import("./brain");
    await expect(addDiscussionComment(otherActor, { workspaceId: "ws-1", threadId: thread.id, bodyMd: "Model output", copied: true, lineageRoots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(rows.brainDiscussionComment).toHaveLength(1);
    expect(await resolveDiscussionThread(ownerActor, { workspaceId: "ws-1", threadId: thread.id })).toMatchObject({ status: "RESOLVED" });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ artifactType: "BrainDiscussionThread", origin: "HUMAN_ORIGINAL", revision: 2 });
    const legacy = { id: "legacy-thread", articleId: "article-original", authorMemberId: "mem-2", targetType: "SECTION", targetRef: "Unknown private heading", status: "OPEN", createdAt: timestamp };
    rows.brainDiscussionThread.push(legacy);
    expect(await resolveDiscussionThread(ownerActor, { workspaceId: "ws-1", threadId: legacy.id })).toMatchObject({ contentWithheld: true });
    expect(rows.artifactInputLineage.at(-1)).toMatchObject({ origin: "UNKNOWN" });
  });
  it("revalidates absorption inputs inside the status transaction and leaves unknown or changed threads untouched", async () => {
    const thread = await originalThread();
    const {resolveDiscussionThread, markThreadAbsorbed} = await import("./brain");
    await resolveDiscussionThread(ownerActor, {workspaceId: "ws-1", threadId: thread.id});
    const roots = await source.captureArtifactInputProof(ownerActor, "ws-1", [{kind: "BrainDiscussionThread", id: thread.id}]);
    rows.brainDiscussionThread.find(row => row.id === thread.id).targetRef = "Concurrent new section";
    const writesBefore = prismaMock.brainDiscussionThread.update.mock.calls.length;
    await expect(markThreadAbsorbed(ownerActor, {workspaceId: "ws-1", threadId: thread.id, expectedInputRoots: roots}))
      .rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    expect(prismaMock.brainDiscussionThread.update.mock.calls).toHaveLength(writesBefore);
    expect(rows.brainDiscussionThread.find(row => row.id === thread.id).status).toBe("RESOLVED");
  });

  it("counts only independently permitted unabsorbed source bodies", async () => {
    const input = await privateInput();
    const publicSource = { id: "source-original", workspaceId: "ws-1", informationCategory: "GENERAL", sourceType: "CONVERSATION", tier: 1, content: "Original public source", title: "Original", metadata: {}, accessDomain: "WORKSPACE", absorbedAt: null, archivedAt: null, createdAt: timestamp };
    rows.brainSource.push(publicSource);
    await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: ownerActor, workspaceId: "ws-1", artifact: { kind: "BrainSource", id: publicSource.id }, content: publicSource, origin: "HUMAN_ORIGINAL", inputs: [] });
    const restricted = { ...publicSource, id: "source-private", content: input.bodyMd };
    rows.brainSource.push(restricted);
    await source.recordArtifactInputLineage({ tx: prismaMock as any, actor: otherActor, workspaceId: "ws-1", artifact: { kind: "BrainSource", id: restricted.id }, content: restricted, origin: "DERIVED", inputs: [{ kind: "Action", id: input.id }] });
    rows.brainSource.push({ ...publicSource, id: "source-legacy", content: "Unknown historical source" });
    const { getBrainStatus } = await import("./brain");
    expect(await getBrainStatus(ownerActor, { workspaceId: "ws-1" })).toMatchObject({ unabsorbedSources: 1 });
    expect(await getBrainStatus(otherActor, { workspaceId: "ws-1" })).toMatchObject({ unabsorbedSources: 2 });
    expect(prismaMock.brainSource.count).not.toHaveBeenCalled();
  });
});
