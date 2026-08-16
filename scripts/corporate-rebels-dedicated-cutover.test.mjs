import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTRACT, loadManifest, parseCsv, runCorporateRebelsDedicatedCutover } from "./corporate-rebels-dedicated-cutover.mjs";

const SHA = "a".repeat(40);
const manifest = () => readFile(new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url));
const healthy = async () => ({ ok: true, json: async () => ({ status: "ok", database: "up", schema: "ready",
  release: { provider: "azure", gitSha: SHA, imageTag: `sha-${SHA}`, version: "main-a", drift: { gitSha: false, imageTag: false } } }) });
function fake(kind = "dedicated", options = {}) {
  const legacyId = kind === "ops" ? CONTRACT.opsLegacyWorkspaceId : CONTRACT.selfServeLegacyWorkspaceId;
  const state = { workspaces: kind === "dedicated" ? [{ id: "sentinel", name: "Other", slug: "other" }]
    : [{ id: legacyId, name: CONTRACT.name, slug: CONTRACT.slug }, { id: "sentinel", name: "Other", slug: "other" }],
  sources: [], articles: [], events: [], deleted: [], deployment: { id: CONTRACT.opsDeploymentId,
    customerAccountId: CONTRACT.opsAccountId, managedWorkspaceId: CONTRACT.opsLegacyWorkspaceId,
    customerSlug: CONTRACT.slug, label: CONTRACT.name, cloudProvider: "RAILWAY",
    railwayProjectId: "old-project", railwayWebServiceId: "old-web" },
  account: { id: CONTRACT.opsAccountId, slug: CONTRACT.slug, displayName: CONTRACT.name,
    primaryDeploymentId: CONTRACT.opsDeploymentId, status: "ONBOARDING" } };
  const countShape = () => ({ members: options.members ?? 0, memberInviteRequests: 0,
    brainSources: state.sources.length, brainArticles: state.articles.length, documents: 0, meetings: 0,
    externalMcpConnections: options.integration ? 1 : 0, externalDataSources: 0,
    externalResourceAttachments: 0, communicationInstallations: 0, appInstallations: 0 });
  const workspace = {
    findUnique: async ({ where }) => { const row = state.workspaces.find((item) => item.id === where.id);
      return row ? { ...row, _count: countShape() } : null; },
    findMany: async ({ where }) => state.workspaces.filter((item) => !where
      || item.slug === CONTRACT.slug || item.name === CONTRACT.name).map(({ id }) => ({ id })),
    create: async ({ data }) => { const row = { id: "11111111-1111-4111-8111-111111111111", ...data };
      state.workspaces.push(row); return row; },
    delete: async ({ where }) => { state.deleted.push(where.id);
      state.workspaces = state.workspaces.filter((item) => item.id !== where.id); },
  };
  const tx = { workspace, brainSource: { count: async () => options.attachments ?? 0,
    createMany: async ({ data }) => { state.sources.push(...data); } },
  meetingAudioAsset: { count: async () => 0 }, workspaceExternalResourceAttachment: { count: async () => 0 },
  buildArtifactAsset: { count: async () => 0 }, event: { count: async () => 0 },
  workflowJob: { count: async () => options.orphanable ?? 0 }, meetingRecorderProviderEvent: { count: async () => 0 },
  communicationInboundEvent: { count: async () => 0 }, approvalPolicy: { create: async () => {} },
  brainArticle: { create: async ({ data }) => { state.articles.push(data); } }, auditLog: { create: async () => {} },
  customerDeployment: { findUnique: async () => state.deployment, update: async ({ data }) => Object.assign(state.deployment, data) },
  customerAccount: { findUnique: async () => state.account, update: async ({ data }) => Object.assign(state.account, data) },
  customerDeploymentEvent: { create: async ({ data }) => { state.events.push(data); } } };
  const prisma = { ...tx, $transaction: async (callback) => { if (options.drift) {
    state.workspaces.find((item) => item.id === legacyId).slug = "drift"; } return callback(tx); } };
  return { prisma, state };
}
async function seedReceipt() {
  return runCorporateRebelsDedicatedCutover({ prisma: fake().prisma, phase: "seed-dedicated", execute: true,
    confirmation: CONTRACT.confirmation, releaseGitSha: SHA, readManifest: manifest });
}

describe("Corporate Rebels dedicated cutover", () => {
  it("pins the 25-row manifest and parses quoted commas", async () => {
    expect(await loadManifest()).toHaveLength(25);
    expect(parseCsv('a,b\n"one, two",three\n')).toEqual([{ a: "one, two", b: "three" }]);
    await expect(loadManifest(async () => Buffer.from("drift"))).rejects.toThrow("digest mismatch");
  });
  it("keeps preflight read-only and requires exact execution confirmation", async () => {
    const target = fake();
    await expect(runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "seed-dedicated",
      releaseGitSha: SHA, readManifest: manifest })).resolves.toMatchObject({ mode: "preflight" });
    await expect(runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "seed-dedicated",
      execute: true, confirmation: "wrong", releaseGitSha: SHA, readManifest: manifest })).rejects.toThrow("confirmation");
    expect(target.state.workspaces).toHaveLength(1);
  });
  it("creates one private dedicated workspace with no users or publication", async () => {
    const target = fake();
    const receipt = await runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "seed-dedicated",
      execute: true, confirmation: CONTRACT.confirmation, releaseGitSha: SHA, readManifest: manifest });
    expect(receipt.workspace._count).toMatchObject({ members: 0, memberInviteRequests: 0,
      brainSources: 25, brainArticles: 1 });
    expect(target.state.sources).toHaveLength(25);
    expect(target.state.articles[0]).toMatchObject({ authority: "DRAFT", isPrivate: true, publishedAt: null });
  });
  it("moves only the exact Ops deployment to the dedicated Azure target", async () => {
    const seed = await seedReceipt(); const target = fake("ops", { members: 6 });
    const receipt = await runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "cutover-ops",
      execute: true, confirmation: CONTRACT.confirmation, workspaceId: seed.workspace.id,
      evidence: seed.evidence, releaseGitSha: SHA, readManifest: manifest, fetchFn: healthy });
    expect(target.state.deployment).toMatchObject({ deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE",
      remoteWorkspaceId: seed.workspace.id, managedWorkspaceId: null, url: CONTRACT.url,
      providerResourceGroup: CONTRACT.resourceGroup, lastHealthStatus: "ok", lastHealthError: null,
      railwayProjectId: null, railwayWebServiceId: null });
    expect(target.state.deleted).toEqual([CONTRACT.opsLegacyWorkspaceId]);
    expect(receipt.evidence).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects malformed seed evidence and unhealthy or drifting releases", async () => {
    const seed = await seedReceipt(); const target = fake("ops");
    await expect(runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "cutover-ops",
      workspaceId: seed.workspace.id, evidence: "bad", releaseGitSha: SHA,
      readManifest: manifest, fetchFn: healthy })).rejects.toThrow("seed evidence");
    await expect(runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "cutover-ops",
      workspaceId: seed.workspace.id, evidence: seed.evidence, releaseGitSha: SHA,
      readManifest: manifest, fetchFn: async () => ({ ok: true, json: async () => ({ status: "down" }) })
    })).rejects.toThrow("health proof");
  });
  it("deletes Self-Serve only after exact Ops evidence and preserves siblings", async () => {
    const seed = await seedReceipt(); const ops = fake("ops");
    const cutover = await runCorporateRebelsDedicatedCutover({ prisma: ops.prisma, phase: "cutover-ops",
      execute: true, confirmation: CONTRACT.confirmation, workspaceId: seed.workspace.id,
      evidence: seed.evidence, releaseGitSha: SHA, readManifest: manifest, fetchFn: healthy });
    const target = fake("selfserve", { members: 8 });
    await runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "delete-selfserve", execute: true,
      confirmation: CONTRACT.confirmation, workspaceId: seed.workspace.id, evidence: cutover.evidence,
      releaseGitSha: SHA, readManifest: manifest });
    expect(target.state.deleted).toEqual([CONTRACT.selfServeLegacyWorkspaceId]);
    expect(target.state.workspaces).toEqual([{ id: "sentinel", name: "Other", slug: "other" }]);
  });
  it("fails closed on target drift, attachments, integrations, or orphanable payloads", async () => {
    const seed = await seedReceipt(); const ops = fake("ops");
    const cutover = await runCorporateRebelsDedicatedCutover({ prisma: ops.prisma, phase: "cutover-ops",
      execute: true, confirmation: CONTRACT.confirmation, workspaceId: seed.workspace.id,
      evidence: seed.evidence, releaseGitSha: SHA, readManifest: manifest, fetchFn: healthy });
    for (const options of [{ drift: true }, { attachments: 1 }, { integration: true }, { orphanable: 1 }]) {
      const target = fake("selfserve", options);
      await expect(runCorporateRebelsDedicatedCutover({ prisma: target.prisma, phase: "delete-selfserve",
        execute: true, confirmation: CONTRACT.confirmation, workspaceId: seed.workspace.id,
        evidence: cutover.evidence, releaseGitSha: SHA, readManifest: manifest })).rejects.toThrow();
      expect(target.state.deleted).toEqual([]);
    }
  });
});
