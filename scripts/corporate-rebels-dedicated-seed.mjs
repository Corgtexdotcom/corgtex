import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CONTRACT = Object.freeze({
  databaseHost: "corgtex-corporate-rebels-prod-pg.postgres.database.azure.com",
  databaseName: "corgtex",
  url: "https://corporate-rebels.corgtex.com",
  name: "Corporate Rebels",
  slug: "corporate-rebels",
  manifestSha256: "91935b44e00c28b0cc1cb967b241944ecd75e2e7a9fc40ccad5ebed8004aaebe",
  confirmation: "seed-corporate-rebels-dedicated-azure",
});
const manifestUrl = new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url);
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

function verifyDatabaseUrl(value) {
  let url; try { url = new URL(value); } catch { fail("Dedicated database URL is invalid."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== CONTRACT.databaseHost
    || url.port || url.pathname.slice(1) !== CONTRACT.databaseName) fail("Dedicated database identity mismatch.");
}

async function verifyHealth(fetchFn, releaseGitSha) {
  if (!/^[0-9a-f]{40}$/.test(releaseGitSha ?? "")) fail("Exact release SHA is required.");
  const response = await fetchFn(`${CONTRACT.url}/api/health`, { signal: AbortSignal.timeout(10_000) });
  const health = response.ok ? await response.json() : null;
  if (!health || health.status !== "ok" || health.database !== "up" || health.schema !== "ready"
    || health.runtime?.redis !== "configured" || health.runtime?.storage !== "configured"
    || health.release?.provider !== "azure" || health.release?.gitSha !== releaseGitSha
    || health.release?.imageTag !== `sha-${releaseGitSha}`
    || health.release?.version !== `main-${releaseGitSha.slice(0, 12)}` || health.release?.drift?.gitSha
    || health.release?.drift?.imageTag || health.release?.drift?.version) fail("Dedicated Azure health proof failed.");
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

async function verifySeed(db, workspaceId, rows, releaseGitSha) {
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true,
    name: true, slug: true, plan: true,
    _count: { select: { members: true, memberInviteRequests: true, brainSources: true, brainArticles: true } } } });
  const article = await db.brainArticle.findUnique({ where: { workspaceId_slug: { workspaceId,
    slug: "corporate-rebels-curated-source-index-2026-08-13" } }, select: { authority: true,
    isPrivate: true, publishedAt: true, frontmatterJson: true } });
  const receipt = await db.auditLog.findFirst({ where: { workspaceId,
    action: "corporate_rebels.dedicated_seeded" }, orderBy: { createdAt: "desc" }, select: { meta: true } });
  const seeded = await db.brainSource.findMany({ where: { workspaceId }, select: { externalId: true } });
  const expectedIds = new Set(rows.map((row) => `corporate-rebels-curation:${row.id}`));
  if (!workspace || workspace.name !== CONTRACT.name || workspace.slug !== CONTRACT.slug
    || workspace.plan !== "ENTERPRISE_MANAGED" || workspace._count.members
    || workspace._count.memberInviteRequests || workspace._count.brainSources !== 25
    || workspace._count.brainArticles !== 1 || seeded.length !== expectedIds.size
    || seeded.some(({ externalId }) => !expectedIds.has(externalId))
    || article?.authority !== "DRAFT" || !article.isPrivate || article.publishedAt
    || article.frontmatterJson?.manifestSha256 !== CONTRACT.manifestSha256
    || receipt?.meta?.sourceCount !== 25 || receipt.meta.releaseGitSha !== releaseGitSha
    || receipt.meta.publication !== false || receipt.meta.invitations !== false) fail("Dedicated seed verification failed.");
  return workspace;
}

async function seedDedicated(prisma, rows, releaseGitSha, execute) {
  const existing = await prisma.workspace.findMany({ where: { OR: [{ slug: CONTRACT.slug },
    { name: CONTRACT.name }] }, select: { id: true } });
  if (existing.length > 1) fail("Dedicated workspace identity is ambiguous.");
  if (existing.length) return { mode: execute ? "executed" : "preflight", phase: "seed-dedicated",
    workspace: await verifySeed(prisma, existing[0].id, rows, releaseGitSha), resumed: true };
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
      slug: "corporate-rebels-curated-source-index-2026-08-13",
      title: "Corporate Rebels Curated Source Index — 2026-08-13", type: "DIGEST", authority: "DRAFT",
      bodyMd: indexBody(rows), isPrivate: true, publishedAt: null, sourceIds: seeded.map((source) => source.id),
      frontmatterJson: { corpusCount: 25, retrievalDate: "2026-08-13",
        manifestSha256: CONTRACT.manifestSha256, projection: "workspace-only" } } });
    await tx.auditLog.create({ data: { workspaceId: workspace.id,
      action: "corporate_rebels.dedicated_seeded", entityType: "Workspace", entityId: workspace.id,
      meta: { sourceCount: 25, releaseGitSha, publication: false, invitations: false } } });
    return { mode: "executed", phase: "seed-dedicated",
      workspace: await verifySeed(tx, workspace.id, rows, releaseGitSha) };
  }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
}

export async function runCorporateRebelsDedicatedSeed({ phase, execute = false, confirmation,
  releaseGitSha, readManifest, fetchFn = fetch, prisma, databaseUrl } = {}) {
  if (phase !== "seed-dedicated") fail("Unsupported phase.");
  if (execute && confirmation !== CONTRACT.confirmation) fail("Exact execution confirmation is required.");
  verifyDatabaseUrl(databaseUrl);
  const rows = await loadManifest(readManifest);
  await verifyHealth(fetchFn, releaseGitSha);
  return seedDedicated(prisma, rows, releaseGitSha, execute);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.DATABASE_URL;
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const receipt = await runCorporateRebelsDedicatedSeed({ phase: process.argv[2],
      execute: process.argv.includes("--execute"), confirmation: process.env.CORPORATE_REBELS_CONFIRM,
      releaseGitSha: process.env.CORPORATE_REBELS_RELEASE_GIT_SHA, prisma, databaseUrl });
    console.log(JSON.stringify(receipt, null, 2));
  } finally { await prisma.$disconnect(); }
}
