import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mcpCredentialVersion, prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../../packages/shared/src/db-test-utils";
import { recordArtifactInputLineage, lineageContentFingerprint, type LineageKind } from "../../../packages/domain/src/source-lineage";
import { WorkItemReadRelease } from "../../../packages/domain/src/work-item-readable-page";
import { loadActionWorkItemResponse, loadTensionWorkItemResponse, serializeActionWorkItem, serializeTensionWorkItem } from "./work-item-api";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(kind: "Action" | "Tension") {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic response joins", slug: randomUUID() } });
  const users = await Promise.all(["reader", "assignee", "raiser", "voter"].map(displayName => prisma.user.create({
    data: { email: `${displayName}-${randomUUID()}@example.test`, displayName, passwordHash: "synthetic" },
  })));
  const members = await Promise.all(users.map(user => prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id } })));
  const actor: AppActor = { kind: "user", user: users[0] };
  const other: AppActor = { kind: "user", user: users[1] };
  const data = { workspaceId: workspace.id, authorUserId: users[0].id, assigneeMemberId: members[1].id,
    title: "Public original", bodyMd: "Admitted body", status: "OPEN" as const, isPrivate: false, priority: 2 };
  const row = kind === "Action" ? await prisma.action.create({ data })
    : await prisma.tension.create({ data: { ...data, raisedByMemberId: members[2].id } });
  const record = (artifactKind: LineageKind, content: { id: string }, inputs: { kind: LineageKind; id: string }[] = [], originalActor = actor) =>
    prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: originalActor, workspaceId: workspace.id,
      artifact: { kind: artifactKind, id: content.id }, content, origin: inputs.length ? "DERIVED" : "HUMAN_ORIGINAL", inputs }));
  await record(kind, row);
  const privateRow = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: users[1].id,
    title: "Hidden source", isPrivate: true } });
  await record("Action", privateRow, [], other);
  const hide = (artifactKind: LineageKind, content: { id: string }) => record(artifactKind, content, [{ kind: "Action", id: privateRow.id }], other);
  const vote = kind === "Tension" ? await prisma.tensionUpvote.create({ data: { tensionId: row.id, userId: users[3].id } }) : null;
  if (vote) await record("TensionUpvote", vote, [{ kind, id: row.id }]);
  const process = await prisma.adviceProcess.create({ data: { workspaceId: workspace.id, authorMemberId: members[0].id,
    subjectType: kind.toUpperCase(), subjectId: row.id } });
  const request = await prisma.adviceRequest.create({ data: { workspaceId: workspace.id, processId: process.id,
    requestedByUserId: users[0].id, audienceType: "WORKSPACE", messageMd: "Admitted advice" } });
  await record("AdviceRequest", request, [{ kind, id: row.id }]);
  const read = (caller: AppActor = actor) => kind === "Action" ? loadActionWorkItemResponse(caller, workspace.id, row.id)
    : loadTensionWorkItemResponse(caller, workspace.id, row.id);
  return { workspace, users, members, actor, row, record, hide, vote, request, read };
}

function beforeRelease(effect: (value: unknown) => Promise<unknown>) {
  const finish = WorkItemReadRelease.prototype.finish;
  return vi.spyOn(WorkItemReadRelease.prototype, "finish").mockImplementation(async function<T>(this: WorkItemReadRelease, value: T) {
    await effect(value);
    return finish.call(this, value) as Promise<T>;
  });
}

it.each(["Action", "Tension"] as const)("preserves %s DTO, editing metadata, and numeric counts for admitted joins", async kind => {
  const f = await fixture(kind);
  const value = await f.read();
  expect(value).toMatchObject({ id: f.row.id, priority: 2, assigneeMemberId: f.members[1].id,
    assigneeMember: { userId: f.users[1].id, user: { displayName: "assignee", email: f.users[1].email } },
    adviceRequestCount: 1, activeAdviceRequestCount: 1, inputRequestCount: 1, activeInputRequestCount: 1 });
  expect(value).toHaveProperty("createdAt", f.row.createdAt);
  expect(value).toHaveProperty("updatedAt", f.row.updatedAt);
  const normalized = kind === "Action" ? serializeActionWorkItem(value!) : serializeTensionWorkItem(value!);
  expect(normalized).toMatchObject({ assigneeMemberName: "assignee", priorityLabel: "Important" });
  if (kind === "Tension") expect(value).toMatchObject({ raisedByMemberId: f.members[2].id, upvotes: [{ id: f.vote!.id }] });
});

it.each(["Action", "Tension"] as const)("redacts %s deactivated and separately hidden assignee joins", async kind => {
  const f = await fixture(kind);
  await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
  expect(await f.read()).toMatchObject({ id: f.row.id, assigneeMemberId: null, assigneeMember: null });
  await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: true } });
  await f.hide("User", f.users[1]);
  expect(await f.read()).toMatchObject({ id: f.row.id, assigneeMemberId: null, assigneeMember: null });
});

it("redacts a hidden Member independently of its otherwise visible User", async () => {
  const f = await fixture("Tension");
  const member = await prisma.member.findUniqueOrThrow({ where: { id: f.members[2].id }, include: { user: { select: { id: true, email: true, displayName: true } } } });
  await f.hide("Member", member);
  expect(await f.read()).toMatchObject({ raisedByMemberId: null, raisedByMember: null,
    assigneeMemberId: f.members[1].id, upvotes: [{ id: f.vote!.id }] });
});

it.each(["vote", "voter"] as const)("filters independently hidden %s from response upvotes", async hidden => {
  const f = await fixture("Tension");
  await (hidden === "vote" ? f.hide("TensionUpvote", f.vote!) : f.hide("User", f.users[3]));
  expect(await f.read()).toMatchObject({ id: f.row.id, upvotes: [], inputRequestCount: 1 });
});

it.each(["Action", "Tension"] as const)("retains the denied %s parent envelope", async kind => {
  const f = await fixture(kind);
  await f.hide(kind, f.row);
  expect(await f.read()).toEqual({ id: f.row.id, contentWithheld: true });
});

for (const kind of ["Action", "Tension"] as const) {
  it.each(["parent-body", "parent-head", "profile-body", "profile-head", "member-epoch", "caller-epoch", "advice-body"] as const)(
    `${kind} rejects post-admission %s mutation`, async change => {
      const f = await fixture(kind);
      const barrier = beforeRelease(async value => {
        expect(value).toMatchObject({ id: f.row.id, assigneeMember: { user: { displayName: "assignee" } } });
        if (change === "parent-body") {
          if (kind === "Action") await prisma.action.update({ where: { id: f.row.id }, data: { bodyMd: "Changed" } });
          else await prisma.tension.update({ where: { id: f.row.id }, data: { bodyMd: "Changed" } });
        }
        if (change === "parent-head") {
          const latest = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id, artifactType: kind, artifactId: f.row.id }, orderBy: { revision: "desc" } });
          await prisma.artifactInputLineage.create({ data: { workspaceId: f.workspace.id, artifactType: kind, artifactId: f.row.id,
            revision: latest.revision + 1, origin: "HUMAN_ORIGINAL", contentHash: lineageContentFingerprint(kind, f.row), inputsJson: [], rootsJson: [] } });
        }
        if (change === "profile-body") await prisma.user.update({ where: { id: f.users[1].id }, data: { displayName: "Changed" } });
        if (change === "profile-head") await f.hide("User", f.users[1]);
        if (change === "member-epoch" || change === "caller-epoch") {
          const id = f.members[change === "member-epoch" ? 1 : 0].id;
          await prisma.member.update({ where: { id }, data: { isActive: false } });
          await prisma.member.update({ where: { id }, data: { isActive: true } });
        }
        if (change === "advice-body") await prisma.adviceRequest.update({ where: { id: f.request.id }, data: { messageMd: "Changed" } });
      });
      await expect(f.read()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(barrier).toHaveBeenCalledTimes(1);
    });
}

it("rejects a voter authority change after vote admission", async () => {
  const f = await fixture("Tension");
  beforeRelease(async value => {
    expect(value).toMatchObject({ upvotes: [{ id: f.vote!.id }] });
    await f.hide("User", f.users[3]);
  });
  await expect(f.read()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it.each(["Action", "Tension"] as const)("rechecks the current scoped %s caller after credential revoke and restore", async kind => {
  const f = await fixture(kind);
  const credential = await prisma.agentCredential.create({ data: { workspaceId: f.workspace.id, label: "Synthetic response reader",
    tokenHash: randomUUID(), scopes: ["workspace:read", "actions:read", "tensions:read", "members:read", "proposals:read"] } });
  const actor: AppActor = { kind: "agent", authProvider: "credential", credentialId: credential.id,
    credentialVersion: mcpCredentialVersion(credential.tokenHash), label: credential.label, workspaceIds: [f.workspace.id], scopes: credential.scopes };
  beforeRelease(async () => {
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { isActive: false } });
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { isActive: true } });
  });
  await expect(f.read(actor)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});
