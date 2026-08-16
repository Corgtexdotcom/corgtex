import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTRACT, loadManifest, parseCsv,
  runCorporateRebelsDedicatedSeed } from "./corporate-rebels-dedicated-seed.mjs";

const SHA = "a".repeat(40);
const manifest = () => readFile(new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url));
const health = () => ({ status: "ok", database: "up", schema: "ready",
  runtime: { redis: "configured", storage: "configured" }, release: { provider: "azure", gitSha: SHA,
    imageTag: `sha-${SHA}`, version: `main-${SHA.slice(0, 12)}`,
    drift: { gitSha: false, imageTag: false, version: false } } });
const healthy = async () => ({ ok: true, json: async () => health() });
const databaseUrl = `postgresql://user:pass@${CONTRACT.databaseHost}/${CONTRACT.databaseName}`;

function fake(options = {}) {
  const state = { workspaces: options.workspaces ?? [{ id: "sentinel", name: "Other", slug: "other" }],
    sources: [], articles: [], receipts: [], policies: [] };
  const counts = () => ({ members: options.members ?? 0, memberInviteRequests: options.invites ?? 0,
    brainSources: state.sources.length, brainArticles: state.articles.length });
  const workspace = {
    findMany: async ({ where }) => state.workspaces.filter((item) => !where
      || item.slug === CONTRACT.slug || item.name === CONTRACT.name).map(({ id }) => ({ id })),
    findUnique: async ({ where }) => { const row = state.workspaces.find((item) => item.id === where.id);
      return row ? { ...row, _count: counts() } : null; },
    create: async ({ data }) => { const row = { id: "11111111-1111-4111-8111-111111111111", ...data };
      state.workspaces.push(row); return row; },
  };
  const tx = { workspace,
    approvalPolicy: { create: async ({ data }) => { state.policies.push(data); } },
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
    expect(target.state.workspaces).toHaveLength(1);
  });

  it("creates one private workspace seed and resumes without duplicates", async () => {
    const target = fake();
    const receipt = await run(target);
    expect(receipt.workspace._count).toEqual({ members: 0, memberInviteRequests: 0,
      brainSources: 25, brainArticles: 1 });
    expect(target.state.articles[0]).toMatchObject({ authority: "DRAFT", isPrivate: true, publishedAt: null });
    expect(target.state.receipts[0].meta).toEqual({ sourceCount: 25, releaseGitSha: SHA,
      publication: false, invitations: false });
    await expect(run(target)).resolves.toMatchObject({ resumed: true, workspace: { id: receipt.workspace.id } });
    expect({ workspaces: target.state.workspaces.length, sources: target.state.sources.length,
      articles: target.state.articles.length, receipts: target.state.receipts.length })
      .toEqual({ workspaces: 2, sources: 25, articles: 1, receipts: 1 });
  });

  it("rejects foreign databases and unhealthy releases before writes", async () => {
    for (const url of ["postgresql://u:p@foreign.invalid/corgtex",
      `postgresql://u:p@${CONTRACT.databaseHost}:5432/corgtex`,
      `postgresql://u:p@${CONTRACT.databaseHost}/foreign`]) {
      const target = fake();
      await expect(run(target, { databaseUrl: url })).rejects.toThrow("database identity");
      expect(target.state.workspaces).toHaveLength(1);
    }
    for (const body of [{ ...health(), status: "down" },
      { ...health(), runtime: { redis: "missing", storage: "configured" } },
      { ...health(), release: { ...health().release, version: "main-wrong" } }]) {
      const target = fake();
      await expect(run(target, { fetchFn: async () => ({ ok: true,
        json: async () => body }) })).rejects.toThrow("health proof");
      expect(target.state.workspaces).toHaveLength(1);
    }
  });

  it("rejects ambiguous or unverifiable existing Corporate Rebels state", async () => {
    const rows = [{ id: "one", name: CONTRACT.name, slug: CONTRACT.slug },
      { id: "two", name: CONTRACT.name, slug: "other" }];
    await expect(run(fake({ workspaces: rows }))).rejects.toThrow("ambiguous");
    const existing = fake({ workspaces: [{ id: "one", name: CONTRACT.name,
      slug: CONTRACT.slug, plan: "ENTERPRISE_MANAGED" }] });
    await expect(run(existing)).rejects.toThrow("seed verification");
  });
});
