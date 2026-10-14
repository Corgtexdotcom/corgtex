import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { getBrainStatus } from "./brain";
import { hasWorkspaceInitialKnowledgeSource } from "./workspace-initial-knowledge";
import { listNotifications, countUnreadNotifications } from "./notifications";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic aggregate", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  return { workspaceId: workspace.id, user, actor };
}
it("counts beyond 5000 canonical sources, replenishes hidden pages, and withholds unproved onboarding context", async () => {
  const f = await fixture();
  await prisma.brainSource.createMany({ data: Array.from({ length: 5001 }, (_, index) => ({
    id: `hidden-${String(index).padStart(5, "0")}`, workspaceId: f.workspaceId,
    sourceType: "DOC" as const, tier: 1, content: "Unproved synthetic copy",
  })) });
  const queries = vi.spyOn(prisma.brainSource, "findMany");
  expect((await getBrainStatus(f.actor, f)).unabsorbedSources).toBe(0);
  expect(queries.mock.calls.length).toBeGreaterThan(50);
  expect(queries.mock.calls.every(([args]) => args?.take === 100 && args.select === undefined)).toBe(true);
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
  const source = await prisma.brainSource.create({ data: { id: "visible-last", workspaceId: f.workspaceId,
    sourceType: "DOC", tier: 1, content: "Authenticated original" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  expect((await getBrainStatus(f.actor, f)).unabsorbedSources).toBe(1);
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(true);
  await prisma.brainSource.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
  expect((await getBrainStatus(f.actor, f)).unabsorbedSources).toBe(0);
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
}, 120_000);

it("pages notification bodies, applies visible skip, stops early and counts only current admitted history", async () => {
  const f = await fixture();
  const timestamp = new Date("2026-10-01T12:00:00Z");
  await prisma.notification.createMany({ data: Array.from({ length: 350 }, (_, index) => ({
    id: `z-hidden-${String(index).padStart(4, "0")}`, workspaceId: f.workspaceId, userId: f.user.id,
    type: "SYNTHETIC", title: "Unproved notification", bodyMd: "Unproved body", createdAt: timestamp,
  })) });
  const input = await prisma.brainSource.create({ data: { workspaceId: f.workspaceId,
    sourceType: "DOC", tier: 1, content: "Authenticated notification input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: input.id }, content: input, origin: "HUMAN_ORIGINAL", inputs: [] }));
  for (const id of ["v3", "v2", "v1"]) {
    const row = await prisma.notification.create({ data: { id, workspaceId: f.workspaceId, userId: f.user.id,
      type: "SYNTHETIC", title: id, bodyMd: "Authenticated original", createdAt: timestamp } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: { kind: "Notification", id }, content: row, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: input.id }] }));
  }
  // Older hidden history must not be loaded to deliver the requested visible page.
  await prisma.notification.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
    id: `a-older-${index}`, workspaceId: f.workspaceId, userId: f.user.id,
    type: "SYNTHETIC", title: "Older hidden", createdAt: new Date("2025-01-01"),
  })) });
  const queries = vi.spyOn(prisma.notification, "findMany");
  expect((await listNotifications(f.actor, f.workspaceId, { skip: 1, take: 1 })).map(row => row.id)).toEqual(["v2"]);
  expect(queries).toHaveBeenCalledTimes(4);
  expect(queries.mock.calls.every(([args]) => args?.take === 100 && args.select === undefined)).toBe(true);
  queries.mockClear();
  expect(await countUnreadNotifications(f.actor, f.workspaceId)).toBe(3);
  expect(queries).toHaveBeenCalledTimes(7);
  await prisma.notification.update({ where: { id: "v2" }, data: { bodyMd: "Unproved replacement" } });
  expect(await countUnreadNotifications(f.actor, f.workspaceId)).toBe(2);
  expect((await listNotifications(f.actor, f.workspaceId, { skip: 1, take: 1 })).map(row => row.id)).toEqual(["v1"]);
}, 120_000);

it("bases initial context on admitted Documents and Meetings beyond hidden first pages", async () => {
  const f = await fixture();
  await prisma.document.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    id: `hidden-doc-${index}`, workspaceId: f.workspaceId, title: "Unproved document", source: "UPLOAD",
    storageKey: `synthetic/${index}`, textContent: "Unproved copied text",
  })) });
  await prisma.meeting.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    id: `hidden-meeting-${index}`, workspaceId: f.workspaceId, source: "UPLOAD", recordedAt: new Date(),
    transcript: "Unproved copied transcript", participantIds: [],
  })) });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
  const source = await prisma.brainSource.create({ data: { workspaceId: f.workspaceId,
    sourceType: "RFC", tier: 1, content: "Authenticated input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const document = await prisma.document.create({ data: { id: "visible-document", workspaceId: f.workspaceId,
    source: "UPLOAD", title: "Proved document", storageKey: "synthetic/valid", textContent: "Authenticated input" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "Document", id: document.id }, content: document, origin: "DERIVED", inputs: [{kind: "BrainSource", id: source.id}] }));
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(true);
  await prisma.document.update({ where: {id: document.id}, data: {archivedAt: new Date()} });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
  const { createMeeting } = await import("./meetings");
  const meeting = await createMeeting(f.actor, { workspaceId: f.workspaceId, source: "WEB_REQUEST", title: "Original Meeting",
    transcript: "I will prepare the proposal.", recordedAt: new Date() });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(true);
  await prisma.meeting.update({ where: {id: meeting.id}, data: {archivedAt: new Date()} });
  expect(await hasWorkspaceInitialKnowledgeSource(f.actor, f.workspaceId)).toBe(false);
}, 120_000);
