import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { listDocumentDirectory, listDocuments } from "./documents";
import { listMeetingDirectory, listMeetings } from "./meetings";
import { recordArtifactInputLineage } from "./source-lineage";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";

let prefix: string;
beforeEach(() => { prefix = `${randomUUID()}-`; });
const idOf = (id: string) => `${prefix}${id}`;
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic PUN-92", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  return { workspaceId: workspace.id, actor: { kind: "user", user } as AppActor, user, member };
}

it("preserves document admission, boundary dates and old search refs while omitting text from output", async () => {
  const f = await fixture();
  const boundary = new Date("2026-10-01T12:00:00Z");
  for (const [id, createdAt, proved] of [
    ["old-reference", new Date(boundary.getTime() - 1), true],
    ["boundary-a", boundary, true], ["boundary-b", boundary, true], ["hidden", boundary, false],
  ] as const) {
    const row = await prisma.document.create({ data: { id: idOf(id), workspaceId: f.workspaceId, title: id, source: "SYNTHETIC", storageKey: id, textContent: "x".repeat(65536), createdAt } });
    if (proved) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Document", id: row.id }, content: row, origin: "HUMAN_ORIGINAL", inputs: [] }));
  }
  const full = await listDocuments(f.actor, f.workspaceId);
  const queries = vi.spyOn(prisma.document, "findMany");
  const { items: directory, complete } = await listDocumentDirectory(f.actor, f.workspaceId, { createdFrom: boundary });
  expect(complete).toBe(true);
  expect(directory.map(row => row.id.slice(prefix.length))).toEqual(["boundary-a", "boundary-b"]);
  expect(directory).toEqual(full.filter(row => row.createdAt >= boundary).map(({ id, title, source, createdAt }) => ({ id, title, source, createdAt })));
  expect(queries.mock.calls[0][0]).toMatchObject({ select: { id: true, createdAt: true }, take: 10001, where: { createdAt: { gte: boundary } } });
  expect(queries.mock.calls.slice(1).every(([args]) => args?.take === 100 && args.select === undefined)).toBe(true);
  expect(await listDocumentDirectory(f.actor, f.workspaceId, { ids: [idOf("old-reference"), idOf("hidden")] })).toMatchObject({ items: [{ id: idOf("old-reference") }], complete: true, nextCursor: null });
  console.log("PUN92 document retained result bytes", { full: Buffer.byteLength(JSON.stringify(full)), directory: Buffer.byteLength(JSON.stringify(directory)) });
});

it("matches canonical meeting permissions/classification and member/date filters", async () => {
  const f = await fixture();
  const date = new Date("2026-10-01T00:00:00Z");
  for (const [index, transcript] of [null, "", " \n\t", "Readable transcript"].entries()) {
    const row = await prisma.meeting.create({ data: { id: idOf(`meeting-${index}`), workspaceId: f.workspaceId, title: `meeting-${index}`,
      source: "SYNTHETIC", status: index % 2 ? "SCHEDULED" : "COMPLETED", transcript, recordedAt: date,
      participantIds: [f.member.id], participantEmails: [f.user.email], summaryMd: "Synthetic summary" } });
    for (const kind of ["MeetingTranscript", "Meeting", "MeetingAgenda"] as const) {
      const content = kind === "MeetingTranscript" ? meetingTranscriptInputProjection(row) : kind === "MeetingAgenda" ? { id: row.id, workspaceId: row.workspaceId, agendaJson: row.agendaJson, archivedAt: row.archivedAt, createdAt: row.createdAt } : row;
      await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId, artifact: { kind, id: row.id }, content, origin: "HUMAN_ORIGINAL", inputs: [] }));
    }
  }
  await prisma.meeting.create({ data: { id: idOf("unproved"), workspaceId: f.workspaceId, source: "SYNTHETIC", transcript: "unproved", recordedAt: date } });
  const opts = { memberIds: [f.member.id], recordedFrom: date, recordedTo: date };
  const old = await listMeetings(f.actor, f.workspaceId, opts);
  const project = (row: (typeof old)[number]) => ({ id: row.id, hasTranscript: Boolean(row.transcript?.trim()), recordedAt: row.recordedAt, summary: row.summaryMd });
  expect(await listMeetingDirectory(f.actor, f.workspaceId, opts, project)).toEqual({ items: old.map(project).sort((a, b) => a.id.localeCompare(b.id)), complete: true, nextCursor: null });
  expect(await listMeetingDirectory(f.actor, f.workspaceId, { recordedFrom: new Date(date.getTime() + 1) }, project)).toEqual({ items: [], complete: true, nextCursor: null });
  expect((await listMeetingDirectory(f.actor, f.workspaceId, {}, project)).items.map(row => row.id)).not.toContain(idOf("unproved"));
});

it("loads directory candidate bodies in bounded batches across a hidden prefix", async () => {
  const f = await fixture();
  await prisma.document.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ id: idOf(`hidden-${String(i).padStart(4, "0")}`),
    workspaceId: f.workspaceId, title: "Synthetic hidden", source: "SYNTHETIC", storageKey: String(i), textContent: "x".repeat(65536) })) });
  const queries = vi.spyOn(prisma.document, "findMany");
  expect(await listDocumentDirectory(f.actor, f.workspaceId)).toEqual({ items: [], complete: true, nextCursor: null });
  expect(queries.mock.calls.map(([args]) => args?.take)).toEqual([10001, 100, 100, 100]);
  const bodyPages = await Promise.all(queries.mock.results.slice(1).map(result => result.value));
  expect(bodyPages.map(rows => rows.length)).toEqual([100, 100, 5]);
  console.log("PUN92 synthetic canonical candidate bytes", { rows: 205, bodyBytes: 205 * 65536, maxHydrationRows: Math.max(...bodyPages.map(rows => rows.length)) });
});
