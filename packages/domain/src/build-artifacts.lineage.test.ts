import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, workspaceId, alpha, beta, resetFixture, known } from "../../agents/src/agents/model-consumer.test-fixture";
import type { AppActor } from "@corgtex/shared";

const storage = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), getSignedUrl: vi.fn() }));
vi.mock("@corgtex/shared", async () => ({ ...await import("../../shared/src/mcp-context"), prisma: fixture.prisma, encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v.slice(4), randomOpaqueToken: () => "synthetic-bearer", sha256: (v: string) => `sha:${v}`,
  env: { APP_URL: "https://synthetic.example.test" } }));
vi.mock("@corgtex/storage", () => ({ defaultStorage: storage }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, actorUserIdForWorkspace: async () => "beta", isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async (actor: any) =>
  actor.kind === "agent" ? ["WORKSPACE"] : fixture.domains.get(actor.user.id) ?? [] }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));
import { addBuildArtifactAsset, getBuildArtifact, getBuildArtifactAssetSignedUrl, listBuildArtifacts,
  resolvePublicBuildArtifactAsset, upsertBuildArtifact, updateBuildArtifact, upsertBuildArtifactsFromGitHubPullRequest } from "./build-artifacts";
import { revokeBuildArtifactPublicAccess } from "./build-artifacts";
import { captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds } from "./source-lineage";
import { createExecutionRequest, getExecutionPacket, submitExecutionResult, listWritebackTargets } from "./execution-plumbing";

let revision = 0;
const files = new Map<string, Buffer>();
const digest = (v: Buffer) => createHash("sha256").update(v).digest("hex");
function matches(row: any, where: any): boolean {
  return Boolean(row) && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "NOT") return !matches(row, value);
    if (key === "artifact") return matches(fixture.rows.buildArtifact.find((a) => a.id === row.artifactId), value);
    if (key === "workspaceId_idempotencyKey" || key === "executionRequestId_idempotencyKey") return matches(row, value);
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
}
function output(name: string, row: any) {
  if (!row) return null;
  return name === "buildArtifact" ? { ...row, createdBy: fixture.rows.user.find((u) => u.id === row.createdByUserId) ?? null,
    assets: fixture.rows.buildArtifactAsset.filter((a) => a.artifactId === row.id).map((a) => ({ ...a })) }
    : name === "executionRequest" ? { ...row, results: fixture.rows.executionResult.filter((result) => result.executionRequestId === row.id).map((r) => ({ ...r })) } : { ...row };
}
function transport(name: string) {
  fixture.rows[name] = [];
  fixture.prisma[name] = {
    findFirst: vi.fn(async ({ where }: any) => output(name, fixture.rows[name].find((row) => matches(row, where)))),
    findUnique: vi.fn(async ({ where }: any) => output(name, fixture.rows[name].find((row) => matches(row, where)))),
    findMany: vi.fn(async ({ where, take }: any = {}) => fixture.rows[name].filter((row) => matches(row, where)).slice(0, take).map((row) => output(name, row))),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `${name}-${++revision}`, createdAt: fixture.timestamp, updatedAt: new Date(fixture.timestamp.getTime() + revision),
        ...(name === "buildArtifact" ? { brainSourceId: null, publicTokenHash: null, publicTokenEnc: null,
          publicEnabledAt: null, publicRevokedAt: null, mergedAt: null, closedAt: null } : {}), ...data };
      if (name === "executionRequest") Object.assign(row, { status: "PENDING", ...row });
      fixture.rows[name].push(row); return output(name, row);
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = fixture.rows[name].find((r) => matches(r, where));
      if (!row) throw new Error(`Missing synthetic ${name}`);
      Object.assign(row, data, { updatedAt: new Date(fixture.timestamp.getTime() + ++revision) }); return output(name, row);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matched = fixture.rows[name].filter((row) => matches(row, where));
      for (const row of matched) Object.assign(row, data, { updatedAt: new Date(fixture.timestamp.getTime() + ++revision) });
      return { count: matched.length };
    }),
  };
}
beforeEach(async () => {
  await resetFixture(); revision = 0; files.clear();
  for (const name of ["buildArtifact", "buildArtifactAsset", "workspaceFeatureFlag", "auditLog", "executionRequest", "executionResult"]) transport(name);
  fixture.prisma.$queryRaw = vi.fn(async (sql: any, ...values: any[]) => {
    const text = typeof sql?.sql === "string" ? sql.sql : Array.isArray(sql) ? sql.join("?") : "";
    const bound = Array.isArray(sql?.values) ? sql.values : values;
    const table = text.match(/FROM "([A-Za-z]+)"/)?.[1];
    if (!table) return [];
    const name = table[0].toLowerCase() + table.slice(1);
    const predicates = [...text.matchAll(/(?:"([A-Za-z]+)"|\b(id)\b)\s*=\s*\?/g)];
    return (fixture.rows[name] ?? []).filter(row => predicates.every((predicate, index) => row[predicate[1] ?? predicate[2]] === bound[index])
      && (!text.includes("'FINANCE'") || row.flag === "FINANCE")
      && (!text.includes("'BUILD_ARTIFACT'") || row.writebackTargetType === "BUILD_ARTIFACT"))
      .map(row => ({ ...row }));
  });
  fixture.prisma.$transaction.mockImplementation(async (run: any) => {
    const before = structuredClone(fixture.rows);
    const tx = new Proxy(fixture.prisma, { get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try { return await run(tx); }
    catch (error) { for (const name of Object.keys(before)) fixture.rows[name] = before[name]; throw error; }
  });
  storage.put.mockImplementation(async (key, data) => { files.set(key, data); });
  storage.get.mockImplementation(async (key) => files.has(key) ? { data: files.get(key)!, contentType: "image/png" } : null);
  installSourcePermissionEpochFixture(fixture.prisma);
});
const fresh = (overrides: any = {}) => ({ workspaceId, repositoryOwner: "synthetic", repositoryName: "product", title: "Fresh authored artifact",
  summaryMd: "Fresh authored details", classification: "OPEN_CORE" as const, visibility: "PUBLIC_REVIEW" as const,
  noPrivateDataConfirmed: true, ...overrides });
async function upload(id: string, actor = beta, options: any = {}) {
  return addBuildArtifactAsset(actor, { workspaceId, artifactId: id, fileBuffer: Buffer.from("synthetic bytes"), fileName: "proof.png", mimeType: "image/png",
    label: "Fresh asset label", captionMd: "Fresh caption", ...options });
}

describe("Build artifact producer/read closure with actual input receipts", () => {
  it("records originals and a separate copied PR source with every asset input, preserving older sources", async () => {
    const created = await upsertBuildArtifact(beta, fresh());
    expect(fixture.manifest("BuildArtifact", created.id).origin).toBe("HUMAN_ORIGINAL");
    const originalSource = fixture.rows.brainSource[0];
    expect(fixture.sources("BrainSource", originalSource.id)).toEqual(new Set([`BuildArtifact:${created.id}`, "Member:member-beta"]));
    const first = await upload(created.id);
    await upload(created.id, beta, { label: "Second label", captionMd: "Second caption" });
    const source = fixture.rows.brainSource.at(-1)!;
    expect(source.id).not.toBe(originalSource.id);
    expect(originalSource.content).not.toContain("Fresh asset label");
    expect(source.content).toContain("Second caption");
    expect(fixture.sources("BrainSource", source.id)).toEqual(new Set([`BuildArtifact:${created.id}`, "Member:member-beta", ...fixture.rows.buildArtifactAsset.map((a) => `BuildArtifactAsset:${a.id}`)]));
    expect(fixture.manifest("BuildArtifactAsset", first.asset.id).origin).toBe("HUMAN_ORIGINAL");
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [source])).toEqual(new Set([source.id]));
    expect(await listBuildArtifacts(alpha, { workspaceId })).toHaveLength(1);
  });

  it("keeps a private artifact's copied PR source private and blocks cross-workspace reads", async () => {
    const created = await upsertBuildArtifact(beta, fresh({ visibility: "PRIVATE", classification: "INTERNAL" }));
    const source = fixture.rows.brainSource.at(-1)!;
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [source])).toEqual(new Set());
    expect(await listBuildArtifacts(alpha, { workspaceId })).toEqual([]);
    await expect(getBuildArtifact(alpha, { workspaceId, artifactId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.add("member", { id: "alpha-foreign", workspaceId: "ws-b", userId: "alpha", isActive: true, role: "ADMIN" });
    await expect(getBuildArtifact(alpha, { workspaceId: "ws-b", artifactId: created.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getBuildArtifact(beta, { workspaceId, artifactId: created.id })).title).toBe("Fresh authored artifact");
    await expect(revokeBuildArtifactPublicAccess(beta, { workspaceId, artifactId: created.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateBuildArtifact(beta, { workspaceId, artifactId: created.id, visibility: "REVOKED" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(fixture.rows.buildArtifact[0].visibility).toBe("PRIVATE");
  });

  it("never certifies a legacy source or unknown retained artifact on a partial edit", async () => {
    const created = await upsertBuildArtifact(beta, fresh());
    const previousSource = fixture.rows.brainSource.at(-1)!;
    fixture.rows.artifactInputLineage = fixture.rows.artifactInputLineage.filter((r) => !(r.artifactType === "BrainSource" && r.artifactId === previousSource.id));
    await updateBuildArtifact(beta, { workspaceId, artifactId: created.id, summaryMd: "New independent current detail" });
    expect(fixture.manifest("BrainSource", previousSource.id)).toBeUndefined();
    expect(previousSource.content).not.toContain("New independent");
    expect(fixture.rows.brainSource.at(-1)!.content).toContain("New independent");
    fixture.rows.artifactInputLineage = fixture.rows.artifactInputLineage.filter((r) => !(r.artifactType === "BuildArtifact" && r.artifactId === created.id));
    await expect(updateBuildArtifact(beta, { workspaceId, artifactId: created.id, title: "Cannot bless retained old body" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires actual copied input proof and retains private ancestry through edits/retries", async () => {
    const article = fixture.add("brainArticle", { id: "private-input", workspaceId, title: "PRIVATE INPUT", bodyMd: "Private facts", isPrivate: true,
      ownerMemberId: "member-beta", archivedAt: null });
    await known("BrainArticle", article, [], beta);
    const roots = await captureArtifactInputProof(beta, workspaceId, [{ kind: "BrainArticle", id: article.id }]);
    await expect(upsertBuildArtifact(beta, fresh({ copied: true }))).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const created = await upsertBuildArtifact(beta, fresh({ copied: true, lineageRoots: roots }));
    const firstSource = fixture.rows.brainSource.at(-1)!;
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [firstSource])).toEqual(new Set());
    await updateBuildArtifact(beta, { workspaceId, artifactId: created.id, summaryMd: "Small edit" });
    const latestSource = fixture.rows.brainSource.at(-1)!;
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [latestSource])).toEqual(new Set());
    await expect(resolvePublicBuildArtifactAsset({ publicToken: "synthetic-bearer", assetId: "absent" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.rows.brainArticle.find((row) => row.id === article.id).archivedAt = fixture.timestamp;
    await expect(upsertBuildArtifact(beta, fresh({ artifactId: created.id, copied: true, lineageRoots: roots }))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await isArtifactInputProofReadable(beta, workspaceId, roots)).toBe(false);
  });

  it("withholds unknown assets from display and refuses an incomplete all-asset source copy", async () => {
    const created = await upsertBuildArtifact(beta, fresh());
    const unknown = await fixture.prisma.buildArtifactAsset.create({ data: { artifactId: created.id, label: "UNKNOWN ASSET CANARY", captionMd: "UNKNOWN CAPTION", storageKey: "unknown", kind: "SCREENSHOT", mimeType: "image/png", sizeBytes: 3, sha256: digest(Buffer.from("old")) } });
    const sourceCount = fixture.rows.brainSource.length;
    await upload(created.id);
    expect(fixture.rows.brainSource).toHaveLength(sourceCount);
    expect(JSON.stringify(await getBuildArtifact(alpha, { workspaceId, artifactId: created.id }))).not.toContain("UNKNOWN");
    await expect(getBuildArtifactAssetSignedUrl(beta, { workspaceId, artifactId: created.id, assetId: unknown.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolvePublicBuildArtifactAsset({ publicToken: "synthetic-bearer", assetId: fixture.rows.buildArtifactAsset.at(-1)!.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
  });

  it("retains private caption ancestry from every asset even when its artifact is a public original", async () => {
    const created = await upsertBuildArtifact(beta, fresh());
    const input = fixture.add("brainArticle", { id: "private-caption", workspaceId, title: "PRIVATE CAPTION SOURCE", bodyMd: "Private caption context",
      isPrivate: true, ownerMemberId: "member-beta", archivedAt: null });
    await known("BrainArticle", input, [], beta);
    const roots = await captureArtifactInputProof(beta, workspaceId, [{ kind: "BrainArticle", id: input.id }]);
    await upload(created.id, beta, { copied: true, lineageRoots: roots, label: "PRIVATE ASSET LABEL", captionMd: "PRIVATE CAPTION CANARY" });
    const source = fixture.rows.brainSource.at(-1)!;
    expect(source.content).toContain("PRIVATE CAPTION CANARY");
    expect(await readableArtifactIds(alpha, workspaceId, "BrainSource", [source])).toEqual(new Set());
    expect(JSON.stringify(await getBuildArtifact(alpha, { workspaceId, artifactId: created.id }))).not.toContain("PRIVATE");
    await expect(resolvePublicBuildArtifactAsset({ publicToken: "synthetic-bearer", assetId: fixture.rows.buildArtifactAsset[0].id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.rows.brainArticle.find((row) => row.id === input.id).archivedAt = fixture.timestamp;
    expect(await readableArtifactIds(beta, workspaceId, "BrainSource", [source])).toEqual(new Set());
    expect((await getBuildArtifact(beta, { workspaceId, artifactId: created.id })).assets).toEqual([]);
  });

  it("never returns signed storage URLs and rechecks current source/token/creator and fetched byte identity", async () => {
    const created = await upsertBuildArtifact(beta, fresh());
    const uploaded = await upload(created.id);
    const normal = await getBuildArtifactAssetSignedUrl(alpha, { workspaceId, artifactId: created.id, assetId: uploaded.asset.id });
    expect(normal.signedUrl).toBeNull(); expect(normal.file.data.toString()).toBe("synthetic bytes");
    expect(normal.mimeType).toBe(uploaded.asset.mimeType);
    const publicFile = await resolvePublicBuildArtifactAsset({ publicToken: "synthetic-bearer", assetId: uploaded.asset.id });
    expect(publicFile.signedUrl).toBeNull(); expect(publicFile.mimeType).toBe(uploaded.asset.mimeType);
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
    fixture.rows.member.find((m) => m.userId === "beta").isActive = false;
    await expect(publicFile.authorize()).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    fixture.rows.member.find((m) => m.userId === "beta").isActive = true;
    fixture.rows.buildArtifact[0].publicTokenHash = "revoked";
    await expect(publicFile.authorize()).rejects.toMatchObject({ code: "NOT_FOUND" });
    fixture.rows.buildArtifact[0].publicTokenHash = "sha:synthetic-bearer";
    files.set(fixture.rows.buildArtifactAsset[0].storageKey, Buffer.from("changed bytes"));
    await expect(getBuildArtifactAssetSignedUrl(alpha, { workspaceId, artifactId: created.id, assetId: uploaded.asset.id })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("withholds copied credential/HTTP and unreceipted GitHub inputs rather than inventing human authorship", async () => {
    const agent: AppActor = { kind: "agent", authProvider: "bootstrap", label: "synthetic-worker", workspaceIds: [workspaceId] };
    await expect(upsertBuildArtifact(agent, fresh())).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    fixture.rows.workspaceFeatureFlag.push({ workspaceId, flag: "BUILD_ARTIFACTS", enabled: true, config: { githubRepositories: ["synthetic/product"] } });
    const outcome = await upsertBuildArtifactsFromGitHubPullRequest({ repositoryOwner: "synthetic", repositoryName: "product", pullRequestNumber: 1, title: "Unreceipted provider" });
    expect(outcome.updatedCount).toBe(1);
    expect(fixture.manifest("BuildArtifact", outcome.artifactIds[0]).origin).toBe("UNKNOWN");
    expect(await listBuildArtifacts(beta, { workspaceId })).toEqual([]);
    expect(fixture.rows.brainSource).toEqual([]);
  });

  it("records exact persisted build request/result inputs and accepts the copied output atomically without requester impersonation", async () => {
    const request = await createExecutionRequest(beta, { workspaceId, goal: "Create a synthetic proof artifact", writebackTargetType: "BUILD_ARTIFACT", idempotencyKey: "build-request" });
    expect(fixture.manifest("ExecutionRequest", request.id).origin).toBe("DERIVED");
    await getExecutionPacket(beta, { workspaceId, requestId: request.id });
    expect(fixture.rows.executionRequest[0].status).toBe("IN_PROGRESS");
    const output = { repositoryOwner: "synthetic", repositoryName: "product", title: "Actual external output", summaryMd: "Actual supplied details", visibility: "PRIVATE" };
    const session = fixture.add("conversationSession", { id: "native-session", workspaceId, userId: "beta" });
    const submitted = fixture.add("conversationPromptInput", { id: "native-submitted-output", workspaceId, userId: "beta", sessionId: session.id, content: JSON.stringify(output) });
    const roots = await captureArtifactInputProof(beta, workspaceId, [{ kind: "ConversationPromptInput", id: submitted.id }]);
    const result = await submitExecutionResult(beta, { workspaceId, requestId: request.id, idempotencyKey: "result", output, lineageRoots: roots });
    expect(result.status).toBe("ACCEPTED");
    expect(fixture.rows.executionRequest[0].status).toBe("COMPLETED");
    expect(fixture.manifest("ExecutionResult", result.id).origin).toBe("DERIVED");
    if (!result.writeback?.entityId) throw new Error("Expected a native build write-back");
    expect(fixture.manifest("BuildArtifact", result.writeback.entityId).origin).toBe("DERIVED");
    const artifact = fixture.rows.buildArtifact[0];
    expect(artifact.createdByUserId).toBe("beta");
    expect((await getBuildArtifact(beta, { workspaceId, artifactId: artifact.id })).title).toBe(output.title);
    expect(await listBuildArtifacts(alpha, { workspaceId })).toEqual([]);
    const count = fixture.rows.buildArtifact.length;
    expect(await submitExecutionResult(beta, { workspaceId, requestId: request.id, idempotencyKey: "result", output: { title: "REPLAY MUST NOT REPLACE" } })).toMatchObject({ id: result.id });
    expect(fixture.rows.buildArtifact).toHaveLength(count);
    expect(artifact.title).toBe(output.title);
  });

  it("denies unreceipted results, private target labels and forged native input roots before writes", async () => {
    const artifact = await upsertBuildArtifact(beta, fresh({ visibility: "PRIVATE", classification: "INTERNAL" }));
    expect(await listWritebackTargets(alpha, { workspaceId, targetTypes: ["BUILD_ARTIFACT"] })).toEqual({ items: [] });
    await expect(createExecutionRequest(alpha, { workspaceId, goal: "No hidden target", writebackTargetType: "BUILD_ARTIFACT", writebackTargetId: artifact.id }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    const request = await createExecutionRequest(beta, { workspaceId, goal: "Known native build request", writebackTargetType: "BUILD_ARTIFACT" });
    await expect(submitExecutionResult(beta, { workspaceId, requestId: request.id, idempotencyKey: "missing", output: { title: "Unknown output" } }))
      .rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(fixture.rows.executionResult).toEqual([]);
    expect(fixture.rows.executionRequest.at(-1)!.status).toBe("PENDING");
    await expect(submitExecutionResult(beta, { workspaceId, requestId: request.id, idempotencyKey: "forged", output: { title: "Forged", repositoryOwner: "synthetic", repositoryName: "product" },
      lineageRoots: [{ kind: "Workspace", id: workspaceId, fingerprint: "f".repeat(64) }] })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.rows.executionResult).toEqual([]);
  });
});
