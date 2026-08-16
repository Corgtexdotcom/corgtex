import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CONTRACT = Object.freeze({
  selfServeLegacyWorkspaceId: "b2167229-321c-4a89-8a03-7e29f146c62f",
  opsLegacyWorkspaceId: "a65ed55c-f1f4-4491-8cd5-9979a1aec958",
  opsDeploymentId: "160103a2-6ae5-4e6d-a92f-110e71b52d33",
  opsAccountId: "53c37e29-745e-4ed4-961e-18cd96d3874d",
  subscriptionId: "227eb707-bc46-415e-a09b-7d2b69fb14b2",
  resourceGroup: "rg-corgtex-corporate-rebels-production-wus3",
  environmentId: "cae-corgtex-corporate-rebels-prod",
  webServiceId: "ca-corgtex-corporate-rebels-prod-web",
  workerServiceId: "ca-corgtex-corporate-rebels-prod-worker",
  postgresServiceId: "corgtex-corporate-rebels-prod-pg",
  opsDatabaseHost: "switchback.proxy.rlwy.net",
  selfServeDatabaseHost: "corgtex-ss-prod-pg.postgres.database.azure.com",
  redisServiceId: "corgtex-corporate-rebels-prod-redis",
  storageResourceId: "corgtexcrprodwus3",
  url: "https://corporate-rebels.corgtex.com",
  name: "Corporate Rebels",
  slug: "corporate-rebels",
  manifestSha256: "91935b44e00c28b0cc1cb967b241944ecd75e2e7a9fc40ccad5ebed8004aaebe",
  confirmation: "replace-exact-corporate-rebels-workspaces-with-dedicated-azure",
});
const manifestUrl = new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const workspaceCounts = { members: true, memberInviteRequests: true, brainSources: true,
  brainArticles: true, documents: true, meetings: true, externalMcpConnections: true,
  externalContentSources: true, externalDataSources: true, externalResourceAttachments: true,
  webhookEndpoints: true, inboundWebhooks: true, oauthConnections: true, oauthApps: true,
  mcpOAuthCodes: true, mcpOAuthTokens: true, aiWorkspaceConnections: true,
  communicationInstallations: true, integrationBindings: true, appInstallations: true };
const blockedRelations = Object.keys(workspaceCounts).filter((key) => ![
  "members", "memberInviteRequests", "brainSources", "brainArticles", "documents", "meetings",
].includes(key));
const scalarModels = ["emailDelivery", "financeImportCandidate", "financeReportFact",
  "oAuthAccessToken", "oAuthAuthorizationCode", "procurementIdempotencyKey", "selfServeEmailCapture",
  "selfServeSmokeRun", "selfServeSupportSession", "supportOperation", "tenantPurgeRun"];
const fail = (message) => { throw new Error(message); };
const digest = (...values) => createHash("sha256").update(values.join("\0")).digest("hex");
const databaseIdentities = Object.freeze([
  [`${CONTRACT.postgresServiceId}.postgres.database.azure.com`, "corgtex"],
  [CONTRACT.opsDatabaseHost, "railway"], [CONTRACT.selfServeDatabaseHost, "corgtex"],
]);

export function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map((entry) => Object.fromEntries(headers.map((header, index) => [header, entry[index] ?? ""])));
}
export async function loadManifest(read = readFile) {
  const bytes = await read(manifestUrl);
  if (digest(bytes) !== CONTRACT.manifestSha256) fail("Corporate Rebels manifest digest mismatch.");
  const rows = parseCsv(bytes.toString("utf8"));
  const ids = new Set(rows.map((row) => row.id));
  const urls = new Set(rows.map((row) => row.canonical_https_url));
  if (rows.length !== 25 || ids.size !== 25 || urls.size !== 25
    || [...urls].some((url) => !url.startsWith("https://"))) fail("Corporate Rebels manifest is invalid.");
  return rows;
}
function verifyDatabaseUrls(values) {
  for (const [index, [host, database]] of databaseIdentities.entries()) {
    let url; try { url = new URL(values[index]); } catch { fail("Database URL is invalid."); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== host
      || url.pathname.slice(1) !== database) fail("Database identity mismatch.");
  }
}
async function exactLegacy(prisma, id) {
  if (![CONTRACT.selfServeLegacyWorkspaceId, CONTRACT.opsLegacyWorkspaceId].includes(id)) fail("Legacy target is not authorized.");
  const workspace = await prisma.workspace.findUnique({ where: { id }, select: { id: true,
    name: true, slug: true, _count: { select: workspaceCounts } } });
  if (!workspace || workspace.name !== CONTRACT.name || workspace.slug !== CONTRACT.slug) fail("Exact Corporate Rebels workspace not found.");
  const matches = await prisma.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
    { name: CONTRACT.name }] }, select: { id: true } });
  if (matches.length !== 1 || matches[0].id !== id) fail("Corporate Rebels workspace identity is ambiguous.");
  const counts = await Promise.all([
    prisma.brainSource.count({ where: { workspaceId: id, fileStorageKey: { not: null } } }),
    prisma.document.count({ where: { workspaceId: id, storageKey: { not: "" } } }),
    prisma.meetingAudioAsset.count({ where: { workspaceId: id } }),
    prisma.workspaceExternalResourceAttachment.count({ where: { workspaceId: id } }),
    prisma.buildArtifactAsset.count({ where: { artifact: { workspaceId: id } } }),
    prisma.event.count({ where: { workspaceId: id } }), prisma.workflowJob.count({ where: { workspaceId: id } }),
    prisma.meetingRecorderProviderEvent.count({ where: { workspaceId: id } }),
    prisma.communicationInboundEvent.count({ where: { workspaceId: id } }),
    ...scalarModels.map((model) => prisma[model].count({ where: { workspaceId: id } })),
    prisma.customerDeploymentBootstrapRun.count({ where: { customerSlug: CONTRACT.slug } }),
  ]);
  if (counts.slice(0, 5).some(Boolean)) fail("Corporate Rebels workspace has external file payloads.");
  if (counts.slice(5).some(Boolean)) fail("Corporate Rebels workspace has retained tenant records.");
  if (blockedRelations.some((key) => workspace._count[key])) fail("Corporate Rebels workspace has integrations.");
  return workspace;
}
async function legacyOrAbsent(prisma, id) {
  if (await prisma.workspace.findUnique({ where: { id }, select: { id: true } })) return exactLegacy(prisma, id);
  const matches = await prisma.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
    { name: CONTRACT.name }] }, select: { id: true } });
  if (matches.length) fail("Corporate Rebels workspace identity is ambiguous.");
  return null;
}
function sources(rows) {
  return rows.map((row) => ({ id: randomUUID(), accessDomain: "WORKSPACE", sourceType: "ARTICLE", tier: 2,
    externalId: `corporate-rebels-curation:${row.id}`, channel: "curated-public-web", title: row.title,
    content: `${row.why_it_matters} Canonical source: ${row.canonical_https_url}`,
    ingestionGuidanceMd: "Attributed external reference only. Cite its canonical URL and original date.",
    metadata: { schemaVersion: 1, manifestId: row.id, canonicalUrl: row.canonical_https_url,
      publisher: row.publisher, authorByline: row.author_byline, originalPublishedAt: row.original_publication_date,
      retrievedAt: row.retrieved_date, language: row.language, topic: row.topic,
      sourceClass: row.source_class, permittedIngestionMode: row.permitted_ingestion_mode,
      manifestSha256: CONTRACT.manifestSha256 } }));
}
function indexBody(rows) {
  const entries = [...rows].sort((a, b) => b.original_publication_date.localeCompare(a.original_publication_date))
    .map((row) => `- **[${row.title}](${row.canonical_https_url})** — ${row.publisher}; ${row.original_publication_date}. ${row.why_it_matters}`);
  return `# Corporate Rebels Curated Source Index — 2026-08-13\n\nPrivate workspace-only index.\n\n${entries.join("\n")}`;
}
async function verifyHealth(fetchFn, releaseGitSha) {
  if (!/^[0-9a-f]{40}$/.test(releaseGitSha ?? "")) fail("Exact release SHA is required.");
  const response = await fetchFn(`${CONTRACT.url}/api/health`, { signal: AbortSignal.timeout(10_000) });
  const health = response.ok ? await response.json() : null;
  if (!health || health.status !== "ok" || health.database !== "up" || health.schema !== "ready"
    || health.runtime?.redis !== "configured" || health.runtime?.storage !== "configured"
    || health.release?.provider !== "azure" || health.release?.gitSha !== releaseGitSha
    || health.release?.imageTag !== `sha-${releaseGitSha}` || !health.release?.version || health.release?.drift?.gitSha
    || health.release?.drift?.imageTag || health.release?.drift?.version) fail("Dedicated Azure health proof failed.");
  return health.release;
}
async function seedDedicated(prisma, rows, releaseGitSha, execute) {
  const existing = await prisma.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
    { name: CONTRACT.name }] }, select: { id: true } });
  if (existing.length > 1) fail("Dedicated workspace identity is ambiguous.");
  const verify = async (db, id) => {
    const workspace = await db.workspace.findUnique({ where: { id }, select: { id: true,
      _count: { select: { members: true, memberInviteRequests: true, brainSources: true, brainArticles: true } } } });
    const article = await db.brainArticle.findUnique({ where: { workspaceId_slug: { workspaceId: id,
      slug: "corporate-rebels-curated-source-index-2026-08-13" } }, select: { authority: true,
      isPrivate: true, publishedAt: true, frontmatterJson: true } });
    const receipt = await db.auditLog.findFirst({ where: { workspaceId: id,
      action: "corporate_rebels.dedicated_seeded" }, select: { id: true } });
    if (!workspace || workspace._count.members || workspace._count.memberInviteRequests
      || workspace._count.brainSources !== 25 || workspace._count.brainArticles !== 1 || !receipt
      || article?.authority !== "DRAFT" || !article.isPrivate || article.publishedAt
      || article.frontmatterJson?.manifestSha256 !== CONTRACT.manifestSha256) fail("Dedicated seed verification failed.");
    return workspace;
  };
  if (existing.length) return { mode: execute ? "executed" : "preflight", phase: "seed-dedicated",
    workspace: await verify(prisma, existing[0].id), resumed: true };
  if (!execute) return { mode: "preflight", phase: "seed-dedicated", manifestCount: rows.length };
  return prisma.$transaction(async (tx) => {
    if ((await tx.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
      { name: CONTRACT.name }] }, select: { id: true } })).length) fail("Dedicated target drifted.");
    const workspace = await tx.workspace.create({ data: { name: CONTRACT.name, slug: CONTRACT.slug,
      description: "Private dedicated Azure Corporate Rebels client workspace.", plan: "ENTERPRISE_MANAGED" } });
    const seeded = sources(rows);
    await tx.approvalPolicy.create({ data: { workspaceId: workspace.id, subjectType: "PROPOSAL",
      mode: "CONSENT", quorumPercent: 0, minApproverCount: 1, decisionWindowHours: 72 } });
    await tx.brainSource.createMany({ data: seeded.map((source) => ({ ...source, workspaceId: workspace.id })) });
    await tx.brainArticle.create({ data: { workspaceId: workspace.id,
      slug: "corporate-rebels-curated-source-index-2026-08-13", title: "Corporate Rebels Curated Source Index — 2026-08-13",
      type: "DIGEST", authority: "DRAFT", bodyMd: indexBody(rows), isPrivate: true, publishedAt: null,
      sourceIds: seeded.map((source) => source.id), frontmatterJson: { corpusCount: 25,
        retrievalDate: "2026-08-13", manifestSha256: CONTRACT.manifestSha256, projection: "workspace-only" } } });
    await tx.auditLog.create({ data: { workspaceId: workspace.id, action: "corporate_rebels.dedicated_seeded",
      entityType: "Workspace", entityId: workspace.id,
      meta: { sourceCount: 25, releaseGitSha, publication: false, invitations: false } } });
    return { mode: "executed", phase: "seed-dedicated", workspace: await verify(tx, workspace.id) };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
const cutoverAction = "corporate_rebels.dedicated_azure_cutover";
function completedDeployment(deployment, workspaceId) {
  return deployment?.remoteWorkspaceId === workspaceId && deployment.managedWorkspaceId === null
    && deployment.url === CONTRACT.url && deployment.deploymentKind === "REMOTE_MANAGED"
    && deployment.deploymentStatus === "ACTIVE" && deployment.cloudProvider === "AZURE"
    && deployment.provisioningStatus === "active" && deployment.bootstrapStatus === "applied"
    && deployment.customDomain === "corporate-rebels.corgtex.com"
    && deployment.providerSubscriptionId === CONTRACT.subscriptionId
    && deployment.providerResourceGroup === CONTRACT.resourceGroup
    && deployment.providerEnvironmentId === CONTRACT.environmentId
    && deployment.providerWebServiceId === CONTRACT.webServiceId
    && deployment.providerWorkerServiceId === CONTRACT.workerServiceId
    && deployment.providerPostgresServiceId === CONTRACT.postgresServiceId
    && deployment.providerRedisServiceId === CONTRACT.redisServiceId
    && deployment.providerStorageResourceId === CONTRACT.storageResourceId;
}
async function opsState(db, workspaceId) {
  const legacy = await legacyOrAbsent(db, CONTRACT.opsLegacyWorkspaceId);
  const deployment = await db.customerDeployment.findUnique({ where: { id: CONTRACT.opsDeploymentId } });
  const account = await db.customerAccount.findUnique({ where: { id: CONTRACT.opsAccountId } });
  const event = await db.customerDeploymentEvent.findFirst({ where: { deploymentId: CONTRACT.opsDeploymentId,
    action: cutoverAction }, orderBy: { createdAt: "desc" }, select: { meta: true } });
  if (!deployment || !account || deployment.customerAccountId !== account.id
    || account.primaryDeploymentId !== deployment.id || deployment.customerSlug !== CONTRACT.slug
    || account.slug !== CONTRACT.slug) fail("Ops identity mismatch.");
  if (legacy && deployment.managedWorkspaceId === legacy.id && deployment.deploymentKind === "SHARED_WORKSPACE"
    && deployment.deploymentStatus === "ACTIVE" && deployment.cloudProvider === "RAILWAY"
    && deployment.provisioningStatus === "active" && deployment.bootstrapStatus === "not_started"
    && account.status === "ONBOARDING") {
    return { state: "initial", legacy, deployment, account };
  }
  if (workspaceId && completedDeployment(deployment, workspaceId) && account.status === "ACTIVE"
    && event?.meta?.remoteWorkspaceId === workspaceId
    && event.meta.legacyWorkspaceId === CONTRACT.opsLegacyWorkspaceId
    && event.meta.approvedScope === "exact-corporate-rebels-only") {
    return { state: "complete", legacy, deployment, account };
  }
  fail("Ops lifecycle state mismatch.");
}
async function cutoverOps(prisma, workspaceId, releaseGitSha, execute, fetchFn) {
  if (workspaceId && (!uuid.test(workspaceId) || [CONTRACT.selfServeLegacyWorkspaceId,
    CONTRACT.opsLegacyWorkspaceId].includes(workspaceId))) fail("New dedicated workspace UUID is required.");
  const release = await verifyHealth(fetchFn, releaseGitSha);
  const state = await opsState(prisma, workspaceId);
  if (state.state === "complete" && state.deployment.releaseImageTag !== release.imageTag) {
    fail("Persisted Ops release proof failed.");
  }
  if (!execute || state.state === "complete") return { mode: execute ? "executed" : "preflight",
    phase: "cutover-ops", state: state.state, resumed: state.state === "complete",
    legacyCounts: state.legacy?._count };
  return prisma.$transaction(async (tx) => {
    const locked = await opsState(tx, workspaceId); const now = new Date();
    if (locked.state !== "initial") fail("Ops lifecycle state drifted.");
    const deployment = await tx.customerDeployment.update({ where: { id: locked.deployment.id }, data: {
      url: CONTRACT.url, deploymentKind: "REMOTE_MANAGED", deploymentStatus: "ACTIVE", cloudProvider: "AZURE",
      remoteWorkspaceId: workspaceId, remoteWorkspaceSlug: CONTRACT.slug, managedWorkspaceId: null,
      provisioningStatus: "active", bootstrapStatus: "applied", region: "westus3", dataResidency: "US",
      providerSubscriptionId: CONTRACT.subscriptionId, providerResourceGroup: CONTRACT.resourceGroup,
      providerEnvironmentId: CONTRACT.environmentId, providerWebServiceId: CONTRACT.webServiceId,
      providerWorkerServiceId: CONTRACT.workerServiceId, providerPostgresServiceId: CONTRACT.postgresServiceId,
      providerRedisServiceId: CONTRACT.redisServiceId, providerStorageResourceId: CONTRACT.storageResourceId,
      providerProjectId: null, providerLogsUrl: null, providerCostUrl: null, providerMetadata: null,
      storageBucketName: null, bootstrapBundleUri: null, bootstrapBundleChecksum: null,
      bootstrapBundleSchemaVersion: null, lastProvisioningError: null, customDomain: "corporate-rebels.corgtex.com",
      railwayProjectId: null, railwayEnvironmentId: null, railwayWebServiceId: null,
      railwayWorkerServiceId: null, railwayPostgresServiceId: null, railwayRedisServiceId: null,
      releaseVersion: release.version, releaseImageTag: release.imageTag, lastHealthCheck: now,
      lastHealthStatus: "ok", lastHealthError: null, lastWorkerHealthCheck: null,
      lastWorkerHealthStatus: null, lastReleaseCheck: now, supportBaseUrl: null, supportMcpUrl: null,
      supportCredentialEnc: null, supportCredentialLabel: null, supportConnectorStatus: "not_configured",
      supportLastConnectedAt: null, supportLastSyncAt: null, supportLastSyncError: null } });
    await tx.customerAccount.update({ where: { id: locked.account.id }, data: { status: "ACTIVE" } });
    await tx.customerDeploymentEvent.create({ data: { deploymentId: deployment.id,
      action: cutoverAction, meta: { legacyWorkspaceId: locked.legacy.id,
        remoteWorkspaceId: workspaceId, releaseGitSha, approvedScope: "exact-corporate-rebels-only" } } });
    return { mode: "executed", phase: "cutover-ops", deploymentId: deployment.id,
      remoteWorkspaceId: workspaceId };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
async function deleteSelfServe(prisma, opsPrisma, workspaceId, execute) {
  if ((await opsState(opsPrisma, workspaceId)).state !== "complete") fail("Persisted Ops cutover proof failed.");
  const legacy = await legacyOrAbsent(prisma, CONTRACT.selfServeLegacyWorkspaceId);
  if (!legacy) return { mode: execute ? "executed" : "preflight", phase: "delete-selfserve", resumed: true };
  if (!execute) return { mode: "preflight", phase: "delete-selfserve", legacyCounts: legacy._count };
  return prisma.$transaction(async (tx) => {
    const locked = await legacyOrAbsent(tx, CONTRACT.selfServeLegacyWorkspaceId);
    if (!locked) return { mode: "executed", phase: "delete-selfserve", resumed: true };
    await tx.workspace.delete({ where: { id: locked.id } });
    return { mode: "executed", phase: "delete-selfserve", deletedWorkspaceId: locked.id,
      preservedWorkspaceId: workspaceId };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
async function deleteOpsLegacy(prisma, workspaceId) {
  return prisma.$transaction(async (tx) => {
    const state = await opsState(tx, workspaceId); const legacy = state.legacy;
    if (state.state !== "complete") fail("Final Ops cutover proof failed.");
    if (!legacy) return { resumed: true };
    await tx.workspace.delete({ where: { id: legacy.id } });
    return { deletedWorkspaceId: legacy.id };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
export async function runCorporateRebelsDedicatedCutover({ phase, execute = false,
  confirmation, releaseGitSha, readManifest, fetchFn = fetch, dedicatedPrisma, opsPrisma,
  selfServePrisma, dedicatedDatabaseUrl, opsDatabaseUrl, selfServeDatabaseUrl } = {}) {
  if (execute && confirmation !== CONTRACT.confirmation) fail("Exact execution confirmation is required.");
  const rows = await loadManifest(readManifest);
  if (phase === "execute-cutover") {
    verifyDatabaseUrls([dedicatedDatabaseUrl, opsDatabaseUrl, selfServeDatabaseUrl]);
    const previewSeed = await seedDedicated(dedicatedPrisma, rows, releaseGitSha, false);
    const previewOps = await cutoverOps(opsPrisma, previewSeed.workspace?.id, releaseGitSha, false, fetchFn);
    const previewSelfServe = await legacyOrAbsent(selfServePrisma, CONTRACT.selfServeLegacyWorkspaceId);
    if (previewOps.state === "initial" && !previewSelfServe) fail("Self-Serve legacy workspace is missing.");
    if (!execute) return { mode: "preflight", phase, dedicated: previewSeed, ops: previewOps,
      selfServe: previewSelfServe };
    const seed = await seedDedicated(dedicatedPrisma, rows, releaseGitSha, true);
    const ops = await cutoverOps(opsPrisma, seed.workspace.id, releaseGitSha, true, fetchFn);
    const selfServe = await deleteSelfServe(selfServePrisma, opsPrisma, seed.workspace.id, true);
    const opsLegacy = await deleteOpsLegacy(opsPrisma, seed.workspace.id);
    return { mode: "executed", phase, workspaceId: seed.workspace.id,
      dedicated: seed, ops, selfServe, opsLegacy };
  }
  fail("Unsupported phase.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const urls = [process.env.DEDICATED_DATABASE_URL, process.env.OPS_DATABASE_URL,
    process.env.SELFSERVE_DATABASE_URL];
  const clients = urls.map((datasourceUrl) => new PrismaClient({ datasourceUrl }));
  try {
    const receipt = await runCorporateRebelsDedicatedCutover({ phase: process.argv[2],
      execute: process.argv.includes("--execute"), confirmation: process.env.CORPORATE_REBELS_CONFIRM,
      releaseGitSha: process.env.CORPORATE_REBELS_RELEASE_GIT_SHA, dedicatedPrisma: clients[0],
      opsPrisma: clients[1], selfServePrisma: clients[2], dedicatedDatabaseUrl: urls[0],
      opsDatabaseUrl: urls[1], selfServeDatabaseUrl: urls[2] });
    console.log(JSON.stringify(receipt, null, 2));
  } finally { await Promise.all(clients.map((client) => client.$disconnect())); }
}
