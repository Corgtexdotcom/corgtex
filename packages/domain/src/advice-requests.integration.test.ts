import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createAdviceRequest, listAdviceRequests, loadAdviceRequestCountSummaries } from "./advice-requests";
import { isArtifactInputProofReadable, captureArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic advice", slug: randomUUID() } });
  const users = await Promise.all(["owner", "recipient", "peer"].map(name => prisma.user.create({ data: { email: `${name}-${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: name } })));
  const members = await Promise.all(users.map(user => prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } })));
  const actors = users.map(user => ({ kind: "user", user }) as AppActor);
  const subject = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: users[0].id, title: "Original subject", status: "OPEN" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: actors[0], workspaceId: workspace.id, artifact: { kind: "Action", id: subject.id }, content: subject, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const params = { workspaceId: workspace.id, subjectType: "ACTION", subjectId: subject.id, audienceType: "MEMBERS" as const, memberIds: [members[1].id], messageMd: "Original advice", idempotencyId: randomUUID() };
  return { workspace, users, members, actors, subject, params };
}
it("seals the final recipient epoch and accepts an identical producer retry", async () => {
  const f = await fixture();
  const request = await createAdviceRequest(f.actors[0], f.params);
  const proof = await captureArtifactInputProof(f.actors[1], f.workspace.id, [{ kind: "AdviceRequest", id: request.id }]);
  expect(await isArtifactInputProofReadable(f.actors[1], f.workspace.id, proof)).toBe(true);
  expect((await listAdviceRequests(f.actors[1], { workspaceId: f.workspace.id })).map(row => row.id)).toEqual([request.id]);
  expect((await loadAdviceRequestCountSummaries(f.actors[1], f.workspace.id, "ACTION", [f.subject.id])).get(f.subject.id)?.activeAdviceRequestCount).toBe(1);
  expect((await createAdviceRequest(f.actors[0], f.params)).id).toBe(request.id);
  expect(await prisma.adviceRequest.count()).toBe(1);
  expect(await prisma.event.count({ where: { type: "advice.requested" } })).toBe(1);
});
it("withholds a private recipient request from a non-recipient list", async () => {
  const f = await fixture(); await createAdviceRequest(f.actors[0], f.params);
  expect(await listAdviceRequests(f.actors[2], { workspaceId: f.workspace.id })).toEqual([]);
});

async function withDeniedTail(f: Awaited<ReturnType<typeof fixture>>) {
  const request = await createAdviceRequest(f.actors[0], f.params);
  await prisma.adviceRequest.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
    workspaceId: f.workspace.id, processId: request.processId, requestedByUserId: f.users[0].id,
    audienceType: "WORKSPACE", messageMd: "Unproved original", createdAt: new Date(1_000 + index),
  })) });
  return request;
}
function afterFirstPage(work: () => Promise<void>) {
  const query = prisma.adviceRequest.findMany.bind(prisma.adviceRequest);
  let changed = false;
  return vi.spyOn(prisma.adviceRequest, "findMany").mockImplementation((async (args?: Prisma.AdviceRequestFindManyArgs) => {
    if (args?.take === 100 && args.where?.OR && !changed) { changed = true; await work(); }
    return query(args);
  }) as typeof prisma.adviceRequest.findMany);
}
it("replenishes denied pages, retains original ranking/DTOs, and excludes foreign processes", async () => {
  const f = await fixture();
  const second = await createAdviceRequest(f.actors[0], { ...f.params, idempotencyId: randomUUID(), messageMd: "Second original" });
  await prisma.adviceRequest.createMany({ data: Array.from({ length: 101 }, () => ({
    workspaceId: f.workspace.id, processId: second.processId, requestedByUserId: f.users[0].id,
    audienceType: "WORKSPACE", messageMd: "Unproved original",
  })) });
  const first = await createAdviceRequest(f.actors[0], f.params);
  const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
  const foreignMember = await prisma.member.create({ data: { workspaceId: foreign.id, userId: f.users[0].id } });
  const foreignAction = await prisma.action.create({ data: { workspaceId: foreign.id, authorUserId: f.users[0].id, title: "Foreign action" } });
  const process = await prisma.adviceProcess.create({ data: { workspaceId: foreign.id, subjectType: "ACTION", subjectId: foreignAction.id, authorMemberId: foreignMember.id, ownerMemberId: foreignMember.id } });
  await prisma.adviceRequest.create({ data: { workspaceId: foreign.id, processId: process.id, requestedByUserId: f.users[0].id, audienceType: "WORKSPACE", messageMd: "Foreign metadata" } });
  const calls = vi.spyOn(prisma.adviceRequest, "findMany");
  const result = await listAdviceRequests(f.actors[1], { workspaceId: f.workspace.id, take: 2 });
  expect(result.map(row => row.id)).toEqual([first.id, second.id]);
  expect(Object.keys(result[0].requestedBy).sort()).toEqual(["displayName", "email", "id"]);
  expect(Object.keys(result[0].recipients[0].member.user).sort()).toEqual(["displayName", "email", "id"]);
  expect(calls.mock.calls.filter(([args]) => args?.take === 100)).toHaveLength(2);
});
it.each(["subject-head", "subject-revoke-restore", "recipient-revoke-restore", "recipient-membership", "requester-identity", "process", "caller"] as const)(
  "rejects original selected advice when %s changes during later paging", async mode => {
    const f = await fixture(); const request = await withDeniedTail(f);
    afterFirstPage(async () => {
      if (mode === "subject-head") await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id, artifact: { kind: "Action", id: f.subject.id }, content: f.subject, origin: "HUMAN_ORIGINAL", inputs: [] }));
      if (mode === "subject-revoke-restore") {
        await prisma.action.update({ where: { id: f.subject.id }, data: { isPrivate: true } });
        await prisma.action.update({ where: { id: f.subject.id }, data: { isPrivate: false } });
      }
      if (mode === "recipient-revoke-restore") {
        const recipient = await prisma.adviceRequestRecipient.findFirstOrThrow({ where: { requestId: request.id } });
        await prisma.adviceRequestRecipient.delete({ where: { id: recipient.id } });
        await prisma.adviceRequestRecipient.create({ data: recipient });
      }
      if (mode === "recipient-membership") {
        await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
        await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: true } });
      }
      if (mode === "requester-identity") await prisma.user.update({ where: { id: f.users[0].id }, data: { displayName: "Changed identity" } });
      if (mode === "process") await prisma.adviceProcess.update({ where: { id: request.processId }, data: { status: "READY" } });
      if (mode === "caller") await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
    });
    await expect(listAdviceRequests(f.actors[1], { workspaceId: f.workspace.id, take: 2 })).rejects.toMatchObject({ code: mode === "caller" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
  },
);
it("withholds requests after original recipient authority is revoked and restored", async () => {
  const f = await fixture(); const request = await createAdviceRequest(f.actors[0], f.params);
  await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
  await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: true } });
  expect(await listAdviceRequests(f.actors[1], { workspaceId: f.workspace.id })).toEqual([]);
  await expect(createAdviceRequest(f.actors[0], f.params)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await prisma.adviceRequest.count({ where: { id: request.id } })).toBe(1);
});
it("retains the final membership gate for empty results and performs no read for take zero", async () => {
  const f = await fixture();
  const calls = vi.spyOn(prisma.adviceRequest, "findMany");
  expect(await listAdviceRequests(f.actors[1], { workspaceId: f.workspace.id, take: 0 })).toEqual([]);
  expect(calls).not.toHaveBeenCalled();
  calls.mockRestore();
  const query = prisma.adviceRequest.findMany.bind(prisma.adviceRequest);
  vi.spyOn(prisma.adviceRequest, "findMany").mockImplementation((async (args?: Prisma.AdviceRequestFindManyArgs) => {
    const result = await query(args);
    await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
    return result;
  }) as typeof prisma.adviceRequest.findMany);
  await expect(listAdviceRequests(f.actors[1], { workspaceId: f.workspace.id })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});

it("bounds denied raw history and continues to the original permitted request", async () => {
  const f = await fixture();
  const request = await createAdviceRequest(f.actors[0], f.params);
  await prisma.adviceRequest.createMany({ data: Array.from({ length: 201 }, () => ({
    workspaceId: f.workspace.id, processId: request.processId, requestedByUserId: f.users[0].id,
    audienceType: "WORKSPACE", messageMd: "Unproved history", createdAt: new Date("2030-01-01"),
  })) });
  const { listAdviceRequestWindow } = await import("./advice-requests");
  const calls = vi.spyOn(prisma.adviceRequest, "findMany");
  const first = await listAdviceRequestWindow(f.actors[1], { workspaceId: f.workspace.id });
  expect(first).toMatchObject({ items: [], complete: false, nextCursor: expect.any(String) });
  expect(calls.mock.calls.filter(([query]) => query?.take === 100)).toHaveLength(2);
  const second = await listAdviceRequestWindow(f.actors[1], { workspaceId: f.workspace.id, cursor: first.nextCursor! });
  expect(second).toMatchObject({ complete: true, nextCursor: null, items: [{ id: request.id }] });
  expect(calls.mock.calls.filter(([query]) => query?.take === 100)).toHaveLength(3);
  expect(second.items[0].requestedBy.email).toBe(f.users[0].email);
});
