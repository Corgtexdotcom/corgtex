import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../../../../../../packages/shared/src/db-test-utils";
import { createCheckIn, respondToCheckIn } from "../../../../../../../packages/domain/src/check-ins";
import { recordArtifactInputLineage } from "../../../../../../../packages/domain/src/source-lineage";

const auth = vi.hoisted(() => ({ actor: null as AppActor | null }));
vi.mock("@/lib/auth", () => ({ resolveRequestActor: async () => auth.actor }));
import { GET } from "./route";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic general check-ins", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const ownerUser = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const owner = await prisma.member.create({ data: { workspaceId: workspace.id, userId: ownerUser.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: "Recipient" } };
  const ownerActor: AppActor = { kind: "user", user: { id: ownerUser.id, email: ownerUser.email, displayName: "Owner" } };
  auth.actor = actor;
  const source = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, title: "Synthetic source", slug: randomUUID(), type: "PROCESS", bodyMd: "Initially shared", sourceIds: [], ownerMemberId: owner.id } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: ownerActor, workspaceId: workspace.id,
    artifact: { kind: "BrainArticle", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const visible = await createCheckIn(actor, { workspaceId: workspace.id, memberId: member.id,
    questionText: "Visible original", questionSource: "human" });
  const derived = await createCheckIn(actor, { workspaceId: workspace.id, memberId: member.id,
    questionText: "Derived private question", questionSource: "AI", metadata: { story: "Private metadata" },
    lineageInputs: [{ kind: "BrainArticle", id: source.id }] });
  await respondToCheckIn(actor, { workspaceId: workspace.id, checkInId: derived.id, responseMd: "Private saved response" });
  return { workspace, actor, member, owner, source, visible, derived };
}
async function get(workspaceId: string, query = "") {
  return GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/check-ins${query}`), { params: Promise.resolve({ workspaceId }) });
}

describe("General check-in API original lineage release", () => {
  it("withholds revoked derived question, metadata and saved response", async () => {
    const f = await setup();
    expect((await (await get(f.workspace.id)).json()).checkIns.map((r: {id: string}) => r.id)).toContain(f.derived.id);
    await prisma.brainArticle.update({ where: { id: f.source.id }, data: { isPrivate: true } });
    const response = await get(f.workspace.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.checkIns.map((r: {id: string}) => r.id)).toEqual([f.visible.id]);
    expect(JSON.stringify(body)).not.toMatch(/Derived private question|Private metadata|Private saved response/);
  });

  it("continues after a hidden-only raw window and rejects foreign recipient cursors", async () => {
    const f = await setup();
    const hidden = await prisma.checkIn.create({ data: { workspaceId: f.workspace.id, memberId: f.member.id,
      questionText: "Unknown newest body", questionSource: "AI", createdAt: new Date("2100-01-01") } });
    const first = await (await get(f.workspace.id, "?take=1")).json();
    expect(first).toEqual({ checkIns: [], nextCursor: hidden.id });
    const next = await (await get(f.workspace.id, `?take=1&cursor=${hidden.id}`)).json();
    expect(next.checkIns).toHaveLength(1);
    expect(next.checkIns[0].id).not.toBe(hidden.id);
    const foreign = await createCheckIn(f.actor, { workspaceId: f.workspace.id, memberId: f.owner.id,
      questionText: "Other member", questionSource: "human" });
    expect((await get(f.workspace.id, `?cursor=${foreign.id}`)).status).toBe(400);
    expect((await get(f.workspace.id, "?cursor=missing")).status).toBe(400);
  });

  it("keeps the raw page bounded, scopes workspace cursors, and preserves agent-empty behavior", async () => {
    const f = await setup();
    const other = await prisma.workspace.create({ data: { name: "Other synthetic tenant", slug: randomUUID() } });
    const otherMember = await prisma.member.create({ data: { workspaceId: other.id, userId: f.member.userId, role: "CONTRIBUTOR" } });
    const foreign = await createCheckIn(f.actor, { workspaceId: other.id, memberId: otherMember.id,
      questionText: "Foreign workspace body", questionSource: "human" });
    expect((await get(f.workspace.id, `?cursor=${foreign.id}`)).status).toBe(400);
    const queries = vi.spyOn(prisma.checkIn, "findMany");
    const response = await get(f.workspace.id, "?take=500");
    expect(response.status).toBe(200);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toMatchObject({ take: 101, where: { workspaceId: f.workspace.id, memberId: f.member.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(JSON.stringify(await response.json())).not.toContain("Foreign workspace body");
    queries.mockClear();
    auth.actor = { kind: "agent", authProvider: "bootstrap", workspaceIds: [f.workspace.id], label: "Synthetic check-in reader" };
    expect(await (await get(f.workspace.id)).json()).toEqual({ checkIns: [], nextCursor: null });
    expect(queries).not.toHaveBeenCalled();
  });

  it.each(["source-private", "caller-restore", "head-replacement"] as const)("withholds original response after %s at final release", async change => {
    const f = await setup();
    const db = getPrismaClient();
    const transaction = db.$transaction.bind(db);
    let changed = false;
    vi.spyOn(db, "$transaction").mockImplementation((async (read: unknown, options: {isolationLevel?: string} | undefined) => {
      if (!changed && options?.isolationLevel === "RepeatableRead") {
        changed = true;
        if (change === "source-private") await prisma.brainArticle.update({ where: { id: f.source.id }, data: { isPrivate: true } });
        else if (change === "caller-restore") {
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
          await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
        } else {
          const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { workspaceId: f.workspace.id,
            artifactType: "CheckIn", artifactId: f.derived.id }, orderBy: { revision: "desc" } });
          await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${head.id}`;
        }
      }
      return transaction(read as never, options as never);
    }) as typeof db.$transaction);
    const response = await get(f.workspace.id);
    expect(changed).toBe(true);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/Derived private question|Private saved response/);
  });
});
