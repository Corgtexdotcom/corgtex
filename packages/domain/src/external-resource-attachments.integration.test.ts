import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { upsertWorkspaceExternalResourceFromUrl } from "./external-resources";
import { WORKSPACE_EXTERNAL_RESOURCE_PURPOSES } from "./external-resources";
import { POST } from "../../../apps/web/app/api/workspaces/[workspaceId]/external-resources/route";

const requestActor = vi.hoisted(() => ({ value: null as AppActor | null }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: async () => requestActor.value }));
vi.mock("@/lib/demo-guard", () => ({ checkApiDemoGuard: async () => undefined }));

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(publicAction = false) {
  const workspace = await prisma.workspace.create({ data: { name: "PUN-84 synthetic", slug: randomUUID() } });
  const users = await Promise.all(["alice", "bob", "admin"].map(name => prisma.user.create({
    data: { email: `${name}-${randomUUID()}@example.test`, passwordHash: "synthetic" },
  })));
  const members = await Promise.all(users.map((user, i) => prisma.member.create({
    data: { workspaceId: workspace.id, userId: user.id, role: i === 2 ? "ADMIN" : "CONTRIBUTOR" },
  })));
  const actors = users.map(user => ({ kind: "user", user }) as AppActor);
  const action = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: users[0].id,
    title: "Alice private draft", status: publicAction ? "OPEN" : "DRAFT", isPrivate: !publicAction } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: actors[0], workspaceId: workspace.id,
    artifact: { kind: "Action", id: action.id }, content: action, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const save = (actor = actors[1], extra: Record<string, unknown> = {}) => upsertWorkspaceExternalResourceFromUrl(actor, {
    workspaceId: workspace.id, url: "https://example.test/synthetic", entityType: "Action", entityId: action.id, ...extra,
  });
  const post = async (body: Record<string, unknown>, actor = actors[1]) => {
    requestActor.value = actor;
    return POST(new NextRequest(`http://localhost/api/workspaces/${workspace.id}/external-resources`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ workspaceId: workspace.id }) });
  };
  return { workspace, users, members, actors, action, save, post };
}

async function effects() {
  return Promise.all([prisma.workspaceExternalResource.count(), prisma.workspaceExternalResourceAttachment.count(),
    prisma.auditLog.count({ where: { action: { startsWith: "external-resource." } } }),
    prisma.workflowJob.count({ where: { type: "knowledge.sync.external-resource" } })]);
}

it.each(["reference", "completion_evidence"])("API denies another user's private draft (%s) before any effects", async purpose => {
  const f = await fixture();
  const response = await f.post({ url: "https://example.test/synthetic", entityType: "Action", entityId: f.action.id, purpose });
  expect(response.status).toBe(403);
  expect(await effects()).toEqual([0, 0, 0, 0]);
});

it.each(["COMPLETED", "archived", "duplicate"])("domain rejects %s Actions before updating a shared resource", async state => {
  const f = await fixture();
  const existing = await f.save(f.actors[0], { entityType: null, entityId: null, descriptionMd: "Retained original" });
  await prisma.action.update({ where: { id: f.action.id }, data: {
    status: state === "COMPLETED" ? "COMPLETED" : "OPEN", isPrivate: false,
    ...(state === "archived" ? { archivedAt: new Date() } : {}),
    ...(state === "duplicate" ? { duplicateOfActionId: (await prisma.action.create({ data: {
      workspaceId: f.workspace.id, authorUserId: f.users[0].id, title: "Canonical" }, })).id } : {}),
  } });
  const unchanged = await prisma.workspaceExternalResource.findUnique({ where: { id: existing.id } });
  const before = await effects();
  await expect(f.save(f.actors[1], { descriptionMd: "Must not overwrite" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(await effects()).toEqual(before);
  expect(await prisma.workspaceExternalResource.findUnique({ where: { id: existing.id } })).toEqual(unchanged);
});

it.each([{ entityId: "orphan" }, { entityType: "Action" }, { entityType: "Action", entityId: "  " }])(
  "rejects incomplete target pairs through API", async target => {
    const f = await fixture();
    expect((await f.post({ url: "https://example.test/synthetic", ...target })).status).toBe(400);
    expect(await effects()).toEqual([0, 0, 0, 0]);
  },
);

it("preserves owner/admin draft attachments and unattached saves without completing the Action", async () => {
  const f = await fixture();
  for (const actor of [f.actors[0], f.actors[2]]) await f.save(actor, { purpose: "completion_evidence" });
  await f.save(f.actors[1], { entityType: null, entityId: null, url: "https://example.test/unattached" });
  expect((await effects()).slice(0, 3)).toEqual([2, 1, 5]);
  expect((await effects())[3]).toBeGreaterThan(0);
  expect(await prisma.action.findUnique({ where: { id: f.action.id } })).toEqual(f.action);
});

it("rejects a foreign-workspace target", async () => {
  const f = await fixture();
  await expect(f.save(f.actors[0], { workspaceId: randomUUID() })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  const other = await prisma.workspace.create({ data: { name: "Other", slug: randomUUID() } });
  await prisma.member.create({ data: { workspaceId: other.id, userId: f.users[0].id } });
  await expect(f.save(f.actors[0], { workspaceId: other.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await effects()).toEqual([0, 0, 0, 0]);
});

it.each(["Action", "Tension", "Proposal", "Meeting", "BrainSource"] as const)(
  "preserves permitted %s attachments for every existing purpose and rejects archive", async kind => {
    const f = await fixture(true);
    const base = { workspaceId: f.workspace.id, authorUserId: f.users[0].id, title: "Synthetic public original", status: "OPEN" as const, isPrivate: false };
    const row = kind === "Action" ? f.action
      : kind === "Tension" ? await prisma.tension.create({ data: base })
      : kind === "Proposal" ? await prisma.proposal.create({ data: { ...base, bodyMd: "Synthetic proposal" } })
      : kind === "Meeting" ? await prisma.meeting.create({ data: { workspaceId: f.workspace.id, title: "Synthetic meeting",
        source: "manual", recordedAt: new Date(), participantIds: [] } })
      : await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, sourceType: "RFC", tier: 1, content: "Synthetic native source" } });
    if (kind !== "Action") await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id,
      artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
    for (const purpose of WORKSPACE_EXTERNAL_RESOURCE_PURPOSES) {
      const response = await f.post({ url: "https://example.test/matrix", entityType: kind, entityId: row.id, purpose },
        kind === "Proposal" ? f.actors[0] : f.actors[1]);
      expect(response.status, `${kind}/${purpose}`).toBe(201);
    }
    expect(await prisma.workspaceExternalResourceAttachment.count()).toBe(4);
    const delegate = { Action: prisma.action, Tension: prisma.tension, Proposal: prisma.proposal,
      Meeting: prisma.meeting, BrainSource: prisma.brainSource }[kind] as typeof prisma.action;
    expect(await delegate.findUnique({ where: { id: row.id } })).toEqual(row);
    await delegate.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    const before = await effects();
    await expect(f.save(f.actors[0], { entityType: kind, entityId: row.id })).rejects.toBeDefined();
    expect(await effects()).toEqual(before);
  },
);

it.each(["Tension", "Proposal"] as const)("enforces %s private-draft and resolved rules", async kind => {
  const f = await fixture();
  const data = { workspaceId: f.workspace.id, authorUserId: f.users[0].id, title: "Private draft", status: "DRAFT" as const, isPrivate: true };
  const row = kind === "Tension" ? await prisma.tension.create({ data })
    : await prisma.proposal.create({ data: { ...data, bodyMd: "Private proposal" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id,
    artifact: { kind, id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  await expect(f.save(f.actors[1], { entityType: kind, entityId: row.id })).rejects.toBeDefined();
  expect(await effects()).toEqual([0, 0, 0, 0]);
  await f.save(f.actors[0], { entityType: kind, entityId: row.id });
  await f.save(f.actors[2], { entityType: kind, entityId: row.id });
  const delegate = (kind === "Tension" ? prisma.tension : prisma.proposal) as typeof prisma.tension;
  await delegate.update({ where: { id: row.id }, data: { status: "RESOLVED", isPrivate: false } });
  const before = await effects();
  await expect(f.save(f.actors[0], { entityType: kind, entityId: row.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(await effects()).toEqual(before);
});

it("does not grant Proposal editing authority to collaborators or to a designated owner", async () => {
  const f = await fixture();
  const row = await prisma.proposal.create({ data: { workspaceId: f.workspace.id, authorUserId: f.users[0].id,
    ownerMemberId: f.members[1].id, title: "Public proposal", bodyMd: "Original", status: "OPEN", isPrivate: false } });
  await expect(f.save(f.actors[1], { entityType: "Proposal", entityId: row.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await effects()).toEqual([0, 0, 0, 0]);
});

it("rejects BrainSource access-domain restrictions and unknown generated lineage", async () => {
  const f = await fixture();
  for (const data of [{ accessDomain: "FINANCE" as const, sourceType: "RFC" as const },
    { accessDomain: "WORKSPACE" as const, sourceType: "CONVERSATION_INSIGHT" as const }]) {
    const source = await prisma.brainSource.create({ data: { workspaceId: f.workspace.id, tier: 1, content: "Restricted", ...data } });
    await expect(f.save(f.actors[1], { entityType: "BrainSource", entityId: source.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect(await effects()).toEqual([0, 0, 0, 0]);
});

async function waitForBlocked(db: Client, count = 1) {
  for (let i = 0; i < 300; i++) {
    const result = await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (result.rows[0].n >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected database lock wait did not occur");
}

it.each(["COMPLETED", "private", "archived", "membership", "role"])(
  "rechecks %s changed between admission and locked write, with no persisted effects", async change => {
    const f = await fixture(change !== "role");
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('work_item_version'), hashtext($1))", [`Action:${f.action.id}`]);
      const pending = f.save(change === "role" ? f.actors[2] : f.actors[1]).then(value => ({ value }), error => ({ error }));
      await waitForBlocked(blocker);
      if (change === "membership" || change === "role") {
        await prisma.member.update({ where: { id: f.members[change === "role" ? 2 : 1].id },
          data: change === "role" ? { role: "CONTRIBUTOR" } : { isActive: false } });
      } else {
        await blocker.query('UPDATE "Action" SET "status"=$1::"ActionStatus", "isPrivate"=$2, "archivedAt"=$3 WHERE id=$4',
          [change === "COMPLETED" ? "COMPLETED" : change === "private" ? "DRAFT" : "OPEN",
            change === "private", change === "archived" ? new Date() : null, f.action.id]);
      }
      await blocker.query("COMMIT");
      expect(await pending).toHaveProperty("error");
      expect(await effects()).toEqual([0, 0, 0, 0]);
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  },
);

it("holds target and member stable through attachment commit when the writer wins", async () => {
  const f = await fixture(true);
  const existing = await f.save(f.actors[1], { entityType: null, entityId: null });
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  let pending: Promise<unknown> | undefined;
  let revocation: Promise<unknown> | undefined;
  let completion: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query('SELECT id FROM "WorkspaceExternalResource" WHERE id=$1 FOR UPDATE', [existing.id]);
    pending = f.save();
    await waitForBlocked(blocker);
    revocation = prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
    completion = prisma.action.update({ where: { id: f.action.id }, data: { status: "COMPLETED" } });
    // Start both lazy Prisma operations before observing their lock waits.
    const changes = Promise.all([revocation, completion]);
    await waitForBlocked(blocker, 3);
    await blocker.query("COMMIT");
    await pending;
    await changes;
    expect(await prisma.workspaceExternalResourceAttachment.count()).toBe(1);
  } finally {
    await blocker.query("ROLLBACK"); await blocker.end();
    await Promise.allSettled([pending, revocation, completion]);
  }
});

it("rolls back resource updates, attachments and audits if queue persistence fails", async () => {
  const f = await fixture(true);
  const resource = await f.save(f.actors[1], { entityType: null, entityId: null, descriptionMd: "Keep me" });
  const unchanged = await prisma.workspaceExternalResource.findUnique({ where: { id: resource.id } });
  const before = await effects();
  await prisma.$executeRawUnsafe(`CREATE FUNCTION pun84_reject_job() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic PUN84 rollback'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER pun84_reject_job BEFORE INSERT OR UPDATE ON "WorkflowJob"
    FOR EACH ROW EXECUTE FUNCTION pun84_reject_job()`);
  try {
    await expect(f.save(f.actors[1], { descriptionMd: "Must roll back" })).rejects.toThrow("synthetic PUN84 rollback");
    expect(await effects()).toEqual(before);
    expect(await prisma.workspaceExternalResource.findUnique({ where: { id: resource.id } })).toEqual(unchanged);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER pun84_reject_job ON "WorkflowJob"');
    await prisma.$executeRawUnsafe("DROP FUNCTION pun84_reject_job()");
  }
});
