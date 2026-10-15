import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const fixture = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const state = { transactionDepth: 0 };
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
  const names = ["workspaceArchiveRecord", "workspacePermalink", "brainArticle", "informationCategoryPolicy", "crmAccount", "crmContact", "crmDeal", "crmActivity", "crmDealStageTransition", "crmConversation", "crmConversationMessage",
    "crmProspectWorkspace", "crmCommunicationSuggestion", "document", "meeting", "meetingInsight", "artifactInputLineage", "artifactInputSnapshot", "workspace", "executionRequest", "executionResult", "demoLead", "crmQualification", "workflowJob", "brainSource", "mcpToolInput", "member", "user", "knowledgeChunk", "externalMcpConnection", "externalContentSource", "externalContentSyncLog", "externalProviderFetchInput", "communicationMessageNativeInput"];
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
          ...(name === "externalProviderFetchInput" ? { fetchedAt: time } : {}),
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
    const tx = new Proxy(prisma, { get(target, key) { return key === "$transaction" ? undefined : Reflect.get(target, key); } });
    state.transactionDepth++;
    try { return await run(tx); } catch (error) { for (const name of names) tables[name] = before[name]; throw error; }
    finally { state.transactionDepth--; }
  });
  return { prisma, tables, time, state, revoked: new Set<string>(), departed: new Set<string>() };
});
vi.mock("../../shared/src/env", () => ({ env: { ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/crypto"), prisma: fixture.prisma, env: { APP_URL: "https://synthetic.test" }, toInputJson: (value: unknown) => value }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: vi.fn(async ({ actor, workspaceId }) => {
  if (!["ws-crm", "ws-other"].includes(workspaceId) || fixture.departed.has(actor.user?.id ?? "agent")) throw Object.assign(new Error("Membership revoked"), { status: 403 });
  return { id: `member-${actor.user?.id ?? "agent"}`, role: actor.user?.globalRole === "OPERATOR" ? "ADMIN" : "MEMBER" };
}), requireGlobalOperator: vi.fn() }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async (actor) => actor.user?.id === "finance" && !fixture.revoked.has("finance")
  ? ["WORKSPACE", "FINANCE"] : ["WORKSPACE"]) }));
vi.mock("./crm-archive-guards", () => ({
  lockCrmLinks: vi.fn(), lockCrmLinkClosure: vi.fn(), lockCrmProspectProvisioning: vi.fn(),
  activeCrmParentWhere: () => ({}),
}));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./trial-entitlements", () => ({ assertTrialStorageCapacity: vi.fn(), lockAndAssertTrialStorageCapacity: vi.fn() }));
vi.mock("./action-policy", () => ({ evaluateDelegatedActionPolicy: vi.fn() }));
const remote = vi.hoisted(() => ({ details: { id: "file", name: "Original Box title", etag: "v1" } as Record<string, unknown>,
  content: { text: "Original Box bytes" } as Record<string, unknown>, fail: false, transport: vi.fn() }));
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readBoxExternalMcpNativeResponse: remote.transport }));

import { listArchivedWorkspaceArtifacts } from "./archive";
import { selectExternalContentSource, syncExternalContentSource, listExternalContentSources, enqueueExternalContentSourceSync } from "./external-content-sources";
import { captureExternalProviderFetchInput, createExternalProviderSyncActor, externalProviderResponseHash,
  getExternalProviderPrincipalUserId, isExternalProviderCapturedResponse, isExternalProviderFetchInputCurrent, assertExternalProviderCapturedResponseCurrent } from "./external-provider-authority";
import { prepareExternalProviderCommitPreflight, prepareExternalProviderRootCommitPreflight, withExternalProviderCommitPreflight, type ExternalProviderCommitPreflight } from "./external-provider-authority";
import { captureArtifactInputProof, captureImmutableArtifactInputProof, recordArtifactInputLineage, isArtifactInputProofReadable, readableArtifactIds, isArtifactInputProofPubliclyShareable } from "./source-lineage";
const owner = { kind: "user", user: { id: "general", email: "general@synthetic.test" } } as AppActor;
const other = { kind: "user", user: { id: "finance", email: "finance@synthetic.test" } } as AppActor;
const ws = "ws-crm";
let epochs: ReturnType<typeof installSourcePermissionEpochFixture>;
async function setup() {
  await fixture.prisma.member.create({ data: { id: "owner-member", workspaceId: ws, userId: "general", isActive: true } });
  await fixture.prisma.member.create({ data: { id: "other-member", workspaceId: ws, userId: "finance", isActive: true } });
  await fixture.prisma.user.create({ data: { id: "general", email: "general@synthetic.test", displayName: "Owner" } });
  await fixture.prisma.externalMcpConnection.create({ data: { id: "connection", workspaceId: ws, userId: "general",
    providerKey: "box", serverUrl: "https://mcp.box.com", providerAccountId: "box-owner", scopes: ["root_readwrite"], status: "ACTIVE",
    accessTokenEnc: "synthetic-token", providerEmail: "provider@synthetic.test" } });
  return selectExternalContentSource(owner, { workspaceId: ws, providerKey: "box", sourceKind: "FILE", externalId: "file", connectionId: "connection", title: "Explicit requested selection" });
}
function claimJob(index = fixture.tables.workflowJob.length - 1) {
  const job = fixture.tables.workflowJob[index]; Object.assign(job, { status: "RUNNING", attempts: 1, lockedBy: "synthetic-worker", lockedAt: fixture.time, startedAt: fixture.time }); return job;
}
async function capture(sourceId: string) {
  return captureExternalProviderFetchInput(owner, { workspaceId: ws, externalContentSourceId: sourceId, connectionId: "connection",
    sourceKind: "FILE", externalId: "file", toolName: "get_file_content", arguments: { file_id: "file" } });
}
describe("External provider live authority and copied lineage with real helpers", () => {
  beforeEach(() => {
    for (const name of Object.keys(fixture.tables)) fixture.tables[name] = [];
    fixture.revoked.clear(); fixture.departed.clear(); vi.clearAllMocks();
    fixture.prisma.$queryRaw.mockReset().mockResolvedValue([]);
    fixture.prisma.$executeRaw.mockReset().mockResolvedValue(1);
    epochs = installSourcePermissionEpochFixture(fixture.prisma);
    remote.details = { id: "file", name: "Original Box title", etag: "v1" }; remote.content = { text: "Original Box bytes" }; remote.fail = false;
    remote.transport.mockImplementation(async ({ toolName }: any) => {
      if (fixture.state.transactionDepth) throw new Error("Provider called inside a database transaction");
      if (remote.fail) throw new Error("Restricted provider payload");
      return structuredClone(toolName === "get_file_details" ? remote.details : remote.content); });
  });
  it.each(["fresh", "permalink-revocation", "later-candidates-revocation"] as const)(
    "replays original restored archive provider authority after discovery: %s", async phase => {
      const source = await setup(); const receipt = await capture(source.id);
      const roots = await captureArtifactInputProof(owner, ws, [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }]);
      const preflight = await prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [receipt] });
      const article = await fixture.prisma.$transaction((tx: any) => withExternalProviderCommitPreflight(owner, ws, tx, preflight, async () => {
        const row = await tx.brainArticle.create({ data: { id: "rebuilt-restored-article", workspaceId: ws,
          title: "Restored provider copy", bodyMd: "Original Box bytes", isPrivate: false, ownerMemberId: null, authority: "REFERENCE" } });
        await recordArtifactInputLineage({ tx, actor: owner, workspaceId: ws, artifact: { kind: "BrainArticle", id: row.id },
          content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
        return row;
      }));
      await fixture.prisma.workspaceArchiveRecord.create({ data: { id: "archive-restored", workspaceId: ws,
        entityType: "BrainArticle", entityId: article.id, archivedAt: fixture.time, restoredAt: fixture.time, purgedAt: null } });
      await fixture.prisma.workspacePermalink.create({ data: { id: "restored-permalink", workspaceId: ws,
        entityType: "BrainArticle", entityId: article.id } });
      if (phase === "later-candidates-revocation") {
        for (let i = 0; i < 100; i++) await fixture.prisma.workspaceArchiveRecord.create({ data: {
          id: `denied-${i}`, workspaceId: ws, entityType: "UnknownArtifact", entityId: `denied-${i}`,
          archivedAt: new Date(0), restoredAt: null, purgedAt: null,
        } });
      }
      const admin = { ...owner, user: { ...(owner as Extract<AppActor, { kind: "user" }>).user, globalRole: "OPERATOR" as const } } as AppActor;
      const localBefore = structuredClone(fixture.tables);
      const callsBeforeLateQuery: number[] = [];
      remote.transport.mockClear();
      const delegate = phase === "later-candidates-revocation" ? fixture.prisma.workspaceArchiveRecord : fixture.prisma.workspacePermalink;
      const original = delegate.findMany.getMockImplementation();
      let queries = 0;
      delegate.findMany.mockImplementation(async (args: any) => {
        const rows = await original(args);
        if (++queries === (phase === "later-candidates-revocation" ? 2 : 1)) {
          callsBeforeLateQuery.push(remote.transport.mock.calls.length);
          if (phase !== "fresh") remote.fail = true;
        }
        return rows;
      });
      try {
        const read = listArchivedWorkspaceArtifacts(admin, { workspaceId: ws, includeRestored: true });
        if (phase === "fresh") {
          await expect(read).resolves.toMatchObject([{ id: "archive-restored", permanentPath: `/workspaces/${ws}/items/restored-permalink` }]);
        } else await expect(read).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
        expect(callsBeforeLateQuery).toHaveLength(1);
        expect(callsBeforeLateQuery[0]).toBeGreaterThan(0);
        expect(remote.transport.mock.calls.length).toBeGreaterThan(callsBeforeLateQuery[0]);
        expect(fixture.tables).toEqual(localBefore);
        // The shared provider harness throws on any network call in a tx;
        // successful fresh release therefore also exercises the local RR fence.
        expect(fixture.state.transactionDepth).toBe(0);
      } finally { delegate.findMany.mockImplementation(original); }
    });
  it("captures encrypted exact responses with opaque runtime identity and checks every live read", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    expect(isExternalProviderCapturedResponse(receipt)).toBe(true); expect(isExternalProviderCapturedResponse({ ...receipt })).toBe(false);
    expect(receipt.input.encryptedResponseJson).not.toContain("Original Box bytes");
    expect(receipt.input.responseHash).toBe(externalProviderResponseHash(remote.content));
    expect(await isArtifactInputProofPubliclyShareable(owner, ws, await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }]))).toBe(false);
    remote.transport.mockClear();
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(true);
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(true);
    expect(remote.transport).toHaveBeenCalledTimes(2);
    expect(await isExternalProviderFetchInputCurrent(other, ws, receipt.input)).toBe(false);
    expect(await isExternalProviderFetchInputCurrent(owner, "ws-other", receipt.input)).toBe(false);
    expect(remote.transport).toHaveBeenCalledTimes(2);
  });
  it("never replays Box inside an unclaimed supplied writer transaction", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    remote.transport.mockClear();
    const tx = { ...fixture.prisma } as any;
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input, tx)).toBe(false);
    expect(remote.transport).not.toHaveBeenCalled();
  });
  it("captures all request bindings synchronously when caller params mutate while the provider is awaited", async () => {
    const source = await setup();
    const params = { workspaceId: ws, externalContentSourceId: source.id, connectionId: "connection", sourceKind: "FILE", externalId: "file",
      toolName: "get_file_content", arguments: { file_id: "file" } };
    remote.transport.mockImplementationOnce(async () => {
      params.workspaceId = "ws-other"; params.externalContentSourceId = "other-selection"; params.connectionId = "other-connection";
      params.sourceKind = "HUB"; params.externalId = "other"; params.toolName = "ai_qa_hub"; params.arguments.file_id = "other";
      await Promise.resolve(); return structuredClone(remote.content);
    });
    const receipt = await captureExternalProviderFetchInput(owner, params);
    expect(receipt.input).toMatchObject({ workspaceId: ws, externalContentSourceId: source.id, connectionId: "connection", sourceKind: "FILE",
      externalId: "file", toolName: "get_file_content", requestJson: { file_id: "file" }, localUserId: "general" });
    await expect(assertExternalProviderCapturedResponseCurrent(receipt)).resolves.toBeUndefined();
  });
  it("rejects changed caller principal during a provider await before storing a receipt", async () => {
    const source = await setup(); const mutable = { kind: "user" as const, user: { id: "general", email: "general@synthetic.test", displayName: "Owner" } };
    remote.transport.mockImplementationOnce(async () => { mutable.user.id = "finance"; await Promise.resolve(); return structuredClone(remote.content); });
    await expect(captureExternalProviderFetchInput(mutable, { workspaceId: ws, externalContentSourceId: source.id, connectionId: "connection",
      sourceKind: "FILE", externalId: "file", toolName: "get_file_content", arguments: { file_id: "file" } })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.externalProviderFetchInput).toHaveLength(0);
  });
  it("freezes nested response/request bytes and dates, rejecting persisted receipt mutation before materializing", async () => {
    const source = await setup(); remote.content = { text: "Original Box bytes", items: [{ title: "Native provider title" }] };
    const receipt = await capture(source.id);
    expect(() => { (receipt.payload as any).items[0].title = "Uncaptured copy"; }).toThrow(TypeError);
    expect(() => { (receipt.payload as any).items.push({ title: "Extra uncaptured input" }); }).toThrow(TypeError);
    expect(() => { (receipt.input.requestJson as any).file_id = "other"; }).toThrow(TypeError);
    expect(() => receipt.input.fetchedAt.setTime(0)).toThrow(TypeError);
    expect(() => Date.prototype.setTime.call(receipt.input.fetchedAt, 0)).toThrow(TypeError);
    await expect(assertExternalProviderCapturedResponseCurrent(receipt)).resolves.toBeUndefined();
    fixture.tables.externalProviderFetchInput[0].requestJson = { file_id: "other" };
    await expect(assertExternalProviderCapturedResponseCurrent(receipt)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
  it("denies tampered stored bytes, mismatched requests and missing provider identity", async () => {
    const source = await setup(); const receipt = await capture(source.id); remote.transport.mockClear();
    expect(await isExternalProviderFetchInputCurrent(owner, ws, { ...receipt.input, encryptedResponseJson: "unciphered" })).toBe(false);
    expect(await isExternalProviderFetchInputCurrent(owner, ws, { ...receipt.input, responseHash: "changed" })).toBe(false);
    expect(await isExternalProviderFetchInputCurrent(owner, ws, { ...receipt.input, requestJson: { file_id: "other" } })).toBe(false);
    expect(await isExternalProviderFetchInputCurrent(owner, ws, { ...receipt.input, providerAccountId: null })).toBe(false);
    expect(remote.transport).not.toHaveBeenCalled();
  });
  it("fails closed after disconnect, scope changes, member removal and source archive without provider fallback", async () => {
    const source = await setup(); const receipt = await capture(source.id); const connection = fixture.tables.externalMcpConnection[0];
    connection.status = "DISCONNECTED"; expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false); connection.status = "ACTIVE";
    connection.scopes = []; expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false); connection.scopes = ["root_readwrite"];
    fixture.tables.member[0].isActive = false; expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false); fixture.tables.member[0].isActive = true;
    fixture.tables.externalContentSource[0].archivedAt = fixture.time; expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false);
  });
  it("rechecks selection liveness after the provider read without queuing revoked sources", async () => {
    const source = await setup(); const receipt = await capture(source.id); const jobs = fixture.tables.workflowJob.length;
    remote.transport.mockImplementationOnce(async () => { fixture.tables.externalContentSource[0].archivedAt = fixture.time; return structuredClone(remote.content); });
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false);
    expect(fixture.tables.workflowJob).toHaveLength(jobs);
  });
  it("withholds changed content under the same etag and queues one exact recipe refetch", async () => {
    const source = await setup(); const receipt = await capture(source.id); fixture.tables.workflowJob[0].status = "COMPLETED"; const priorJobs = fixture.tables.workflowJob.length;
    remote.content.text = "Changed actual bytes";
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false);
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false);
    expect(fixture.tables.workflowJob).toHaveLength(priorJobs + 1);
    const job = fixture.tables.workflowJob.at(-1); expect(job.dedupeKey).toMatch(/^external-refetch:/);
    expect(await readableArtifactIds(owner, ws, "WorkflowJobInput", [job])).toEqual(new Set([job.id]));
  });
  it("never returns stale success or queues a refetch on provider permission/network failure", async () => {
    const source = await setup(); const receipt = await capture(source.id); const jobs = fixture.tables.workflowJob.length;
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(true); remote.fail = true;
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false);
    expect(fixture.tables.workflowJob).toHaveLength(jobs);
  });
  it("uses a single-use exact transaction capability without provider calls and leaves ordinary reads live", async () => {
    const source = await setup(); const receipt = await capture(source.id); const unrelated = await capture(source.id);
    const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    const preflight = await prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [receipt] });
    remote.transport.mockClear();
    await fixture.prisma.$transaction(async (tx: any) => {
      await withExternalProviderCommitPreflight(owner, ws, tx, preflight, async () => {
        expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input, tx)).toBe(true);
        expect(await isExternalProviderFetchInputCurrent({ ...owner }, ws, receipt.input, tx)).toBe(false);
        expect(await isExternalProviderFetchInputCurrent(owner, "ws-other", receipt.input, tx)).toBe(false);
        expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input, { ...tx })).toBe(false);
        expect(await isExternalProviderFetchInputCurrent(owner, ws, unrelated.input, tx)).toBe(false);
        expect(await isExternalProviderFetchInputCurrent(owner, ws, { ...receipt.input, responseHash: "uncaptured" }, tx)).toBe(false);
        expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(false);
        expect(remote.transport).not.toHaveBeenCalled();
      });
      await expect(withExternalProviderCommitPreflight(owner, ws, tx, preflight, async () => undefined)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    });
    expect(remote.transport).not.toHaveBeenCalled();
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(true);
    expect(await isExternalProviderFetchInputCurrent(owner, ws, receipt.input)).toBe(true);
    expect(remote.transport).toHaveBeenCalledTimes(2);
  });
  it("rejects forged capabilities, cloned fetch receipts, omitted epochs and different actors before copying", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    await expect(prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [{ ...receipt }] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prepareExternalProviderCommitPreflight(owner, ws, { roots: roots.map(root => ({ ...root, permissionEpochs: undefined })), receipts: [receipt] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const preflight = await prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [receipt] });
    const copy = vi.fn(async () => undefined); remote.transport.mockClear();
    await fixture.prisma.$transaction(async (tx: any) => {
      await expect(withExternalProviderCommitPreflight(owner, ws, tx, {} as ExternalProviderCommitPreflight, copy)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      await expect(withExternalProviderCommitPreflight(owner, ws, tx, { ...preflight }, copy)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      await expect(withExternalProviderCommitPreflight({ ...owner }, ws, tx, preflight, copy)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      await expect(withExternalProviderCommitPreflight(owner, "ws-other", tx, preflight, copy)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      await expect(withExternalProviderCommitPreflight(owner, ws, fixture.prisma, preflight, copy)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    });
    expect(copy).not.toHaveBeenCalled(); expect(remote.transport).not.toHaveBeenCalled();
  });
  it("preflights existing native roots live without creating new receipts, rejecting forged and moved roots", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    const count = fixture.tables.externalProviderFetchInput.length; remote.transport.mockClear();
    const capability = await prepareExternalProviderRootCommitPreflight(owner, ws, roots);
    expect(remote.transport).toHaveBeenCalled(); expect(fixture.tables.externalProviderFetchInput).toHaveLength(count);
    remote.transport.mockClear();
    await fixture.prisma.$transaction((tx: any) => withExternalProviderCommitPreflight(owner, ws, tx, capability, async () => {
      expect(await isArtifactInputProofReadable(owner, ws, roots, tx)).toBe(true);
    }));
    expect(remote.transport).not.toHaveBeenCalled();
    await expect(prepareExternalProviderRootCommitPreflight(owner, ws,
      roots.map(root => root.kind === "ExternalProviderFetchInput" ? { ...root, fingerprint: "a".repeat(64) } : root)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(prepareExternalProviderRootCommitPreflight(owner, ws,
      roots.map(root => ({ ...root, permissionEpochs: undefined })))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    fixture.tables.externalProviderFetchInput[0].workspaceId = "ws-other";
    await expect(prepareExternalProviderRootCommitPreflight(owner, ws, roots)).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_INPUT" });
    expect(fixture.tables.externalProviderFetchInput).toHaveLength(count);
  });
  it.each(["disconnect", "scopes", "token-rotation", "membership", "rebind", "native-bytes"])(
    "rejects local %s changes after preflight without network fallback", async change => {
      const source = await setup(); const receipt = await capture(source.id);
      const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
        [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
      const preflight = await prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [receipt] });
      if (change === "disconnect") fixture.tables.externalMcpConnection[0].status = "DISCONNECTED";
      if (change === "scopes") fixture.tables.externalMcpConnection[0].scopes = [];
      if (change === "token-rotation") {
        fixture.tables.externalMcpConnection[0].accessTokenEnc = "rotated-synthetic-token";
        epochs.bump(ws, "ExternalMcpConnection", "connection");
      }
      if (change === "membership") fixture.tables.member[0].isActive = false;
      if (change === "rebind") fixture.tables.externalContentSource[0].externalId = "new-file";
      if (change === "native-bytes") fixture.tables.externalProviderFetchInput[0].encryptedResponseJson = "changed-native-ciphertext";
      remote.transport.mockClear(); const copy = vi.fn(async () => undefined);
      await expect(fixture.prisma.$transaction((tx: any) => withExternalProviderCommitPreflight(owner, ws, tx, preflight, copy)))
        .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(copy).not.toHaveBeenCalled(); expect(remote.transport).not.toHaveBeenCalled();
    });
  it("does not refresh a revoked-and-restored original epoch proof at preflight", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    epochs.bump(ws, "ExternalContentSource", source.id);
    await expect(prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [receipt] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
  it("rejects unadapted cross-provider ancestors before opening a copy transaction", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    await fixture.prisma.communicationMessageNativeInput.create({ data: { id: "unsupported-slack-input", workspaceId: ws } });
    remote.transport.mockClear();
    await expect(prepareExternalProviderCommitPreflight(owner, ws, { receipts: [receipt], roots: [...roots,
      { kind: "CommunicationMessageNativeInput", id: "unsupported-slack-input", fingerprint: "unproven" }] }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_INPUT" });
    expect(remote.transport).not.toHaveBeenCalled();
  });
  it("revalidates the original proof after copying and rejects a changed local grant atomically", async () => {
    const source = await setup(); const receipt = await capture(source.id);
    const roots = [(source.metadata as any).selectionInputRoot, ...await captureArtifactInputProof(owner, ws,
      [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    const preflight = await prepareExternalProviderCommitPreflight(owner, ws, { roots, receipts: [receipt] });
    remote.transport.mockClear();
    await expect(fixture.prisma.$transaction((tx: any) => withExternalProviderCommitPreflight(owner, ws, tx, preflight, async () => {
      await tx.brainSource.create({ data: { workspaceId: ws, sourceType: "EXTERNAL_CONTENT", content: "Synthetic copy" } });
      fixture.tables.externalMcpConnection[0].scopes = [];
    }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.tables.brainSource).toHaveLength(0); expect(remote.transport).not.toHaveBeenCalled();
  });
  it.each(["lease", "job-manifest", "job-payload"])("rejects changed exact worker %s after live preflight", async change => {
    const source = await setup(); const job = claimJob(); const recipe = (source.metadata as any).selectionInputRoot;
    let jobRoots: Awaited<ReturnType<typeof captureArtifactInputProof>> = [];
    const actor = await createExternalProviderSyncActor({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id,
      validateInputs: async (cap, db) => { jobRoots = await captureArtifactInputProof(cap, ws, [{ kind: "WorkflowJobInput", id: job.id }], db); return isArtifactInputProofReadable(cap, ws, [recipe], db); } });
    const receipt = await captureExternalProviderFetchInput(actor, { workspaceId: ws, externalContentSourceId: source.id, connectionId: "connection",
      sourceKind: "FILE", externalId: "file", toolName: "get_file_content", arguments: { file_id: "file" } });
    const roots = [recipe, ...jobRoots, ...await captureArtifactInputProof(actor, ws, [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }])];
    await expect(prepareExternalProviderCommitPreflight(actor, ws, { roots: roots.filter(root => root.kind !== "WorkflowJobInput"), receipts: [receipt] }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const preflight = await prepareExternalProviderCommitPreflight(actor, ws, { roots, receipts: [receipt] });
    if (change === "lease") job.lockedBy = "new-worker";
    if (change === "job-manifest") fixture.tables.artifactInputLineage = fixture.tables.artifactInputLineage.filter(row => row.artifactType !== "WorkflowJobInput");
    if (change === "job-payload") job.payload = { ...job.payload, copiedUnknownValue: "Uncaptured job data" };
    remote.transport.mockClear(); const copy = vi.fn(async () => undefined);
    await expect(fixture.prisma.$transaction((tx: any) => withExternalProviderCommitPreflight(actor, ws, tx, preflight, copy)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(copy).not.toHaveBeenCalled(); expect(remote.transport).not.toHaveBeenCalled();
  });
  it("issues only a proven exact job capability, rejecting copied actors and changed leases", async () => {
    const source = await setup(); const job = claimJob(); const root = (source.metadata as any).selectionInputRoot;
    const actor = await createExternalProviderSyncActor({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id,
      validateInputs: async (cap, db) => { await captureArtifactInputProof(cap, ws, [{ kind: "WorkflowJobInput", id: job.id }], db); return isArtifactInputProofReadable(cap, ws, [root], db); } });
    expect(getExternalProviderPrincipalUserId(actor, ws)).toBe("general");
    expect(getExternalProviderPrincipalUserId({ ...actor }, ws)).toBeNull();
    const receipt = await captureExternalProviderFetchInput(actor, { workspaceId: ws, externalContentSourceId: source.id, connectionId: "connection",
      sourceKind: "FILE", externalId: "file", toolName: "get_file_content", arguments: { file_id: "file" } });
    remote.transport.mockClear();
    await fixture.prisma.externalContentSource.create({ data: { id: "other-selection", workspaceId: ws, connectionId: "connection", selectedByUserId: "general",
      providerKey: "box", sourceKind: "FILE", externalId: "other-file" } });
    await expect(captureExternalProviderFetchInput(actor, { workspaceId: ws, externalContentSourceId: "other-selection", connectionId: "connection",
      sourceKind: "FILE", externalId: "other-file", toolName: "get_file_content", arguments: { file_id: "other-file" } })).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(remote.transport).not.toHaveBeenCalled();
    job.attempts++; expect(await isExternalProviderFetchInputCurrent(actor, ws, receipt.input)).toBe(false);
  });
  it("rejects unknown job inputs before a provider call and revokes a failed provisional capability", async () => {
    const source = await setup(); const job = claimJob(); fixture.tables.artifactInputLineage = fixture.tables.artifactInputLineage.filter(row => row.artifactType !== "WorkflowJobInput");
    const syncKnowledge = vi.fn();
    await expect(syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(remote.transport).not.toHaveBeenCalled(); expect(syncKnowledge).not.toHaveBeenCalled();
    let provisional: AppActor | undefined;
    await expect(createExternalProviderSyncActor({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id,
      validateInputs: async actor => { provisional = actor; return false; } })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(getExternalProviderPrincipalUserId(provisional!, ws)).toBeNull();
  });
  it("rejects an unrelated readable snapshot grafted into a legacy selection recipe", async () => {
    const source = await setup(); const job = claimJob();
    const doc = await fixture.prisma.document.create({ data: { id: "public-original", workspaceId: ws, title: "Unrelated original", source: "api", storageKey: "public-original", metadata: {} } });
    await recordArtifactInputLineage({ tx: fixture.prisma, actor: owner, workspaceId: ws, artifact: { kind: "Document", id: doc.id }, content: doc, origin: "HUMAN_ORIGINAL", inputs: [] });
    const unrelated = await captureImmutableArtifactInputProof(owner, ws, await captureArtifactInputProof(owner, ws, [{ kind: "Document", id: doc.id }]), fixture.prisma);
    fixture.tables.externalContentSource[0].metadata.selectionInputRoot = unrelated[0];
    const syncKnowledge = vi.fn();
    await expect(syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(remote.transport).not.toHaveBeenCalled(); expect(syncKnowledge).not.toHaveBeenCalled();
  });
  it("persists complete source and Brain receipts before indexing, without widening owner audience", async () => {
    const source = await setup(); const job = claimJob();
    const syncKnowledge = vi.fn(async input => {
      expect(fixture.tables.brainSource).toHaveLength(1);
      expect(await readableArtifactIds(input.lineageActor, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set([fixture.tables.brainSource[0].id]));
      expect(input.content).toContain("Original Box bytes"); return 2;
    });
    const result = await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge });
    expect(result).toMatchObject({ status: "SYNCED", chunksCreated: 2 });
    expect(await listExternalContentSources(other, { workspaceId: ws })).toEqual([]);
    const visible = await listExternalContentSources(owner, { workspaceId: ws }); expect(visible).toHaveLength(1); expect(visible[0].syncLogs).toEqual([]);
    expect(await readableArtifactIds(other, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set());
    expect(fixture.tables.externalProviderFetchInput).toHaveLength(2);
  });
  it("checks live provider authority after the copy transaction before releasing content to indexing", async () => {
    const source = await setup(); const job = claimJob(); const syncKnowledge = vi.fn();
    const update = fixture.prisma.externalContentSource.update.getMockImplementation();
    fixture.prisma.externalContentSource.update.mockImplementationOnce(async (params: any) => {
      const saved = await update(params);
      remote.content.text = "Provider content changed after bounded copying";
      return saved;
    });
    await expect(syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(syncKnowledge).not.toHaveBeenCalled();
    expect(await readableArtifactIds(owner, ws, "BrainSource", fixture.tables.brainSource)).toEqual(new Set());
  });
  it("refetches changed bytes with stable etag from original selection while retaining history", async () => {
    const source = await setup(); const job = claimJob();
    await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: vi.fn(async () => 1) });
    job.status = "COMPLETED"; remote.content.text = "Changed actual bytes";
    expect(await listExternalContentSources(owner, { workspaceId: ws })).toEqual([]);
    const next = claimJob(); expect(next.id).not.toBe(job.id);
    const syncKnowledge = vi.fn(async (_input: any) => 1);
    await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: next.id, syncKnowledge });
    expect(syncKnowledge.mock.calls[0][0].content).toContain("Changed actual bytes"); expect(fixture.tables.brainSource).toHaveLength(2);
    expect(fixture.tables.artifactInputSnapshot.some(row => row.origin === "UNKNOWN" && JSON.stringify(row.contentJson).includes("Original Box bytes"))).toBe(true);
  });
  it("returns unchanged only when every consumed response hash is unchanged", async () => {
    const source = await setup(); const job = claimJob();
    await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: vi.fn(async () => 1) });
    job.status = "COMPLETED"; await enqueueExternalContentSourceSync(owner, { workspaceId: ws, sourceId: source.id }); const next = claimJob();
    const syncKnowledge = vi.fn(); const result = await syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: next.id, syncKnowledge });
    expect(result.status).toBe("UNCHANGED"); expect(syncKnowledge).not.toHaveBeenCalled(); expect(fixture.tables.brainSource).toHaveLength(1);
  });
  it("retries indexing after copying succeeded but indexing failed, then becomes unchanged", async () => {
    const source = await setup(); const job = claimJob();
    const run = (syncKnowledge: (input: any) => Promise<number>) => syncExternalContentSource({
      workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge,
    });
    await expect(run(async () => { throw new Error("Synthetic index failure"); })).rejects.toMatchObject({ code: "EXTERNAL_CONTENT_SYNC_FAILED" });
    expect(fixture.tables.brainSource).toHaveLength(1);
    expect(fixture.tables.externalContentSyncLog.at(-1).status).toBe("ERROR");
    const index = vi.fn(async () => 1);
    await expect(run(index)).resolves.toMatchObject({ status: "SYNCED", chunksCreated: 1 });
    expect(index).toHaveBeenCalledTimes(1);
    expect(fixture.tables.externalContentSyncLog.at(-1).status).toBe("SYNCED");
    await expect(run(index)).resolves.toMatchObject({ status: "UNCHANGED", chunksCreated: 0 });
    expect(index).toHaveBeenCalledTimes(1);
    expect(fixture.tables.brainSource).toHaveLength(2);
  });
  it("preserves prior copies and withholds raw errors on failed refetch", async () => {
    const source = await setup(); const job = claimJob(); remote.fail = true;
    await expect(syncExternalContentSource({ workspaceId: ws, sourceId: source.id, workflowJobId: job.id, syncKnowledge: vi.fn() })).rejects.toThrow("External content synchronization failed.");
    expect(fixture.tables.brainSource).toHaveLength(0);
    expect(fixture.tables.externalContentSource[0].title).toBe("Explicit requested selection");
    expect(JSON.stringify(fixture.tables.externalContentSyncLog)).not.toContain("Restricted provider payload");
  });
});
