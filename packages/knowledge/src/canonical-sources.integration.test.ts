import { randomUUID } from "node:crypto";
import type { KnowledgeSourceType, Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptSecret, prisma, resetLocalCacheStore, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, lineageContentFingerprint, recordArtifactInputLineage, type LineageKind } from "../../domain/src/source-lineage";
import { captureSlackNativeMessageFetch, withSlackNativeCommitReceipt } from "../../domain/src/communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "../../domain/src/communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "../../domain/src/source-permission-epochs";
import { loadCanonicalKnowledgeSource } from "./canonical-sources";
import { syncKnowledgeForSource } from "./chunks";
import { fetchReadableKnowledgeChunk, searchIndexedKnowledge } from "./retrieval";

const slack = vi.hoisted(() => ({ message: { type: "message", ts: "1700000000.000001", user: "U_AUTHOR", text: "Canonical original launch facts" } }));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  auth = { test: async () => ({ ok: true, team_id: "T_SYNTHETIC", user_id: "U_BOT" }) };
  conversations = { info: async () => ({ ok: true, channel: { id: "synthetic-public", is_private: false, is_member: true, is_archived: false } }),
    history: async () => ({ ok: true, messages: [slack.message] }) };
} }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const local = database.hostname === "127.0.0.1" && database.port === "63973" && database.pathname === "/child_read_test";
const hosted = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!local && !hosted) || database.searchParams.get("schema") !== "public") throw new Error("Canonical source tests require the owned disposable fixture or documented hosted CI fixture.");
const usage = { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0, latencyMs: 0,
  estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0" };
beforeEach(async () => {
  await truncateAllTables(); resetLocalCacheStore(); vi.stubEnv("KNOWLEDGE_SEARCH_PROVIDER", "postgres");
  vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({ input }) => ({ embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage }));
  vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({ documents, topK }) => ({ results: documents.slice(0, topK).map((document, index) => ({ index, score: 1, document })), usage }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(sourceType: KnowledgeSourceType) {
  const workspace = await prisma.workspace.create({ data: { name: "Canonical synthetic", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Original author" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const readerActor: AppActor = { kind: "user", user: reader };
  const circle = await prisma.circle.create({ data: { workspaceId: workspace.id, name: "Canonical launch", purposeMd: "Original launch facts" } });
  const original = async (kind: LineageKind, row: { id: string }) => prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  await original("Circle", circle);
  let sourceId = circle.id;
  if (sourceType === "ACTION") {
    const row = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: user.id, assigneeMemberId: member.id,
      circleId: circle.id, title: "Canonical launch", bodyMd: "Original launch facts", status: "OPEN" } });
    await original("Action", row); sourceId = row.id;
  } else if (sourceType === "TENSION") {
    const row = await prisma.tension.create({ data: { workspaceId: workspace.id, authorUserId: user.id, assigneeMemberId: member.id,
      raisedByMemberId: member.id, circleId: circle.id, title: "Canonical launch", bodyMd: "Original launch facts" } });
    await original("Tension", row); sourceId = row.id;
  } else if (sourceType === "ROLE") {
    const row = await prisma.role.create({ data: { circleId: circle.id, name: "Canonical launch", purposeMd: "Original launch facts", accountabilities: ["Ship"], artifacts: [] } });
    await original("Role", row); sourceId = row.id;
  } else if (sourceType === "SLACK") {
    const installation = await prisma.communicationInstallation.create({ data: { workspaceId: workspace.id, provider: "SLACK", externalWorkspaceId: "T_SYNTHETIC",
      appId: "APP_SYNTHETIC", botUserId: "U_BOT", botTokenEnc: encryptSecret("synthetic-token"), scopes: ["channels:read", "channels:history"], status: "ACTIVE" } });
    const channel = await prisma.communicationChannel.create({ data: { workspaceId: workspace.id, installationId: installation.id,
      provider: "SLACK", externalChannelId: "synthetic-public", name: "Canonical launch", kind: "PUBLIC", isIngestEnabled: true } });
    const fetched = await captureSlackNativeMessageFetch({ workspaceId: workspace.id, installationId: installation.id, channelId: channel.externalChannelId, messageTs: slack.message.ts });
    const message = await prisma.$transaction(async tx => {
      const stamp = new Date(Math.trunc(Number(slack.message.ts) * 1000));
      const row = await tx.communicationMessage.create({ data: { workspaceId: workspace.id, installationId: installation.id, provider: "SLACK",
        externalChannelId: channel.externalChannelId, externalMessageId: slack.message.ts, externalUserId: slack.message.user,
        text: String(fetched.projected.text), raw: fetched.projected as Prisma.InputJsonValue, messageTs: stamp, receivedAt: stamp,
        expiresRawAt: new Date(Date.now() + 120000), permalink: null } });
      const permissionEpochsJson = await capturePermissionEpochs(tx, workspace.id, artifactPermissionEpochIdentities("CommunicationMessage", row));
      const input = await tx.communicationMessageNativeInput.create({ data: { workspaceId: workspace.id, installationId: installation.id,
        communicationMessageId: row.id, provider: "SLACK", externalWorkspaceId: installation.externalWorkspaceId, appId: installation.appId,
        providerPrincipalId: fetched.providerPrincipalId, externalChannelId: channel.externalChannelId, externalMessageId: row.externalMessageId,
        externalUserId: row.externalUserId, threadExternalId: null, mode: "AUTHENTICATED_FETCH", ingressInputId: null,
        requestJson: { ...fetched.request, messageContentFingerprint: lineageContentFingerprint("CommunicationMessage", row) } as Prisma.InputJsonValue,
        encryptedPayloadJson: encryptSecret(communicationCanonicalJson(fetched.payload)), projectedContentJson: fetched.projected as Prisma.InputJsonValue,
        projectionHash: communicationNativeHash(communicationCanonicalJson(fetched.projected)), installationGrantHash: fetched.installationGrantHash,
        channelGrantHash: fetched.channelGrantHash, permissionEpochsJson: permissionEpochsJson as Prisma.InputJsonValue, epochProofVersion: 1,
        expiresRawAt: row.expiresRawAt!, fetchedAt: new Date(fetched.capturedAtMs) } });
      await withSlackNativeCommitReceipt(actor, workspace.id, input.id, tx, fetched, () => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
        artifact: { kind: "CommunicationMessage", id: row.id }, content: row, origin: "DERIVED", inputs: [{ kind: "CommunicationMessageNativeInput", id: input.id }] }));
      return row;
    });
    sourceId = message.id;
  }
  const params = { workspaceId: workspace.id, sourceType, sourceId };
  const canonical = await loadCanonicalKnowledgeSource(params);
  expect(canonical).not.toBeNull();
  await captureArtifactInputProof(actor, workspace.id, canonical!.inputs);
  return { ...params, actor, readerActor, member, user, circle, canonical: canonical! };
}

it.each(["ACTION", "TENSION", "CIRCLE", "ROLE", "SLACK"] as const)("indexes and ordinarily retrieves canonical %s with exact joined content", async sourceType => {
  const f = await fixture(sourceType);
  expect(await syncKnowledgeForSource({ ...f, accessDomain: "WORKSPACE", content: f.canonical.content, sourceTitle: f.canonical.title, metadata: f.canonical.metadata, lineageActor: f.actor })).toBe(1);
  const chunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { workspaceId: f.workspaceId, sourceId: f.sourceId } });
  expect(chunk.content).toBe(f.canonical.content);
  expect(chunk.metadata).toMatchObject({ sourceContentHash: f.canonical.contentHash, ...f.canonical.metadata });
  expect(chunk.metadata).not.toHaveProperty("externalTeamName");
  const roots = await captureArtifactInputProof(f.readerActor, f.workspaceId, [{ kind: "KnowledgeChunk", id: chunk.id }]);
  expect(roots.length).toBeGreaterThan(0);
  const found = await searchIndexedKnowledge({ actor: f.readerActor, workspaceId: f.workspaceId, query: "launch", sourceTypes: [sourceType], limit: 3 });
  expect(found.map(row => row.chunkId)).toEqual([chunk.id]);
  expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspaceId, chunk.id)).toMatchObject({ id: chunk.id, content: f.canonical.content });
}, 60000);

it("withholds previously indexed Action bytes after joined assignee membership revoke/restore", async () => {
  const f = await fixture("ACTION");
  await syncKnowledgeForSource({ ...f, accessDomain: "WORKSPACE", content: f.canonical.content, sourceTitle: f.canonical.title, metadata: f.canonical.metadata, lineageActor: f.actor });
  const chunk = await prisma.knowledgeChunk.findFirstOrThrow({ where: { workspaceId: f.workspaceId, sourceId: f.sourceId } });
  expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspaceId, chunk.id)).not.toBeNull();
  await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
  await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
  expect(await fetchReadableKnowledgeChunk(f.readerActor, f.workspaceId, chunk.id)).toBeNull();
  expect(await searchIndexedKnowledge({ actor: f.readerActor, workspaceId: f.workspaceId, query: "launch", sourceTypes: ["ACTION"] })).toEqual([]);
}, 60000);

it("rejects joined label drift during embedding without persisting a chunk", async () => {
  const f = await fixture("TENSION");
  vi.mocked(defaultModelGateway.embed).mockImplementationOnce(async ({ input, authorizeAttempt }) => {
    await authorizeAttempt?.({ signal: new AbortController().signal });
    await prisma.user.update({ where: { id: f.user.id }, data: { displayName: "Replaced author" } });
    return { embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage };
  });
  await expect(syncKnowledgeForSource({ ...f, accessDomain: "WORKSPACE", content: f.canonical.content, sourceTitle: f.canonical.title, metadata: f.canonical.metadata, lineageActor: f.actor })).resolves.toBe(0);
  expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
}, 60000);

it("withholds mixed-family retrieval when their shared original contributor changes between source reads", async () => {
  const f = await fixture("ACTION");
  const tension = await prisma.tension.create({ data: { workspaceId: f.workspaceId, authorUserId: f.user.id,
    title: "Canonical launch tension", bodyMd: "Original launch facts", circleId: f.circle.id } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "Tension", id: tension.id }, content: tension, origin: "HUMAN_ORIGINAL", inputs: [] }));
  for (const params of [f, { workspaceId: f.workspaceId, sourceType: "TENSION" as const, sourceId: tension.id }]) {
    const canonical = (await loadCanonicalKnowledgeSource(params))!;
    expect(await syncKnowledgeForSource({ ...params, content: canonical.content, sourceTitle: canonical.title,
      metadata: canonical.metadata, accessDomain: "WORKSPACE", lineageActor: f.actor })).toBe(1);
  }
  const { getPrismaClient } = await import("../../shared/src/db");
  const db = getPrismaClient();
  const actionFind = db.action.findMany.bind(db.action);
  const tensionFind = db.tension.findMany.bind(db.tension);
  const families = new Set<string>();
  let changed = false;
  const before = async (family: string, args: unknown) => {
    if (!args || typeof args !== "object" || !("include" in args)) return;
    families.add(family);
    if (families.size === 2 && !changed) {
      changed = true;
      await prisma.user.update({ where: { id: f.user.id }, data: { displayName: "Changed between families" } });
    }
  };
  vi.spyOn(db.action, "findMany").mockImplementation((async args => { await before("ACTION", args); return actionFind(args); }) as typeof db.action.findMany);
  vi.spyOn(db.tension, "findMany").mockImplementation((async args => { await before("TENSION", args); return tensionFind(args); }) as typeof db.tension.findMany);
  vi.mocked(defaultModelGateway.embed).mockClear();
  await expect(searchIndexedKnowledge({ actor: f.readerActor, workspaceId: f.workspaceId, query: "launch", sourceTypes: ["ACTION", "TENSION"] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
  expect(defaultModelGateway.embed).not.toHaveBeenCalled();
}, 60000);
