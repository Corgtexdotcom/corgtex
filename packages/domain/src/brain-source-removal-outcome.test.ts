import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, resetFixture, alpha, workspaceId } from "../../agents/src/agents/model-consumer.test-fixture";

vi.mock("@corgtex/shared", async original => ({ ...await original<typeof import("@corgtex/shared")>(), prisma: fixture.prisma }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: fixture.membership, isGlobalOperator: () => false }));
vi.mock("./brain-access", () => ({ resolveKnowledgeAccessDomains: async () => ["WORKSPACE"] }));
import { commitBrainSourceRemovalCompletion, consumeArchivedBrainSourceRetirement, isBrainSourceRemovalOutcomeReadable,
  prepareArchivedBrainSourceRetirement, prepareBrainSourceRemovalControl } from "./brain-source-removal-outcome";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";

let source: any;
beforeEach(async () => {
  await resetFixture();
  fixture.rows.member.find(row => row.userId === "alpha").role = "ADMIN";
  source = fixture.add("brainSource", { id: "native-source", workspaceId, sourceType: "ARTICLE", accessDomain: "WORKSPACE",
    authorMemberId: null, archivedAt: null, archivedByUserId: null, metadata: null,
    title: "PRIVATE title not selected by control queries", content: "PRIVATE old body" });
  fixture.prisma.workspaceArchiveRecord = { findFirst: vi.fn(async () => null) };
  fixture.prisma.financeImportBatch = { findFirst: vi.fn(async () => null) };
  fixture.prisma.$queryRaw.mockImplementation(async (...args: any[]) => {
    const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
    if (!sql.includes('"sourceType"::text')) return [];
    expect(sql).not.toMatch(/\b(content|title|previousState)\b/);
    return args[1] === source.id && args[2] === workspaceId ? [{ id: source.id, workspaceId, sourceType: source.sourceType,
      accessDomain: source.accessDomain, authorMemberId: source.authorMemberId, archivedAt: source.archivedAt,
      archivedByUserId: source.archivedByUserId, documentId: null, bindingMalformed: false }] : [];
  });
  installSourcePermissionEpochFixture(fixture.prisma);
});

describe("SourceRemoval native control constructor boundaries", () => {
  function archiveGeneration() {
    source.archivedAt = new Date("2026-10-13T00:00:00Z"); source.archivedByUserId = "alpha";
    const archive = { id: "native-archive", archivedAt: source.archivedAt };
    fixture.prisma.workspaceArchiveRecord.findFirst.mockResolvedValue(archive);
    return archive;
  }
  it("allows one exact native retirement capability without returning or certifying the archived body", async () => {
    archiveGeneration();
    const token = await prepareArchivedBrainSourceRetirement(alpha, { workspaceId, sourceId: source.id }, fixture.prisma);
    await expect(consumeArchivedBrainSourceRetirement(token, alpha, { workspaceId, sourceId: source.id }, fixture.prisma)).resolves.toBeUndefined();
    await expect(consumeArchivedBrainSourceRetirement(token, alpha, { workspaceId, sourceId: source.id }, fixture.prisma))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    expect(source.content).toBe("PRIVATE old body");
    expect(fixture.rows.artifactInputLineage).toEqual([]);
  });
  it("requires an actual current archive generation rather than a raw archived status", async () => {
    source.archivedAt = new Date();
    await expect(prepareArchivedBrainSourceRetirement(alpha, { workspaceId, sourceId: source.id }, fixture.prisma))
      .rejects.toMatchObject({ code: "OPERATION_NOT_COMMITTED" });
  });
  it("rejects cloned or substituted retirement capabilities", async () => {
    archiveGeneration();
    const token = await prepareArchivedBrainSourceRetirement(alpha, { workspaceId, sourceId: source.id }, fixture.prisma);
    for (const [candidate, actor, tx] of [[{ ...token }, alpha, fixture.prisma], [token, { ...alpha }, fixture.prisma],
      [token, alpha, { ...fixture.prisma }]] as any[]) {
      await expect(consumeArchivedBrainSourceRetirement(candidate, actor, { workspaceId, sourceId: source.id }, tx))
        .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    }
  });
  it("rechecks current control authority and exact archive generation at consumption", async () => {
    const archive = archiveGeneration();
    const token = await prepareArchivedBrainSourceRetirement(alpha, { workspaceId, sourceId: source.id }, fixture.prisma);
    fixture.prisma.workspaceArchiveRecord.findFirst.mockResolvedValue({ ...archive, id: "another-generation" });
    await expect(consumeArchivedBrainSourceRetirement(token, alpha, { workspaceId, sourceId: source.id }, fixture.prisma))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    archiveGeneration();
    const current = await prepareArchivedBrainSourceRetirement(alpha, { workspaceId, sourceId: source.id }, fixture.prisma);
    fixture.rows.member.find(row => row.userId === "alpha").role = "CONTRIBUTOR";
    await expect(consumeArchivedBrainSourceRetirement(current, alpha, { workspaceId, sourceId: source.id }, fixture.prisma))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("uses a body-free locked control projection and refuses to complete an uncommitted archive", async () => {
    const token = await prepareBrainSourceRemovalControl(alpha, { workspaceId, sourceId: source.id, mode: "DIRECT",
      planIdentityHash: "1".repeat(64) }, fixture.prisma);
    await expect(commitBrainSourceRemovalCompletion(token, { actor: alpha, workspaceId }, fixture.prisma))
      .rejects.toMatchObject({ code: "OPERATION_NOT_COMMITTED" });
    expect(source.content).toBe("PRIVATE old body");
    expect(fixture.rows.artifactInputLineage).toEqual([]);
  });

  it("rejects copied tokens and actor/transaction substitution before constructing a fact", async () => {
    const token = await prepareBrainSourceRemovalControl(alpha, { workspaceId, sourceId: source.id, mode: "DIRECT",
      planIdentityHash: "1".repeat(64) }, fixture.prisma);
    await expect(commitBrainSourceRemovalCompletion({ ...token }, { actor: alpha, workspaceId }, fixture.prisma))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(commitBrainSourceRemovalCompletion(token, { actor: { ...alpha }, workspaceId }, fixture.prisma))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    await expect(commitBrainSourceRemovalCompletion(token, { actor: alpha, workspaceId }, { ...fixture.prisma }))
      .rejects.toMatchObject({ code: "INVALID_INPUT_RECEIPT" });
    expect(fixture.rows.artifactInputLineage).toEqual([]);
  });

  it("requires the current role rather than authorizing from a stored claim or a service label", async () => {
    fixture.rows.member.find(row => row.userId === "alpha").role = "CONTRIBUTOR";
    await expect(prepareBrainSourceRemovalControl(alpha, { workspaceId, sourceId: source.id, mode: "DIRECT",
      planIdentityHash: "1".repeat(64) }, fixture.prisma)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const agent = { kind: "agent", authProvider: "bootstrap", label: "Admin", workspaceIds: [workspaceId], scopes: ["brain:write"] } as const;
    await expect(prepareBrainSourceRemovalControl(agent as any, { workspaceId, sourceId: source.id, mode: "DIRECT",
      planIdentityHash: "1".repeat(64) }, fixture.prisma)).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_REVOKED" });
  });

  it("rejects legacy/malformed outcome metadata without inferring a native source from status", async () => {
    expect(await isBrainSourceRemovalOutcomeReadable(alpha, workspaceId, { workspaceId, operation: "BRAIN_SOURCE_REMOVAL_COMPLETED",
      requestKey: "1".repeat(64), actorKind: "user", userId: "alpha", credentialId: null, credentialVersion: null, scopeHash: null,
      requiredScopes: [], controlJson: { version: 1, sourceId: source.id, status: "archived" } }, fixture.prisma)).toBe(false);
    expect(fixture.rows.artifactInputLineage).toEqual([]);
  });
});
