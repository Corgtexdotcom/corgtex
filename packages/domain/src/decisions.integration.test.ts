import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import {
  archiveDecisionRecord,
  createDecisionRecord,
  getDecisionRecord,
  listDecisionLinkOptions,
  listDecisionRecords,
  restoreDecisionRecord,
  updateDecisionRecord,
} from "./decisions";

const suffix = randomUUID();
const workspaces: string[] = [];
const users: string[] = [];
let workspaceId: string;
let otherWorkspaceId: string;
let author: AppActor;
let colleague: AppActor;
let outsider: AppActor;
let proposalId: string;
let tensionId: string;
let otherProposalId: string;

beforeAll(async () => {
  const [authorUser, colleagueUser, outsiderUser] = await Promise.all(["author", "colleague", "outsider"].map((name) =>
    prisma.user.create({ data: { email: `decision-${name}-${suffix}@example.test`, passwordHash: "synthetic" } })));
  users.push(authorUser.id, colleagueUser.id, outsiderUser.id);
  author = { kind: "user", user: authorUser };
  colleague = { kind: "user", user: colleagueUser };
  outsider = { kind: "user", user: outsiderUser };
  const [workspace, otherWorkspace] = await Promise.all([
    prisma.workspace.create({ data: { slug: `decision-a-${suffix}`, name: "Decision A" } }),
    prisma.workspace.create({ data: { slug: `decision-b-${suffix}`, name: "Decision B" } }),
  ]);
  workspaceId = workspace.id;
  otherWorkspaceId = otherWorkspace.id;
  workspaces.push(workspaceId, otherWorkspaceId);
  await prisma.member.createMany({ data: [
    { workspaceId, userId: authorUser.id, role: "CONTRIBUTOR" },
    { workspaceId, userId: colleagueUser.id, role: "CONTRIBUTOR" },
    { workspaceId: otherWorkspaceId, userId: outsiderUser.id, role: "CONTRIBUTOR" },
  ] });
  const [proposal, tension, otherProposal] = await Promise.all([
    prisma.proposal.create({ data: { workspaceId, authorUserId: authorUser.id, title: "Budget proposal", bodyMd: "Proposal details", status: "OPEN", isPrivate: false } }),
    prisma.tension.create({ data: { workspaceId, authorUserId: authorUser.id, title: "Budget tension", status: "OPEN", isPrivate: false } }),
    prisma.proposal.create({ data: { workspaceId: otherWorkspaceId, authorUserId: outsiderUser.id, title: "Private tenant proposal", bodyMd: "Other details", status: "OPEN", isPrivate: false } }),
  ]);
  proposalId = proposal.id;
  tensionId = tension.id;
  otherProposalId = otherProposal.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

it("records, searches, links, edits, archives, and restores decisions within a workspace", async () => {
  const input = {
    workspaceId,
    title: "Choose annual budget",
    bodyMd: "Approved the 2027 operating budget.",
    tags: "Budget, strategy, budget",
    decidedAt: new Date("2026-09-28T12:00:00.000Z"),
    proposalId,
    tensionId,
  };
  await expect(createDecisionRecord(author, { ...input, proposalId: otherProposalId })).rejects.toMatchObject({ code: "INVALID_LINK" });
  const decision = await createDecisionRecord(author, input);
  expect(decision.tags).toEqual(["budget", "strategy"]);
  expect((await listDecisionLinkOptions(author, workspaceId)).proposals).toContainEqual({ id: proposalId, title: "Budget proposal" });
  await prisma.proposal.createMany({ data: Array.from({ length: 201 }, (_, index) => ({
    workspaceId,
    authorUserId: author.kind === "user" ? author.user.id : "",
    title: `Newer proposal ${index}`,
    bodyMd: "Proposal details",
    status: "OPEN" as const,
    isPrivate: false,
  })) });
  await prisma.tension.createMany({ data: Array.from({ length: 201 }, (_, index) => ({
    workspaceId,
    authorUserId: author.kind === "user" ? author.user.id : "",
    title: `Newer tension ${index}`,
    status: "OPEN" as const,
    isPrivate: false,
  })) });
  const allOptions = await listDecisionLinkOptions(author, workspaceId);
  expect(allOptions.proposals.length).toBeGreaterThan(200);
  expect(allOptions.tensions.length).toBeGreaterThan(200);
  expect(allOptions.proposals).toContainEqual({ id: proposalId, title: "Budget proposal" });
  expect(allOptions.tensions).toContainEqual({ id: tensionId, title: "Budget tension" });
  const result = await listDecisionRecords(colleague, { workspaceId, query: "operating", tag: "Budget" });
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({ id: decision.id, proposal: { id: proposalId }, tension: { id: tensionId } });
  await prisma.proposal.update({ where: { id: proposalId }, data: { isPrivate: true } });
  expect((await getDecisionRecord(colleague, { workspaceId, decisionId: decision.id })).proposal).toBeNull();
  await expect(createDecisionRecord(author, input)).rejects.toMatchObject({ code: "INVALID_LINK" });
  await prisma.proposal.update({ where: { id: proposalId }, data: { isPrivate: false } });
  expect((await listDecisionRecords(author, { workspaceId, tag: "nonexistent" })).total).toBe(0);
  await expect(getDecisionRecord(outsider, { workspaceId, decisionId: decision.id })).rejects.toMatchObject({ status: 403 });
  await expect(updateDecisionRecord(colleague, { ...input, decisionId: decision.id, expectedVersion: 1 })).rejects.toMatchObject({ status: 403 });
  const updated = await updateDecisionRecord(author, { ...input, title: "Approve annual budget", decisionId: decision.id, expectedVersion: 1 });
  expect(updated.version).toBe(2);
  await expect(updateDecisionRecord(author, { ...input, decisionId: decision.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await archiveDecisionRecord(author, { workspaceId, decisionId: decision.id, expectedVersion: 2 });
  expect((await listDecisionRecords(author, { workspaceId })).total).toBe(0);
  const archived = await listDecisionRecords(author, { workspaceId, includeArchived: true, tag: "budget" });
  expect(archived.total).toBe(1);
  expect(archived.items[0].archivedAt).not.toBeNull();
  await restoreDecisionRecord(author, { workspaceId, decisionId: decision.id, expectedVersion: 3 });
  expect((await listDecisionRecords(author, { workspaceId })).total).toBe(1);
  expect((await listDecisionRecords(author, { workspaceId, includeArchived: true })).total).toBe(0);
});
