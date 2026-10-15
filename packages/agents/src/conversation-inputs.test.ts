import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSourcePermissionEpochFixture } from "../../domain/src/source-permission-epochs.test-fixture";
import type { AppActor } from "@corgtex/shared";
import type { LineageKind, LineageRoot } from "../../domain/src/source-lineage";
import type { ConversationPageContext } from "./page-context";

const fixture = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>();
  const memberships = new Map<string, { id: string; role: string }>();
  const manifests: any[] = [];
  const delegates = new Map<string, any>();
  const membership = vi.fn();
  const onboarding = vi.fn();
  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    if (where.AND && !where.AND.every((item: any) => matches(row, item))) return false;
    for (const [key, value] of Object.entries(where)) {
      if (key === "AND") continue;
      if (key === "OR") { if (!(value as any[]).some(item => matches(row, item))) return false; continue; }
      if (key === "conversation") {
        if (!matches(tables.get("conversationSession")?.get(row.conversationId), value)) return false;
      } else if (typeof value === "object" && value !== null && "in" in value) {
        if (!(value.in as string[]).includes(row[key])) return false;
      } else if (typeof value === "object" && value !== null && "lt" in value) {
        if (!(row[key] < value.lt!)) return false;
      } else if (row[key] !== value) return false;
    }
    return true;
  };
  const project = (row: any, select: any) => select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : structuredClone(row);
  const base = {
    $transaction: vi.fn(), $executeRaw: vi.fn(), $queryRaw: vi.fn(),
    artifactInputLineage: {
      findFirst: vi.fn(async ({ where }) => [...manifests].reverse().find((item) => Object.entries(where).every(([key, value]) => item[key] === value)) ?? null),
      findMany: vi.fn(async ({ where }) => [...manifests].reverse().filter((item) => item.workspaceId === where.workspaceId && item.artifactType === where.artifactType
        && where.artifactId.in.includes(item.artifactId))),
      create: vi.fn(async ({ data }) => { const row = { id: `manifest-${manifests.length}`, ...data }; manifests.push(row); return row; }),
    },
  };
  const prisma = new Proxy(base, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    if (!delegates.has(String(property))) delegates.set(String(property), {
      findFirst: vi.fn(async ({ where, select }) => {
        const row = [...(tables.get(String(property))?.values() ?? [])].find((item) => matches(item, where));
        return row ? project(row, select) : null;
      }),
      findMany: vi.fn(async ({ where, select, orderBy, take }) => {
        let rows = [...(tables.get(String(property))?.values() ?? [])].filter((row) => matches(row, where));
        if (orderBy?.sequenceNumber === "desc" || (Array.isArray(orderBy) && orderBy[0]?.sequenceNumber === "desc")) {
          rows = rows.sort((left, right) => right.sequenceNumber - left.sequenceNumber || right.id.localeCompare(left.id));
        }
        return rows.slice(0, take ?? rows.length).map((row) => project(row, select));
      }),
      create: vi.fn(async ({ data }) => {
        const row = { id: `${String(property)}-${tables.get(String(property))?.size ?? 0}`, createdAt: new Date("2026-10-12T12:00:00Z"), ...data };
        if (!tables.has(String(property))) tables.set(String(property), new Map());
        tables.get(String(property))!.set(row.id, row);
        return structuredClone(row);
      }),
    });
    return delegates.get(String(property));
  } });
  return { tables, memberships, manifests, delegates, membership, onboarding, prisma, base };
});

vi.mock("@corgtex/shared", () => ({ prisma: fixture.prisma, toInputJson: (value: unknown) => value, env: { MODEL_PROVIDER: "fake", MODEL_REQUEST_TIMEOUT_MS: 1000 } }));
vi.mock("../../domain/src/auth", () => ({ requireWorkspaceMembership: fixture.membership }));
vi.mock("../../domain/src/brain-access", () => ({ resolveKnowledgeAccessDomains: vi.fn(async () => ["WORKSPACE"]) }));
vi.mock("../../domain/src/role-onboarding", () => ({ updateRoleOnboardingStatusByConversation: vi.fn() }));
vi.mock("@corgtex/domain", async () => ({
  ...await import("../../domain/src/source-lineage"),
  ...await import("../../domain/src/conversation-lineage"),
  AppError: (await import("../../domain/src/errors")).AppError,
  createConversationPromptInput: (await import("../../domain/src/conversations")).createConversationPromptInput,
  buildRoleOnboardingContextWithLineageForConversation: fixture.onboarding,
}));

import { AppError } from "../../domain/src/errors";
import { lineageContentFingerprint, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { createConversationLineageCollector } from "./conversation-lineage";
import { admitConversationPageContext, loadConversationHistory, loadConversationOnboarding, prepareConversationInputs } from "./conversation-inputs";

const alice = { kind: "user", user: { id: "synthetic-alice", email: "alice@example.test", displayName: null } } as AppActor;
const bob = { kind: "user", user: { id: "synthetic-bob", email: "bob@example.test", displayName: null } } as AppActor;
const workspaceId = "synthetic-ws-a";
const stamp = new Date("2026-10-12T12:00:00Z");
const base = { actor: alice, workspaceId, sessionId: "session-alice", userId: "synthetic-alice", userMessage: "Synthetic current utterance" };

function insert(delegate: string, value: { id: string; [key: string]: unknown }) {
  const row: { id: string; [key: string]: unknown } = { createdAt: stamp, ...(!["conversationPromptInput", "conversationTurn"].includes(delegate) ? { updatedAt: stamp } : {}), ...value };
  if (!fixture.tables.has(delegate)) fixture.tables.set(delegate, new Map());
  fixture.tables.get(delegate)!.set(row.id, row);
  return row;
}

async function original(kind: LineageKind, delegate: string, value: { id: string; [key: string]: unknown }) {
  const row = insert(delegate, value);
  await recordArtifactInputLineage({ tx: fixture.prisma as any, actor: alice, workspaceId: String(value.workspaceId ?? workspaceId),
    artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] });
  return row;
}

async function derived(kind: LineageKind, delegate: string, value: { id: string; [key: string]: unknown }, roots: LineageRoot[]) {
  const row = insert(delegate, value);
  await recordArtifactInputLineage({ tx: fixture.prisma as any, actor: alice, workspaceId: String(value.workspaceId ?? workspaceId),
    artifact: { kind, id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
  return row;
}

function crmPage(): ConversationPageContext {
  return { surface: "crm", route: "/crm?secret=untrusted", workspaceId, view: "accounts", section: "Untrusted section",
    selectedIds: { accountId: "account-public", contactId: null, dealId: null, activityId: null, suggestionId: null }, filters: { query: "Injected restricted context" },
    pagination: { page: 1, pageCount: 999, total: 99999 },
    visibleContext: { metrics: [{ label: "Untrusted private rank", value: 99999 }], accounts: [{ id: "account-public", name: "Forged browser account title", description: "Forged private browser content" }],
      contacts: [], deals: [], activities: [], suggestions: [] } };
}

beforeEach(() => {
  vi.clearAllMocks(); fixture.tables.clear(); fixture.memberships.clear(); fixture.manifests.length = 0;
  fixture.memberships.set(`${workspaceId}:synthetic-alice`, { id: "member-alice", role: "CONTRIBUTOR" });
  fixture.memberships.set(`${workspaceId}:synthetic-bob`, { id: "member-bob", role: "CONTRIBUTOR" });
  fixture.memberships.set("synthetic-ws-b:synthetic-bob", { id: "member-bob-b", role: "CONTRIBUTOR" });
  fixture.membership.mockImplementation(async ({ actor, workspaceId: ws }) => {
    const userId = actor.kind === "user" ? actor.user.id : "agent";
    const membership = fixture.memberships.get(`${ws}:${userId}`);
    if (!membership) throw new AppError(403, "NOT_A_MEMBER", "Synthetic membership unavailable");
    return membership;
  });
  fixture.base.$transaction.mockImplementation(async (callback) => callback(fixture.prisma));
  fixture.onboarding.mockResolvedValue(null);
  insert("conversationSession", { id: base.sessionId, workspaceId, userId: base.userId, agentKey: "assistant", topic: null, status: "ACTIVE", systemPrompt: null });
  insert("conversationSession", { id: "session-bob", workspaceId, userId: "synthetic-bob", agentKey: "assistant", topic: null, status: "ACTIVE", systemPrompt: null });
  fixture.base.$executeRaw.mockReset().mockResolvedValue(1);
  fixture.base.$queryRaw.mockReset().mockResolvedValue([]);
  installSourcePermissionEpochFixture(fixture.prisma);
});

describe("conversation server context admission with actual source proofs", () => {
  it("creates an owned immutable prompt before context capture and binds the exact utterance", async () => {
    const prepared = await prepareConversationInputs(base);
    expect(prepared.promptInputId).toBe("conversationPromptInput-0");
    expect(await prepared.collector.roots()).toEqual([expect.objectContaining({ kind: "ConversationPromptInput", id: prepared.promptInputId,
      fingerprint: lineageContentFingerprint("ConversationPromptInput", fixture.tables.get("conversationPromptInput")!.get(prepared.promptInputId!)),
      permissionEpochs: expect.objectContaining({ version: 1, entries: expect.arrayContaining([
        { kind: "ConversationPromptInput", id: prepared.promptInputId, epoch: "0" },
        { kind: "MemberUserPolicy", id: base.userId, epoch: "0" }, { kind: "Workspace", id: workspaceId, epoch: "0" },
      ]) }) })]);
    expect(fixture.delegates.get("conversationPromptInput").create).toHaveBeenCalledWith({ data: { workspaceId, sessionId: base.sessionId, userId: base.userId, content: base.userMessage } });
  });

  it("rejects actor mismatch, another person's session, tenant mismatch and current membership revocation", async () => {
    await expect(prepareConversationInputs({ ...base, actor: bob })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(prepareConversationInputs({ ...base, sessionId: "session-bob" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepareConversationInputs({ ...base, workspaceId: "synthetic-ws-b" })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    fixture.memberships.delete(`${workspaceId}:synthetic-alice`);
    await expect(prepareConversationInputs(base)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    expect(fixture.tables.get("conversationPromptInput")?.size ?? 0).toBe(0);
  });

  it("honors a current UNKNOWN native-prompt receipt and live session ownership changes", async () => {
    const prepared = await prepareConversationInputs(base);
    const prompt = fixture.tables.get("conversationPromptInput")!.get(prepared.promptInputId!);
    fixture.manifests.push({ id: "unknown-prompt", workspaceId, artifactType: "ConversationPromptInput", artifactId: prompt.id, revision: 1,
      origin: "UNKNOWN", contentHash: lineageContentFingerprint("ConversationPromptInput", prompt), rootsJson: null });
    await expect(prepared.collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    fixture.manifests.length = 0;
    fixture.tables.get("conversationSession")!.get(base.sessionId).userId = "synthetic-bob";
    await expect(prepared.collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("drops browser CRM text, counts, filters, paths and ranks, and reloads verified SQL fields", async () => {
    await original("CrmAccount", "crmAccount", { id: "account-public", workspaceId, name: "Current SQL account", archivedAt: null });
    const prepared = await prepareConversationInputs({ ...base, pageContext: crmPage() });
    expect(prepared.pageContext).toMatchObject({ route: null, section: null, filters: {}, pagination: { page: null, pageCount: null, total: null },
      visibleContext: { metrics: [], accounts: [{ id: "account-public", name: "Current SQL account" }] } });
    expect(JSON.stringify(prepared.pageContext)).not.toContain("Forged");
    expect(JSON.stringify(prepared.pageContext)).not.toContain("999");
    expect((await prepared.collector.roots()).some((root) => root.kind === "CrmAccount" && root.id === "account-public")).toBe(true);
  });

  it("rejects cross-workspace page pointers before retrieving their records", async () => {
    const page = crmPage(); if (page.surface !== "crm") throw new Error("Fixture surface");
    page.workspaceId = "synthetic-ws-b";
    const prepared = await prepareConversationInputs({ ...base, pageContext: page });
    expect(prepared.pageContext).toBeNull(); expect(fixture.delegates.get("crmAccount")?.findMany).not.toHaveBeenCalled();
  });

  it("omits unknown and mixed private/public CRM inputs for a different member", async () => {
    const privateArticle = await original("BrainArticle", "brainArticle", { id: "private-article", workspaceId, title: "Private source", bodyMd: "Synthetic private fact",
      isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const privateRoot = { kind: "BrainArticle" as const, id: privateArticle.id, fingerprint: lineageContentFingerprint("BrainArticle", privateArticle) };
    await original("CrmAccount", "crmAccount", { id: "account-public", workspaceId, name: "Current public account", archivedAt: null });
    await derived("CrmAccount", "crmAccount", { id: "account-mixed", workspaceId, name: "Copied restricted account name", archivedAt: null }, [privateRoot]);
    insert("crmAccount", { id: "account-unknown", workspaceId, name: "Unknown legacy account", archivedAt: null });
    const page = crmPage(); if (page.surface !== "crm") throw new Error("Fixture surface");
    page.selectedIds.accountId = "account-mixed"; page.visibleContext.accounts.push({ id: "account-mixed" }, { id: "account-unknown" });
    const own = await prepareConversationInputs({ ...base, pageContext: page });
    expect(own.pageContext?.surface === "crm" && own.pageContext.visibleContext.accounts).toHaveLength(2);
    const other = await prepareConversationInputs({ ...base, actor: bob, sessionId: "session-bob", userId: "synthetic-bob", pageContext: page });
    expect(other.pageContext?.surface === "crm" && other.pageContext.visibleContext.accounts).toEqual([{ id: "account-public", name: "Current public account" }]);
    expect(other.pageContext?.surface === "crm" && other.pageContext.selectedIds.accountId).toBeNull();
    privateArticle.archivedAt = stamp;
    fixture.tables.get("brainArticle")!.set(privateArticle.id, privateArticle);
    await expect(own.collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("reloads graph selection labels from SQL and removes edges with a withheld endpoint", async () => {
    const privateArticle = await original("BrainArticle", "brainArticle", { id: "private-article", workspaceId, title: "Private source", bodyMd: "Synthetic private fact",
      isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const privateRoot = { kind: "BrainArticle" as const, id: privateArticle.id, fingerprint: lineageContentFingerprint("BrainArticle", privateArticle) };
    await original("ContextMapView", "contextMapView", { id: "view-public", workspaceId, name: "SQL map name", viewType: "org", createdByUserId: null });
    await original("ContextGraphObject", "contextGraphObject", { id: "object-public", workspaceId, title: "SQL public node", objectType: "Team", status: "approved", properties: {} });
    await derived("ContextGraphObject", "contextGraphObject", { id: "object-private", workspaceId, title: "Private copied node", objectType: "Team", status: "approved", properties: {} }, [privateRoot]);
    await original("ContextGraphRelationship", "contextGraphRelationship", { id: "edge-private", workspaceId, sourceObjectId: "object-public", targetObjectId: "object-private", relationshipType: "part_of", status: "approved", properties: {} });
    const page: ConversationPageContext = { surface: "context-map", route: "Forged path", mapView: { id: "view-public", name: "Forged map label", viewType: "Forged map kind" }, includeStale: false,
      selectedObjectIds: ["object-public", "object-private"], selectedObjects: [{ id: "object-public", title: "Forged selected text", objectType: "Forged kind", status: "Forged state" }],
      selectedRelationship: { id: "edge-private", sourceObjectId: "object-public", targetObjectId: "object-private", relationshipType: "Forged edge", status: "Forged edge state" } };
    const prepared = await prepareConversationInputs({ ...base, actor: bob, sessionId: "session-bob", userId: "synthetic-bob", pageContext: page });
    expect(prepared.pageContext).toEqual({ surface: "context-map", route: null, mapView: { id: "view-public", name: "SQL map name", viewType: "org" }, includeStale: false,
      selectedObjectIds: ["object-public"], selectedObjects: [{ id: "object-public", title: "SQL public node", objectType: "Team", status: "approved" }], selectedRelationship: null });
    expect(JSON.stringify(prepared.pageContext)).not.toContain("Forged");
    expect((await prepared.collector.roots()).every((root) => root.id !== "object-private" && root.id !== "edge-private")).toBe(true);
    const own = await prepareConversationInputs({ ...base, pageContext: page });
    expect(own.pageContext?.surface === "context-map" && own.pageContext.selectedRelationship).toEqual({ id: "edge-private", sourceObjectId: "object-public",
      targetObjectId: "object-private", relationshipType: "part_of", status: "approved" });
    expect((await own.collector.roots()).some((root) => root.id === "edge-private")).toBe(true);
  });

  it("withholds an unknown or another user's personal map instead of accepting its browser label", async () => {
    const map = await original("ContextMapView", "contextMapView", { id: "personal-map", workspaceId, name: "Private SQL name", viewType: "org", createdByUserId: "synthetic-alice" });
    const page: ConversationPageContext = { surface: "context-map", route: null, mapView: { id: map.id, name: "Forged label", viewType: "org" }, includeStale: false,
      selectedObjectIds: [], selectedObjects: [], selectedRelationship: null };
    const collector = createConversationLineageCollector(bob, workspaceId);
    expect(await admitConversationPageContext(bob, workspaceId, page, collector)).toBeNull();
    fixture.manifests.length = 0;
    expect(await admitConversationPageContext(alice, workspaceId, page, createConversationLineageCollector(alice, workspaceId))).toBeNull();
  });

  it("accepts a custom system prompt only when it exactly matches a proven current owned session", async () => {
    const session = await original("ConversationSession", "conversationSession", { id: base.sessionId, workspaceId, userId: base.userId,
      agentKey: "assistant", topic: null, status: "ACTIVE", systemPrompt: "Current stored custom instructions" });
    const current = await prepareConversationInputs({ ...base, systemPrompt: session.systemPrompt as string });
    expect(current.systemPrompt).toBe(session.systemPrompt);
    expect((await current.collector.roots()).some((root) => root.kind === "ConversationSession" && root.id === session.id)).toBe(true);
    expect((await prepareConversationInputs({ ...base, systemPrompt: "Untrusted client instructions" })).systemPrompt).toBeNull();
    fixture.manifests.length = 0;
    expect((await prepareConversationInputs({ ...base, systemPrompt: session.systemPrompt as string })).systemPrompt).toBeNull();
  });

  it("filters prior history permissions before applying the history cap", async () => {
    const source = await original("BrainArticle", "brainArticle", { id: "source-public", workspaceId, title: "Permitted source", bodyMd: "Permitted body", isPrivate: false, ownerMemberId: null, archivedAt: null });
    const sourceRoot = { kind: "BrainArticle" as const, id: source.id, fingerprint: lineageContentFingerprint("BrainArticle", source) };
    await derived("ConversationTurn", "conversationTurn", { id: "turn-permitted", conversationId: base.sessionId, sequenceNumber: 1, userMessage: "Earlier human question", assistantMessage: "Permitted earlier reply", promptInputId: null, contextJson: null }, [sourceRoot]);
    for (let number = 2; number <= 125; number += 1) insert("conversationTurn", { id: `turn-unknown-${number}`, conversationId: base.sessionId,
      sequenceNumber: number, userMessage: "Unknown copied question", assistantMessage: "Unknown legacy answer", promptInputId: null, contextJson: null });
    const prepared = await prepareConversationInputs(base);
    expect(await loadConversationHistory(alice, workspaceId, base.sessionId, 1, prepared.collector)).toMatchObject([{ id: "turn-permitted", sequenceNumber: 1 }]);
    source.archivedAt = stamp; fixture.tables.get("brainArticle")!.set(source.id, source);
    await expect(prepared.collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("does not borrow another user's or workspace's conversation turns", async () => {
    const prepared = await prepareConversationInputs(base);
    insert("conversationTurn", { id: "bob-turn", conversationId: "session-bob", sequenceNumber: 1, userMessage: "Other person utterance", assistantMessage: "Other person reply" });
    expect(await loadConversationHistory(alice, workspaceId, "session-bob", 5, prepared.collector)).toEqual([]);
    expect(await loadConversationHistory(alice, "synthetic-ws-b", base.sessionId, 5, prepared.collector)).toEqual([]);
  });

  it("selects only the newest twenty proven turns from a history beyond5000", async () => {
    const prepared = await prepareConversationInputs(base);
    for (let number = 1; number <= 4981; number += 1) insert("conversationTurn", { id: `turn-${number}`, conversationId: base.sessionId, sequenceNumber: number });
    const source = await original("BrainArticle", "brainArticle", { id: "history-source", workspaceId, title: "Permitted history source", bodyMd: "Original source", isPrivate: false, ownerMemberId: null, archivedAt: null });
    const roots = [{ kind: "BrainArticle" as const, id: source.id, fingerprint: lineageContentFingerprint("BrainArticle", source) }];
    for (let number = 4982; number <= 5001; number += 1) await derived("ConversationTurn", "conversationTurn", {
      id: `turn-${number}`, conversationId: base.sessionId, sequenceNumber: number, userMessage: "Original question", assistantMessage: "Original reply", promptInputId: null, contextJson: null,
    }, roots);
    const history = await loadConversationHistory(alice, workspaceId, base.sessionId, 20, prepared.collector);
    expect(history.map(row => row.sequenceNumber)).toEqual(Array.from({ length: 20 }, (_, i) => 4982 + i));
    const queries = fixture.delegates.get("conversationTurn").findMany.mock.calls;
    expect(queries).toHaveLength(1);
    expect(queries[0][0].take).toBe(100);
    expect((await prepared.collector.roots()).filter(root => root.kind === "ConversationTurn")).toHaveLength(20);
  });

  it("captures every onboarding input including an uncited private contributor and rechecks it at release", async () => {
    const article = await original("BrainArticle", "brainArticle", { id: "onboarding-source", workspaceId, title: "Private role source", bodyMd: "Synthetic role fact",
      isPrivate: true, ownerMemberId: "member-alice", archivedAt: null });
    const roots = [{ kind: "BrainArticle" as const, id: article.id, fingerprint: lineageContentFingerprint("BrainArticle", article) }];
    fixture.onboarding.mockResolvedValue({ context: "Synthetic role intro influenced by uncited source", lineageRoots: roots, lineageInputs: [] });
    const prepared = await prepareConversationInputs(base);
    expect(await loadConversationOnboarding(workspaceId, base.sessionId, base.userId, prepared.collector)).toContain("Synthetic role intro");
    expect(await prepared.collector.roots()).toEqual(expect.arrayContaining(roots));
    article.isPrivate = true; article.ownerMemberId = "member-bob"; fixture.tables.get("brainArticle")!.set(article.id, article);
    await expect(prepared.collector.assertReadable()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});

it("rejects an earlier admitted history page when its source changes during replenishment", async () => {
  const prepared = await prepareConversationInputs(base);
  const source = await original("BrainArticle", "brainArticle", { id: "paged-source", workspaceId, title: "Original", bodyMd: "Original", isPrivate: false, ownerMemberId: null, archivedAt: null });
  await derived("ConversationTurn", "conversationTurn", { id: "newest-proven", conversationId: base.sessionId, sequenceNumber: 200,
    userMessage: "Original", assistantMessage: "Derived", promptInputId: null, contextJson: null },
    [{ kind: "BrainArticle", id: source.id, fingerprint: lineageContentFingerprint("BrainArticle", source) }]);
  for (let i = 1; i <= 101; i++) insert("conversationTurn", { id: `denied-${i}`, conversationId: base.sessionId, sequenceNumber: i });
  const delegate = fixture.delegates.get("conversationTurn");
  const load = delegate.findMany.getMockImplementation();
  delegate.findMany.mockImplementation(async (args: { where: { OR?: unknown } }) => {
    if (args.where.OR) source.archivedAt = stamp;
    return load(args);
  });
  await expect(loadConversationHistory(alice, workspaceId, base.sessionId, 2, prepared.collector)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});
