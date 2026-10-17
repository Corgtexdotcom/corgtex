import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptSecret, getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "../../knowledge/src/retrieval";
import { isArtifactInputProofReadable, captureArtifactInputProof } from "../../domain/src/source-lineage";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { handleOAuthDocumentsSync, handleOAuthEmailSync } from "./handlers/knowledge-sync";

beforeEach(truncateAllTables);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture(kind: "documents" | "email" = "documents", nullableWorkspace = false) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic OAuth indexing", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@oauth.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const connection = await prisma.oAuthConnection.create({data: {workspaceId: nullableWorkspace ? null : workspace.id, userId: user.id,
    provider: "GOOGLE", providerAccountId: "synthetic-account", accessToken: "synthetic-oauth-access",
    expiresAt: new Date(Date.now() + 3600_000), scopes: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/gmail.readonly"],
    syncSettings: {documents: {enabled: true, selectedDriveIds: ["doc-1"]}, email: {enabled: true, filters: ["subject:synthetic"]}}}});
  const job = await prisma.workflowJob.create({data: {workspaceId: workspace.id, type: `oauth.${kind}.sync`,
    payload: {connectionId: connection.id}, status: "RUNNING", lockedBy: "synthetic-worker", lockedAt: new Date(), startedAt: new Date(), attempts: 1}});
  const remote = {accountId: "synthetic-account", text: "Synthetic searchable cobalt policy."};
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return Response.json({id: remote.accountId});
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/doc-1?fields=")) return Response.json({id: "doc-1", name: "Synthetic policy", mimeType: "text/plain"});
    if (url === "https://www.googleapis.com/drive/v3/files/doc-1?alt=media") return new Response(remote.text);
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({messages: [{id: "email-1"}]});
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/email-1?")) return Response.json({id: "email-1", snippet: remote.text, payload: {headers: [{name: "Subject", value: "Synthetic policy"}]}});
    throw new Error("Unexpected provider endpoint in isolated fixture");
  });
  vi.stubGlobal("fetch", fetchMock);
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({input}) => ({embeddings: (Array.isArray(input) ? input : [input]).map(() => Array(1536).fill(0.01)),
    usage: {provider: "fixture", model: "fixture-embed", inputTokens: 1, outputTokens: 0, latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
  vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({documents, topK}) => ({results: documents.slice(0, topK).map((document, index) => ({index, score: 1, document})),
    usage: {provider: "fixture", model: "fixture-rerank", inputTokens: 1, outputTokens: 0, latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
  const run = () => (kind === "documents" ? handleOAuthDocumentsSync : handleOAuthEmailSync)(job.id, {connectionId: connection.id}, workspace.id, structuredClone(job));
  const actor: AppActor = {kind: "user", user};
  const search = () => searchIndexedKnowledge({actor, workspaceId: workspace.id, query: "cobalt policy", sourceTypes: ["DOCUMENT"]});
  return {workspace, user, member, connection, job, actor, run, search, remote, fetchMock, embed};
}

it.each(["documents", "email"] as const)("publishes searchable canonical OAuth %s before marking sync successful", async kind => {
  const {workspace, connection, job, run, search} = await fixture(kind);
  await run();
  const current = await prisma.oAuthConnection.findUniqueOrThrow({where: {id: connection.id}});
  expect(current.status).toBe("ACTIVE");
  expect(current.lastSyncAt).not.toBeNull();
  const chunks = await prisma.knowledgeChunk.findMany({where: {workspaceId: workspace.id}});
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.some(chunk => chunk.content.includes("Synthetic searchable cobalt policy."))).toBe(true);
  const document = await prisma.document.findFirstOrThrow({where: {workspaceId: workspace.id}});
  expect(chunks.map(chunk => chunk.sourceId)).toEqual([document.id]);
  expect(await prisma.artifactInputLineage.findFirst({where: {workspaceId: workspace.id, artifactType: "Document", artifactId: document.id}})).toMatchObject({origin: "DERIVED"});
  await prisma.workflowJob.update({where: {id: job.id}, data: {status: "COMPLETED", lockedBy: null, lockedAt: null}});
  expect((await search()).map(row => row.sourceId)).toContain(document.id);
});

it("reindexes a stable document id and preserves null-workspace owner binding through token rotation", async () => {
  const f = await fixture("documents", true);
  await f.run();
  const first = await prisma.document.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "Document", id: first.id, snapshot: first}]);
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {accessToken: encryptSecret("synthetic-rotated-token"),
    refreshToken: encryptSecret("synthetic-rotated-refresh"), tokenStorageVersion: "aes-256-gcm", expiresAt: new Date(Date.now()+7200_000)}});
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
  await f.run();
  expect(await prisma.document.findMany({where: {workspaceId: f.workspace.id}, select: {id: true}})).toEqual([{id: first.id}]);
  expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(1);
  expect((await f.search()).map(row => row.sourceId)).toContain(first.id);
});

it.each(["selection", "account", "owner"] as const)("withholds publication after original %s revocation and restoration at the embedding credential boundary", async mode => {
  const f = await fixture("documents", true);
  let sent = 0;
  f.embed.mockImplementationOnce(async request => {
    if (mode === "selection") {
      await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: {documents: {enabled: false}}}});
      await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: f.connection.syncSettings as Prisma.InputJsonValue}});
    } else if (mode === "account") {
      await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {providerAccountId: "other-account"}});
      await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {providerAccountId: f.connection.providerAccountId}});
    } else {
      await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
      await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
    }
    await request.authorizeAttempt!({signal: request.signal!});
    sent++;
    throw new Error("Forbidden embedding dispatched");
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.embed).toHaveBeenCalledTimes(1);
  expect(sent).toBe(0);
  expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({lastSyncAt: null, status: "ACTIVE"});
});

it("checks the original account after credential refresh and does not publish an alien provider response", async () => {
  const f = await fixture();
  f.remote.accountId = "other-account";
  await expect(f.run()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(f.fetchMock).toHaveBeenCalledTimes(1);
  expect(f.embed).not.toHaveBeenCalled();
  expect(await prisma.oAuthProviderFetchInput.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({lastSyncAt: null, status: "ERROR"});
});

it("denies changed remote bytes after a completed sync and rejects forged receipt bodies", async () => {
  const f = await fixture(); await f.run();
  const input = await prisma.oAuthProviderFetchInput.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "OAuthProviderFetchInput", id: input.id, snapshot: input}]);
  await expect(prisma.oAuthProviderFetchInput.update({where: {id: input.id}, data: {externalId: "forged"}})).rejects.toThrow("immutable");
  f.remote.text = "Changed provider bytes";
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(false);
  expect(await f.search()).toEqual([]);
});

it("does not checkpoint or revive a disconnect after the chunk transaction returns", async () => {
  const f = await fixture();
  const client = getPrismaClient();
  const original = client.$transaction.bind(client);
  let published = false, disconnected = false;
  vi.spyOn(client, "$transaction").mockImplementation((async (work: any, options: any) => {
    if (typeof work !== "function") return original(work, options);
    const value = await original(async tx => {
      const create = tx.knowledgeChunk.createMany.bind(tx.knowledgeChunk);
      tx.knowledgeChunk.createMany = (async (...args: any[]) => {const result = await (create as any)(...args); published = true; return result;}) as typeof create;
      try { return await work(tx); } finally { tx.knowledgeChunk.createMany = create; }
    }, options);
    if (published && !disconnected) {
      disconnected = true;
      await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {status: "DISCONNECTED", disconnectedAt: new Date()}});
    }
    return value;
  }) as typeof prisma.$transaction);
  await expect(f.run()).rejects.toThrow();
  expect(published && disconnected).toBe(true);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({lastSyncAt: null, status: "DISCONNECTED"});
  expect(await f.search()).toEqual([]);
});

it.each([false, true])("fences the actual token refresh response before publication (disconnect=%s)", async disconnect => {
  const f = await fixture();
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {expiresAt: new Date(0),
    refreshToken: encryptSecret("synthetic-refresh"), accessToken: encryptSecret("synthetic-expired"), tokenStorageVersion: "aes-256-gcm"}});
  const respond = f.fetchMock.getMockImplementation()!;
  let refreshed = 0;
  f.fetchMock.mockImplementation(async input => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      refreshed++;
      if (disconnect) await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {status: "DISCONNECTED", disconnectedAt: new Date()}});
      return Response.json({access_token: "synthetic-refreshed", refresh_token: "synthetic-rotated", expires_in: 3600});
    }
    return respond(input);
  });
  if (disconnect) {
    await expect(f.run()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(f.embed).not.toHaveBeenCalled();
    expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(0);
    expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({status: "DISCONNECTED", lastSyncAt: null});
  } else {
    await f.run();
    expect((await f.search()).length).toBeGreaterThan(0);
    expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({status: "ACTIVE", lastSyncError: null});
  }
  expect(refreshed).toBe(1);
});


it.each(["expired", "takeover-before-begin", "replacement-during-replay"] as const)("rejects the original OAuth worker claim: %s", async mode => {
  const f = await fixture();
  let replaced = false, sent = 0;
  const replace = async () => {
    await prisma.workflowJob.update({where: {id: f.job.id}, data: mode === "expired"
      ? {lockedAt: new Date(Date.now() - 6 * 60_000)}
      : {attempts: {increment: 1}, lockedBy: "replacement-worker", lockedAt: new Date()}});
    replaced = true;
  };
  if (mode === "expired") {
    await replace();
    // Even an exact originally claimed recipe cannot outlive the normal five-minute lease.
    f.job.lockedAt = new Date(Date.now() - 6 * 60_000);
    await prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedAt: f.job.lockedAt}});
  } else if (mode === "takeover-before-begin") {
    const find = prisma.oAuthConnection.findUnique.bind(prisma.oAuthConnection);
    vi.spyOn(prisma.oAuthConnection, "findUnique").mockImplementationOnce((async args => {
      const row = await find(args);
      await replace();
      return row;
    }) as typeof prisma.oAuthConnection.findUnique);
  } else {
    f.embed.mockImplementationOnce(async request => {
      const respond = f.fetchMock.getMockImplementation()!;
      f.fetchMock.mockImplementation(async input => {
        const result = await respond(input);
        if (!replaced && String(input).includes("alt=media")) await replace();
        return result;
      });
      await request.authorizeAttempt!({signal: request.signal!});
      sent++;
      return {embeddings: [Array(1536).fill(0.01)], usage: {provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0, latencyMs: 0,
        estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}};
    });
  }
  await expect(f.run()).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(sent).toBe(0);
  if (mode !== "replacement-during-replay") expect(f.fetchMock).not.toHaveBeenCalled();
  expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({lastSyncAt: null, status: "ACTIVE"});
  if (mode !== "expired") expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toMatchObject({attempts: 2, lockedBy: "replacement-worker", status: "RUNNING"});
});

it("shares provider-derived workspace documents with another current member after the job completes", async () => {
  const f = await fixture(); await f.run();
  await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "COMPLETED", lockedAt: null, lockedBy: null}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@oauth.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: f.workspace.id, userId: user.id, role: "CONTRIBUTOR"}});
  const rows = await searchIndexedKnowledge({actor: {kind: "user", user}, workspaceId: f.workspace.id, query: "cobalt policy", sourceTypes: ["DOCUMENT"]});
  expect(rows.some(row => row.snippet.includes("Synthetic searchable cobalt policy."))).toBe(true);
});
