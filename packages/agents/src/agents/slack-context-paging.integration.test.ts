import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@corgtex/shared";
import { truncateAllTables } from "../../../shared/src/db-test-utils";
import { recordArtifactInputLineage, isArtifactInputProofReadable } from "../../../domain/src/source-lineage";
import { listMeetings } from "../../../domain/src/meetings";
import { loadSlackReadableRows } from "./slack-agent";

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic paging", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor = { kind: "user" as const, user: { id: user.id, email: user.email, displayName: "Synthetic reader" } };
  return { workspace, user, actor };
}

describe("meeting and Slack canonical page admission", () => {
  beforeEach(async () => { await truncateAllTables(); });

  it("continues the actual meeting listing beyond 5001 unknown rows without admitting their content", async () => {
    const f = await fixture();
    const recordedAt = new Date("2026-01-01T00:00:00Z");
    await prisma.meeting.createMany({ data: Array.from({ length: 5_001 }, (_, i) => ({
      id: `denied-${String(i).padStart(5, "0")}`, workspaceId: f.workspace.id, source: "SYNTHETIC", recordedAt,
      participantIds: [], summaryMd: "UNKNOWN summary",
    })) });
    const tail = await prisma.meeting.create({ data: { id: "readable-tail", workspaceId: f.workspace.id,
      source: "SYNTHETIC", recordedAt, participantIds: [], summaryMd: "Human original summary" } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Meeting", id: tail.id }, content: tail, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const rows = await listMeetings(f.actor, f.workspace.id);
    expect(rows.map(row => row.id)).toEqual([tail.id]);
    expect(rows[0].summaryMd).toBe("Human original summary");
  }, 180_000);

  it("replenishes Slack within its 200-row budget, preserves the public gate and rejects a later edit", async () => {
    const f = await fixture();
    const createdAt = new Date("2026-01-01T00:00:00Z");
    await prisma.action.createMany({ data: Array.from({ length: 199 }, (_, i) => ({
      id: `denied-${String(i).padStart(5, "0")}`, workspaceId: f.workspace.id, authorUserId: f.user.id,
      title: "UNKNOWN action", status: "OPEN", createdAt,
    })) });
    const tail = await prisma.action.create({ data: { id: "readable-tail", workspaceId: f.workspace.id,
      authorUserId: f.user.id, title: "Public human original", status: "OPEN", createdAt } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Action", id: tail.id }, content: tail, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const pages: number[] = [];
    const result = await loadSlackReadableRows({ proof: { actor: f.actor, prompt: "Synthetic", roots: [], publicReply: true },
      workspaceId: f.workspace.id, kind: "Action", limit: 5,
      load: async page => {
        pages.push(page.take);
        return prisma.action.findMany({ where: { workspaceId: f.workspace.id, status: "OPEN", archivedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page });
      },
    });
    expect(result.records.map(row => row.id)).toEqual([tail.id]);
    expect(pages).toHaveLength(5);
    expect(new Set(pages)).toEqual(new Set([50, 1]));
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, result.roots)).toBe(true);
    await prisma.action.update({ where: { id: tail.id }, data: { title: "Changed after capture" } });
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, result.roots)).toBe(false);
  }, 180_000);

  it("rejects a Slack denied prefix beyond its raw budget without silently hiding the readable tail", async () => {
    const f = await fixture();
    const createdAt = new Date("2026-01-01T00:00:00Z");
    await prisma.action.createMany({ data: Array.from({ length: 200 }, (_, i) => ({
      id: `denied-${String(i).padStart(5, "0")}`, workspaceId: f.workspace.id, authorUserId: f.user.id,
      title: "UNKNOWN action", status: "OPEN", createdAt,
    })) });
    const tail = await prisma.action.create({ data: { id: "readable-tail", workspaceId: f.workspace.id,
      authorUserId: f.user.id, title: "Public human original", status: "OPEN", createdAt } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
      artifact: { kind: "Action", id: tail.id }, content: tail, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const pages: number[] = [];
    const proof = { actor: f.actor, prompt: "Synthetic", roots: [], publicReply: true };
    await expect(loadSlackReadableRows({ proof, workspaceId: f.workspace.id, kind: "Action", limit: 5,
      load: async page => {
        pages.push(page.take);
        return prisma.action.findMany({ where: { workspaceId: f.workspace.id, status: "OPEN", archivedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page });
      },
    })).rejects.toMatchObject({ code: "SLACK_CONTEXT_SCAN_LIMIT" });
    expect(pages).toEqual([50, 50, 50, 50, 1]);
    expect(proof.roots).toEqual([]);
  }, 180_000);
});
