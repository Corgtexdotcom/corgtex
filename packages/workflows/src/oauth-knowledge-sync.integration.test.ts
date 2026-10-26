import { withOAuthKnowledgeSyncLease } from "../../domain/src/oauth-knowledge-sync-lease";
import { PrismaClient, type Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptSecret, getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "../../knowledge/src/retrieval";
import { isArtifactInputProofReadable, captureArtifactInputProof } from "../../domain/src/source-lineage";
import { createCrmAccount, createContact, getCrmConversation, listCrmActivities } from "../../domain/src/crm";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import * as knowledge from "@corgtex/knowledge";
import * as domain from "@corgtex/domain";
import { runPendingJobs } from "./outbox";
import { handleCalendarSync, handleOAuthDocumentsSync, handleOAuthEmailSync } from "./handlers/knowledge-sync";

beforeEach(truncateAllTables);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function fixture(kind: "documents" | "email" = "documents", nullableWorkspace = false, provider: "GOOGLE" | "MICROSOFT" = "GOOGLE") {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic OAuth indexing", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@oauth.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const connection = await prisma.oAuthConnection.create({data: {workspaceId: nullableWorkspace ? null : workspace.id, userId: user.id,
    provider, providerAccountId: "synthetic-account", accessToken: "synthetic-oauth-access",
    expiresAt: new Date(Date.now() + 3600_000), scopes: provider === "GOOGLE" ? ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/gmail.readonly"] : ["Files.Read", "Mail.Read"],
    syncSettings: {documents: {enabled: true, selectedDriveIds: ["doc-1"]}, email: {enabled: true, filters: ["subject:synthetic"]}}}});
  const job = await prisma.workflowJob.create({data: {workspaceId: workspace.id, type: `oauth.${kind}.sync`,
    payload: {connectionId: connection.id}, status: "RUNNING", lockedBy: "synthetic-worker", lockedAt: new Date(), startedAt: new Date(), attempts: 1}});
  const remote = {accountId: "synthetic-account", from: "person@synthetic.example", text: "Synthetic searchable cobalt policy."};
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return Response.json({id: remote.accountId});
    if (url === "https://graph.microsoft.com/v1.0/me") return Response.json({id: remote.accountId});
    if (url === "https://graph.microsoft.com/v1.0/me/drive/items/doc-1") return Response.json({id: "doc-1", name: "Synthetic policy", file: {mimeType: "text/plain"}});
    if (url === "https://graph.microsoft.com/v1.0/me/drive/items/doc-1/content") return new Response(remote.text);
    const graphMessage = {id: "email-1", subject: "Synthetic policy", from: {emailAddress: {address: remote.from}},
      receivedDateTime: "2026-06-18T09:00:00Z", bodyPreview: remote.text};
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/messages/email-1?")) return Response.json(graphMessage);
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/messages?")) return Response.json({value: [graphMessage]});
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/doc-1?fields=")) return Response.json({id: "doc-1", name: "Synthetic policy", mimeType: "text/plain"});
    if (url === "https://www.googleapis.com/drive/v3/files/doc-1?alt=media") return new Response(remote.text);
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({messages: [{id: "email-1"}]});
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/email-1?")) return Response.json({id: "email-1", snippet: remote.text, payload: {headers: [{name: "Subject", value: "Synthetic policy"}, {name: "From", value: remote.from}, {name: "Message-ID", value: "<email-1@synthetic.example>"}]}});
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
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({lastSyncAt: null, status: "ACTIVE",
    lastSyncError: "OAuth content could not be safely indexed; retry after checking source access."});
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


it("accepts an existing full Google Drive grant", async () => {
  const f = await fixture();
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes: ["https://www.googleapis.com/auth/drive"]}});
  await f.run();
  expect((await f.search()).length).toBeGreaterThan(0);
});

it("keeps completed email readable across unrelated document selection changes and a newer inbox page", async () => {
  const f = await fixture("email"); await f.run();
  await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "COMPLETED", lockedBy: null, lockedAt: null}});
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes: ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/gmail.readonly"], syncSettings: {
    documents: {enabled: true, selectedDriveIds: ["other-doc"]}, email: {enabled: true, filters: ["subject:synthetic"]},
  }}});
  const respond = f.fetchMock.getMockImplementation()!;
  f.fetchMock.mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname === "/gmail/v1/users/me/messages" && !url.searchParams.get("q")?.includes("rfc822msgid:")) {
      return Response.json({messages: Array.from({length: 10}, (_, i) => ({id: `newer-${i}`}))});
    }
    return respond(input);
  });
  expect((await f.search()).length).toBeGreaterThan(0);
});

it("publishes readable matched CRM email activity, conversation and message idempotently", async () => {
  const f = await fixture("email");
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: {email: {enabled: true, filters: ["from:person@synthetic.example"]}}}});
  const account = await createCrmAccount(f.actor, {workspaceId: f.workspace.id, name: "Synthetic account", domain: "synthetic.example"});
  await createContact(f.actor, {workspaceId: f.workspace.id, accountId: account.id, name: "Synthetic sender", email: f.remote.from});
  await f.run();
  const conversation = await prisma.crmConversation.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  expect((await listCrmActivities(f.actor, f.workspace.id)).items.length).toBe(1);
  expect((await getCrmConversation(f.actor, {workspaceId: f.workspace.id, conversationId: conversation.id})).messages).toMatchObject([{bodyMd: f.remote.text}]);
  await f.run();
  expect(await prisma.crmActivity.count({where: {workspaceId: f.workspace.id}})).toBe(1);
  expect(await prisma.crmConversation.count({where: {workspaceId: f.workspace.id}})).toBe(1);
  expect(await prisma.crmConversationMessage.count({where: {conversationId: conversation.id}})).toBe(1);
  const manifests = await prisma.artifactInputLineage.findMany({where: {workspaceId: f.workspace.id, artifactType: {in: ["CrmActivity", "CrmConversation", "CrmConversationMessage"]}}});
  expect(new Set(manifests.map(row => row.artifactType)).size).toBe(3);
  expect(manifests.every(row => row.origin === "DERIVED")).toBe(true);
});

it("retains source-kind governors through immutable native snapshot capture", async () => {
  const f = await fixture();
  const {beginOAuthKnowledgeSync} = await import("../../domain/src/oauth-provider-native");
  const {prepareArtifactCommitPreflight, withArtifactCommitPreflight} = await import("../../domain/src/artifact-commit-preflight");
  const {captureImmutableArtifactInputProof, assertArtifactInputWriteFence} = await import("../../domain/src/source-lineage");
  await withOAuthKnowledgeSyncLease(f.job, async () => {
  const capture = await beginOAuthKnowledgeSync({workspaceId:f.workspace.id,connectionId:f.connection.id,workflowJobId:f.job.id,kind:"documents",expectedClaim:f.job});
  const proof = await captureArtifactInputProof(capture.actor,f.workspace.id,[{kind:"Document",id:capture.documents[0]!.id,snapshot:capture.documents[0]!}]);
  expect(await isArtifactInputProofReadable(capture.actor,f.workspace.id,proof)).toBe(true);
  const prepared = await prepareArtifactCommitPreflight(capture.actor,f.workspace.id,proof);
  const frozen = await prisma.$transaction(async tx => {await assertArtifactInputWriteFence(tx);return withArtifactCommitPreflight(capture.actor,f.workspace.id,tx,proof,prepared,()=>captureImmutableArtifactInputProof(capture.actor,f.workspace.id,proof,tx));});
  expect(await isArtifactInputProofReadable(capture.actor,f.workspace.id,frozen)).toBe(true);
  });
});

it.each(["email-selection-aba", "takeover"] as const)("rolls back CRM publication after %s between native preflight and its transaction", async mode => {
  const f = await fixture("email");
  const settings = {email: {enabled: true, filters: ["from:person@synthetic.example"]}};
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: settings}});
  const account = await createCrmAccount(f.actor, {workspaceId: f.workspace.id, name: "Synthetic account", domain: "synthetic.example"});
  await createContact(f.actor, {workspaceId: f.workspace.id, accountId: account.id, name: "Synthetic sender", email: f.remote.from});
  const preflights = await import("../../domain/src/artifact-commit-preflight");
  const prepare = preflights.prepareArtifactCommitPreflight;
  let changed = false;
  vi.spyOn(preflights, "prepareArtifactCommitPreflight").mockImplementation(async (...args) => {
    const token = await prepare(...args);
    if (!changed && args[2].some(root => root.kind === "CrmContact")) {
      if (mode === "takeover") {
        await prisma.workflowJob.update({where: {id: f.job.id}, data: {attempts: {increment: 1}, lockedBy: "replacement-worker", lockedAt: new Date()}});
      } else {
        await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: {email: {enabled: false}}}});
        await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: settings}});
      }
      changed = true;
    }
    return token;
  });
  await expect(f.run()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
  expect(await prisma.crmActivity.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.crmConversation.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.crmConversationMessage.count()).toBe(0);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({status: "ACTIVE", lastSyncAt: null, lastSyncError: null});
  if (mode === "takeover") expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toMatchObject({status: "RUNNING", attempts: 2, lockedBy: "replacement-worker"});
});

it("invalidates old email and all three CRM projections after relevant grant revocation and restoration", async () => {
  const f = await fixture("email");
  const settings = {email: {enabled: true, filters: ["from:person@synthetic.example"]}};
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {syncSettings: settings}});
  const account = await createCrmAccount(f.actor, {workspaceId: f.workspace.id, name: "Synthetic account", domain: "synthetic.example"});
  await createContact(f.actor, {workspaceId: f.workspace.id, accountId: account.id, name: "Synthetic sender", email: f.remote.from});
  await f.run();
  const conversation = await prisma.crmConversation.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "COMPLETED", lockedBy: null, lockedAt: null}});
  const colleague = await prisma.user.create({data: {email: `${randomUUID()}@oauth.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: f.workspace.id, userId: colleague.id, role: "CONTRIBUTOR"}});
  const reader: AppActor = {kind: "user", user: colleague};
  expect((await getCrmConversation(reader, {workspaceId: f.workspace.id, conversationId: conversation.id})).messages).toHaveLength(1);
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes: ["https://www.googleapis.com/auth/drive.file"]}});
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes: f.connection.scopes}});
  expect((await listCrmActivities(reader, f.workspace.id)).items).toEqual([]);
  await expect(getCrmConversation(reader, {workspaceId: f.workspace.id, conversationId: conversation.id})).rejects.toMatchObject({code: "NOT_FOUND"});
  expect(await f.search()).toEqual([]);
});

it("rejects a lookalike publication token and changed caller message bytes", async () => {
  const f = await fixture("email");
  const {beginOAuthKnowledgeSync} = await import("../../domain/src/oauth-provider-native");
  const {materializeCrmEmailTouchpoints} = await import("../../domain/src/crm-information-gathering");
  await withOAuthKnowledgeSyncLease(f.job, async () => {
  const capture = await beginOAuthKnowledgeSync({workspaceId: f.workspace.id, connectionId: f.connection.id, workflowJobId: f.job.id, kind: "email", expectedClaim: f.job});
  const params = {workspaceId: f.workspace.id, connectionId: f.connection.id, messages: capture.messages, publication: capture.emailPublication};
  await expect(materializeCrmEmailTouchpoints({...params, publication: {} as typeof capture.emailPublication})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  await expect(materializeCrmEmailTouchpoints({...params, messages: capture.messages.map(message => ({...message, snippet: "Forged body"}))})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(await prisma.crmActivity.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  });
});


it("retains shared identity scope revocation across restore for saved email", async () => {
  const f = await fixture("email");
  const scopes = [...f.connection.scopes, "profile"];
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes}});
  await f.run();
  expect((await f.search()).length).toBeGreaterThan(0);
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes: f.connection.scopes}});
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {scopes}});
  expect(await f.search()).toEqual([]);
});


it("renews the original OAuth claim through more than five minutes and multiple messages", async () => {
  const f = await fixture("email");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
  const originalFetch = f.fetchMock.getMockImplementation()!;
  let advanced = false;
  const acknowledged: number[] = [];
  f.fetchMock.mockImplementation(async input => {
    const url = String(input);
    if (!advanced && url.includes("/messages?")) {
      advanced = true;
      // A provider wait spanning seven minutes. Each minute's real DB CAS must
      // finish before the next simulated minute; the original attempt never changes.
      for (let minute = 0; minute < 7; minute++) {
        now += 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
        const {currentOAuthKnowledgeSyncLease} = await import("../../domain/src/oauth-knowledge-sync-lease");
        await currentOAuthKnowledgeSyncLease(f.job).readGuard(async () => {});
        acknowledged.push((await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).lockedAt!.getTime());
        expect(acknowledged.at(-1)).toBe(now);
      }
    }
    if (url.includes("/messages?")) return Response.json({messages: [{id: "email-1"}, {id: "email-2"}]});
    if (url.includes("/messages/email-2?")) return Response.json({id: "email-2", snippet: f.remote.text, payload: {headers: [{name: "Subject", value: "Second policy"}, {name: "From", value: f.remote.from}, {name: "Message-ID", value: "<email-2@synthetic.example>"}]}});
    return originalFetch(input);
  });
  await f.run();
  const job = await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}});
  expect(job).toMatchObject({attempts: 1, lockedBy: f.job.lockedBy, startedAt: f.job.startedAt, payload: f.job.payload});
  expect(job.lockedAt!.getTime()).toBe(now);
  expect(new Set(acknowledged).size).toBe(7);
  expect(await prisma.document.count({where: {workspaceId: f.workspace.id}})).toBe(2);
  expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(2);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({status: "ACTIVE", lastSyncAt: expect.any(Date)});
  expect(vi.getTimerCount()).toBe(0);
}, 120_000);


it("cannot revive a lease that expires while renewal waits for a real row lock", async () => {
  const f = await fixture();
  let now = Date.now();
  const original = await prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedAt: new Date(now - 180_000)}});
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
  const {createOAuthKnowledgeSyncLease} = await import("../../domain/src/oauth-knowledge-sync-lease");
  const owner = createOAuthKnowledgeSyncLease(original);
  let unlock!: () => void; let locked!: () => void;
  const lockAcquired = new Promise<void>(resolve => {locked = resolve;});
  const releaseLock = new Promise<void>(resolve => {unlock = resolve;});
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id=${f.job.id} FOR UPDATE`;
    locked(); await releaseLock;
  });
  await lockAcquired;
  try {
    now += 60_000; await vi.advanceTimersByTimeAsync(60_000);
    let observedLockWait = false;
    for (let attempt = 0; attempt < 30 && !observedLockWait; attempt++) {
      const waits = await prisma.$queryRaw<Array<{count: bigint}>>`SELECT count(*) FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%WorkflowJob%FOR UPDATE%'`;
      observedLockWait = Number(waits[0]?.count) > 0;
      if (!observedLockWait) await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(observedLockWait).toBe(true);
    // The original four-minute stamp expires while the renewal is blocked.
    now += 120_000; unlock(); await blocker;
    await expect(owner.readGuard(async () => {})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect((await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).lockedAt).toEqual(original.lockedAt);
    expect(await owner.settle({status: "COMPLETED"})).toEqual({count: 0});
    expect(owner.signal.aborted).toBe(true);
  } finally {unlock(); await blocker; await owner.dispose();}
  expect(vi.getTimerCount()).toBe(0);
});

it("a takeover during provider wait cannot be renewed or checkpointed by the old handler", async () => {
  const f = await fixture();
  vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
  const fetch = f.fetchMock.getMockImplementation()!;
  let replacement: Awaited<ReturnType<typeof prisma.workflowJob.findUniqueOrThrow>> | null = null;
  f.fetchMock.mockImplementation(async input => {
    if (!replacement && String(input).includes("alt=media")) {
      replacement = await prisma.workflowJob.update({where: {id: f.job.id}, data: {attempts: 2, lockedBy: "replacement-worker", lockedAt: new Date(Date.now() + 1)}});
      await vi.advanceTimersByTimeAsync(60_000);
    }
    return fetch(input);
  });
  await expect(f.run()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toEqual(replacement);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({status: "ACTIVE", lastSyncAt: null, lastSyncError: null});
  expect(await prisma.document.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.oAuthProviderFetchInput.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(f.embed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});


it("keeps saturated Outlook membership indeterminate through native proof and commit preflight", async () => {
  const f = await fixture("email");
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {provider: "MICROSOFT", scopes: ["Mail.Read"]}});
  let state: "matched" | "saturated" | "malformed" | "absent" = "matched";
  const message = {id: "email-1", subject: "Synthetic policy", from: {emailAddress: {address: f.remote.from}},
    bodyPreview: f.remote.text, receivedDateTime: "2026-06-18T09:00:00.999Z"};
  f.fetchMock.mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname === "/v1.0/me") return Response.json({id: f.remote.accountId});
    if (url.pathname === "/v1.0/me/messages/email-1") return Response.json(message);
    if (url.pathname === "/v1.0/me/messages") {
      if (url.searchParams.get("$top") === "10") return Response.json({value: [message]});
      if (state === "saturated") return Response.json({value: Array.from({length: 1000}, (_, i) => ({id: `other-${i}`}))});
      if (state === "malformed") return Response.json({value: [], "@odata.nextLink": "not-a-url"});
      return Response.json({value: state === "absent" ? [] : [message]});
    }
    throw new Error("Unexpected synthetic Outlook endpoint");
  });
  await f.run();
  const {isOAuthProviderFetchInputCurrent} = await import("../../domain/src/oauth-provider-native");
  const {prepareOAuthProviderReadCommitPreflight} = await import("../../domain/src/oauth-provider-read-preflight");
  const input = await prisma.oAuthProviderFetchInput.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "OAuthProviderFetchInput", id: input.id, snapshot: input}]);
  const before = {document: await prisma.document.findMany({where: {workspaceId: f.workspace.id}}),
    chunks: await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id}})};
  expect(before.document).toHaveLength(1); expect(before.chunks.length).toBeGreaterThan(0);
  expect(await isOAuthProviderFetchInputCurrent(f.actor, f.workspace.id, input)).toBe(true);
  for (const next of ["saturated", "malformed"] as const) {
    state = next;
    await expect(isOAuthProviderFetchInputCurrent(f.actor, f.workspace.id, input)).rejects.toMatchObject({status: 503, code: "OAUTH_SELECTION_INCOMPLETE"});
    await expect(isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).rejects.toMatchObject({code: "OAUTH_SELECTION_INCOMPLETE"});
    await expect(prepareOAuthProviderReadCommitPreflight(f.actor, f.workspace.id, roots, roots)).rejects.toMatchObject({code: "OAUTH_SELECTION_INCOMPLETE"});
    expect({document: await prisma.document.findMany({where: {workspaceId: f.workspace.id}}),
      chunks: await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id}})}).toEqual(before);
  }
  state = "matched";
  expect(await isOAuthProviderFetchInputCurrent(f.actor, f.workspace.id, input)).toBe(true);
  expect((await f.search()).map(row => row.sourceId)).toContain(before.document[0]!.id);
  state = "absent";
  expect(await isOAuthProviderFetchInputCurrent(f.actor, f.workspace.id, input)).toBe(false);
});

it.each([["documents", "GOOGLE"], ["email", "GOOGLE"], ["documents", "MICROSOFT"], ["email", "MICROSOFT"]] as const)("keeps saved OAuth %s/%s inputs indeterminate on transient provider failures without losing their lineage", async (kind, provider) => {
  const f = await fixture(kind, false, provider);
  await f.run();
  const document = await prisma.document.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "Document", id: document.id}]);
  const original = f.fetchMock.getMockImplementation()!;
  const manifests = await prisma.artifactInputLineage.findMany({where: {workspaceId: f.workspace.id}, orderBy: {id: "asc"}});
  for (const failure of [429, 503, "network", "malformed", "empty"] as const) {
    f.fetchMock.mockImplementation(async input => {
      if (["https://www.googleapis.com/oauth2/v2/userinfo", "https://graph.microsoft.com/v1.0/me"].includes(String(input))) return original(input);
      if (failure === "network") throw new TypeError("Synthetic network unavailable");
      return failure === "malformed" ? new Response("{invalid-json") : failure === "empty" ? new Response("")
        : new Response("Synthetic transient response", {status: failure});
    });
    await expect(isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).rejects.toMatchObject({status: 503, code: "OAUTH_PROVIDER_INDETERMINATE"});
    expect(await prisma.artifactInputLineage.findMany({where: {workspaceId: f.workspace.id}, orderBy: {id: "asc"}})).toEqual(manifests);
    f.fetchMock.mockImplementation(original);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
  }
  for (const status of [401, 403, 404, 410]) {
    f.fetchMock.mockImplementation(async input => ["https://www.googleapis.com/oauth2/v2/userinfo", "https://graph.microsoft.com/v1.0/me"].includes(String(input))
      ? original(input) : new Response("Synthetic definitive denial", {status}));
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(false);
  }
  f.fetchMock.mockImplementation(original);
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
}, 120_000);

it.each(["GOOGLE", "MICROSOFT"] as const)("keeps original %s authority through transient expired-token refresh and denies invalid grant", async provider => {
  const f = await fixture("documents", false, provider);
  await f.run();
  const document = await prisma.document.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "Document", id: document.id}]);
  const original = f.fetchMock.getMockImplementation()!;
  const tokenUrl = provider === "GOOGLE" ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
  const expire = () => prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {
    expiresAt: new Date("2026-01-01T00:00:00Z"), refreshToken: encryptSecret("synthetic-refresh"), tokenStorageVersion: "aes-256-gcm"}});
  for (const failure of [429, 503, "network", "malformed", "empty"] as const) {
    const before = await expire();
    f.fetchMock.mockImplementation(async input => {
      if (String(input) !== tokenUrl) return original(input);
      if (failure === "network") throw new TypeError("Synthetic token transport unavailable");
      return failure === "malformed" ? new Response("{invalid-json") : failure === "empty" ? new Response("")
        : new Response("Synthetic transient token response", {status: failure});
    });
    await expect(isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).rejects.toMatchObject({status: 503, code: "OAUTH_PROVIDER_INDETERMINATE"});
    expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toEqual(before);
    f.fetchMock.mockImplementation(async input => String(input) === tokenUrl
      ? Response.json({access_token: "synthetic-refreshed", expires_in: 3600}) : original(input));
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
  }
  await expire();
  f.fetchMock.mockImplementation(async input => String(input) === tokenUrl
    ? Response.json({error: "invalid_grant"}, {status: 400}) : original(input));
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(false);
  expect(await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toMatchObject({status: "ERROR"});
}, 120_000);

it.each([["GOOGLE", "fetch"], ["GOOGLE", "model"], ["MICROSOFT", "fetch"], ["MICROSOFT", "model"]] as const)("preserves existing %s grant authority after a later background %s failure", async (provider, phase) => {
  const f = await fixture("documents", false, provider);
  await f.run();
  const document = await prisma.document.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  const originalDocumentProof = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "Document", id: document.id}]);
  const input = await prisma.oAuthProviderFetchInput.findFirstOrThrow({where: {workspaceId: f.workspace.id}, orderBy: {createdAt: "asc"}});
  const originalNativeProof = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "OAuthProviderFetchInput", id: input.id}]);
  const before = await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}});
  const readGrantEpochs = () => prisma.sourcePermissionEpoch.findMany({where: {workspaceId: f.workspace.id,
    sourceId: f.connection.id, sourceKind: {in: ["OAuthConnectionPolicy", "OAuthDocumentsPolicy", "OAuthEmailPolicy"]}}, orderBy: {id: "asc"}});
  const epochs = await readGrantEpochs();
  const job = await prisma.workflowJob.create({data: {workspaceId: f.workspace.id, type: "oauth.documents.sync",
    payload: {connectionId: f.connection.id}, status: "RUNNING", lockedBy: "synthetic-next-worker", lockedAt: new Date(), startedAt: new Date(), attempts: 1}});
  const original = f.fetchMock.getMockImplementation()!;
  if (phase === "fetch") f.fetchMock.mockImplementation(async url =>
    ["https://www.googleapis.com/oauth2/v2/userinfo", "https://graph.microsoft.com/v1.0/me"].includes(String(url))
      ? original(url) : new Response("Synthetic temporary provider outage", {status: 503}));
  else f.embed.mockRejectedValueOnce(new Error("Synthetic indexing provider unavailable"));
  await expect(handleOAuthDocumentsSync(job.id, {connectionId: f.connection.id}, f.workspace.id, structuredClone(job))).rejects.toThrow();
  const after = await prisma.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}});
  expect(after).toMatchObject({status: "ACTIVE", lastSyncAt: before.lastSyncAt,
    lastSyncError: "OAuth content could not be safely indexed; retry after checking source access.",
    accessToken: before.accessToken, refreshToken: before.refreshToken, syncSettings: before.syncSettings});
  expect(await readGrantEpochs()).toEqual(epochs);
  expect(await prisma.oAuthProviderFetchInput.findUniqueOrThrow({where: {id: input.id}})).toEqual(input);
  if (phase === "fetch") expect(await prisma.oAuthProviderFetchInput.count({where: {workspaceId: f.workspace.id}})).toBe(1);
  else expect(f.embed).toHaveBeenCalledTimes(2);
  f.fetchMock.mockImplementation(original);
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, originalNativeProof)).toBe(true);
  if (phase === "fetch") expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, originalDocumentProof)).toBe(true);
}, 120_000);

// Observe committed authority through a distinct Prisma connection, including the
// trigger-maintained epochs and permission events. All providers below are stubbed.
const calendarObserver = new PrismaClient();
afterAll(() => calendarObserver.$disconnect());
const calendarDiagnostic = "Calendar sync failed; retry after checking provider and processing availability.";
async function calendarFixture(provider: "GOOGLE" | "MICROSOFT") {
  const f = await fixture("documents", false, provider);
  await f.run();
  const emailJob = await prisma.workflowJob.create({data: {workspaceId: f.workspace.id, type: "oauth.email.sync",
    payload: {connectionId: f.connection.id}, status: "RUNNING", lockedBy: "synthetic-email-worker", lockedAt: new Date(), startedAt: new Date(), attempts: 1}});
  await handleOAuthEmailSync(emailJob.id, {connectionId: f.connection.id}, f.workspace.id, structuredClone(emailJob));
  const inputs = await prisma.oAuthProviderFetchInput.findMany({where: {workspaceId: f.workspace.id}, orderBy: {id: "asc"}});
  expect(new Set(inputs.map(input => input.sourceKind))).toEqual(new Set(["documents", "email"]));
  const nativeProofs = await Promise.all(inputs.map(input => captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "OAuthProviderFetchInput", id: input.id}])));
  const documents = await prisma.document.findMany({where: {workspaceId: f.workspace.id}, orderBy: {id: "asc"}});
  expect(documents).toHaveLength(2);
  const derivedProofs = await Promise.all(documents.map(document => captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "Document", id: document.id}])));
  const respond = f.fetchMock.getMockImplementation()!;
  const isCalendar = (input: string | URL | Request) => String(input).includes("/calendar/v3/") || String(input).includes("/v1.0/me/events?");
  const isToken = (input: string | URL | Request) => String(input).includes("/token");
  const healthy = async (input: string | URL | Request) => isCalendar(input) ? Response.json({items: [], value: []})
    : isToken(input) ? Response.json({access_token: "synthetic-refreshed-calendar", expires_in: 3600}) : respond(input);
  f.fetchMock.mockImplementation(healthy);
  const run = () => handleCalendarSync("synthetic-calendar-job", {connectionId: f.connection.id}, f.workspace.id);
  await run();
  const read = async () => ({
    connection: await calendarObserver.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}}),
    epochs: await calendarObserver.sourcePermissionEpoch.findMany({where: {workspaceId: f.workspace.id,
      sourceId: f.connection.id, sourceKind: {in: ["OAuthConnectionPolicy", "OAuthDocumentsPolicy", "OAuthEmailPolicy"]}}, orderBy: {id: "asc"}}),
    inputs: await calendarObserver.oAuthProviderFetchInput.findMany({where: {workspaceId: f.workspace.id}, orderBy: {id: "asc"}}),
    lineage: await calendarObserver.artifactInputLineage.findMany({where: {workspaceId: f.workspace.id}, orderBy: {id: "asc"}}),
    permissionEvents: await calendarObserver.event.findMany({where: {workspaceId: f.workspace.id, type: "source-permission.changed"}, orderBy: {id: "asc"}}),
  });
  const readable = async (expected = true) => {
    for (const proof of [...nativeProofs, ...derivedProofs]) expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(expected);
  };
  const expire = () => prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {expiresAt: new Date(0),
    refreshToken: encryptSecret("synthetic-refresh"), tokenStorageVersion: "aes-256-gcm"}});
  return {...f, run, read, readable, expire, nativeProofs, derivedProofs, healthy, isCalendar, isToken};
}
function calendarFailure(failure: number | "network" | "malformed" | "empty") {
  if (failure === "network") throw new TypeError("Synthetic private transport payload");
  return failure === "malformed" ? new Response("{invalid-json") : failure === "empty" ? new Response("")
    : new Response("Synthetic private provider payload", {status: failure});
}
type CalendarState = Awaited<ReturnType<Awaited<ReturnType<typeof calendarFixture>>["read"]>>;
function expectPreservedCalendarAuthority(before: CalendarState, after: CalendarState) {
  expect(after).toEqual({...before, connection: {...before.connection, updatedAt: after.connection.updatedAt, lastSyncError: calendarDiagnostic}});
}
it.each(["GOOGLE", "MICROSOFT"] as const)("preserves saved Docs and Email proofs through %s Calendar failures and a real outbox retry", async provider => {
  const f = await calendarFixture(provider);
  for (const failure of [429, 503, 401, 403, "network", "malformed"] as const) {
    const before = await f.read();
    f.fetchMock.mockImplementation(async input => f.isCalendar(input) ? calendarFailure(failure) : f.healthy(input));
    await expect(f.run()).rejects.toThrow();
    expectPreservedCalendarAuthority(before, await f.read());
    // Calendar-only denials cannot prove revocation of either native family.
    await f.readable();
    f.fetchMock.mockImplementation(f.healthy);
    await f.run();
    expect((await f.read()).connection.lastSyncError).toBeNull();
  }
  const job = await prisma.workflowJob.create({data: {workspaceId: f.workspace.id, type: "calendar.sync", payload: {connectionId: f.connection.id}}});
  const before = await f.read();
  let fetches = 0, unavailable = true;
  f.fetchMock.mockImplementation(async input => {
    if (f.isCalendar(input)) { fetches++; if (unavailable) return calendarFailure(503); }
    return f.healthy(input);
  });
  expect(await runPendingJobs("synthetic-calendar-worker", 1, 1)).toBe(1);
  expect(await calendarObserver.workflowJob.findUniqueOrThrow({where: {id: job.id}})).toMatchObject({status: "PENDING", attempts: 1, completedAt: null});
  expectPreservedCalendarAuthority(before, await f.read());
  unavailable = false;
  await prisma.workflowJob.update({where: {id: job.id}, data: {runAfter: new Date(0)}});
  expect(await runPendingJobs("synthetic-calendar-worker", 1, 1)).toBe(1);
  expect(fetches).toBe(2);
  expect(await calendarObserver.workflowJob.findUniqueOrThrow({where: {id: job.id}})).toMatchObject({status: "COMPLETED", attempts: 2, error: null});
  expect((await f.read()).connection).toMatchObject({status: "ACTIVE", lastSyncError: null});
  expect((await f.read()).connection.lastSyncAt!.getTime()).toBeGreaterThan(before.connection.lastSyncAt!.getTime());
  await f.readable();
}, 120_000);

it.each(["GOOGLE", "MICROSOFT"] as const)("keeps both %s proof families through transient refresh and fails closed on invalid_grant", async provider => {
  const f = await calendarFixture(provider);
  for (const failure of [429, 503, "network", "malformed", "empty"] as const) {
    await f.expire();
    const before = await f.read();
    f.fetchMock.mockImplementation(async input => f.isToken(input) ? calendarFailure(failure) : f.healthy(input));
    await expect(f.run()).rejects.toThrow();
    expectPreservedCalendarAuthority(before, await f.read());
    for (const proof of f.nativeProofs) await expect(isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).rejects.toThrow();
    f.fetchMock.mockImplementation(f.healthy);
    await f.readable();
    await f.run();
  }
  await f.expire();
  const beforeRefresh = await f.read();
  f.fetchMock.mockImplementation(async input => f.isCalendar(input) ? calendarFailure(503) : f.healthy(input));
  await expect(f.run()).rejects.toThrow();
  const refreshed = await f.read();
  expect(refreshed.connection).toMatchObject({status: "ACTIVE", lastSyncAt: beforeRefresh.connection.lastSyncAt, lastSyncError: calendarDiagnostic});
  expect(refreshed.connection.accessToken).not.toBe(beforeRefresh.connection.accessToken);
  expect(refreshed.epochs).toEqual(beforeRefresh.epochs);
  expect(refreshed.permissionEvents).toEqual(beforeRefresh.permissionEvents);
  await f.readable();
  await f.expire();
  const beforeDenial = await f.read();
  f.fetchMock.mockImplementation(async input => f.isToken(input) ? Response.json({error: "invalid_grant"}, {status: 400}) : f.healthy(input));
  await expect(f.run()).rejects.toMatchObject({code: "OAUTH_PROVIDER_AUTH_REVOKED"});
  const denied = await f.read();
  expect(denied.connection).toMatchObject({status: "ERROR", lastSyncAt: beforeDenial.connection.lastSyncAt});
  expect(denied.epochs).not.toEqual(beforeDenial.epochs);
  expect(denied.inputs).toEqual(beforeDenial.inputs);
  expect(denied.lineage).toEqual(beforeDenial.lineage);
  await f.readable(false);
  // A status-only restoration cannot revive captured epochs. This is synthetic
  // evidence, not an application recovery path or broad reactivation behavior.
  await prisma.oAuthConnection.update({where: {id: f.connection.id}, data: {status: "ACTIVE"}});
  f.fetchMock.mockImplementation(f.healthy);
  await f.readable(false);
}, 120_000);

it.each(["index", "recorder", "crm"] as const)("retains both saved proof families after a downstream Calendar %s failure", async phase => {
  const f = await calendarFixture("GOOGLE");
  const before = await f.read();
  const failure = new Error("Synthetic downstream private payload");
  const target = phase === "index" ? vi.spyOn(knowledge, "syncKnowledgeForSource") : phase === "recorder"
    ? vi.spyOn(domain, "syncCalendarEventRecorder") : vi.spyOn(domain, "materializeCrmCalendarTouchpoints");
  target.mockRejectedValueOnce(failure);
  const event = {id: "synthetic-event", summary: "Synthetic meeting", start: {dateTime: "2026-10-19T12:00:00Z"},
    end: {dateTime: "2026-10-19T13:00:00Z"}, hangoutLink: "https://meet.google.com/aaa-bbbb-ccc", attendees: []};
  f.fetchMock.mockImplementation(async input => f.isCalendar(input) ? Response.json({items: [event]}) : f.healthy(input));
  await expect(f.run()).rejects.toBe(failure);
  expect(target).toHaveBeenCalledTimes(1);
  expectPreservedCalendarAuthority(before, await f.read());
  await f.readable();
  target.mockRestore();
  f.fetchMock.mockImplementation(f.healthy);
  await f.run();
  expect((await f.read()).connection.lastSyncError).toBeNull();
});

it("retains committed Calendar CRM work and retries it without duplicate activity after a later failure", async () => {
  const f = await calendarFixture("GOOGLE");
  const account = await createCrmAccount(f.actor, {workspaceId: f.workspace.id, name: "Synthetic calendar account", domain: "synthetic.example"});
  await createContact(f.actor, {workspaceId: f.workspace.id, accountId: account.id, name: "Synthetic attendee", email: f.remote.from});
  const before = await f.read();
  const materialize = domain.materializeCrmCalendarTouchpoints;
  const failure = new Error("Synthetic failure after committed CRM processing");
  const target = vi.spyOn(domain, "materializeCrmCalendarTouchpoints").mockImplementationOnce(async params => {
    await materialize(params);
    throw failure;
  });
  const event = {id: "synthetic-committed-event", summary: "Synthetic meeting", start: {dateTime: "2026-10-19T12:00:00Z"},
    end: {dateTime: "2026-10-19T13:00:00Z"}, hangoutLink: "https://meet.google.com/aaa-bbbb-ccc", attendees: [{email: f.remote.from}]};
  f.fetchMock.mockImplementation(async input => f.isCalendar(input) ? Response.json({items: [event]}) : f.healthy(input));
  await expect(f.run()).rejects.toBe(failure);
  expectPreservedCalendarAuthority(before, await f.read());
  const committed = await calendarObserver.crmActivity.findMany({where: {workspaceId: f.workspace.id}});
  expect(committed).toHaveLength(1);
  await f.readable();
  target.mockRestore();
  await f.run();
  expect(await calendarObserver.crmActivity.findMany({where: {workspaceId: f.workspace.id}, select: {id: true}})).toEqual([{id: committed[0]!.id}]);
  expect((await f.read()).connection.lastSyncError).toBeNull();
});

it.each([
  ["GOOGLE", "reconnect", "diagnostic"], ["GOOGLE", "reconnect", "checkpoint"],
  ["GOOGLE", "disconnect", "diagnostic"], ["GOOGLE", "disconnect", "checkpoint"],
  ["MICROSOFT", "reconnect", "diagnostic"], ["MICROSOFT", "reconnect", "checkpoint"],
  ["MICROSOFT", "disconnect", "diagnostic"], ["MICROSOFT", "disconnect", "checkpoint"],
] as const)("fences the actual %s %s during Calendar %s writes", async (provider, change, phase) => {
  const f = await calendarFixture(provider);
  const update = prisma.oAuthConnection.update.bind(prisma.oAuthConnection);
  let replacement: CalendarState["connection"] | undefined;
  vi.spyOn(prisma.oAuthConnection, "update").mockImplementation((async args => {
    const data = args.data;
    const matchingWrite = phase === "diagnostic" ? data.lastSyncError === calendarDiagnostic : data.lastSyncAt !== undefined;
    if (!replacement && matchingWrite) {
      await update({where: {id: f.connection.id}, data: change === "disconnect"
        ? {status: "DISCONNECTED", disconnectedAt: new Date()}
        : {accessToken: encryptSecret("synthetic-reconnected-access"), refreshToken: encryptSecret("synthetic-reconnected-refresh"),
          expiresAt: new Date(Date.now() + 7200_000), syncSettings: {...f.connection.syncSettings as Prisma.JsonObject, calendar: {enabled: false}}}});
      replacement = await calendarObserver.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}});
    }
    return update(args);
  }) as typeof prisma.oAuthConnection.update);
  if (phase === "diagnostic") f.fetchMock.mockImplementation(async input => f.isCalendar(input) ? calendarFailure(503) : f.healthy(input));
  await expect(f.run()).rejects.toMatchObject({code: "OAUTH_PROVIDER_INDETERMINATE"});
  expect(replacement).toBeDefined();
  expect(await calendarObserver.oAuthConnection.findUniqueOrThrow({where: {id: f.connection.id}})).toEqual(replacement);
});
