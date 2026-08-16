import { describe, expect, it } from "vitest";
import { CONTRACT, loadManifest, parseCsv, runCorporateRebelsConsolidation } from "./corporate-rebels-azure-consolidation.mjs";
const manifestBytes = () => import("node:fs/promises").then(({ readFile }) => readFile(
  new URL("./data/corporate-rebels-source-manifest-2026-08-13.csv", import.meta.url)));
function fakeDatabase(kind, { ambiguous = false, attachments = 0, orphanable = 0,
  failSources = false, drift = false, invalidHost = false } = {}) {
  const oldId = kind === "azure" ? CONTRACT.azureLegacyWorkspaceId : CONTRACT.opsLegacyWorkspaceId;
  const state = { workspaces: [{ id: oldId, name: CONTRACT.name, slug: CONTRACT.slug },
    { id: "other-workspace", name: "Untouched Tenant", slug: "untouched-tenant" }], members: [{ workspaceId: oldId }],
    invites: [], sources: [{ workspaceId: oldId }], articles: [], policies: [], audits: [], events: [], ledger: [] };
  if (ambiguous) state.workspaces.push({ id: "collision", name: CONTRACT.name, slug: "collision" });
  const count = (workspaceId, key) => state[key].filter((row) => row.workspaceId === workspaceId).length;
  const workspaceModel = {
    findUnique: async ({ where }) => { const row = state.workspaces.find((entry) => entry.id === where.id);
      return row ? { ...row, _count: { members: count(row.id, "members"), memberInviteRequests: count(row.id, "invites"),
        brainSources: count(row.id, "sources"), brainArticles: count(row.id, "articles"), documents: 0, meetings: 0,
        externalMcpConnections: 0, externalDataSources: 0, externalResourceAttachments: 0,
        communicationInstallations: 0, appInstallations: 0 } } : null; },
    findMany: async () => state.workspaces.filter((row) => row.slug === CONTRACT.slug || row.name === CONTRACT.name)
      .map(({ id }) => ({ id })),
    delete: async ({ where }) => { state.ledger.push(`workspace.delete:${where.id}`);
      state.workspaces = state.workspaces.filter((row) => row.id !== where.id);
      for (const key of ["members", "invites", "sources", "articles"]) state[key] = state[key].filter(
        (row) => row.workspaceId !== where.id); },
    create: async ({ data }) => { const row = { id: "11111111-1111-4111-8111-111111111111", ...data };
      state.ledger.push(`workspace.create:${data.slug}`); state.workspaces.push(row); return row; },
  };
  const deployment = { id: CONTRACT.opsDeploymentId, managedWorkspaceId: oldId,
    customerAccountId: CONTRACT.opsAccountId, customerSlug: CONTRACT.slug,
    label: CONTRACT.name, cloudProvider: "RAILWAY", lastHealthError: "stale Railway error", lastWorkerHealthStatus: "stale",
    lastReleaseCheck: new Date("2025-01-01T00:00:00.000Z") };
  const host = { id: CONTRACT.azureHostDeploymentId, cloudProvider: "AZURE", deploymentStatus: "ACTIVE",
    url: "https://selfserve.corgtex.com", region: "westus3", dataResidency: "US",
    providerResourceGroup: CONTRACT.azureResourceGroup, providerEnvironmentId: invalidHost ? null : CONTRACT.azureEnvironmentId,
    providerWebServiceId: CONTRACT.azureWebServiceId, providerWorkerServiceId: CONTRACT.azureWorkerServiceId,
    releaseImageTag: "sha-reviewed", lastHealthStatus: "ok", lastHealthError: null, lastWorkerHealthStatus: "ok",
    lastWorkerHealthCheck: new Date("2026-08-15T00:00:00.000Z"), lastReleaseCheck: null };
  const tx = { workspace: workspaceModel,
    approvalPolicy: { create: async ({ data }) => { state.policies.push(data); } },
    brainSource: { count: async () => attachments,
      createMany: async ({ data }) => { if (failSources) throw new Error("seed failed");
        state.sources.push(...data); } },
    document: { count: async () => 0 }, meetingAudioAsset: { count: async () => 0 },
    workspaceExternalResourceAttachment: { count: async () => 0 },
    buildArtifactAsset: { count: async () => 0 },
    event: { count: async () => 0 }, workflowJob: { count: async () => 0 },
    meetingRecorderProviderEvent: { count: async () => 0 }, communicationInboundEvent: { count: async () => orphanable },
    brainArticle: { create: async ({ data }) => { state.articles.push({ id: "article", ...data }); } },
    auditLog: { create: async ({ data }) => { state.audits.push(data); } },
    customerDeployment: { findUnique: async ({ where }) => where.id === deployment.id ? deployment : host,
      update: async ({ data }) => { state.ledger.push(`deployment.update:${deployment.id}`);
        Object.assign(deployment, data); return deployment; } },
    customerAccount: { findUnique: async () => ({ id: CONTRACT.opsAccountId, slug: CONTRACT.slug,
      displayName: CONTRACT.name, primaryDeploymentId: CONTRACT.opsDeploymentId }) },
    customerDeploymentEvent: { create: async ({ data }) => { state.events.push(data); } },
  };
  const prisma = { ...tx, $transaction: async (callback) => { const snapshot = structuredClone(state);
    if (drift) state.workspaces.find((row) => row.id === oldId).slug = "drifted";
    try { return await callback(tx); } catch (error) { for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, snapshot); throw error; } } };
  return { prisma, state, deployment };
}

describe("Corporate Rebels Azure consolidation", () => {
  it("pins the authoritative 25-row manifest and parses quoted commas", async () => {
    const manifest = await loadManifest();
    expect(manifest).toMatchObject({ digest: CONTRACT.manifestSha256, rows: { length: 25 } });
    expect(parseCsv('a,b\n"one, two","three"\n')).toEqual([{ a: "one, two", b: "three" }]);
    await expect(loadManifest(async () => Buffer.from("drift"))).rejects.toThrow("digest mismatch");
  });
  it("keeps Azure preflight read-only", async () => {
    const { prisma, state } = fakeDatabase("azure");
    const receipt = await runCorporateRebelsConsolidation({ prisma, phase: "azure", readManifest: manifestBytes });
    expect(receipt).toMatchObject({ mode: "preflight", phase: "azure", manifestCount: 25 });
    expect(state.ledger).toEqual([]);
  });
  it("requires the exact execution confirmation before any write", async () => {
    const { prisma, state } = fakeDatabase("azure");
    await expect(runCorporateRebelsConsolidation({ prisma, phase: "azure", execute: true,
      confirmation: "approved", readManifest: manifestBytes })).rejects.toThrow("Exact execution confirmation");
    expect(state.ledger).toEqual([]);
  });
  it("atomically replaces the Azure legacy workspace with private seeded state and no users", async () => {
    const { prisma, state } = fakeDatabase("azure");
    const receipt = await runCorporateRebelsConsolidation({ prisma, phase: "azure", execute: true,
      confirmation: CONTRACT.confirmation, readManifest: manifestBytes });
    expect(receipt.azureWorkspace._count).toMatchObject({ members: 0, memberInviteRequests: 0,
      brainSources: 25, brainArticles: 1 });
    expect(state.workspaces.map((row) => row.id)).toContain("other-workspace");
    expect(state.sources).toHaveLength(25);
    expect(state.articles[0]).toMatchObject({ authority: "DRAFT", isPrivate: true, publishedAt: null });
    expect(state.articles[0].sourceIds).toHaveLength(25);
  });
  it("fails closed on ambiguous Corporate Rebels identity", async () => {
    const { prisma, state } = fakeDatabase("azure", { ambiguous: true });
    await expect(runCorporateRebelsConsolidation({ prisma, phase: "azure",
      readManifest: manifestBytes })).rejects.toThrow("identity is ambiguous");
    expect(state.ledger).toEqual([]);
  });
  it("fails closed before deletion when file attachments exist", async () => {
    const { prisma, state } = fakeDatabase("azure", { attachments: 1 });
    await expect(runCorporateRebelsConsolidation({ prisma, phase: "azure",
      readManifest: manifestBytes })).rejects.toThrow("has file attachments");
    expect(state.ledger).toEqual([]);
  });
  it("revalidates identity and orphanable payloads inside the destructive transaction", async () => {
    for (const options of [{ drift: true }, { orphanable: 1 }]) {
      const { prisma, state } = fakeDatabase("azure", options);
      await expect(runCorporateRebelsConsolidation({ prisma, phase: "azure", execute: true,
        confirmation: CONTRACT.confirmation, readManifest: manifestBytes })).rejects.toThrow();
      expect(state.workspaces.some((row) => row.id === CONTRACT.azureLegacyWorkspaceId)).toBe(true);
    }
  });

  it("rolls back the Azure transaction when seeding fails", async () => {
    const { prisma, state } = fakeDatabase("azure", { failSources: true });
    await expect(runCorporateRebelsConsolidation({ prisma, phase: "azure", execute: true,
      confirmation: CONTRACT.confirmation, readManifest: manifestBytes })).rejects.toThrow("seed failed");
    expect(state.workspaces.some((row) => row.id === CONTRACT.azureLegacyWorkspaceId)).toBe(true);
    expect(state.ledger).toEqual([]);
  });

  it("moves only the exact Ops registry to Azure and deletes only its legacy workspace", async () => {
    const { prisma, state, deployment } = fakeDatabase("ops");
    const azureResult = await runCorporateRebelsConsolidation({ prisma: fakeDatabase("azure").prisma,
      phase: "azure", execute: true, confirmation: CONTRACT.confirmation, readManifest: manifestBytes });
    const azureWorkspaceId = azureResult.azureWorkspace.id;
    const receipt = await runCorporateRebelsConsolidation({ prisma, phase: "ops", execute: true,
      confirmation: CONTRACT.confirmation, azureWorkspaceId, azurePhaseEvidence: azureResult.azureEvidence,
      readManifest: manifestBytes });
    expect(receipt.deployment).toMatchObject({ cloudProvider: "AZURE", remoteWorkspaceId: azureWorkspaceId,
      managedWorkspaceId: null });
    expect(deployment).toMatchObject({ deploymentKind: "SHARED_WORKSPACE", lastHealthError: null,
      lastWorkerHealthStatus: "ok", lastReleaseCheck: null });
    expect(deployment.url).toBe(CONTRACT.azureWebUrl);
    expect(state.workspaces).toEqual([{ id: "other-workspace", name: "Untouched Tenant", slug: "untouched-tenant" }]);
    expect(state.events).toHaveLength(1);
    const drifted = fakeDatabase("ops", { drift: true });
    await expect(runCorporateRebelsConsolidation({ prisma: drifted.prisma, phase: "ops", execute: true,
      confirmation: CONTRACT.confirmation, azureWorkspaceId, azurePhaseEvidence: azureResult.azureEvidence,
      readManifest: manifestBytes })).rejects.toThrow("workspace");
    expect(drifted.state.ledger).toEqual([]);
  });

  it("rejects malformed, legacy, unverified, or wrong-host Ops destinations", async () => {
    const azureResult = await runCorporateRebelsConsolidation({ prisma: fakeDatabase("azure").prisma,
      phase: "azure", execute: true, confirmation: CONTRACT.confirmation, readManifest: manifestBytes });
    for (const [azureWorkspaceId, azurePhaseEvidence, invalidHost] of [
      ["not-a-uuid", "bad", false], [CONTRACT.opsLegacyWorkspaceId, "bad", false],
      ["11111111-1111-4111-8111-111111111111", "bad", false],
      [azureResult.azureWorkspace.id, azureResult.azureEvidence, true],
    ]) {
      const { prisma, state } = fakeDatabase("ops", { invalidHost });
      await expect(runCorporateRebelsConsolidation({ prisma, phase: "ops", azureWorkspaceId,
        azurePhaseEvidence, readManifest: manifestBytes })).rejects.toThrow();
      expect(state.ledger).toEqual([]);
    }
  });
});
