import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CONTRACT = Object.freeze({
  azureLegacyWorkspaceId: "b2167229-321c-4a89-8a03-7e29f146c62f",
  opsLegacyWorkspaceId: "a65ed55c-f1f4-4491-8cd5-9979a1aec958",
  opsDeploymentId: "160103a2-6ae5-4e6d-a92f-110e71b52d33",
  opsAccountId: "53c37e29-745e-4ed4-961e-18cd96d3874d",
  azureHostDeploymentId: "e0d34b24-bd86-4cb2-8ccb-f2f84309ca16",
  name: "Corporate Rebels",
  slug: "corporate-rebels",
  manifestSha256: "91935b44e00c28b0cc1cb967b241944ecd75e2e7a9fc40ccad5ebed8004aaebe",
  confirmation: "delete-two-corporate-rebels-workspaces-and-create-one-private-azure-workspace",
});

const manifestUrl = new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url);
const workspaceCountSelect = { members: true, memberInviteRequests: true, brainSources: true,
  brainArticles: true, documents: true, meetings: true, externalMcpConnections: true,
  externalDataSources: true, externalResourceAttachments: true, communicationInstallations: true,
  appInstallations: true };

function fail(message) { throw new Error(message); }

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
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== CONTRACT.manifestSha256) fail("Corporate Rebels manifest digest mismatch.");
  const rows = parseCsv(bytes.toString("utf8"));
  if (rows.length !== 25) fail("Corporate Rebels manifest must contain exactly 25 rows.");
  const ids = new Set(rows.map((row) => row.id));
  const urls = new Set(rows.map((row) => row.canonical_https_url));
  if (ids.size !== 25 || urls.size !== 25 || [...urls].some((url) => !url.startsWith("https://"))) {
    fail("Corporate Rebels manifest IDs and HTTPS URLs must be unique.");
  }
  return { digest, rows };
}

async function exactWorkspace(prisma, id) {
  const workspace = await prisma.workspace.findUnique({ where: { id },
    select: { id: true, name: true, slug: true, _count: { select: workspaceCountSelect } } });
  if (!workspace || workspace.name !== CONTRACT.name || workspace.slug !== CONTRACT.slug) {
    fail(`Exact Corporate Rebels workspace ${id} was not found.`);
  }
  const matches = await prisma.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
    { name: CONTRACT.name }] }, select: { id: true } });
  if (matches.length !== 1 || matches[0].id !== id) fail("Corporate Rebels workspace identity is ambiguous.");
  const attachmentCounts = await Promise.all([
    prisma.brainSource.count({ where: { workspaceId: id, fileStorageKey: { not: null } } }),
    prisma.document.count({ where: { workspaceId: id } }),
    prisma.meetingAudioAsset.count({ where: { workspaceId: id } }),
    prisma.workspaceExternalResourceAttachment.count({ where: { workspaceId: id } }),
    prisma.buildArtifactAsset.count({ where: { artifact: { workspaceId: id } } }),
  ]);
  const fileAttachments = attachmentCounts.reduce((sum, count) => sum + count, 0);
  if (fileAttachments) fail(`Corporate Rebels workspace ${id} has file attachments.`);
  return { ...workspace, fileAttachments };
}

function sourceRows(rows) {
  return rows.map((row) => ({
    id: randomUUID(), accessDomain: "WORKSPACE", sourceType: "ARTICLE", tier: 2,
    externalId: `corporate-rebels-curation:${row.id}`, channel: "curated-public-web", title: row.title,
    content: `${row.why_it_matters} This curated reference covers ${row.topic}. Canonical source: ${row.canonical_https_url}`,
    ingestionGuidanceMd: "Treat as an attributed external reference. Cite the canonical URL and original publication date; do not present it as internal policy without corroboration.",
    metadata: { schemaVersion: 1, manifestId: row.id, sourceUrl: row.canonical_https_url,
      canonicalUrl: row.canonical_https_url, publisher: row.publisher, authorByline: row.author_byline,
      originalPublishedAt: row.original_publication_date, retrievedAt: row.retrieved_date,
      language: row.language, topic: row.topic, sourceClass: row.source_class,
      permittedIngestionMode: row.permitted_ingestion_mode, synopsisAuthorship: "original-curation",
      manifestArtifactName: "corporate-rebels-source-manifest-2026-08-13.csv",
      manifestSha256: CONTRACT.manifestSha256 },
  }));
}

function indexBody(rows) {
  const sorted = [...rows].sort((left, right) => right.original_publication_date.localeCompare(
    left.original_publication_date) || left.id.localeCompare(right.id));
  const entries = sorted.map((row) => `- **[${row.title}](${row.canonical_https_url})** — ${row.publisher}; ${row.author_byline}; ${row.original_publication_date}. ${row.why_it_matters}`);
  return `# Corporate Rebels Curated Source Index — 2026-08-13\n\nPrivate workspace-only index of 25 dated public references. Metadata and original concise synopses only; no publisher page bodies are stored.\n\n${entries.join("\n")}`;
}

async function azurePhase(prisma, manifest, execute) {
  const legacy = await exactWorkspace(prisma, CONTRACT.azureLegacyWorkspaceId);
  const preflight = { phase: "azure", legacyWorkspaceId: legacy.id, legacyCounts: legacy._count,
    legacyFileAttachments: legacy.fileAttachments, manifestSha256: manifest.digest,
    manifestCount: manifest.rows.length };
  if (!execute) return { mode: "preflight", ...preflight };
  const sources = sourceRows(manifest.rows);
  return prisma.$transaction(async (tx) => {
    await tx.workspace.delete({ where: { id: legacy.id } });
    const workspace = await tx.workspace.create({ data: { name: CONTRACT.name, slug: CONTRACT.slug,
      description: "Private Azure-backed Corporate Rebels client workspace.", plan: "ENTERPRISE_MANAGED" } });
    await tx.approvalPolicy.create({ data: { workspaceId: workspace.id, subjectType: "PROPOSAL",
      mode: "CONSENT", quorumPercent: 0, minApproverCount: 1, decisionWindowHours: 72 } });
    await tx.brainSource.createMany({ data: sources.map((source) => ({ ...source, workspaceId: workspace.id })) });
    await tx.brainArticle.create({ data: { workspaceId: workspace.id,
      slug: "corporate-rebels-curated-source-index-2026-08-13",
      title: "Corporate Rebels Curated Source Index — 2026-08-13", type: "DIGEST", authority: "DRAFT",
      bodyMd: indexBody(manifest.rows), isPrivate: true, publishedAt: null,
      sourceIds: sources.map((source) => source.id), frontmatterJson: { corpusCount: 25,
        officialCount: 20, independentCount: 5, dateRange: ["2017-09-05", "2026-07-27"],
        retrievalDate: "2026-08-13", manifestSha256: manifest.digest, projection: "workspace-only" } } });
    await tx.auditLog.create({ data: { workspaceId: workspace.id,
      action: "corporate_rebels.azure_workspace_consolidated", entityType: "Workspace",
      entityId: workspace.id, meta: { legacyWorkspaceId: legacy.id,
        manifestSha256: manifest.digest, sourceCount: 25, publication: false, invitations: false } } });
    const result = await tx.workspace.findUnique({ where: { id: workspace.id }, select: { id: true,
      name: true, slug: true, plan: true, _count: { select: { members: true, memberInviteRequests: true,
        brainSources: true, brainArticles: true } } } });
    if (!result || result._count.members || result._count.memberInviteRequests
      || result._count.brainSources !== 25 || result._count.brainArticles !== 1) fail("Azure result verification failed.");
    return { mode: "executed", ...preflight, azureWorkspace: result };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}

async function opsPhase(prisma, azureWorkspaceId, execute) {
  if (!/^[0-9a-f-]{36}$/.test(azureWorkspaceId ?? "")
    || azureWorkspaceId === CONTRACT.azureLegacyWorkspaceId) fail("A new Azure workspace ID is required.");
  const legacy = await exactWorkspace(prisma, CONTRACT.opsLegacyWorkspaceId);
  const deployment = await prisma.customerDeployment.findUnique({ where: { id: CONTRACT.opsDeploymentId } });
  const host = await prisma.customerDeployment.findUnique({ where: { id: CONTRACT.azureHostDeploymentId } });
  const account = await prisma.customerAccount.findUnique({ where: { id: CONTRACT.opsAccountId } });
  if (!deployment || deployment.managedWorkspaceId !== legacy.id || deployment.customerAccountId !== account?.id
    || deployment.customerSlug !== CONTRACT.slug || deployment.label !== CONTRACT.name
    || account.primaryDeploymentId !== deployment.id || account.slug !== CONTRACT.slug
    || account.displayName !== CONTRACT.name) fail("Corporate Rebels control-plane identity mismatch.");
  if (!host || host.cloudProvider !== "AZURE" || host.deploymentStatus !== "ACTIVE") fail("Azure host registry is not active.");
  const preflight = { phase: "ops", legacyWorkspaceId: legacy.id, legacyCounts: legacy._count,
    legacyFileAttachments: legacy.fileAttachments, deploymentId: deployment.id,
    customerAccountId: account.id, azureHostDeploymentId: host.id, azureWorkspaceId,
    manifestSha256: CONTRACT.manifestSha256 };
  if (!execute) return { mode: "preflight", ...preflight };
  return prisma.$transaction(async (tx) => {
    const providerKeys = ["region", "dataResidency", "providerSubscriptionId", "providerResourceGroup",
      "providerProjectId", "providerEnvironmentId", "providerWebServiceId", "providerWorkerServiceId",
      "providerPostgresServiceId", "providerRedisServiceId", "providerStorageResourceId", "providerLogsUrl",
      "providerCostUrl", "releaseVersion", "releaseImageTag", "lastHealthCheck", "lastHealthStatus"];
    const provider = Object.fromEntries(providerKeys.map((key) => [key, host[key] ?? null]));
    await tx.customerDeployment.update({ where: { id: deployment.id }, data: { ...provider,
      url: `${host.url.replace(/\/$/, "")}/workspaces/${azureWorkspaceId}`,
      deploymentKind: "REMOTE_MANAGED", deploymentStatus: "ACTIVE", cloudProvider: "AZURE",
      remoteWorkspaceId: azureWorkspaceId, remoteWorkspaceSlug: CONTRACT.slug, managedWorkspaceId: null,
      provisioningStatus: "active", bootstrapStatus: "completed", supportBaseUrl: null,
      supportMcpUrl: null, supportCredentialEnc: null, supportCredentialLabel: null,
      supportConnectorStatus: "not_configured", supportLastConnectedAt: null, supportLastSyncAt: null,
      supportLastSyncError: null } });
    await tx.customerDeploymentEvent.create({ data: { deploymentId: deployment.id,
      action: "corporate_rebels.azure_workspace_consolidated", meta: { legacyWorkspaceId: legacy.id,
        azureWorkspaceId, azureHostDeploymentId: host.id, approvedScope: "exact-target-only" } } });
    await tx.workspace.delete({ where: { id: legacy.id } });
    const result = await tx.customerDeployment.findUnique({ where: { id: deployment.id }, select: {
      id: true, cloudProvider: true, deploymentKind: true, remoteWorkspaceId: true,
      remoteWorkspaceSlug: true, managedWorkspaceId: true, releaseImageTag: true } });
    if (result?.remoteWorkspaceId !== azureWorkspaceId || result.managedWorkspaceId !== null
      || result.cloudProvider !== "AZURE") fail("Ops result verification failed.");
    return { mode: "executed", ...preflight, deployment: result };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}

export async function runCorporateRebelsConsolidation({ prisma, phase, execute = false,
  confirmation, azureWorkspaceId, readManifest } = {}) {
  if (phase !== "azure" && phase !== "ops") fail("Phase must be azure or ops.");
  if (execute && confirmation !== CONTRACT.confirmation) fail("Exact execution confirmation is required.");
  const manifest = await loadManifest(readManifest);
  return phase === "azure" ? azurePhase(prisma, manifest, execute)
    : opsPhase(prisma, azureWorkspaceId, execute);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  try {
    const receipt = await runCorporateRebelsConsolidation({ prisma, phase: process.argv[2],
      execute: process.argv.includes("--execute"), confirmation: process.env.CORPORATE_REBELS_CONFIRM,
      azureWorkspaceId: process.env.CORPORATE_REBELS_AZURE_WORKSPACE_ID });
    console.log(JSON.stringify(receipt, null, 2));
  } finally { await prisma.$disconnect(); }
}
