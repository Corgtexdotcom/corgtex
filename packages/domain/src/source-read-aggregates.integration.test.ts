import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { getPrismaClient } from "../../shared/src/db";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { getBrainStatus, listArticles } from "./brain";
import { hasWorkspaceInitialKnowledgeSource } from "./workspace-initial-knowledge";
import { listNotificationPage, listNotifications, getUnreadNotificationSummary, countUnreadNotifications, markAllNotificationsRead } from "./notifications";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic aggregate", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  return { workspaceId: workspace.id, user, actor };
}
it("counts beyond 5000 canonical sources, replenishes hidden pages, and withholds unproved onboarding context", async () => {
  const f = await fixture();
  await prisma.brainSource.createMany({ data: Array.from({ length: 5001 }, (_, index) => ({
    id: `hidden-${String(index).padStart(5, "0")}`, workspaceId: f.workspaceId,
    sourceType: "DOC" as const, tier: 1, content: "Unproved synthetic copy",
  })) });
  const queries = vi.spyOn(prisma.brainSource, "findMany");
  expect((await getBrainStatus(f.actor, f)).unabsorbedSources).toBe(0);
  expect(queries.mock.calls.length).toBe(1);
  expect(queries.mock.calls.every(([args]) => args?.take === 10001 && args.select === undefined)).toBe(true);
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
  const source = await prisma.brainSource.create({ data: { id: "visible-last", workspaceId: f.workspaceId,
    sourceType: "DOC", tier: 1, content: "Authenticated original" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  expect((await getBrainStatus(f.actor, f)).unabsorbedSources).toBe(1);
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(true);
  await prisma.brainSource.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
  expect((await getBrainStatus(f.actor, f)).unabsorbedSources).toBe(0);
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
}, 120_000);

it("pages notification bodies, applies visible skip, stops early and counts only current admitted history", async () => {
  const f = await fixture();
  const timestamp = new Date("2026-10-01T12:00:00Z");
  await prisma.notification.createMany({ data: Array.from({ length: 350 }, (_, index) => ({
    id: `z-hidden-${String(index).padStart(4, "0")}`, workspaceId: f.workspaceId, userId: f.user.id,
    type: "SYNTHETIC", title: "Unproved notification", bodyMd: "Unproved body", createdAt: timestamp,
  })) });
  const input = await prisma.brainSource.create({ data: { workspaceId: f.workspaceId,
    sourceType: "DOC", tier: 1, content: "Authenticated notification input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: input.id }, content: input, origin: "HUMAN_ORIGINAL", inputs: [] }));
  for (const id of ["v3", "v2", "v1"]) {
    const row = await prisma.notification.create({ data: { id, workspaceId: f.workspaceId, userId: f.user.id,
      type: "SYNTHETIC", title: id, bodyMd: "Authenticated original", createdAt: timestamp } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Notification", id }, content: row, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: input.id }] }));
  }
  // Older hidden history must not be loaded to deliver the requested visible page.
  await prisma.notification.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
    id: `a-older-${index}`, workspaceId: f.workspaceId, userId: f.user.id,
    type: "SYNTHETIC", title: "Older hidden", createdAt: new Date("2025-01-01"),
  })) });
  const queries = vi.spyOn(prisma.notification, "findMany");
  const first = await listNotificationPage(f.actor, f.workspaceId, { skip: 1, take: 1 });
  expect(first).toMatchObject({ items: [], complete: false, hasMore: true });
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(queries).toHaveBeenCalledTimes(2);
  expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")).id).toBe("z-hidden-0150");
  queries.mockClear();
  // No readable rows were consumed in the first window, so the visible skip is
  // still outstanding when the caller explicitly continues.
  const second = await listNotificationPage(f.actor, f.workspaceId, { cursor: first.nextCursor!, skip: 1, take: 1 });
  expect(second.items.map(row => row.id)).toEqual(["v2"]);
  expect(second).toMatchObject({ complete: false, hasMore: true });
  expect(queries).toHaveBeenCalledTimes(2);
  expect(queries.mock.calls.every(([args]) => args?.take === 100 && args.select === undefined)).toBe(true);
  const next = await listNotificationPage(f.actor, f.workspaceId, { cursor: second.nextCursor!, take: 1 });
  expect(next.items.map(row => row.id)).toEqual(["v1"]);
  // Bounded summaries must not fabricate a global zero from a hidden prefix.
  expect(await getUnreadNotificationSummary(f.actor, f.workspaceId)).toEqual({ count: 0, complete: false, available: true });
  await expect(countUnreadNotifications(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  await expect(listNotifications(f.actor, f.workspaceId, { skip: 1, take: 1 }))
    .rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  const collectUnreadWindows = async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let window = 0; window < 4; window++) {
      const before = queries.mock.calls.length;
      const page = await listNotificationPage(f.actor, f.workspaceId, { unreadOnly: true, take: 100, cursor });
      expect(queries.mock.calls.length - before).toBeLessThanOrEqual(2);
      ids.push(...page.items.map(row => row.id));
      if (page.complete) { expect(page.nextCursor).toBeNull(); return ids; }
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor!;
    }
    throw new Error("Expected this synthetic history to finish within four explicit windows.");
  };
  queries.mockClear();
  expect(await collectUnreadWindows()).toEqual(["v3", "v2", "v1"]);
  expect(queries).toHaveBeenCalledTimes(7);
  await prisma.notification.update({ where: { id: "v2" }, data: { bodyMd: "Unproved replacement" } });
  expect(await collectUnreadWindows()).toEqual(["v3", "v1"]);
  expect((await listNotificationPage(f.actor, f.workspaceId,
    { cursor: first.nextCursor!, skip: 1, take: 1 })).items.map(row => row.id)).toEqual(["v1"]);
}, 120_000);

it("bases initial context on admitted Documents and Meetings beyond hidden first pages", async () => {
  const f = await fixture();
  await prisma.document.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    id: `hidden-doc-${index}`, workspaceId: f.workspaceId, title: "Unproved document", source: "UPLOAD",
    storageKey: `synthetic/${index}`, textContent: "Unproved copied text",
  })) });
  await prisma.meeting.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    id: `hidden-meeting-${index}`, workspaceId: f.workspaceId, source: "UPLOAD", recordedAt: new Date(),
    transcript: "Unproved copied transcript", participantIds: [],
  })) });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
  const source = await prisma.brainSource.create({ data: { workspaceId: f.workspaceId,
    sourceType: "RFC", tier: 1, content: "Authenticated input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const document = await prisma.document.create({ data: { id: "visible-document", workspaceId: f.workspaceId,
    source: "UPLOAD", title: "Proved document", storageKey: "synthetic/valid", textContent: "Authenticated input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "Document", id: document.id }, content: document, origin: "DERIVED", inputs: [{kind: "BrainSource", id: source.id}] }));
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(true);
  await prisma.document.update({ where: {id: document.id}, data: {archivedAt: new Date()} });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
  const { createMeeting } = await import("./meetings");
  const meeting = await createMeeting(f.actor, { workspaceId: f.workspaceId, source: "WEB_REQUEST", title: "Original Meeting",
    transcript: "I will prepare the proposal.", recordedAt: new Date() });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(true);
  await prisma.meeting.update({ where: {id: meeting.id}, data: {archivedAt: new Date()} });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
}, 120_000);


it("lists articles beyond 5000 hidden rows with selected-only relations and bounded variant requests", async () => {
  const f = await fixture();
  const timestamp = new Date("2026-10-01T12:00:00Z");
  await prisma.brainArticle.createMany({ data: Array.from({ length: 5001 }, (_, index) => ({
    id: `z-hidden-${String(index).padStart(5, "0")}`, workspaceId: f.workspaceId, slug: `hidden-${index}`,
    title: "Unproved article", bodyMd: "Unproved synthetic body", type: "PRODUCT" as const,
    sourceIds: [], updatedAt: timestamp,
  })) });
  for (const id of ["v3", "v2", "v1"]) {
    const row = await prisma.brainArticle.create({ data: { id, workspaceId: f.workspaceId, slug: id,
      title: id, bodyMd: "Authenticated original", type: "PRODUCT", sourceIds: [], updatedAt: timestamp } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "BrainArticle", id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  }
  await prisma.brainBacklink.createMany({data: ["v1", "z-hidden-00000"].map(fromArticleId => ({
    workspaceId: f.workspaceId, fromArticleId, toArticleId: "v2",
  }))});
  const author = await prisma.member.findFirstOrThrow({where: {workspaceId: f.workspaceId, userId: f.user.id}});
  const thread = await prisma.brainDiscussionThread.create({data: {articleId: "v2", authorMemberId: author.id, targetType: "ARTICLE"}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "BrainDiscussionThread", id: thread.id}, content: thread, origin: "HUMAN_ORIGINAL", inputs: []}));
  await prisma.brainDiscussionThread.create({data: {articleId: "v2", authorMemberId: author.id,
    targetType: "SECTION", targetRef: "Hidden thread metadata"}});
  await prisma.brainDiscussionComment.createMany({data: Array.from({length: 105}, () => ({
    threadId: thread.id, authorMemberId: author.id, bodyMd: "Hidden comment body must never be loaded for a count",
  }))});
  const comments = vi.spyOn(prisma.brainDiscussionComment, "findMany");
  const variant = vi.spyOn(await import("./brain-article-variants"), "requestBrainArticleVariant");
  const queries = vi.spyOn(prisma.brainArticle, "findMany");
  const threads = vi.spyOn(prisma.brainDiscussionThread, "findMany");
  const links = vi.spyOn(prisma.brainBacklink, "findMany");
  expect(await listArticles(f.actor, { workspaceId: f.workspaceId, take: 0 })).toMatchObject({ items: [], total: 3 });
  expect(variant).not.toHaveBeenCalled();
  expect(threads).not.toHaveBeenCalled();
  expect(links).not.toHaveBeenCalled();
  expect(queries.mock.calls.length).toBe(51);
  expect(queries.mock.calls.every(([args]) => args?.take === 100 && args.include === undefined && args.select === undefined)).toBe(true);
  queries.mockClear();
  const result = await listArticles(f.actor, { workspaceId: f.workspaceId, skip: 1, take: 1 });
  expect(result).toMatchObject({ total: 3, items: [{ id: "v2", variantOfArticleId: null, variantSourceStateJson: null }] });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]._count).toEqual({discussions: 1, backlinksTo: 1});
  expect(comments).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("Hidden comment");
  expect(variant).toHaveBeenCalledTimes(1);
  expect(threads.mock.calls.every(([args]) => args?.where?.articleId === "v2" && !args.include && args.take === 100)).toBe(true);
  expect(links.mock.calls.every(([args]) => args?.where?.toArticleId === "v2" && args.take === 100)).toBe(true);
  await prisma.brainArticle.update({ where: { id: "v2" }, data: { bodyMd: "Unreceipted replacement" } });
  expect(await listArticles(f.actor, { workspaceId: f.workspaceId, take: 0 })).toMatchObject({ total: 2 });
}, 120_000);

it("marks admitted notification history in awaited100-row batches without skipping after readAt changes", async () => {
  const f = await fixture();
  const timestamp = new Date("2026-10-01T12:00:00Z");
  await prisma.notification.createMany({ data: Array.from({ length: 120 }, (_, index) => ({
    id: `z-hidden-${index}`, workspaceId: f.workspaceId, userId: f.user.id,
    type: "SYNTHETIC", title: "Unknown notification", createdAt: timestamp,
  })) });
  const source = await prisma.brainSource.create({ data: { workspaceId: f.workspaceId,
    sourceType: "DOC", tier: 1, content: "Authenticated notification input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  for (let index = 0; index < 205; index++) {
    const row = await prisma.notification.create({ data: { id: `visible-${String(index).padStart(3, "0")}`,
      workspaceId: f.workspaceId, userId: f.user.id, type: "SYNTHETIC", title: "Proved notification", createdAt: timestamp } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Notification", id: row.id }, content: row, origin: "DERIVED", inputs: [{kind: "BrainSource", id: source.id}] }));
  }
  const reads = vi.spyOn(prisma.notification, "findMany");
  const writeBatches: number[] = [];
  const client = getPrismaClient();
  const transaction = client.$transaction.bind(client);
  const observeTransaction = async (work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }) => transaction(async tx => {
    const write = tx.notification.updateMany.bind(tx.notification);
    vi.spyOn(tx.notification, "updateMany").mockImplementation(args => {
      writeBatches.push((args.where?.id as { in: string[] }).in.length);
      return write(args);
    });
    return work(tx);
  }, options);
  vi.spyOn(client, "$transaction").mockImplementation(observeTransaction as typeof client.$transaction);
  const first = await markAllNotificationsRead(f.actor, f.workspaceId);
  expect(first).toMatchObject({ updatedCount: 80, complete: false });
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(reads).toHaveBeenCalledTimes(2);
  expect(writeBatches).toEqual([80]);
  // The resolved request includes committed writes, but does not claim that the
  // remaining 125 admitted rows have already been updated.
  expect(await prisma.notification.count({ where: { workspaceId: f.workspaceId, readAt: { not: null } } })).toBe(80);
  expect(await prisma.notification.count({ where: { workspaceId: f.workspaceId, readAt: null } })).toBe(245);
  reads.mockClear();
  const second = await markAllNotificationsRead(f.actor, f.workspaceId, { cursor: first.nextCursor! });
  expect(second).toEqual({ updatedCount: 125, complete: true, nextCursor: null });
  expect(reads).toHaveBeenCalledTimes(2);
  expect(first.updatedCount + second.updatedCount).toBe(205);
  expect(await prisma.notification.count({ where: { workspaceId: f.workspaceId, readAt: { not: null } } })).toBe(205);
  expect(await prisma.notification.count({ where: { workspaceId: f.workspaceId, readAt: null } })).toBe(120);
  expect(reads.mock.calls.every(([args]) => args?.take === 100 && args.select === undefined)).toBe(true);
  expect(writeBatches).toEqual([80, 100, 25]);
  expect(await countUnreadNotifications(f.actor, f.workspaceId)).toBe(0);
}, 120_000);

it("returns only current visible workspace counts and never queries categories outside a real credential's scopes", async () => {
  const f = await fixture();
  const { mcpCredentialVersion, mcpScopesHash } = await import("@corgtex/shared");
  const { createCorgtexMcpServer } = await import("../../mcp/src/server");
  for (const state of ["visible", "private", "archived", "unproved"] as const) {
    const data = {workspaceId: f.workspaceId, authorUserId: f.user.id, title: state, bodyMd: "Synthetic original",
      isPrivate: state === "private", archivedAt: state === "archived" ? new Date() : null};
    const action = await prisma.action.create({data: {...data, status: state === "private" ? "DRAFT" : "OPEN"}});
    const tension = await prisma.tension.create({data: {...data, status: state === "private" ? "DRAFT" : "OPEN"}});
    const proposal = await prisma.proposal.create({data: {...data, status: state === "private" ? "DRAFT" : "OPEN"}});
    if (state !== "unproved") for (const [kind, row] of [["Action", action], ["Tension", tension], ["Proposal", proposal]] as const) {
      await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
        artifact: {kind, id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
    }
  }
  const read = async (scopes: string[]) => {
    const credential = await prisma.agentCredential.create({data: {workspaceId: f.workspaceId,
      label: "Synthetic count reader", tokenHash: `synthetic-${randomUUID()}`, scopes}});
    const version = mcpCredentialVersion(credential.tokenHash);
    const actor: AppActor = {kind: "agent", authProvider: "credential", label: credential.label, workspaceIds: [f.workspaceId],
      credentialId: credential.id, credentialVersion: version, scopes};
    const server = createCorgtexMcpServer({actor, workspaceId: f.workspaceId, authKind: "agent", scopes,
      mcpOrigin: {kind: "agent", id: credential.id, workspaceId: f.workspaceId,
        credentialVersion: version, scopeHash: mcpScopesHash(scopes), requiredScopes: []}});
    const tools = (server as unknown as {_registeredTools: Record<string, {handler(args: object): Promise<{content: {text: string}[]}>}>})._registeredTools;
    const response = await tools.get_workspace_info.handler({});
    await server.close();
    return JSON.parse(response.content[0].text).counts;
  };
  expect(await read(["workspace:read", "actions:read", "tensions:read", "proposals:read"]))
    .toMatchObject({actions: 1, tensions: 1, proposals: 1});
  const actions = vi.spyOn(prisma.action, "findMany"), tensions = vi.spyOn(prisma.tension, "findMany");
  const proposals = vi.spyOn(prisma.proposal, "findMany");
  expect(await read(["workspace:read"])).toMatchObject({actions: 0, tensions: 0, proposals: 0});
  expect(actions).not.toHaveBeenCalled(); expect(tensions).not.toHaveBeenCalled(); expect(proposals).not.toHaveBeenCalled();
  await prisma.action.updateMany({where: {workspaceId: f.workspaceId, title: "visible"}, data: {bodyMd: "Unreceipted replacement"}});
  expect(await read(["workspace:read", "actions:read", "tensions:read", "proposals:read"]))
    .toMatchObject({actions: 0, tensions: 1, proposals: 1});
}, 120_000);
