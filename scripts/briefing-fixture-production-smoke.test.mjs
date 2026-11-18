import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertBriefingFixturePayload,
  assertBriefingFixtureCandidateCoverage,
  assertDashboardBriefingHtml,
  BriefingFixtureSmoke,
  briefingFixtureHealthReleaseBlocker,
  briefingFixtureTimestamps,
  cleanupFailureMessage,
  filterBriefingFixtureCandidates,
  isSmokeOwnedBriefing,
  isSmokeOwnedBriefingSnapshot,
  normalizeBaseUrl,
  parseSetCookie,
  smokeOwnedBriefingWhere,
} from "./briefing-fixture-production-smoke.mjs";

function fixture() {
  return {
    title: "Daily Workspace Briefing - 2026-04-30",
    dateKey: "2026-04-30",
    action: { id: "action-1", title: "PROD-VERIFY action" },
    proposal: { id: "proposal-1", title: "PROD-VERIFY proposal" },
    article: { id: "article-1", title: "PROD-VERIFY knowledge" },
  };
}

function briefingPayload() {
  const data = fixture();
  return {
    title: data.title,
    period: "DAILY",
    dateKey: data.dateKey,
    editorialMode: "daily_homepage",
    leadMd: `**${data.action.title}**: Critical blocker decision needs an owner today.`,
    bodyMd: `**${data.article.title}**: Knowledge fixture proves source labels.`,
    attentionMd: `Needs attention today: ${data.proposal.title}: Strategic stale proposal remains open.`,
    continuingContextMd: null,
    sourceCounts: {
      ACTION: 1,
      PROPOSAL: 1,
      BRAIN_ARTICLE: 1,
    },
    items: [
      {
        kind: "ACTION",
        title: data.action.title,
        sourceRefs: [{ type: "ACTION", id: data.action.id, label: data.action.title }],
      },
      {
        kind: "BRAIN_ARTICLE",
        title: data.article.title,
        sourceRefs: [{ type: "BRAIN_ARTICLE", id: data.article.id, label: data.article.title }],
      },
      {
        kind: "PROPOSAL",
        title: data.proposal.title,
        sourceRefs: [{ type: "PROPOSAL", id: data.proposal.id, label: data.proposal.title }],
      },
    ],
    sourceRefs: [
      { type: "ACTION", id: data.action.id, label: data.action.title },
      { type: "BRAIN_ARTICLE", id: data.article.id, label: data.article.title },
      { type: "PROPOSAL", id: data.proposal.id, label: data.proposal.title },
    ],
  };
}

describe("briefing fixture production smoke helpers", () => {
  it("normalizes base URLs and session cookies", () => {
    expect(normalizeBaseUrl("https://app.corgtex.com/")).toBe("https://app.corgtex.com");
    expect(parseSetCookie("corgtex-session=abc123; Path=/; HttpOnly")).toBe("corgtex-session=abc123");
  });

  it("pins deterministic fresh, stale, and overdue timestamps around the generated briefing time", () => {
    const timestamps = briefingFixtureTimestamps(new Date("2026-04-30T12:00:00.000Z"));

    expect(timestamps.generatedAt.toISOString()).toBe("2026-04-30T12:00:00.000Z");
    expect(timestamps.freshAt.toISOString()).toBe("2026-04-30T11:59:59.000Z");
    expect(timestamps.staleAt.toISOString()).toBe("2026-03-16T12:00:00.000Z");
    expect(timestamps.overdueAt.toISOString()).toBe("2025-04-30T12:00:00.000Z");
  });

  it("blocks before fixture writes when release metadata drifts", () => {
    expect(briefingFixtureHealthReleaseBlocker({
      release: {
        gitSha: "older-sha",
      },
    }, "current-sha")).toContain("release.gitSha older-sha");

    expect(briefingFixtureHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "older-sha" },
        drift: {
          gitSha: true,
          imageTag: false,
          version: false,
          details: ["configured.gitSha=older-sha does not match runtime.gitSha=current-sha"],
        },
      },
    }, "current-sha")).toContain("configured.gitSha=older-sha");
  });

  it("accepts aligned release metadata", () => {
    expect(briefingFixtureHealthReleaseBlocker({
      release: {
        gitSha: "current-sha",
        configured: { gitSha: "current-sha" },
        drift: {
          gitSha: false,
          imageTag: false,
          version: false,
          details: [],
        },
      },
    }, "current-sha")).toBeNull();
  });

  it("only lets cleanup restore or delete the smoke-owned briefing row", () => {
    const expected = {
      id: "briefing-1",
      title: "Daily Workspace Briefing - 2026-04-30",
      modelUsed: "production-validation-fixture",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
    };

    expect(isSmokeOwnedBriefing({
      ...expected,
      generatedAt: "2026-04-30T12:00:00.000Z",
    }, expected)).toBe(true);
    expect(isSmokeOwnedBriefing({
      ...expected,
      modelUsed: "gpt-5",
    }, expected)).toBe(false);
    expect(isSmokeOwnedBriefing({
      ...expected,
      generatedAt: "2026-04-30T12:05:00.000Z",
    }, expected)).toBe(false);

    expect(smokeOwnedBriefingWhere(expected)).toEqual({
      id: "briefing-1",
      title: "Daily Workspace Briefing - 2026-04-30",
      modelUsed: "production-validation-fixture",
      generatedAt: new Date("2026-04-30T12:00:00.000Z"),
    });
    expect(isSmokeOwnedBriefingSnapshot(expected)).toBe(true);
    expect(isSmokeOwnedBriefingSnapshot({ ...expected, modelUsed: "gpt-5" })).toBe(false);
  });

  it("isolates canonical briefing candidates to the fixture records", () => {
    const data = fixture();
    const candidates = [
      { sourceType: "ACTION", sourceId: data.action.id },
      { sourceType: "PROPOSAL", sourceId: data.proposal.id },
      { sourceType: "BRAIN_ARTICLE", sourceId: data.article.id },
      { sourceType: "ACTION", sourceId: "organic-action" },
    ];

    const filtered = filterBriefingFixtureCandidates(candidates, data);
    expect(filtered).toEqual(candidates.slice(0, 3));
    expect(assertBriefingFixtureCandidateCoverage(filtered, data)).toEqual({
      candidateCount: 3,
      candidateTypes: ["ACTION", "PROPOSAL", "BRAIN_ARTICLE"],
    });
    expect(() => assertBriefingFixtureCandidateCoverage(filtered.slice(0, 2), data)).toThrow("Canonical briefing collector did not include fixture BRAIN_ARTICLE");
  });

  it("creates new fixture rows and native lineage atomically without product events", async () => {
    const actionCreate = vi.fn().mockResolvedValue({ id: "action-1" });
    const proposalCreate = vi.fn().mockResolvedValue({ id: "proposal-1" });
    const articleCreate = vi.fn().mockResolvedValueOnce({ id: "article-1", slug: "briefing-fixture-run" })
      .mockResolvedValueOnce({ id: "anchor-1", title: "Private inputs", slug: "briefing-fixture-inputs-run" });
    const recordArtifactInputLineage = vi.fn();
    const tx = { action: { create: actionCreate }, proposal: { create: proposalCreate }, brainArticle: { create: articleCreate } };
    const smoke = new BriefingFixtureSmoke({
      loadDomain: async () => ({ recordArtifactInputLineage }),
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-briefing-fixture-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "Admin@Example.com",
      authPassword: "password",
      prNumbers: [724],
      prisma: {
        user: {
          findFirst: vi.fn().mockResolvedValue({ id: "user-1", email: "admin@example.com" }),
        },
        member: {
          findUnique: vi.fn().mockResolvedValue({ id: "member-1", isActive: true }),
        },
        $transaction: vi.fn((run) => run(tx)),
      },
      generatedAt: "2026-04-30T12:00:00.000Z",
    });
    smoke.workspace = { id: "ws-1", slug: "corgtex-validation" };
    smoke.actor = { kind: "user", user: { id: "user-1" } };
    smoke.sessionFetch = vi.fn(async () => {
      throw new Error("product write API should not be used during fixture creation");
    });

    await smoke.createFixtureRecords();

    expect(smoke.sessionFetch).not.toHaveBeenCalled();
    expect(recordArtifactInputLineage.mock.calls.map(([p]) => ({ tx: p.tx, actor: p.actor,
      workspaceId: p.workspaceId, kind: p.artifact.kind, id: p.artifact.id, origin: p.origin, inputs: p.inputs })))
      .toEqual([{ tx, actor: smoke.actor, workspaceId: "ws-1", kind: "BrainArticle", id: "anchor-1",
        origin: "HUMAN_ORIGINAL", inputs: [] }, ...["Action", "Proposal", "BrainArticle"].map((kind, i) => ({ tx, actor: smoke.actor,
        workspaceId: "ws-1", kind, id: ["action-1", "proposal-1", "article-1"][i], origin: "DERIVED",
        inputs: [{ kind: "BrainArticle", id: "anchor-1" }] }))]);
    const anchor = articleCreate.mock.calls[1][0].data;
    expect(anchor).toMatchObject({ isPrivate: true, ownerMemberId: "member-1" });
    expect(JSON.parse(anchor.bodyMd)).toEqual({ action: { id: "action-1" }, proposal: { id: "proposal-1" },
      article: { id: "article-1", slug: "briefing-fixture-run" } });
    expect(smoke.cleanupRegistry.entries().map(x => x.id)).toEqual([
      "archive:BrainArticle:anchor-1", "archive:Action:action-1", "archive:Proposal:proposal-1", "archive:BrainArticle:article-1"]);
    expect(actionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        authorUserId: "user-1",
        status: "OPEN",
        priority: 1_000_000,
        dueAt: new Date("2025-04-30T12:00:00.000Z"),
        updatedAt: new Date("2026-04-30T11:59:59.000Z"),
      }),
    });
    expect(proposalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        authorUserId: "user-1",
        ownerMemberId: null,
        status: "OPEN",
        priority: 1_000_000,
        updatedAt: new Date("2026-03-16T12:00:00.000Z"),
      }),
    });
    expect(articleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        slug: expect.stringMatching(/^briefing-fixture-/),
        authority: "REFERENCE",
        isPrivate: false,
        updatedAt: new Date("2026-04-30T11:59:59.000Z"),
      }),
    });
  });
});

describe("briefing fixture native provenance", () => {
  const actor = { kind: "user", user: { id: "user-1" } };
  function smokeFor(prisma, domain = {}) {
    const smoke = new BriefingFixtureSmoke({ baseUrl: "https://fixture.invalid", prisma,
      loadDomain: async () => domain, authEmail: "validation@example.test", authPassword: "synthetic",
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true }, prNumbers: [],
      generatedAt: "2026-11-18T12:00:00Z" });
    smoke.workspace = { id: "ws-1", slug: "corgtex-validation" };
    smoke.actor = actor;
    return smoke;
  }
  it.each([null, { kind: "agent" }, { kind: "user", user: { id: "foreign-user" } }])(
    "rejects a missing or mismatched authenticated original author", async (sessionActor) => {
      const prisma = { user: { findFirst: vi.fn().mockResolvedValue({ id: "user-1" }) }, $transaction: vi.fn() };
      const smoke = smokeFor(prisma); smoke.actor = sessionActor;
      await expect(smoke.createFixtureRecords()).rejects.toThrow("session user does not match");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  it("leaves no registered partial fixture when the atomic native receipt fails", async () => {
    const tx = Object.fromEntries(["action", "proposal", "brainArticle"].map((model) =>
      [model, { create: vi.fn().mockResolvedValue({ id: model, slug: "fixture" }) }]));
    const prisma = { user: { findFirst: vi.fn().mockResolvedValue({ id: "user-1" }) },
      member: { findUnique: vi.fn().mockResolvedValue({ id: "member-1", isActive: true }) },
      $transaction: vi.fn((run) => run(tx)) };
    const smoke = smokeFor(prisma, { recordArtifactInputLineage: vi.fn().mockRejectedValue(new Error("SOURCE_CHANGED")) });
    await expect(smoke.createFixtureRecords()).rejects.toThrow("SOURCE_CHANGED");
    expect(smoke.cleanupRegistry.entries()).toEqual([]);
    expect(smoke.created).toEqual({ inputAnchor: null, action: null, proposal: null, article: null, briefing: null });
  });
  it("binds a prior briefing proof to the exact saved body and rejects a concurrent body change", async () => {
    const previous = { id: "briefing-1", title: "Saved earlier body", modelUsed: "normal-producer" };
    const capture = vi.fn(async (_actor, _workspace, input) => {
      expect(input.fingerprint).toBe("saved-body-fingerprint");
      throw new Error("SOURCE_CHANGED");
    });
    const tx = { workspaceBriefing: { findUnique: vi.fn().mockResolvedValue(previous) },
      artifactInputLineage: { findFirst: vi.fn().mockResolvedValue({ origin: "DERIVED" }) } };
    const fingerprint = vi.fn().mockReturnValue("saved-body-fingerprint");
    const smoke = smokeFor({ $transaction: (run) => run(tx) }, {
      captureArtifactInputSnapshotProof: capture, lineageContentFingerprint: fingerprint,
    });
    await expect(smoke.snapshotExistingBriefing()).rejects.toThrow("SOURCE_CHANGED");
    expect(fingerprint).toHaveBeenCalledExactlyOnceWith("WorkspaceBriefing", previous);
    expect(capture).toHaveBeenCalledExactlyOnceWith(actor, "ws-1", {
      kind: "WorkspaceBriefing", id: "briefing-1", fingerprint: "saved-body-fingerprint",
    }, tx);
    expect(smoke.cleanupRegistry.entries()).toEqual([]);
  });
  it.each(["row", "manifest", "new row"])("rejects a producer %s change atomically before fixture replacement", async (change) => {
    const previous = change === "new row" ? null : { id: "old", title: "Saved body" };
    const manifest = previous ? { id: "old-head", revision: 1 } : null;
    const tx = { $queryRaw: vi.fn(), workspaceBriefing: {
      findUnique: vi.fn().mockResolvedValue(change === "manifest" ? previous : { id: "old", title: "New producer" }),
      update: vi.fn(), create: vi.fn(),
    }, artifactInputLineage: { findFirst: vi.fn().mockResolvedValue(change === "manifest" ? { ...manifest, revision: 2 } : manifest) } };
    const record = vi.fn(); const prisma = { $transaction: vi.fn(run => run(tx)) };
    const smoke = smokeFor(prisma, { renderWorkspaceBriefingMarkdown: () => "Body", recordArtifactInputLineage: record });
    smoke.previousBriefing = previous; smoke.previousBriefingManifest = manifest;
    await expect(smoke.publishFixtureBriefing({ workspaceId: "ws-1", period: "DAILY", dateKey: "2026-11-18",
      briefing: { sourceRefs: [], items: [], sourceCounts: {}, generatedAt: "2026-11-18T12:00:00Z" }, lineageRoots: [] }))
      .rejects.toThrow("no fixture replacement was written");
    expect(tx.workspaceBriefing.update).not.toHaveBeenCalled(); expect(tx.workspaceBriefing.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled(); expect(smoke.cleanupRegistry.entries()).toEqual([]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });
  function restoreFixture({ proof = [{ kind: "ArtifactInputSnapshot", id: "original-proof" }], changedHead = false,
    changedRow = false, invalidProof = false } = {}) {
    const manifest = { id: "fixture-head", revision: 2, origin: "DERIVED" };
    const previous = { id: "briefing-1", title: "Prior briefing", modelUsed: "prior", generatedAt: new Date("2026-11-18T10:00:00Z") };
    const current = { ...previous, title: "Fixture", modelUsed: "production-validation-fixture", generatedAt: new Date("2026-11-18T12:00:00Z") };
    const tx = { $queryRaw: vi.fn(), artifactInputLineage: { findFirst: vi.fn().mockResolvedValue(changedHead ? { ...manifest, id: "other-head" } : manifest) },
      workspaceBriefing: { updateMany: vi.fn().mockResolvedValue({ count: changedRow ? 0 : 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(previous) } };
    const domain = { recordArtifactInputLineage: vi.fn(async () => { if (invalidProof) throw new Error("SOURCE_CHANGED"); }),
      invalidateArtifactInputLineage: vi.fn() };
    const prisma = { $transaction: vi.fn((run) => run(tx)) };
    const smoke = smokeFor(prisma, domain);
    smoke.previousBriefing = previous; smoke.previousBriefingProof = proof; smoke.fixtureBriefingManifest = manifest;
    smoke.registerBriefingCleanup(current);
    return { smoke, tx, domain, prisma, previous };
  }
  it("restores the prior body and genuine immutable ancestry in the same owned transaction", async () => {
    const f = restoreFixture(); const result = await f.smoke.cleanupRegistry.runAll();
    expect(result.failed).toEqual([]);
    expect(f.domain.recordArtifactInputLineage).toHaveBeenCalledExactlyOnceWith({ tx: f.tx, actor,
      workspaceId: "ws-1", artifact: { kind: "WorkspaceBriefing", id: "briefing-1" }, content: f.previous,
      origin: "DERIVED", inputs: [], inheritedRoots: f.smoke.previousBriefingProof });
    expect(f.domain.invalidateArtifactInputLineage).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });
  it("keeps a prior unproven body UNKNOWN rather than assigning fabricated ancestry", async () => {
    const f = restoreFixture({ proof: null }); const result = await f.smoke.cleanupRegistry.runAll();
    expect(result.failed).toEqual([]);
    expect(f.domain.recordArtifactInputLineage).not.toHaveBeenCalled();
    expect(f.domain.invalidateArtifactInputLineage).toHaveBeenCalledExactlyOnceWith({ tx: f.tx, workspaceId: "ws-1",
      artifact: { kind: "WorkspaceBriefing", id: "briefing-1" }, content: f.previous });
  });
  it.each([{ changedHead: true }, { changedRow: true }])("preserves a competing producer's row or proof", async (options) => {
    const f = restoreFixture(options); const result = await f.smoke.cleanupRegistry.runAll();
    expect(result.failed).toEqual([]);
    expect(f.domain.recordArtifactInputLineage).not.toHaveBeenCalled();
    expect(f.domain.invalidateArtifactInputLineage).not.toHaveBeenCalled();
    if (options.changedHead) expect(f.tx.workspaceBriefing.updateMany).not.toHaveBeenCalled();
  });
  it.each(["read failure", "unexpected revision"])(
    "registers committed briefing cleanup before a post-upsert %s", async (failure) => {
      const data = fixture();
      const stored = { id: "briefing-1", title: "Fixture", modelUsed: "production-validation-fixture",
        generatedAt: new Date("2026-11-18T12:00:00Z"), briefingJson: { dateKey: "2026-11-18" } };
      const manifest = { id: "head-1", revision: failure === "unexpected revision" ? 2 : 1,
        origin: "DERIVED", contentHash: "expected-content" };
      const read = vi.fn().mockResolvedValue(manifest);
      if (failure === "read failure") read.mockRejectedValueOnce(new Error("DATABASE_READ_FAILED"));
      const tx = { $queryRaw: vi.fn(), artifactInputLineage: { findFirst: read },
        workspaceBriefing: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) } };
      const domain = { workspaceBriefingContextSince: () => new Date(0),
        collectWorkspaceBriefingCandidates: vi.fn().mockResolvedValue([
          { sourceType: "ACTION", sourceId: data.action.id, lineageRoots: [{ kind: "Action", id: data.action.id }] },
          { sourceType: "PROPOSAL", sourceId: data.proposal.id, lineageRoots: [{ kind: "Proposal", id: data.proposal.id }] },
          { sourceType: "BRAIN_ARTICLE", sourceId: data.article.id, lineageRoots: [{ kind: "BrainArticle", id: data.article.id }] },
        ]), buildWorkspaceBriefingFromCandidates: () => ({}), captureArtifactInputProof: vi.fn().mockResolvedValue([{ kind: "Workspace", id: "ws-1" }]),
        mergeArtifactInputProofs: (...roots) => roots.flat(),
        normalizeWorkspaceBriefingPayload: (value) => value, lineageContentFingerprint: () => "expected-content" };
      const smoke = smokeFor({ artifactInputLineage: tx.artifactInputLineage, $transaction: (run) => run(tx) }, domain);
      smoke.fixture = data;
      smoke.publishFixtureBriefing = vi.fn().mockResolvedValue(stored);
      await expect(smoke.generateBriefing()).rejects.toThrow(failure === "read failure" ? "DATABASE_READ_FAILED" : "input proof changed");
      expect(smoke.created.briefing.id).toBe(stored.id);
      expect(smoke.cleanupRegistry.entries()).toHaveLength(1);
      expect(smoke.publishFixtureBriefing).toHaveBeenCalledWith(expect.objectContaining({ actor,
        lineageRoots: [{ kind: "Workspace", id: "ws-1" }, { kind: "Action", id: data.action.id },
          { kind: "Proposal", id: data.proposal.id }, { kind: "BrainArticle", id: data.article.id }] }));
      const result = await smoke.cleanupRegistry.runAll();
      if (failure === "read failure") {
        expect(result.failed).toEqual([]);
        expect(tx.workspaceBriefing.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: stored.id, workspaceId: "ws-1" }) });
      } else {
        expect(result.failed).toHaveLength(1);
        expect(tx.workspaceBriefing.deleteMany).not.toHaveBeenCalled();
      }
    });
  it("does not downgrade a previously proven but now invalid ancestor to UNKNOWN", async () => {
    const f = restoreFixture({ invalidProof: true }); const result = await f.smoke.cleanupRegistry.runAll();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error.message).toBe("SOURCE_CHANGED");
    expect(f.domain.invalidateArtifactInputLineage).not.toHaveBeenCalled();
  });
});

describe("briefing fixture production smoke assertions", () => {
  it("requires fresh action lead, stale proposal context, source labels, and homepage mode", () => {
    const summary = assertBriefingFixturePayload(briefingPayload(), fixture());

    expect(summary.actionItem.title).toBe("PROD-VERIFY action");
    expect(summary.proposalItem.title).toBe("PROD-VERIFY proposal");
    expect(summary.articleItem.title).toBe("PROD-VERIFY knowledge");
  });

  it("fails when stale proposals are promoted into fresh body copy", () => {
    const payload = briefingPayload();
    payload.bodyMd = `${payload.bodyMd}\n\n${fixture().proposal.title}`;

    expect(() => assertBriefingFixturePayload(payload, fixture())).toThrow("Stale proposal was presented as fresh body content.");
  });

  it("asserts dashboard HTML displays the generated briefing and fixture items", () => {
    const data = fixture();

    expect(assertDashboardBriefingHtml(`
      <main>
        <h2>${data.title}</h2>
        <p>${data.action.title}</p>
        <p>${data.proposal.title}</p>
      </main>
    `, data)).toBe(true);
  });
});

describe("briefing fixture production smoke validation matrix", () => {
  it("records one validation result per covered PR number", () => {
    const smoke = new BriefingFixtureSmoke({
      baseUrl: "https://app.corgtex.com",
      outDir: ".artifacts/test-briefing-fixture-production-smoke",
      expectedGitSha: null,
      workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
      authEmail: "admin@example.com",
      authPassword: "password",
      prNumbers: [723, 724],
      prisma: {},
      generatedAt: "2026-04-30T12:00:00.000Z",
    });
    smoke.created = {
      action: { id: "action-1", cleanupActionId: "archive:Action:action-1" },
      proposal: { id: "proposal-1", cleanupActionId: "archive:Proposal:proposal-1" },
      article: { id: "article-1", cleanupActionId: "archive:BrainArticle:article-1" },
      briefing: { id: "briefing-1", cleanupActionId: "delete:WorkspaceBriefing:briefing-1" },
    };

    smoke.recordValidationPass();

    expect(smoke.validationRun.results).toHaveLength(2);
    expect(smoke.validationRun.results.map((result) => result.prNumber)).toEqual([723, 724]);
    expect(smoke.validationRun.results[0]).toMatchObject({
      result: "pass",
      createdRecordIds: ["action-1", "proposal-1", "article-1", "briefing-1"],
    });
  });

  it("describes cleanup failures so the smoke cannot pass with dirty fixture records", () => {
    expect(cleanupFailureMessage({
      failed: [
        { entry: { id: "restore:WorkspaceBriefing:briefing-1" } },
        { entry: { id: "archive:Action:action-1" } },
      ],
    })).toBe("Validation cleanup failed for restore:WorkspaceBriefing:briefing-1, archive:Action:action-1");
  });

  it("checks existing briefing ownership before creating fixture records", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "corgtex-briefing-fixture-"));
    try {
      const calls = [];
      const smoke = new BriefingFixtureSmoke({
        baseUrl: "https://app.corgtex.com",
        outDir,
        expectedGitSha: null,
        workspaceSelector: { workspaceSlug: "corgtex-validation", explicit: true },
        authEmail: "admin@example.com",
        authPassword: "password",
        prNumbers: [724],
        prisma: { $disconnect: vi.fn() },
        generatedAt: "2026-04-30T12:00:00.000Z",
      });
      smoke.verifyHealth = vi.fn(async () => calls.push("health"));
      smoke.login = vi.fn(async () => calls.push("login"));
      smoke.snapshotExistingBriefing = vi.fn(async () => {
        calls.push("snapshot");
        throw new Error("Existing 2026-04-30 workspace briefing is owned by another production validation run.");
      });
      smoke.createFixtureRecords = vi.fn(async () => calls.push("create-fixture"));

      await expect(smoke.run()).rejects.toThrow("owned by another production validation run");

      expect(calls).toEqual(["health", "login", "snapshot"]);
      expect(smoke.createFixtureRecords).not.toHaveBeenCalled();
      expect(smoke.validationRun.results[0]).toMatchObject({
        result: "partial",
        blocker: "Existing 2026-04-30 workspace briefing is owned by another production validation run.",
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
