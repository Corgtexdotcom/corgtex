import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createProposal, updateProposal } from "./proposals";
import { captureArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";

vi.mock("@corgtex/models", () => ({ defaultModelGateway: { extract: vi.fn() } }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const explicit = process.env.CORGTEX_DISPOSABLE_TEST_DATABASE_URL === process.env.DATABASE_URL
  && database.hostname === "127.0.0.1" && database.pathname === "/proposal_attempt_test";
const ci = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432";
if (!explicit && !ci) throw new Error("Proposal attempts require an assigned disposable fixture.");
beforeEach(async () => { await truncateAllTables(); vi.mocked(defaultModelGateway.extract).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
const body = Array.from({ length: 140 }, (_, i) => `Synthetic${i}`).join(" ");
async function fixture(mode: "create" | "update") {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic proposal guard", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const source = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "source", title: "Private input",
    bodyMd: body, type: "PROJECT", isPrivate: true, ownerMemberId: member.id } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainArticle", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const roots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "BrainArticle", id: source.id }]);
  const proposal = mode === "update" ? await createProposal(actor, { workspaceId: workspace.id, title: "Private stored proposal", bodyMd: body,
    isPrivate: true, lineageRoots: roots }) : null;
  const run = () => mode === "create" ? createProposal(actor, { workspaceId: workspace.id, title: "Derived proposal", bodyMd: body,
    isPrivate: true, lineageRoots: roots, includeAiSummary: true }) : updateProposal(actor, { workspaceId: workspace.id,
    proposalId: proposal!.id, expectedVersion: proposal!.version, includeAiSummary: true });
  return { workspace, user, member, actor, source, proposal, run };
}
const cases = (["create", "update"] as const).flatMap(mode => (["credentials", "retry"] as const).flatMap(boundary =>
  (["source", "caller", "none"] as const).map(change => ({ mode, boundary, change }))));
describe("Proposal summary provider attempt authority", () => {
  it.each(cases)("guards $mode after $boundary $change changes", async ({ mode, boundary, change }) => {
    const f = await fixture(mode); let sends = 0;
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      const context = { signal: request.signal ?? new AbortController().signal };
      if (boundary === "retry") { await request.authorizeAttempt?.(context); sends++; }
      await Promise.resolve();
      if (change === "source") {
        await prisma.brainArticle.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
        await prisma.brainArticle.update({ where: { id: f.source.id }, data: { archivedAt: null } });
      }
      if (change === "caller") {
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      }
      await request.authorizeAttempt?.(context); sends++;
      return { output: { summary: "Generated summary" } } as never;
    });
    const result = await f.run().catch(error => error);
    expect(sends).toBe((boundary === "retry" ? 1 : 0) + (change === "none" ? 1 : 0));
    if (change === "none") expect(result).toMatchObject({ summary: "Generated summary" });
    else expect(result).toBeInstanceOf(Error);
    if (mode === "create") expect(await prisma.proposal.count({ where: { workspaceId: f.workspace.id } })).toBe(change === "none" ? 1 : 0);
    else expect(await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal!.id } })).toMatchObject({ version: change === "none" ? 2 : 1, summary: change === "none" ? "Generated summary" : null });
  });
  it("rejects a replacement same-body Proposal head before transmitting its private text", async () => {
    const f = await fixture("update"); let sends = 0;
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id, artifactType: "Proposal", artifactId: f.proposal!.id }, orderBy: { revision: "desc" } });
      await prisma.artifactInputLineage.create({ data: { workspaceId: head.workspaceId, artifactType: head.artifactType, artifactId: head.artifactId,
        revision: head.revision + 1, origin: head.origin, contentHash: head.contentHash, epochProofVersion: head.epochProofVersion,
        inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
        permissionEpochsJson: head.permissionEpochsJson as Prisma.InputJsonValue } });
      await request.authorizeAttempt?.({ signal: request.signal ?? new AbortController().signal }); sends++;
      return { output: { summary: "Not permitted" } } as never;
    });
    await expect(f.run()).rejects.toBeInstanceOf(Error); expect(sends).toBe(0);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal!.id } })).version).toBe(1);
  });
  it.each(["create", "update"] as const)("latches a swallowed %s denial even after current membership is restored", async mode => {
    const f = await fixture(mode);
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await request.authorizeAttempt?.({ signal: request.signal ?? new AbortController().signal }).catch(() => {});
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
      return { output: { summary: "Do not publish" } } as never;
    });
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(await prisma.proposal.count({ where: { workspaceId: f.workspace.id } })).toBe(mode === "create" ? 0 : 1);
    if (f.proposal) expect((await prisma.proposal.findUniqueOrThrow({ where: { id: f.proposal.id } })).version).toBe(1);
  });
  it.each(["create", "update"] as const)("retains ordinary provider-error fallback for authorized %s", async mode => {
    const f = await fixture(mode);
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      await request.authorizeAttempt?.({ signal: request.signal ?? new AbortController().signal });
      throw new Error("synthetic provider unavailable");
    });
    expect(await f.run()).toMatchObject({ summary: null });
  });
  it("summarizes a literal human original with no inherited artifact roots", async () => {
    const f = await fixture("create");
    vi.mocked(defaultModelGateway.extract).mockImplementationOnce(async request => {
      await request.authorizeAttempt?.({ signal: request.signal ?? new AbortController().signal });
      return { output: { summary: "Human summary" } } as never;
    });
    expect(await createProposal(f.actor, { workspaceId: f.workspace.id, title: "Human original", bodyMd: body,
      includeAiSummary: true })).toMatchObject({ summary: "Human summary" });
  });
});
