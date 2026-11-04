import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  modelGatewayMock,
  createArticleMock,
  updateArticleMock,
  markSourceAbsorbedMock,
  rebuildBacklinksMock,
  syncBrainArticleKnowledgeMock,
  lockWorkspaceArchiveArtifactMock,
  recoveryIdentityMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    brainSource: {
      findUnique: vi.fn(),
    },
    brainArticle: {
      findMany: vi.fn(),
    },
    brainBacklink: {
      findMany: vi.fn(),
    },
  },
  modelGatewayMock: {
    extract: vi.fn(),
    chat: vi.fn(),
  },
  createArticleMock: vi.fn(),
  updateArticleMock: vi.fn(),
  markSourceAbsorbedMock: vi.fn(),
  rebuildBacklinksMock: vi.fn(),
  syncBrainArticleKnowledgeMock: vi.fn(),
  lockWorkspaceArchiveArtifactMock: vi.fn(),
  recoveryIdentityMock: vi.fn(),
}));

vi.mock("@corgtex/shared", () => ({
  prisma: prismaMock,
}));

vi.mock("@corgtex/models", () => ({
  defaultModelGateway: modelGatewayMock,
  resolveModel: vi.fn(() => "gpt-4o-mini"),
}));

vi.mock("@corgtex/domain", () => ({
  sealArtifactInputActor: (actor: unknown) => actor,
  assertArtifactInputWriteFence: vi.fn(async () => undefined),
  lockArtifactReadAuthorityRows: vi.fn(async () => undefined),
  prepareArtifactCommitPreflight: vi.fn(async () => ({})),
  withArtifactCommitPreflight: vi.fn(async (_actor, _workspaceId, _tx, _roots, _token, work, options) => {
    await options?.beforeSourceEpochs();
    return work();
  }),
  AGENT_REGISTRY: {
    "brain-absorb": { defaultModelTier: "fast" },
  },
  createArticle: createArticleMock,
  updateArticle: updateArticleMock,
  markSourceAbsorbed: markSourceAbsorbedMock,
  rebuildBacklinks: rebuildBacklinksMock,
  lockWorkspaceArchiveArtifact: lockWorkspaceArchiveArtifactMock,
  brainSourceRecoveryIdentity: recoveryIdentityMock,
  brainSourceContentFingerprint: vi.fn(() => "source-fingerprint"),
  captureArtifactInputProof: vi.fn(async (_actor, _workspaceId, inputs) => inputs.map((input: {kind: string; id: string}) => ({kind: input.kind, id: input.id, fingerprint: "a".repeat(64)}))),
  captureImmutableArtifactInputProof: vi.fn(async (_actor, _workspaceId, roots) => roots),
  isArtifactInputProofReadable: vi.fn(async () => true),
  isArtifactInputProofPubliclyShareable: vi.fn(async () => true),
  getBrainExportWorkerPurpose: vi.fn(() => null),
  assertBrainExportWorkerCurrent: vi.fn(async () => undefined),
  scanSourceReadableRecords: vi.fn(async ({load}) => (await load(undefined, 100)).filter((row: {isPrivate?: boolean}) => !row.isPrivate)),
  invariant: (condition: unknown, _status: number, code: string, message: string) => {if (!condition) throw Object.assign(new Error(message), {code});},
  resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]),
  readableArtifactIds: vi.fn(async (_actor, _workspaceId, _kind, records) => new Set(records.map((record: { id: string }) => record.id))),
  readableBrainSourceIds: vi.fn(async (_actor, _workspaceId, records) =>
    new Set(records.map((record: { id: string }) => record.id))),
}));

vi.mock("@corgtex/knowledge", () => ({
  syncBrainArticleKnowledge: syncBrainArticleKnowledgeMock,
}));

describe("absorbSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoveryIdentityMock.mockReturnValue("a".repeat(64));
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    lockWorkspaceArchiveArtifactMock.mockResolvedValue(undefined);
    prismaMock.brainSource.findUnique.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      sourceType: "DOC",
      tier: 1,
      title: "Launch notes",
      channel: "text-paste",
      content: "Launch content",
      ingestionGuidanceMd: "Prioritize launch blockers.",
      accessDomain: "WORKSPACE",
      absorbedAt: null,
      archivedAt: null,
    });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainBacklink.findMany.mockResolvedValue([]);
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        articleType: "PROJECT",
        updateSlugs: [],
        createNew: null,
        summary: "Launch context",
      },
    });
    modelGatewayMock.chat.mockResolvedValue({ content: "## Launch notes\n\nLaunch context." });
    createArticleMock.mockResolvedValue({ id: "article-created", slug: "launch-notes" });
    rebuildBacklinksMock.mockResolvedValue(undefined);
    markSourceAbsorbedMock.mockResolvedValue(undefined);
  });

  it("passes ingestion guidance into source analysis", async () => {
    const { absorbSource } = await import("./brain-absorb");

    await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(modelGatewayMock.extract).toHaveBeenCalledWith(expect.objectContaining({
      instruction: expect.stringContaining("Prioritize launch blockers."),
      input: expect.stringContaining("Prioritize launch blockers."),
    }));
  });

  it("rejects changed recovery input before inference", async () => {
    const { absorbSource } = await import("./brain-absorb");
    await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "run-1", expectedSourceIdentity: "b".repeat(64) })).rejects.toThrow("SOURCE_CHANGED");
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
  });

  it.each(["missing", "archived", "absorbed", "wrong_workspace"])("rejects %s recovery input before an initial skip can become success", async (state) => {
    const { absorbSource } = await import("./brain-absorb");
    prismaMock.brainSource.findUnique.mockResolvedValueOnce(state === "missing" ? null : {
      id: "source-1", workspaceId: state === "wrong_workspace" ? "other" : "workspace-1",
      absorbedAt: state === "absorbed" ? new Date() : null,
      archivedAt: state === "archived" ? new Date() : null,
    });
    recoveryIdentityMock.mockReturnValue("b".repeat(64));
    await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "run-1", expectedSourceIdentity: "a".repeat(64) })).rejects.toThrow("SOURCE_CHANGED");
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(modelGatewayMock.chat).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("preserves ordinary missing-source skips", async () => {
    const { absorbSource } = await import("./brain-absorb");
    prismaMock.brainSource.findUnique.mockResolvedValueOnce(null);
    await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "run-1" })).resolves.toEqual({ skipped: true, reason: "not_found" });
    expect(recoveryIdentityMock).not.toHaveBeenCalled();
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
  });

  it("rechecks recovery identity under the source row lock before any output write", async () => {
    const { absorbSource } = await import("./brain-absorb");
    recoveryIdentityMock.mockReturnValueOnce("a".repeat(64)).mockReturnValueOnce("a".repeat(64))
      .mockReturnValueOnce("a".repeat(64)).mockReturnValueOnce("a".repeat(64)).mockReturnValueOnce("b".repeat(64));
    await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "run-1", expectedSourceIdentity: "a".repeat(64) })).rejects.toThrow("SOURCE_CHANGED");
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("skips archived sources before sending content to the model", async () => {
    prismaMock.brainSource.findUnique.mockResolvedValueOnce({
      id: "source-1",
      workspaceId: "workspace-1",
      sourceType: "DOC",
      tier: 1,
      title: "Launch notes",
      channel: "text-paste",
      content: "Launch content",
      ingestionGuidanceMd: null,
      absorbedAt: null,
      archivedAt: new Date("2026-08-20T10:00:00.000Z"),
    });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual({ skipped: true, reason: "archived" });
    expect(modelGatewayMock.extract).not.toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("skips article writes when a source is archived after analysis", async () => {
    prismaMock.brainSource.findUnique
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        tier: 1,
        title: "Launch notes",
        channel: "text-paste",
        content: "Launch content",
        ingestionGuidanceMd: null,
        accessDomain: "WORKSPACE",
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        tier: 1,
        title: "Launch notes",
        channel: "text-paste",
        content: "Launch content",
        ingestionGuidanceMd: null,
        accessDomain: "WORKSPACE",
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        workspaceId: "workspace-1",
        absorbedAt: null,
        archivedAt: new Date("2026-08-20T10:00:00.000Z"),
      });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual({ skipped: true, reason: "archived", sourceId: "source-1" });
    expect(modelGatewayMock.extract).toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("skips article creation when a source is archived after drafting", async () => {
    prismaMock.brainSource.findUnique
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        tier: 1,
        title: "Launch notes",
        channel: "text-paste",
        content: "Launch content",
        ingestionGuidanceMd: null,
        accessDomain: "WORKSPACE",
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        tier: 1,
        title: "Launch notes",
        channel: "text-paste",
        content: "Launch content",
        ingestionGuidanceMd: null,
        accessDomain: "WORKSPACE",
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        channel: "text-paste",
        accessDomain: "WORKSPACE",
        absorbedAt: null,
        archivedAt: null,
      })
      .mockResolvedValueOnce({
        id: "source-1",
        workspaceId: "workspace-1",
        sourceType: "DOC",
        channel: "text-paste",
        accessDomain: "WORKSPACE",
        absorbedAt: null,
        archivedAt: new Date("2026-08-20T10:00:00.000Z"),
      });
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        articleType: "PROJECT",
        updateSlugs: [],
        createNew: { title: "Launch notes", slug: "launch-notes" },
        summary: "Launch context",
      },
    });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual({ skipped: true, reason: "archived", sourceId: "source-1" });
    expect(modelGatewayMock.chat).toHaveBeenCalled();
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("does not publish a draft synthesized from a replaced upload", async () => {
    const original = {
      id: "source-1", workspaceId: "workspace-1", sourceType: "FILE_UPLOAD", tier: 2,
      title: "Upload", content: "Old contract terms", accessDomain: "WORKSPACE", absorbedAt: null, archivedAt: null,
    };
    const replacement = { ...original, content: "New contract terms" };
    recoveryIdentityMock.mockImplementation((source: { content: string }) => source.content);
    prismaMock.brainSource.findUnique
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement);

    const { absorbSource } = await import("./brain-absorb");
    expect(await absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "run-1" }))
      .toEqual({ skipped: true, reason: "source_changed", sourceId: "source-1" });
    expect(lockWorkspaceArchiveArtifactMock).toHaveBeenCalledWith(prismaMock, "BrainSource", "source-1");
    expect(createArticleMock).not.toHaveBeenCalled();
    expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
  });

  it("creates a public reference recap when document sources match non-draft articles", async () => {
    prismaMock.brainArticle.findMany.mockResolvedValue([
      {
        id: "article-1",
        slug: "launch",
        title: "Launch",
        type: "PROJECT",
        authority: "REFERENCE",
        bodyMd: "Published launch notes",
        sourceIds: [],
        frontmatterJson: null,
      },
    ]);
    modelGatewayMock.extract.mockResolvedValue({
      output: {
        articleType: "PROJECT",
        updateSlugs: ["launch"],
        createNew: { title: "Launch", slug: "launch" },
        summary: "Launch context",
      },
    });

    const { absorbSource } = await import("./brain-absorb");
    const result = await absorbSource({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      agentRunId: "run-1",
    });

    expect(result).toEqual(expect.objectContaining({
      absorbed: true,
      skippedSlugs: ["launch"],
      createdSlug: "launch-notes",
      touchedArticleCount: 1,
    }));
    expect(updateArticleMock).not.toHaveBeenCalled();
    expect(createArticleMock).toHaveBeenCalledWith(expect.objectContaining({ label: "brain-absorb" }), expect.objectContaining({
      workspaceId: "workspace-1",
      slug: expect.stringMatching(/^launch-[a-f0-9]{16}$/),
      isPrivate: false,
      completeInputRoots: expect.arrayContaining([expect.objectContaining({kind: "BrainSource", id: "source-1"})]),
      title: "Launch notes",
      authority: "REFERENCE",
      sourceIds: ["source-1"],
      derivation: { sourceId: "source-1", sourceFingerprint: "source-fingerprint", agentRunId: "run-1" },
    }));
    expect(lockWorkspaceArchiveArtifactMock).toHaveBeenCalledTimes(2);
    expect(lockWorkspaceArchiveArtifactMock).toHaveBeenCalledWith(prismaMock, "BrainSource", "source-1");
    expect(lockWorkspaceArchiveArtifactMock.mock.invocationCallOrder[0]).toBeLessThan(createArticleMock.mock.invocationCallOrder[0]);
    expect(lockWorkspaceArchiveArtifactMock.mock.invocationCallOrder[0]).toBeLessThan(rebuildBacklinksMock.mock.invocationCallOrder[0]);
    expect(lockWorkspaceArchiveArtifactMock.mock.invocationCallOrder[0]).toBeLessThan(markSourceAbsorbedMock.mock.invocationCallOrder[0]);
    expect(markSourceAbsorbedMock.mock.invocationCallOrder[0]).toBeLessThan(syncBrainArticleKnowledgeMock.mock.invocationCallOrder[0]);
    expect(markSourceAbsorbedMock).toHaveBeenCalledWith(expect.objectContaining({ label: "brain-absorb" }), { sourceId: "source-1", tx: prismaMock });
  });
});


describe("absorption provider attempt controls", () => {
  const phases = ["analysis", "synthesis", "new", "fallback"] as const;
  type Phase = typeof phases[number];
  function prepare(phase: Phase) {
    prismaMock.brainArticle.findMany.mockResolvedValue(phase === "synthesis" ? [{ id: "article-1", slug: "existing", title: "Existing", type: "PROJECT", authority: "DRAFT", bodyMd: "Original body", sourceIds: [], isPrivate: false }] : []);
    return { output: { articleType: "PROJECT", createNew: phase === "synthesis" ? { title: "Existing", slug: "existing" } : phase === "new" ? { title: "New", slug: "new" } : null, summary: "Summary" } };
  }
  beforeEach(() => {
    vi.clearAllMocks();
    recoveryIdentityMock.mockReturnValue("a".repeat(64));
    prismaMock.$transaction.mockImplementation(async callback => callback(prismaMock));
    prismaMock.brainSource.findUnique.mockResolvedValue({ id: "source-1", workspaceId: "workspace-1", sourceType: "DOC", tier: 1, title: "Source", content: "Private captured source", accessDomain: "WORKSPACE", absorbedAt: null, archivedAt: null });
    prismaMock.brainArticle.findMany.mockResolvedValue([]);
    prismaMock.brainBacklink.findMany.mockResolvedValue([]);
    createArticleMock.mockResolvedValue({ id: "article-created", slug: "generated" });
    markSourceAbsorbedMock.mockResolvedValue(undefined);
    rebuildBacklinksMock.mockResolvedValue(undefined);
  });
  const cases = phases.flatMap(phase => (["credentials", "retry"] as const).flatMap(boundary => (["source", "worker"] as const).map(authority => ({ phase, boundary, authority }))));
  it.each(cases)("reauthorizes $phase/$boundary/$authority before sending", async ({ phase, boundary, authority }) => {
    const domain = await import("@corgtex/domain");
    let revoked = false, sends = 0;
    vi.mocked(domain.isArtifactInputProofReadable).mockImplementation(async () => authority !== "source" || !revoked);
    vi.mocked(domain.assertBrainExportWorkerCurrent).mockImplementation(async () => { if (authority === "worker" && revoked) throw new Error("Export worker revoked"); });
    const analysis = prepare(phase);
    const attempt = async (request: { signal?: AbortSignal; authorizeAttempt?: (context: { signal: AbortSignal }) => Promise<void> }) => {
      const context = { signal: new AbortController().signal };
      if (boundary === "credentials") revoked = true;
      await request.authorizeAttempt?.(context); sends++;
      if (boundary === "retry") { revoked = true; await request.authorizeAttempt?.(context); sends++; }
    };
    modelGatewayMock.extract.mockImplementation(async request => { if (phase === "analysis") await attempt(request); else await request.authorizeAttempt?.({ signal: new AbortController().signal }); return analysis; });
    modelGatewayMock.chat.mockImplementation(async request => { await attempt(request); return { content: "Generated" }; });
    const { absorbSource } = await import("./brain-absorb");
    try {
      await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "run-attempt" })).rejects.toThrow();
      expect(sends).toBe(boundary === "credentials" ? 0 : 1);
      expect(createArticleMock).not.toHaveBeenCalled();
      expect(markSourceAbsorbedMock).not.toHaveBeenCalled();
    } finally {
      vi.mocked(domain.isArtifactInputProofReadable).mockResolvedValue(true);
      vi.mocked(domain.assertBrainExportWorkerCurrent).mockResolvedValue(undefined);
    }
  });
  it.each(phases)("preserves authorized retries and original proofs at $0", async phase => {
    const domain = await import("@corgtex/domain");
    const analysis = prepare(phase);
    if (phase === "analysis") prismaMock.brainSource.findUnique.mockResolvedValue({ id: "source-1", workspaceId: "workspace-1", sourceType: "RESEARCH", tier: 2, title: "Source", content: "Source", accessDomain: "WORKSPACE", absorbedAt: null, archivedAt: null });
    let attempts = 0;
    const caller = vi.fn(async () => {});
    const attempt = async (request: { signal: AbortSignal; authorizeAttempt: (context: { signal: AbortSignal }) => Promise<void> }) => {
      expect(request.signal).toBeInstanceOf(AbortSignal);
      for (let i = 0; i < 2; i++) { await request.authorizeAttempt({ signal: new AbortController().signal }); attempts++; }
    };
    modelGatewayMock.extract.mockImplementation(async request => { if (phase === "analysis") await attempt(request); else await request.authorizeAttempt({ signal: new AbortController().signal }); return analysis; });
    modelGatewayMock.chat.mockImplementation(async request => { await attempt(request); return { content: "Generated body" }; });
    const { absorbSource } = await import("./brain-absorb");
    await absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "authorized-attempt", authorizeAttempt: caller });
    expect(attempts).toBe(2); expect(caller.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(domain.captureArtifactInputProof).toHaveBeenCalledOnce();
    expect(domain.captureImmutableArtifactInputProof).toHaveBeenCalledOnce();
  });
  it.each(["prior", "proof"] as const)("honors cancellation during $0 authorization", async boundary => {
    const domain = await import("@corgtex/domain");
    const controller = new AbortController(); let armed = false, sends = 0;
    const context = { signal: new AbortController().signal };
    const caller = vi.fn(async actual => { expect(actual).toBe(context); if (boundary === "prior") controller.abort(new Error("Caller stopped")); });
    vi.mocked(domain.isArtifactInputProofReadable).mockImplementation(async () => { if (armed && boundary === "proof") controller.abort(new Error("Caller stopped")); return true; });
    modelGatewayMock.extract.mockImplementation(async request => { armed = true; await request.authorizeAttempt(context); sends++; return prepare("analysis"); });
    const { absorbSource } = await import("./brain-absorb");
    try { await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "cancelled", signal: controller.signal, authorizeAttempt: caller })).rejects.toThrow("Caller stopped"); expect(sends).toBe(0); }
    finally { vi.mocked(domain.isArtifactInputProofReadable).mockResolvedValue(true); }
  });
  it("latches failed authority when an adapter swallows the guard error", async () => {
    const domain = await import("@corgtex/domain"); let revoked = false;
    vi.mocked(domain.isArtifactInputProofReadable).mockImplementation(async () => !revoked);
    modelGatewayMock.extract.mockImplementation(async request => { revoked = true; try { await request.authorizeAttempt({ signal: new AbortController().signal }); } catch {} expect(request.signal.aborted).toBe(true); return prepare("analysis"); });
    const { absorbSource } = await import("./brain-absorb");
    try { await expect(absorbSource({ workspaceId: "workspace-1", sourceId: "source-1", agentRunId: "swallowed" })).rejects.toMatchObject({ code: "SOURCE_CHANGED" }); expect(createArticleMock).not.toHaveBeenCalled(); }
    finally { vi.mocked(domain.isArtifactInputProofReadable).mockResolvedValue(true); }
  });
});
