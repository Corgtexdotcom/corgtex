import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTRACT, loadManifest, parseCsv,
  runCorporateRebelsDedicatedSeed } from "./corporate-rebels-dedicated-seed.mjs";

const SHA = "a".repeat(40);
const manifest = () => readFile(new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url));
const health = () => ({ status: "ok", database: "up", schema: "ready",
  runtime: { redis: "configured", storage: "configured", workspaceScopeSlug: CONTRACT.slug,
    workspaceScopeValid: true },
  release: { provider: "azure", gitSha: SHA,
    runtime: { gitSha: SHA, source: "github" },
    imageTag: `sha-${SHA}`, version: `main-${SHA.slice(0, 12)}`,
    drift: { gitSha: false, imageTag: false, version: false } } });
const healthy = async () => ({ ok: true, json: async () => health() });
const databaseUrl = `postgresql://user:pass@${CONTRACT.databaseHost}/${CONTRACT.databaseName}?sslmode=require`;

function fake(options = {}) {
  const state = { workspaces: options.workspaces ?? [],
    users: [], members: [], sources: [], articles: [], receipts: [], policies: [] };
  const counts = () => ({ members: state.members.length, memberInviteRequests: options.invites ?? 0,
    brainSources: state.sources.length, brainArticles: state.articles.length });
  const workspace = {
    findMany: async ({ where, select }) => state.workspaces.filter((item) => !where
      || item.slug === CONTRACT.slug || item.name === CONTRACT.name)
      .map((item) => Object.fromEntries(Object.keys(select).map((key) => [key, item[key]]))),
    findUnique: async ({ where }) => { const row = state.workspaces.find((item) => item.id === where.id);
      return row ? { ...row, members: state.members.map((member) => ({ ...member,
        user: state.users.find((user) => user.id === member.userId) })), _count: counts() } : null; },
    upsert: async ({ where, update, create }) => { const existing = state.workspaces.find((item) => item.slug === where.slug);
      if (existing) { Object.assign(existing, update); return existing; }
      const row = { id: "11111111-1111-4111-8111-111111111111", ...create };
      state.workspaces.push(row); return row; },
  };
  const tx = { workspace,
    user: { findMany: async () => [], create: async ({ data }) => { const user = {
      id: "22222222-2222-4222-8222-222222222222", ...data }; state.users.push(user); return user; } },
    member: { upsert: async ({ create }) => { state.members.push(create); return create; } },
    approvalPolicy: { createMany: async ({ data }) => { state.policies.push(...data); } },
    brainSource: { createMany: async ({ data }) => { state.sources.push(...data); },
      findMany: async ({ where }) => state.sources.filter((row) => row.workspaceId === where.workspaceId) },
    brainArticle: { create: async ({ data }) => { state.articles.push(data); },
      findUnique: async () => state.articles[0] ?? null },
    auditLog: { create: async ({ data }) => { state.receipts.push(data); },
      findFirst: async () => state.receipts.length ? { meta: state.receipts.at(-1).meta } : null } };
  return { state, prisma: { ...tx, $transaction: async (callback) => callback(tx) } };
}

const run = (target, extra = {}) => runCorporateRebelsDedicatedSeed({ phase: "seed-dedicated",
  execute: true, confirmation: CONTRACT.confirmation, releaseGitSha: SHA, readManifest: manifest,
  fetchFn: healthy, prisma: target.prisma, databaseUrl, ...extra });

describe("Corporate Rebels dedicated seed", () => {
  it("loads through the plain Node operational entrypoint", () => {
    expect(() => execFileSync(process.execPath, ["-e",
      'import("./scripts/corporate-rebels-dedicated-seed.mjs")'], {
      cwd: new URL("..", import.meta.url), stdio: "pipe",
    })).not.toThrow();
  });

  it("pins the 25-row manifest and parses quoted commas", async () => {
    expect(await loadManifest()).toHaveLength(25);
    expect(parseCsv('a,b\n"one, two",three\n')).toEqual([{ a: "one, two", b: "three" }]);
    await expect(loadManifest(async () => Buffer.from("drift"))).rejects.toThrow("digest mismatch");
    const source = await readFile(new URL("./corporate-rebels-dedicated-seed.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.delete\(|customerDeployment|customerAccount|selfServe|opsPrisma/);
  });

  it("keeps preflight read-only and requires exact execution confirmation", async () => {
    const target = fake();
    const params = { phase: "seed-dedicated", releaseGitSha: SHA, readManifest: manifest,
      fetchFn: healthy, prisma: target.prisma, databaseUrl };
    await expect(runCorporateRebelsDedicatedSeed(params)).resolves.toMatchObject({ mode: "preflight" });
    await expect(runCorporateRebelsDedicatedSeed({ ...params, execute: true,
      confirmation: "wrong" })).rejects.toThrow("confirmation");
    expect(target.state.workspaces).toHaveLength(0);
  });

  it("creates one private workspace seed and resumes without duplicates", async () => {
    const target = fake();
    const receipt = await run(target);
    expect(receipt.workspace._count).toEqual({ members: 1, memberInviteRequests: 0,
      brainSources: 25, brainArticles: 1 });
    expect(receipt.workspace.members).toEqual([expect.objectContaining({
      role: "ADMIN", kind: "SYSTEM", isActive: false,
      user: expect.objectContaining({ email: "system+corporate-rebels@corgtex.local" }),
    })]);
    expect(target.state.articles[0]).toMatchObject({ authority: "DRAFT", isPrivate: true, publishedAt: null });
    expect(target.state.sources[0].metadata.sourceUrl).toBe(target.state.sources[0].metadata.canonicalUrl);
    expect(target.state.receipts[0].meta).toEqual({ sourceCount: 25, releaseGitSha: SHA,
      publication: false, invitations: false });
    await expect(run(target)).resolves.toMatchObject({ resumed: true, workspace: { id: receipt.workspace.id } });
    expect({ workspaces: target.state.workspaces.length, sources: target.state.sources.length,
      articles: target.state.articles.length, receipts: target.state.receipts.length })
      .toEqual({ workspaces: 1, sources: 25, articles: 1, receipts: 1 });
  });

  it("rejects foreign databases and unhealthy releases before writes", async () => {
    for (const url of ["postgresql://u:p@foreign.invalid/corgtex",
      `postgresql://u:p@${CONTRACT.databaseHost}:5432/corgtex`,
      `postgresql://u:p@${CONTRACT.databaseHost}/foreign?sslmode=require`,
      `postgresql://u:p@${CONTRACT.databaseHost}/corgtex?sslmode=require&schema=staging`]) {
      const target = fake();
      await expect(run(target, { databaseUrl: url })).rejects.toThrow("database identity");
      expect(target.state.workspaces).toHaveLength(0);
    }
    for (const body of [{ ...health(), status: "down" },
      { ...health(), runtime: { redis: "missing", storage: "configured" } },
      { ...health(), runtime: { ...health().runtime, workspaceScopeSlug: "wrong" } },
      { ...health(), release: { ...health().release, runtime: { gitSha: null, source: "missing" } } },
      { ...health(), release: { ...health().release, version: "main-wrong" } }]) {
      const target = fake();
      await expect(run(target, { fetchFn: async () => ({ ok: true,
        json: async () => body }) })).rejects.toThrow("health proof");
      expect(target.state.workspaces).toHaveLength(0);
    }
  });

  it("rejects ambiguous or unverifiable existing Corporate Rebels state", async () => {
    await expect(run(fake({ workspaces: [{ id: "sentinel", name: "Other", slug: "other" }] })))
      .rejects.toThrow("foreign workspace");
    const rows = [{ id: "one", name: CONTRACT.name, slug: CONTRACT.slug },
      { id: "two", name: CONTRACT.name, slug: "other" }];
    await expect(run(fake({ workspaces: rows }))).rejects.toThrow("ambiguous");
    const existing = fake({ workspaces: [{ id: "one", name: CONTRACT.name,
      slug: CONTRACT.slug, plan: "ENTERPRISE_MANAGED" }] });
    await expect(run(existing)).rejects.toThrow("seed verification");
    const corrupted = fake(); await run(corrupted);
    corrupted.state.sources[1] = { ...corrupted.state.sources[0], id: "duplicate" };
    await expect(run(corrupted)).rejects.toThrow("seed verification");
    corrupted.state.sources[1] = { ...corrupted.state.sources[0],
      externalId: "corporate-rebels-curation:CR-002", accessDomain: "PUBLIC" };
    await expect(run(corrupted)).rejects.toThrow("seed verification");
    const indexDrift = fake(); await run(indexDrift); indexDrift.state.articles[0].bodyMd = "corrupted";
    await expect(run(indexDrift)).rejects.toThrow("seed verification");
    const archived = fake(); await run(archived); archived.state.sources[0].archivedAt = new Date();
    await expect(run(archived)).rejects.toThrow("seed verification");
    const archivedIndex = fake(); await run(archivedIndex); archivedIndex.state.articles[0].archivedAt = new Date();
    await expect(run(archivedIndex)).rejects.toThrow("seed verification");
  });
});
