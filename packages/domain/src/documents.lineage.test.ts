import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const time = new Date("2026-10-12T09:00:00Z");
  const match = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND") return value.every((clause: any) => match(row, clause));
    if (["conversation", "member", "account", "contact", "deal"].includes(key)) return true;
    if (key === "OR") return value.some((clause: any) => match(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.in) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("gt" in value) return row[key] > value.gt;
      if ("lt" in value) return row[key] < value.lt;
      if (value.path) return value.path.reduce((current: any, part: string) => current?.[part], row[key]) === value.equals;
      return true;
    }
    return row[key] === value;
  });
  const project = (row: any, args: any) => {
    if (!row) return null;
    let result = { ...row };
    if (args.include?.account) result.account = tables.crmAccount.find((parent) => parent.id === row.accountId) ?? null;
    if (args.include?.contact) result.contact = tables.crmContact.find((parent) => parent.id === row.contactId) ?? null;
    if (args.include?.deal) result.deal = tables.crmDeal.find((parent) => parent.id === row.dealId) ?? null;
    if (args.select) result = Object.fromEntries(Object.keys(args.select).map((key) => [key, result[key]]));
    return result;
  };
  const names = ["informationCategoryPolicy", "crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob", "brainSource", "mcpToolInput", "member", "user", "knowledgeChunk"];
  const prisma: any = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 1),
    auditLog: { create: vi.fn(async () => ({})) }, event: { createMany: vi.fn(async () => ({ count: 1 })) } };
  for (const name of names) {
    tables[name] = [];
    prisma[name] = {
      findFirst: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        return project(name === "artifactInputLineage" ? rows.at(-1) : rows[0], args);
      }),
      findUnique: vi.fn(async (args: any) => project(tables[name].find((row) => match(row, args.where)), args)),
      findMany: vi.fn(async (args: any) => {
        const rows = tables[name].filter((row) => match(row, args.where));
        const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
        rows.sort((left, right) => { for (const field of order) { const key = Object.keys(field)[0]; if (left[key] === right[key]) continue;
          return (left[key] > right[key] ? 1 : -1) * (field[key] === "desc" ? -1 : 1); } return 0; });
        if (name === "artifactInputLineage") rows.sort((left, right) => right.revision - left.revision);
        const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor.id) + (args.skip ?? 0) : args.skip ?? 0;
        return rows.slice(start, start + (args.take ?? rows.length)).map((row) => project(row, args));
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `${name}-${tables[name].length + 1}`,
          ...(["document", "brainSource", "meeting"].includes(name) ? { informationCategory: "GENERAL" } : {}), archivedAt: null, createdAt: time,
          ...(["document", "brainSource"].includes(name) ? { accessDomain: "WORKSPACE" } : {}),
          ...(name === "executionRequest" ? { status: "PENDING", results: [], claimedAt: null, completedAt: null } : {}),
          ...(name !== "crmActivity" && name !== "crmDealStageTransition" ? { updatedAt: time } : {}), ...data };
        tables[name].push(row); return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = tables[name].findIndex((row) => match(row, where));
        const patched = Object.fromEntries(Object.entries(data).map(([key, value]: [string, any]) => [key, value && typeof value === "object" && "increment" in value ? tables[name][index][key] + value.increment : value]));
        tables[name][index] = { ...tables[name][index], ...patched }; return { ...tables[name][index] };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = tables[name].filter((row) => match(row, where));
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      }),
    };
  }
  prisma.$transaction = vi.fn(async (run: (tx: any) => Promise<any>) => {
    const before = Object.fromEntries(names.map((name) => [name, tables[name].map((row) => ({ ...row }))]));
    try { return await run(prisma); } catch (error) { for (const name of names) tables[name] = before[name]; throw error; }
  });
  return { prisma, tables, time, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("../../shared/src/env", () => ({ env: { ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/crypto"), prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (!["ws-crm", "ws-other"].includes(workspaceId) || fixture.departed.has(actor.user?.id ?? "agent")) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user?.id ?? "agent"}`, role: "MEMBER" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor) => actor.user?.id === "finance" && !fixture.revoked.has("finance")
  ? ["WORKSPACE", "FINANCE"] : ["WORKSPACE"]) }));
vi.mock("./crm-archive-guards", () => ({
  lockCrmLinks: vi.fn(), lockCrmLinkClosure: vi.fn(), lockCrmProspectProvisioning: vi.fn(),
  activeCrmParentWhere: () => ({}),
}));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./trial-entitlements", () => ({ assertTrialStorageCapacity: vi.fn(), lockAndAssertTrialStorageCapacity: vi.fn() }));
import { encryptSecret } from "../../shared/src/crypto";
import { createDocument, getDocument, listDocuments } from "./documents";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, invalidateArtifactInputLineage, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { withMcpToolInputContext } from "./mcp-tool-input-context";
const general = { kind: "user", user: { id: "general", email: "general@synthetic.test" } } as AppActor;
const finance = { kind: "user", user: { id: "finance", email: "finance@synthetic.test" } } as AppActor;
const agent = { kind: "agent", authProvider: "bootstrap", label: "document", workspaceIds: ["ws-crm"] } as AppActor;
const ws = "ws-crm";
async function native(id: string, domain = "WORKSPACE", extra: Record<string, unknown> = {}) {
  const row = await fixture.prisma.document.create({ data: { id, workspaceId: ws, accessDomain: domain, title: "Same document", source: "api",
    storageKey: `native/${id}`, textContent: "Same native body", mimeType: "text/plain", metadata: {}, ...extra } });
  await recordArtifactInputLineage({ tx: fixture.prisma, actor: domain === "FINANCE" ? finance : general, workspaceId: row.workspaceId,
    artifact: { kind: "Document", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}
async function derived() {
  const source = await native("finance-original", "FINANCE", { title: "Finance original", textContent: "Finance raw original" });
  const roots = await captureArtifactInputProof(finance, ws, [{ kind: "Document", id: source.id }]);
  const doc = await createDocument(finance, { workspaceId: ws, title: "Public-looking synthesis", source: "api", storageKey: "synthesized", textContent: "Copied finance",
    lineageRoots: roots });
  return { source, doc };
}

describe("Document source receipts with real lineage gates", () => {
  beforeEach(() => { for (const name of Object.keys(fixture.tables)) fixture.tables[name] = []; fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks();
    fixture.prisma.$queryRaw.mockReset().mockResolvedValue([]);
    fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
    installSourcePermissionEpochFixture(fixture.prisma);
  });
  it("keeps native standalone originals while gating copied document bodies, source bodies, lists and counts", async () => {
    const original = await native("original"); const { source, doc } = await derived();
    expect((await listDocuments(general, ws)).map(row => row.id)).toEqual([original.id]);
    expect((await listDocuments(finance, ws)).map(row => row.id).sort()).toEqual([source.id, doc.id, original.id].sort());
    expect(await readableArtifactIds(general, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set());
    expect(await readableArtifactIds(finance, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set([fixture.tables.brainSource[0].id]));
    await expect(getDocument(general, ws, doc.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.revoked.add("finance");
    expect((await listDocuments(finance, ws)).map(row => row.id)).toEqual([original.id]);
    expect(await readableArtifactIds(finance, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set());
    expect(fixture.tables.document.find(row => row.id === source.id)?.textContent).toBe("Finance raw original");
  });
  it("withholds a legacy document without inferring originality from its type while preserving its bytes", async () => {
    const legacy = await fixture.prisma.document.create({ data: { id: "legacy", workspaceId: ws, accessDomain: "WORKSPACE",
      title: "Unproven copy", source: "api", storageKey: "legacy-original", textContent: "Legacy original bytes", metadata: {} } });
    expect(await listDocuments(general, ws)).toEqual([]);
    await expect(getDocument(general, ws, legacy.id)).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.tables.document[0].textContent).toBe("Legacy original bytes");
    expect(fixture.tables.document[0].storageKey).toBe("legacy-original");
  });
  it("withholds unknown manifests and blocks bare-agent copied writes without actual input receipts", async () => {
    const unknown = await native("unknown");
    await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId: ws, artifact: { kind: "Document", id: unknown.id }, content: unknown });
    expect(await listDocuments(general, ws)).toEqual([]);
    await expect(createDocument(agent, { workspaceId: ws, title: "Uncaptured", source: "api", storageKey: "agent", textContent: "Uncaptured model text" })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.tables.document).toHaveLength(1); expect(fixture.tables.brainSource).toHaveLength(0);
  });
  it("filters unknown and other-reader candidates before duplicate ranking and explicit target choice", async () => {
    const hidden = await native("hidden");
    await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId: ws, artifact: { kind: "Document", id: hidden.id }, content: hidden });
    const input = { workspaceId: ws, title: hidden.title, source: "api", storageKey: "incoming", textContent: hidden.textContent,
      duplicateGuard: { resolution: "use_existing" as const, targetEntityId: hidden.id } };
    await expect(createDocument(general, input)).rejects.toMatchObject({ code: "DUPLICATE_GUARD_TARGET_NOT_FOUND" });
    const { doc } = await derived();
    await expect(createDocument(general, { ...input, title: doc.title, textContent: doc.textContent, duplicateGuard: { resolution: "use_existing", targetEntityId: doc.id } })).rejects.toMatchObject({ code: "DUPLICATE_GUARD_TARGET_NOT_FOUND" });
  });
  it("scans past a full hidden page before selecting an admitted duplicate", async () => {
    for (let i = 0; i < 105; i++) {
      const hidden = await native(`hidden-${i.toString().padStart(3, "0")}`);
      await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId: ws, artifact: { kind: "Document", id: hidden.id }, content: hidden });
    }
    const visible = await native("visible", "WORKSPACE", { updatedAt: new Date("2026-10-11") });
    const result = await createDocument(general, { workspaceId: ws, title: visible.title, source: "api", storageKey: "new", textContent: visible.textContent,
      duplicateGuard: { resolution: "use_existing", targetEntityId: visible.id } });
    expect(result.id).toBe(visible.id); expect(fixture.tables.document).toHaveLength(106);
    expect((await listDocuments(general, ws)).map(row => row.id)).toEqual([visible.id]);
    expect(fixture.prisma.document.findMany.mock.calls.some(([args]: any[]) => args.take === 10001 && args.where.id?.gt === undefined)).toBe(true);
  });
  it("preserves native prior document revisions and unknown legacy source bodies before complete regeneration", async () => {
    const doc = await native("existing");
    const legacy = await fixture.prisma.brainSource.create({ data: { id: "legacy-source", workspaceId: ws, sourceType: "DOC", tier: 2, title: "Unproven old title", channel: "api",
      content: "Unproven source body", fileStorageKey: "workspaces/ws-other/restricted.bin", ingestionGuidanceMd: "Unproven old instructions", accessDomain: "WORKSPACE", metadata: { documentId: doc.id } } });
    await invalidateArtifactInputLineage({ tx: fixture.prisma, workspaceId: ws, artifact: { kind: "BrainSource", id: legacy.id }, content: legacy });
    const updated = await createDocument(general, { workspaceId: ws, title: doc.title, source: "api", storageKey: "incoming", textContent: doc.textContent,
      metadata: { note: "New native note" }, duplicateGuard: { resolution: "update_existing", targetEntityId: doc.id } });
    expect(updated.id).toBe(doc.id);
    expect(fixture.tables.artifactInputSnapshot.some(row => row.sourceKind === "Document" && row.sourceId === doc.id && row.origin === "HUMAN_ORIGINAL")).toBe(true);
    expect(fixture.tables.artifactInputSnapshot.some(row => row.sourceKind === "BrainSource" && row.origin === "UNKNOWN" && row.contentJson.content === "Unproven source body")).toBe(true);
    expect(fixture.tables.brainSource[0].title).toBe(doc.title); expect(fixture.tables.brainSource[0].ingestionGuidanceMd).toBeNull();
    expect(fixture.tables.brainSource[0].fileStorageKey).toBeNull();
    expect(await readableArtifactIds(general, ws, "Document", fixture.tables.document)).toEqual(new Set([doc.id]));
    expect(await readableArtifactIds(general, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set([legacy.id]));
  });
  it("does not promote unmanifested copied sources when their Document link is removed", async () => {
    const { doc } = await derived();
    const legacy = await fixture.prisma.brainSource.create({ data: { id: "unmanifested", workspaceId: ws, sourceType: "DOC", tier: 2, title: "Hidden legacy copy", content: "Private legacy copy",
      accessDomain: "WORKSPACE", metadata: { documentId: doc.id } } });
    expect(await readableArtifactIds(general, ws, "BrainSource", [legacy])).toEqual(new Set());
    expect(await readableArtifactIds(finance, ws, "BrainSource", [legacy])).toEqual(new Set());
    fixture.tables.brainSource.at(-1).metadata = {};
    expect(await readableArtifactIds(general, ws, "BrainSource", [fixture.tables.brainSource.at(-1)])).toEqual(new Set());
  });
  it("rejects changed captured inputs and changed source linkage before any document/source mutation", async () => {
    const source = await native("source"); const roots = await captureArtifactInputProof(general, ws, [{ kind: "Document", id: source.id }]);
    fixture.tables.document[0].metadata = { changed: true };
    await expect(createDocument(general, { workspaceId: ws, title: "Changed", source: "api", storageKey: "new", textContent: "Old source copy", lineageRoots: roots })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.document).toHaveLength(1);
  });
  it("propagates native MCP input grants into document and copied source instead of certifying a human original", async () => {
    const tool = await fixture.prisma.mcpToolInput.create({ data: { id: "tool", workspaceId: ws, actorKind: "user", userId: "general",
      credentialId: null, credentialVersion: null, scopeHash: null, toolName: "create_document", requiredScopes: ["documents:write"], argumentsJson: encryptSecret(JSON.stringify({ textContent: "Captured request body" })) } });
    const roots = await captureArtifactInputProof(general, ws, [{ kind: "McpToolInput", id: tool.id }]);
    const frozen = await captureImmutableArtifactInputProof(general, ws, roots, fixture.prisma);
    const doc = await withMcpToolInputContext(general, ws, frozen, () => createDocument(general, { workspaceId: ws, title: "Tool copy", source: "api", storageKey: "tool", textContent: "Captured request body" }));
    expect(fixture.tables.artifactInputLineage.find(row => row.artifactType === "Document" && row.artifactId === doc.id)?.origin).toBe("DERIVED");
    expect(await readableArtifactIds(finance, ws, "Document", [doc])).toEqual(new Set());
    expect(await readableArtifactIds(finance, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set());
    expect((await getDocument(general, ws, doc.id)).textContent).toBe("Captured request body");
  });
  it("does not return foreign workspace rows and stops after current membership loss", async () => {
    await native("own"); await native("foreign", "WORKSPACE", { workspaceId: "ws-other" });
    expect((await listDocuments(general, ws)).map(row => row.id)).toEqual(["own"]);
    fixture.departed.add("general"); await expect(listDocuments(general, ws)).rejects.toThrow("Membership revoked");
    expect(fixture.tables.document.find(row => row.id === "own")?.textContent).toBe("Same native body");
  });
});
