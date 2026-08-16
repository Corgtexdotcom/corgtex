import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTRACT, loadManifest, parseCsv,
  runCorporateRebelsDedicatedCutover } from "./corporate-rebels-dedicated-cutover.mjs";

const SHA = "a".repeat(40);
const manifest = () => readFile(new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url));
const health = () => ({ status: "ok", database: "up", schema: "ready",
  runtime: { redis: "configured", storage: "configured" }, release: { provider: "azure", gitSha: SHA,
    imageTag: `sha-${SHA}`, version: `main-${SHA.slice(0, 12)}`,
    drift: { gitSha: false, imageTag: false, version: false } } });
const healthy = async () => ({ ok: true, json: async () => health() });
function fake(kind = "dedicated", options = {}) {
  const legacyId = kind === "ops" ? CONTRACT.opsLegacyWorkspaceId : CONTRACT.selfServeLegacyWorkspaceId;
  const state = { workspaces: kind === "dedicated" ? [{ id: "sentinel", name: "Other", slug: "other" }]
    : [{ id: legacyId, name: CONTRACT.name, slug: CONTRACT.slug }, { id: "sentinel", name: "Other", slug: "other" }],
  sources: [], articles: [], events: [], deleted: [], deployment: { id: CONTRACT.opsDeploymentId,
    customerAccountId: CONTRACT.opsAccountId, managedWorkspaceId: CONTRACT.opsLegacyWorkspaceId,
    customerSlug: CONTRACT.slug, label: CONTRACT.name, deploymentKind: "SHARED_WORKSPACE",
    deploymentStatus: options.deploymentStatus ?? "ACTIVE", cloudProvider: "RAILWAY",
    provisioningStatus: "active", bootstrapStatus: "not_started", railwayProjectId: "old-project",
    railwayWebServiceId: "old-web", providerLogsUrl: "old-logs", providerCostUrl: "old-cost",
    providerMetadata: { old: true }, storageBucketName: "old-bucket", bootstrapBundleUri: "old-bundle" },
  account: { id: CONTRACT.opsAccountId, slug: CONTRACT.slug, displayName: CONTRACT.name,
    primaryDeploymentId: CONTRACT.opsDeploymentId, status: "ONBOARDING" } };
  const countShape = () => ({ members: options.members ?? 0, memberInviteRequests: 0,
    brainSources: state.sources.length, brainArticles: state.articles.length, documents: 0, meetings: 0,
    externalMcpConnections: options.integration ? 1 : 0, externalContentSources: options.contentSource ?? 0,
    externalDataSources: 0, oauthConnections: options.oauth ?? 0, integrationBindings: options.binding ?? 0,
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
  communicationInboundEvent: { count: async () => 0 },
  workspaceIntegrationBinding: { count: async () => options.binding ?? 0 },
  oAuthConnection: { count: async () => options.oauth ?? 0 }, oAuthApp: { count: async () => 0 },
  oAuthAuthorizationCode: { count: async () => 0 }, oAuthAccessToken: { count: async () => 0 },
  mcpOAuthAuthorizationCode: { count: async () => 0 }, mcpOAuthAccessToken: { count: async () => 0 },
  approvalPolicy: { create: async () => {} },
  brainArticle: { create: async ({ data }) => { state.articles.push(data); },
    findUnique: async () => state.articles[0] ?? null },
  auditLog: { create: async ({ data }) => { state.audit = data; },
    findFirst: async () => state.audit ? { id: "audit" } : null },
  customerDeployment: { findUnique: async () => state.deployment,
    update: async ({ data }) => Object.assign(state.deployment, data) },
  customerAccount: { findUnique: async () => state.account,
    update: async ({ data }) => Object.assign(state.account, data) },
  customerDeploymentEvent: { create: async ({ data }) => { state.events.push(data); },
    findFirst: async () => state.events.at(-1) ?? null },
  customerDeploymentBootstrapRun: { count: async () => 0 } };
  for (const model of ["emailDelivery", "financeImportCandidate", "financeReportFact", "procurementIdempotencyKey",
    "selfServeEmailCapture", "selfServeSmokeRun", "selfServeSupportSession", "supportOperation"])
    tx[model] = { count: async () => options.scalar ?? 0 };
  tx.tenantPurgeRun = { count: async ({ where }) => {
    if (!("targetWorkspaceId" in where)) throw new Error("wrong tenant purge selector");
    return options.scalar ?? 0;
  } };
  const prisma = { ...tx, $transaction: async (callback) => { if (options.drift) {
    state.workspaces.find((item) => item.id === legacyId).slug = "drift"; } return callback(tx); } };
  return { prisma, state };
}
const dedicatedUrl = `postgresql://user:pass@${CONTRACT.postgresServiceId}.postgres.database.azure.com/corgtex`;
const opsUrl = `postgresql://user:pass@${CONTRACT.opsDatabaseHost}:${CONTRACT.opsDatabasePort}/railway`;
const selfServeUrl = `postgresql://user:pass@${CONTRACT.selfServeDatabaseHost}/corgtex`;
const execute = (dedicated, ops, selfserve, extra = {}) => runCorporateRebelsDedicatedCutover({
  phase: "execute-cutover", execute: true, confirmation: CONTRACT.confirmation, releaseGitSha: SHA,
  readManifest: manifest, fetchFn: healthy, dedicatedDatabaseUrl: dedicatedUrl, opsDatabaseUrl: opsUrl,
  selfServeDatabaseUrl: selfServeUrl,
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
      dedicatedDatabaseUrl: dedicatedUrl, opsDatabaseUrl: opsUrl, selfServeDatabaseUrl: selfServeUrl,
      dedicatedPrisma: dedicated.prisma,
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
      bootstrapStatus: "applied", railwayProjectId: null, railwayWebServiceId: null,
      providerLogsUrl: null, providerCostUrl: null, providerMetadata: null, storageBucketName: null,
      bootstrapBundleUri: null });
    expect(ops.state.deleted).toEqual([CONTRACT.opsLegacyWorkspaceId]);
    expect(selfserve.state.deleted).toEqual([CONTRACT.selfServeLegacyWorkspaceId]);
    expect(receipt.dedicated.workspace._count).toMatchObject({ members: 0, memberInviteRequests: 0,
      brainSources: 25, brainArticles: 1 });
    expect(dedicated.state.workspaces.map(({ slug }) => slug)).toContain(CONTRACT.slug);
    expect(dedicated.state.articles[0]).toMatchObject({ authority: "DRAFT", isPrivate: true, publishedAt: null });
    await expect(execute(dedicated, ops, selfserve)).resolves.toMatchObject({ workspaceId: receipt.workspaceId });
    expect(ops.state.deleted).toEqual([CONTRACT.opsLegacyWorkspaceId]);
    expect(selfserve.state.deleted).toEqual([CONTRACT.selfServeLegacyWorkspaceId]);
    expect({ sources: dedicated.state.sources.length, events: ops.state.events.length })
      .toEqual({ sources: 25, events: 1 });
  });
  it("rejects every foreign database and unhealthy release before writes", async () => {
    for (const override of [{ dedicatedDatabaseUrl: "postgresql://u:p@foreign.invalid/corgtex" },
      { opsDatabaseUrl: "postgresql://u:p@foreign.invalid/railway" },
      { opsDatabaseUrl: `postgresql://u:p@${CONTRACT.opsDatabaseHost}:45901/railway` },
      { selfServeDatabaseUrl: "postgresql://u:p@foreign.invalid/corgtex" }]) {
      const dedicated = fake(); const ops = fake("ops"); const selfserve = fake("selfserve");
      await expect(execute(dedicated, ops, selfserve, override)).rejects.toThrow("Database identity");
      expect(dedicated.state.workspaces).toHaveLength(1);
    }
    await expect(execute(fake(), fake("ops"), fake("selfserve"), { fetchFn: async () => ({ ok: true,
      json: async () => ({ status: "down" }) }) })).rejects.toThrow("health proof");
    for (const body of [{ ...health(), runtime: { redis: "missing", storage: "configured" } },
      { ...health(), release: { ...health().release, drift: { version: true } } },
      { ...health(), release: { ...health().release, version: "main-wrong" } }])
      await expect(execute(fake(), fake("ops"), fake("selfserve"), { fetchFn: async () => ({ ok: true,
        json: async () => body }) })).rejects.toThrow("health proof");
  });
  it("fails before writes on held or retained tenant state", async () => {
    for (const [label, options] of Object.entries({ drift: { drift: true }, attachments: { attachments: 1 },
      documents: { documents: 1 }, integration: { integration: true }, content: { contentSource: 1 },
      scalar: { scalar: 1 }, oauth: { oauth: 1 }, binding: { binding: 1 }, runtime: { orphanable: 1 } })) {
      const target = fake("selfserve", options);
      const dedicated = fake(); const ops = fake("ops");
      let failure; try { await execute(dedicated, ops, target); } catch (error) { failure = error; }
      expect(failure, label).toBeInstanceOf(Error);
      expect(target.state.deleted).toEqual([]);
      expect(ops.state.deleted).toEqual([]);
    }
    await expect(execute(fake(), fake("ops", { deploymentStatus: "SUSPENDED" }),
      fake("selfserve"))).rejects.toThrow("lifecycle state");
  });
});
