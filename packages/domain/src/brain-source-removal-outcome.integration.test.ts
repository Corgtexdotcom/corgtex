import { randomUUID, createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { mcpCredentialVersion, mcpScopesHash, prisma, type AppActor } from "@corgtex/shared";
import { captureMcpOAuthGrantEpoch, runWithMcpOrigin, type McpOrigin } from "../../shared/src/mcp-context";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveWorkspaceArtifact, restoreWorkspaceArtifact } from "./archive";
import { createArticle, deleteSource } from "./brain";
import { commitBrainSourceRemovalCompletion, getBrainSourceRemovalOutcomeInputReceipt, getBrainSourceRemovalOutcomeInputRoots,
  isBrainSourceRemovalOutcomeReadable, prepareBrainSourceRemovalControl } from "./brain-source-removal-outcome";
import { captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
const plan = createHash("sha256").update("Synthetic direct source-only archive plan").digest("hex");
async function fixture(copiedPrivate = false) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic source controls", slug: `controls-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic foreign controls", slug: `foreign-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `controls-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `other-controls-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Synthetic operator" } };
  const otherActor: AppActor = { kind: "user", user: { id: other.id, email: other.email, displayName: "Other operator" } };
  const original = copiedPrivate ? await createArticle(actor, { workspaceId: workspace.id, title: "PRIVATE original title",
    bodyMd: "PRIVATE original body", type: "PROJECT", isPrivate: true, ownerMemberId: member.id }) : null;
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1,
    title: copiedPrivate ? "PRIVATE copied source title" : "Known original source", content: copiedPrivate ? "PRIVATE copied source body" : "Literal original source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: original ? "DERIVED" : "HUMAN_ORIGINAL",
    inputs: original ? [{ kind: "BrainArticle", id: original.id }] : [] }));
  return { workspace, foreign, user, other, member, actor, otherActor, source, original };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function oauth(f: Fixture, scopes: string[], userId = f.user.id) {
  const client = await prisma.mcpOAuthClient.create({ data: { clientId: `synthetic-${randomUUID()}`, name: "Synthetic native control",
    redirectUris: ["https://synthetic.invalid/callback"], scopes } });
  const token = await prisma.mcpOAuthAccessToken.create({ data: { clientId: client.id, userId, workspaceId: f.workspace.id,
    instanceSlug: "synthetic", tokenHash: `synthetic-${randomUUID()}`, scopes, expiresAt: new Date(Date.now() + 3600000),
    refreshExpiresAt: new Date(Date.now() + 7200000) } });
  const grantEpoch = await prisma.$transaction(tx => captureMcpOAuthGrantEpoch(tx, f.workspace.id, token.id));
  const origin: McpOrigin = { kind: "oauth", id: token.id, workspaceId: f.workspace.id, scopeHash: mcpScopesHash(scopes), grantEpoch,
    requiredScopes: [] };
  return { token, origin };
}

describe("canonical SourceRemoval native control facts", () => {
  it("replays a minimal native fact while copied private bytes and archived DERIVED proof stay withheld", async () => {
    const f = await fixture(true);
    const before = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "BrainSource", artifactId: f.source.id } });
    const result = await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    expect(result).toEqual({ id: f.source.id, status: "archived" });
    const roots = await getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result);
    expect(roots.map(root => root.kind)).toEqual(["ConversationOperationOutcome"]);
    const row = await prisma.conversationOperationOutcome.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    const receipt = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "ConversationOperationOutcome", artifactId: row.id } });
    expect(receipt).toMatchObject({ origin: "NATIVE_ORIGINAL", inputsJson: [], rootsJson: [], epochProofVersion: 1 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(row.controlJson)).not.toContain("PRIVATE");
    expect(await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id })).toEqual(result);
    expect(await prisma.conversationOperationOutcome.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    expect(await prisma.artifactInputLineage.findFirstOrThrow({ where: { id: before.id } })).toEqual(before);
    const archived = await prisma.brainSource.findUniqueOrThrow({ where: { id: f.source.id } });
    expect(archived).toMatchObject({ content: f.source.content, title: f.source.title });
    expect(await readableArtifactIds(f.actor, f.workspace.id, "BrainSource", [archived])).toEqual(new Set());
    expect(await prisma.brainArticle.findUniqueOrThrow({ where: { id: f.original!.id } })).toMatchObject({ bodyMd: "PRIVATE original body", archivedAt: null });
    expect(getBrainSourceRemovalOutcomeInputReceipt({ ...result })).toBeUndefined();
    await expect(getBrainSourceRemovalOutcomeInputRoots(f.otherActor, f.workspace.id, result)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(getBrainSourceRemovalOutcomeInputRoots(f.actor, f.foreign.id, result)).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(deleteSource(f.otherActor, { workspaceId: f.workspace.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteSource(f.actor, { workspaceId: f.foreign.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects legacy archived status/APPLIED payloads rather than minting a native completion", async () => {
    const f = await fixture();
    await archiveWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "BrainSource", entityId: f.source.id });
    await prisma.workflowJob.create({ data: { workspaceId: f.workspace.id, type: "agent.brain-source-regenerate", status: "COMPLETED",
      payload: { version: 1, sourceId: f.source.id, sourceFingerprint: "unproven", articles: [], phase: "APPLIED", privateOldBody: "PRIVATE legacy payload" } } });
    await expect(deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.conversationOperationOutcome.count()).toBe(0);
  });

  it("withholds an old fact after membership demotion or departure/restoration without replacing its vectors", async () => {
    const f = await fixture();
    const result = await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    const roots = await getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result);
    const before = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "ConversationOperationOutcome" } });
    await prisma.member.update({ where: { id: f.member.id }, data: { role: "CONTRIBUTOR" } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
    await expect(deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.member.update({ where: { id: f.member.id }, data: { role: "ADMIN", isActive: false } });
    await expect(deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, roots)).toBe(false);
    await expect(deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id })).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(await prisma.artifactInputLineage.findFirstOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await prisma.conversationOperationOutcome.count()).toBe(1);
  });

  it("binds each archive generation and leaves old native facts withheld after source restoration", async () => {
    const f = await fixture();
    const first = await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    const oldRoots = await getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, first);
    await restoreWorkspaceArtifact(f.actor, { workspaceId: f.workspace.id, entityType: "BrainSource", entityId: f.source.id });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, oldRoots)).toBe(false);
    const second = await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    expect(second).toEqual(first);
    const newRoots = await getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, second);
    expect(newRoots[0].id).not.toBe(oldRoots[0].id);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, oldRoots)).toBe(false);
    expect(await prisma.workspaceArchiveRecord.count({ where: { entityId: f.source.id } })).toBe(2);
  });

  it("allows actual write-only credentials to attest the SQL fact and rejects credential revoke/restore", async () => {
    const f = await fixture();
    const credential = await prisma.agentCredential.create({ data: { workspaceId: f.workspace.id, label: "Synthetic write control",
      tokenHash: `synthetic-${randomUUID()}`, scopes: ["brain:write"] } });
    const actor: AppActor = { kind: "agent", authProvider: "credential", label: "Synthetic write control", credentialId: credential.id,
      credentialVersion: mcpCredentialVersion(credential.tokenHash), scopes: credential.scopes, workspaceIds: [f.workspace.id] };
    const result = await prisma.$transaction(async tx => {
      const token = await prepareBrainSourceRemovalControl(actor, { workspaceId: f.workspace.id, sourceId: f.source.id, mode: "DIRECT", planIdentityHash: plan }, tx);
      await archiveWorkspaceArtifact(actor, { workspaceId: f.workspace.id, entityType: "BrainSource", entityId: f.source.id, _tx: tx });
      return commitBrainSourceRemovalCompletion(token, { actor, workspaceId: f.workspace.id }, tx);
    });
    const roots = await getBrainSourceRemovalOutcomeInputRoots(actor, f.workspace.id, result);
    expect(await isArtifactInputProofReadable(actor, f.workspace.id, roots)).toBe(true);
    const source = await prisma.brainSource.findUniqueOrThrow({ where: { id: f.source.id } });
    expect(await readableArtifactIds(actor, f.workspace.id, "BrainSource", [source])).toEqual(new Set());
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { isActive: false } });
    expect(await isArtifactInputProofReadable(actor, f.workspace.id, roots)).toBe(false);
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { isActive: true } });
    expect(await isArtifactInputProofReadable(actor, f.workspace.id, roots)).toBe(false);
  });

  it("checks exact live OAuth user/workspace/consent/epoch without adding token ancestry to web facts", async () => {
    const f = await fixture();
    const result = await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    const valid = await oauth(f, ["brain:write"]);
    expect(await runWithMcpOrigin(valid.origin, () => getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result))).toHaveLength(1);
    const lacking = await oauth(f, ["brain:read"]);
    await expect(runWithMcpOrigin(lacking.origin, () => getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const mismatched = await oauth(f, ["brain:write"], f.other.id);
    await expect(runWithMcpOrigin(mismatched.origin, () => getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await prisma.mcpOAuthAccessToken.update({ where: { id: valid.token.id }, data: { revokedAt: new Date() } });
    await expect(runWithMcpOrigin(valid.origin, () => getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result))).rejects.toThrow();
    await prisma.mcpOAuthAccessToken.update({ where: { id: valid.token.id }, data: { revokedAt: null } });
    await expect(runWithMcpOrigin(valid.origin, () => getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result))).rejects.toThrow();
    expect(await getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result)).toHaveLength(1);
  });

  it("rejects fabricated tokens, transaction/principal substitution, unknown facts and malformed control metadata", async () => {
    const f = await fixture();
    await expect(prisma.$transaction(tx => commitBrainSourceRemovalCompletion({ purpose: "BRAIN_SOURCE_REMOVAL_CONTROL" },
      { actor: f.actor, workspaceId: f.workspace.id }, tx))).rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    let token: Awaited<ReturnType<typeof prepareBrainSourceRemovalControl>>;
    await prisma.$transaction(async tx => { token = await prepareBrainSourceRemovalControl(f.actor,
      { workspaceId: f.workspace.id, sourceId: f.source.id, mode: "DIRECT", planIdentityHash: plan }, tx); });
    await expect(prisma.$transaction(tx => commitBrainSourceRemovalCompletion(token!, { actor: f.actor, workspaceId: f.workspace.id }, tx)))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    const result = await deleteSource(f.actor, { workspaceId: f.workspace.id, sourceId: f.source.id });
    const row = await prisma.conversationOperationOutcome.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(await isBrainSourceRemovalOutcomeReadable(f.actor, f.workspace.id, { ...row, controlJson: { ...row.controlJson as object,
      copiedPrivateBody: "PRIVATE" } })).toBe(false);
    await prisma.artifactInputLineage.deleteMany({ where: { artifactType: "ConversationOperationOutcome", artifactId: row.id } });
    await expect(captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ConversationOperationOutcome", id: row.id }])).rejects.toMatchObject({ code: "UNKNOWN_LINEAGE" });
    expect(getBrainSourceRemovalOutcomeInputReceipt(result)).toBeDefined();
    await expect(getBrainSourceRemovalOutcomeInputRoots(f.actor, f.workspace.id, result)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
