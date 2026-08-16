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
  document: { count: async () => options.documents ?? 0 }, meetingAudioAsset: { count: async () => 0 },
  workspaceExternalResourceAttachment: { count: async () => 0 },
  buildArtifactAsset: { count: async () => 0 }, event: { count: async () => 0 },
  workflowJob: { count: async () => options.orphanable ?? 0 }, meetingRecorderProviderEvent: { count: async () => 0 },
  communicationInboundEvent: { count: async () => 0 }, workspaceIntegrationBinding: { count: async () => options.binding ?? 0 },
  oAuthConnection: { count: async () => options.oauth ?? 0 }, oAuthApp: { count: async () => 0 },
  oAuthAuthorizationCode: { count: async () => 0 }, oAuthAccessToken: { count: async () => 0 },
  mcpOAuthAuthorizationCode: { count: async () => 0 }, mcpOAuthAccessToken: { count: async () => 0 },
  approvalPolicy: { create: async () => {} },
  brainArticle: { create: async ({ data }) => { state.articles.push(data); } }, auditLog: { create: async () => {} },
  customerDeployment: { findUnique: async () => state.deployment, update: async ({ data }) => Object.assign(state.deployment, data) },
  customerAccount: { findUnique: async () => state.account, update: async ({ data }) => Object.assign(state.account, data) },
  customerDeploymentEvent: { create: async ({ data }) => { state.events.push(data); } } };
  const prisma = { ...tx, $transaction: async (callback) => { if (options.drift) {
    state.workspaces.find((item) => item.id === legacyId).slug = "drift"; } return callback(tx); } };
  return { prisma, state };
}
const dedicatedUrl = `postgresql://user:pass@${CONTRACT.postgresServiceId}.postgres.database.azure.com/corgtex`;
const execute = (dedicated, ops, selfserve, extra = {}) => runCorporateRebelsDedicatedCutover({
  phase: "execute-cutover", execute: true, confirmation: CONTRACT.confirmation, releaseGitSha: SHA,
  readManifest: manifest, fetchFn: healthy, dedicatedDatabaseUrl: dedicatedUrl,
  dedicatedPrisma: dedicated.prisma, opsPrisma: ops.prisma, selfServePrisma: selfserve.prisma, ...extra });

describe("Corporate Rebels dedicated cutover", () => {
  it("pins the 25-row manifest and parses quoted commas", async () => {
    expect(await loadManifest()).toHaveLength(25);
    expect(parseCsv('a,b\n"one, two",three\n')).toEqual([{ a: "one, two", b: "three" }]);
    await expect(loadManifest(async () => Buffer.from("drift"))).rejects.toThrow("digest mismatch");
  });
  it("keeps preflight read-only and requires exact execution confirmation", async () => {
    const dedicated = fake(); const ops = fake("ops"); const selfserve = fake("selfserve");
    const params = { phase: "execute-cutover", releaseGitSha: SHA, readManifest: manifest, fetchFn: healthy,
      dedicatedDatabaseUrl: dedicatedUrl, dedicatedPrisma: dedicated.prisma,
      opsPrisma: ops.prisma, selfServePrisma: selfserve.prisma };
    await expect(runCorporateRebelsDedicatedCutover(params)).resolves.toMatchObject({ mode: "preflight" });
    await expect(runCorporateRebelsDedicatedCutover({ ...params, execute: true,
      confirmation: "wrong" })).rejects.toThrow("confirmation");
    expect(dedicated.state.workspaces).toHaveLength(1);
  });
  it("seeds and replaces only the exact two legacy workspaces in one bound run", async () => {
    const dedicated = fake(); const ops = fake("ops", { members: 6 }); const selfserve = fake("selfserve");
    const receipt = await execute(dedicated, ops, selfserve);
    expect(ops.state.deployment).toMatchObject({ deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE",
      remoteWorkspaceId: receipt.workspaceId, managedWorkspaceId: null, url: CONTRACT.url,
      providerResourceGroup: CONTRACT.resourceGroup, lastHealthStatus: "ok", lastHealthError: null,
      railwayProjectId: null, railwayWebServiceId: null });
    expect(ops.state.deleted).toEqual([CONTRACT.opsLegacyWorkspaceId]);
    expect(selfserve.state.deleted).toEqual([CONTRACT.selfServeLegacyWorkspaceId]);
    expect(receipt.dedicated.workspace._count).toMatchObject({ members: 0, memberInviteRequests: 0,
      brainSources: 25, brainArticles: 1 });
    expect(dedicated.state.workspaces.map(({ slug }) => slug)).toContain(CONTRACT.slug);
    expect(dedicated.state.articles[0]).toMatchObject({ authority: "DRAFT", isPrivate: true, publishedAt: null });
  });
  it("rejects CRINA or Chirone databases and unhealthy releases before writes", async () => {
    for (const host of ["corgtex-crina-prod-pg.postgres.database.azure.com",
      "corgtex-chirone-prod-pg.postgres.database.azure.com"]) {
      const dedicated = fake(); const ops = fake("ops"); const selfserve = fake("selfserve");
      await expect(execute(dedicated, ops, selfserve, { dedicatedDatabaseUrl:
        `postgresql://user:pass@${host}/corgtex` })).rejects.toThrow("database identity");
      expect(dedicated.state.workspaces).toHaveLength(1);
    }
    await expect(execute(fake(), fake("ops"), fake("selfserve"), { fetchFn: async () => ({ ok: true,
      json: async () => ({ status: "down" }) }) })).rejects.toThrow("health proof");
  });
  it("fails before writes on drift, files, integrations, OAuth, bindings, or runtime payloads", async () => {
    for (const options of [{ drift: true }, { attachments: 1 }, { documents: 1 }, { integration: true },
      { oauth: 1 }, { binding: 1 }, { orphanable: 1 }]) {
      const target = fake("selfserve", options);
      const dedicated = fake(); const ops = fake("ops");
      await expect(execute(dedicated, ops, target)).rejects.toThrow();
      expect(target.state.deleted).toEqual([]);
      expect(ops.state.deleted).toEqual([]);
    }
  });
});
