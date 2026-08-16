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
  externalDataSources: true, externalResourceAttachments: true, communicationInstallations: true,
  appInstallations: true };
const fail = (message) => { throw new Error(message); };
const digest = (...values) => createHash("sha256").update(values.join("\0")).digest("hex");

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
function seedEvidence(workspaceId, releaseGitSha) {
  return digest("corporate-rebels-dedicated-seed-v1", workspaceId, releaseGitSha,
    CONTRACT.manifestSha256, CONTRACT.resourceGroup, CONTRACT.webServiceId, "25", "1", "0");
}
function opsEvidence(workspaceId, releaseGitSha) {
  return digest("corporate-rebels-ops-cutover-v1", workspaceId, releaseGitSha,
    CONTRACT.opsDeploymentId, CONTRACT.selfServeLegacyWorkspaceId);
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
    prisma.meetingAudioAsset.count({ where: { workspaceId: id } }),
    prisma.workspaceExternalResourceAttachment.count({ where: { workspaceId: id } }),
    prisma.buildArtifactAsset.count({ where: { artifact: { workspaceId: id } } }),
    prisma.event.count({ where: { workspaceId: id } }), prisma.workflowJob.count({ where: { workspaceId: id } }),
    prisma.meetingRecorderProviderEvent.count({ where: { workspaceId: id } }),
    prisma.communicationInboundEvent.count({ where: { workspaceId: id } }),
  ]);
  if (counts.slice(0, 4).some(Boolean)) fail("Corporate Rebels workspace has external file payloads.");
  if (counts.slice(4).some(Boolean)) fail("Corporate Rebels workspace has orphanable runtime payloads.");
  if (workspace._count.externalMcpConnections || workspace._count.externalDataSources
    || workspace._count.externalResourceAttachments || workspace._count.communicationInstallations
    || workspace._count.appInstallations) fail("Corporate Rebels workspace has active integrations.");
  return workspace;
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
    || health.release?.provider !== "azure" || health.release?.gitSha !== releaseGitSha
    || health.release?.imageTag !== `sha-${releaseGitSha}` || health.release?.drift?.gitSha
    || health.release?.drift?.imageTag) fail("Dedicated Azure health proof failed.");
  return health.release;
}
async function seedDedicated(prisma, rows, releaseGitSha, execute) {
  const existing = await prisma.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
    { name: CONTRACT.name }] }, select: { id: true } });
  if (existing.length) fail("Dedicated database already contains Corporate Rebels.");
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
      entityType: "Workspace", entityId: workspace.id, meta: { sourceCount: 25, publication: false, invitations: false } } });
    const result = await tx.workspace.findUnique({ where: { id: workspace.id }, select: { id: true,
      _count: { select: { members: true, memberInviteRequests: true, brainSources: true, brainArticles: true } } } });
    if (!result || result._count.members || result._count.memberInviteRequests
      || result._count.brainSources !== 25 || result._count.brainArticles !== 1) fail("Dedicated seed verification failed.");
    return { mode: "executed", phase: "seed-dedicated", workspace: result,
      evidence: seedEvidence(result.id, releaseGitSha) };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
async function cutoverOps(prisma, workspaceId, evidence, releaseGitSha, execute, fetchFn) {
  if (!uuid.test(workspaceId ?? "") || [CONTRACT.selfServeLegacyWorkspaceId,
    CONTRACT.opsLegacyWorkspaceId].includes(workspaceId)) fail("New dedicated workspace UUID is required.");
  if (evidence !== seedEvidence(workspaceId, releaseGitSha)) fail("Dedicated seed evidence is invalid.");
  const release = await verifyHealth(fetchFn, releaseGitSha);
  const preflight = async (db) => {
    const legacy = await exactLegacy(db, CONTRACT.opsLegacyWorkspaceId);
    const deployment = await db.customerDeployment.findUnique({ where: { id: CONTRACT.opsDeploymentId } });
    const account = await db.customerAccount.findUnique({ where: { id: CONTRACT.opsAccountId } });
    if (!deployment || !account || deployment.managedWorkspaceId !== legacy.id
      || deployment.customerAccountId !== account.id || account.primaryDeploymentId !== deployment.id
      || deployment.customerSlug !== CONTRACT.slug || account.slug !== CONTRACT.slug) fail("Ops identity mismatch.");
    return { legacy, deployment, account };
  };
  const state = await preflight(prisma);
  if (!execute) return { mode: "preflight", phase: "cutover-ops", legacyCounts: state.legacy._count };
  return prisma.$transaction(async (tx) => {
    const locked = await preflight(tx); const now = new Date();
    const deployment = await tx.customerDeployment.update({ where: { id: locked.deployment.id }, data: {
      url: CONTRACT.url, deploymentKind: "REMOTE_MANAGED", deploymentStatus: "ACTIVE", cloudProvider: "AZURE",
      remoteWorkspaceId: workspaceId, remoteWorkspaceSlug: CONTRACT.slug, managedWorkspaceId: null,
      provisioningStatus: "active", bootstrapStatus: "completed", region: "westus3", dataResidency: "US",
      providerSubscriptionId: CONTRACT.subscriptionId, providerResourceGroup: CONTRACT.resourceGroup,
      providerEnvironmentId: CONTRACT.environmentId, providerWebServiceId: CONTRACT.webServiceId,
      providerWorkerServiceId: CONTRACT.workerServiceId, providerPostgresServiceId: CONTRACT.postgresServiceId,
      providerRedisServiceId: CONTRACT.redisServiceId, providerStorageResourceId: CONTRACT.storageResourceId,
      providerProjectId: null, customDomain: "corporate-rebels.corgtex.com",
      railwayProjectId: null, railwayEnvironmentId: null, railwayWebServiceId: null,
      railwayWorkerServiceId: null, railwayPostgresServiceId: null, railwayRedisServiceId: null,
      releaseVersion: release.version, releaseImageTag: release.imageTag, lastHealthCheck: now,
      lastHealthStatus: "ok", lastHealthError: null, lastWorkerHealthCheck: null,
      lastWorkerHealthStatus: null, lastReleaseCheck: now, supportBaseUrl: null, supportMcpUrl: null,
      supportCredentialEnc: null, supportCredentialLabel: null, supportConnectorStatus: "not_configured",
      supportLastConnectedAt: null, supportLastSyncAt: null, supportLastSyncError: null } });
    await tx.customerAccount.update({ where: { id: locked.account.id }, data: { status: "ACTIVE" } });
    await tx.customerDeploymentEvent.create({ data: { deploymentId: deployment.id,
      action: "corporate_rebels.dedicated_azure_cutover", meta: { legacyWorkspaceId: locked.legacy.id,
        remoteWorkspaceId: workspaceId, releaseGitSha, approvedScope: "exact-corporate-rebels-only" } } });
    await tx.workspace.delete({ where: { id: locked.legacy.id } });
    return { mode: "executed", phase: "cutover-ops", deploymentId: deployment.id,
      remoteWorkspaceId: workspaceId, evidence: opsEvidence(workspaceId, releaseGitSha) };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
async function deleteSelfServe(prisma, workspaceId, evidence, releaseGitSha, execute) {
  if (evidence !== opsEvidence(workspaceId, releaseGitSha)) fail("Ops cutover evidence is invalid.");
  const legacy = await exactLegacy(prisma, CONTRACT.selfServeLegacyWorkspaceId);
  if (!execute) return { mode: "preflight", phase: "delete-selfserve", legacyCounts: legacy._count };
  return prisma.$transaction(async (tx) => {
    const locked = await exactLegacy(tx, CONTRACT.selfServeLegacyWorkspaceId);
    await tx.workspace.delete({ where: { id: locked.id } });
    return { mode: "executed", phase: "delete-selfserve", deletedWorkspaceId: locked.id,
      preservedWorkspaceId: workspaceId };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}
export async function runCorporateRebelsDedicatedCutover({ prisma, phase, execute = false,
  confirmation, workspaceId, evidence, releaseGitSha, readManifest, fetchFn = fetch } = {}) {
  if (execute && confirmation !== CONTRACT.confirmation) fail("Exact execution confirmation is required.");
  const rows = await loadManifest(readManifest);
  if (phase === "seed-dedicated") return seedDedicated(prisma, rows, releaseGitSha, execute);
  if (phase === "cutover-ops") return cutoverOps(prisma, workspaceId, evidence, releaseGitSha, execute, fetchFn);
  if (phase === "delete-selfserve") return deleteSelfServe(prisma, workspaceId, evidence, releaseGitSha, execute);
  fail("Unsupported phase.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  try {
    const receipt = await runCorporateRebelsDedicatedCutover({ prisma, phase: process.argv[2],
      execute: process.argv.includes("--execute"), confirmation: process.env.CORPORATE_REBELS_CONFIRM,
      workspaceId: process.env.CORPORATE_REBELS_WORKSPACE_ID, evidence: process.env.CORPORATE_REBELS_EVIDENCE,
      releaseGitSha: process.env.CORPORATE_REBELS_RELEASE_GIT_SHA });
    console.log(JSON.stringify(receipt, null, 2));
  } finally { await prisma.$disconnect(); }
}
