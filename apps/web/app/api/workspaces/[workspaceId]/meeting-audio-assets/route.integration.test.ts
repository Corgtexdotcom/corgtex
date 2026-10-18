import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { createMeetingAudioAsset } from "@corgtex/domain";

const requestActor = vi.hoisted(() => ({current: null as AppActor | null,
  beforeRelease: null as (() => Promise<void>) | null}));
vi.mock("@corgtex/domain", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/domain")>();
  return {...actual, withArtifactCountReleaseSnapshot: async (...args: Parameters<typeof actual.withArtifactCountReleaseSnapshot>) => {
    await requestActor.beforeRelease?.();
    return actual.withArtifactCountReleaseSnapshot(...args);
  }};
});
vi.mock("@/lib/auth", () => ({resolveRequestActor: async () => requestActor.current}));
vi.mock("@/lib/http", () => ({handleRouteError: (error: {status?: number; code?: string}) =>
  NextResponse.json({code: error.code, message: String(error)}, {status: error.status ?? 500})}));
afterAll(async () => {await prisma.$disconnect();});

it("reaches an owner-private upload through bounded hidden windows and withholds its revoked original", async () => {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic audio route", slug: `audio-route-${randomUUID()}`}});
  const owner = await prisma.user.create({data: {email: `owner-${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const peer = await prisma.user.create({data: {email: `peer-${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: peer.id, role: "CONTRIBUTOR"}});
  const ownerActor: AppActor = {kind: "user", user: {id: owner.id, email: owner.email, displayName: owner.displayName}};
  requestActor.current = ownerActor;
  const storage = {put: async () => ({key: "synthetic"}), get: async () => null, delete: async () => undefined} as never;
  const visible = await createMeetingAudioAsset(ownerActor, {workspaceId: workspace.id,
    fileName: "owner-private.m4a", mimeType: "audio/mp4", fileBuffer: Buffer.from("synthetic audio"), storage});
  await prisma.meetingAudioAsset.createMany({data: Array.from({length: 5100}, (_, index) => ({
    workspaceId: workspace.id, uploadedByUserId: owner.id, fileName: `legacy-${index}.m4a`,
    storageKey: `synthetic-legacy-${workspace.id}-${index}`, sizeBytes: 10, createdAt: new Date(Date.now() + 1000 + index),
  }))});
  const {GET} = await import("./route");
  const request = (cursor?: string | null) => new NextRequest(`http://localhost/api/workspaces/${workspace.id}/meeting-audio-assets?take=1${cursor ? `&cursor=${cursor}` : ""}`);
  let cursor: string | null = null;
  let lastCursor: string | null = null;
  let body: {audioAssets: Array<Record<string, unknown>>; complete: boolean; nextCursor: string | null};
  let windows = 0;
  do {
    lastCursor = cursor;
    const response = await GET(request(cursor), {params: Promise.resolve({workspaceId: workspace.id})});
    expect(response.status).toBe(200);
    body = await response.json();
    if (windows === 0) expect(body).toMatchObject({audioAssets: [], complete: false, nextCursor: expect.any(String)});
    cursor = body.nextCursor;
    windows++;
  } while (cursor);
  expect(windows).toBe(26);
  expect(body!.audioAssets).toEqual([expect.objectContaining({id: visible.audioAsset.id, fileName: "owner-private.m4a"})]);
  expect(body!.audioAssets[0]).not.toHaveProperty("storageKey");
  expect(body!.audioAssets[0]).not.toHaveProperty("transcriptText");

  requestActor.current = {kind: "user", user: {id: peer.id, email: peer.email, displayName: peer.displayName}};
  expect(await (await GET(request(lastCursor), {params: Promise.resolve({workspaceId: workspace.id})})).json()).toMatchObject({audioAssets: []});
  requestActor.current = ownerActor;
  requestActor.beforeRelease = async () => {
    await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
    await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
  };
  const changed = await GET(request(lastCursor), {params: Promise.resolve({workspaceId: workspace.id})});
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({code: "SOURCE_CHANGED"});
  requestActor.beforeRelease = null;
  expect(await (await GET(request(lastCursor), {params: Promise.resolve({workspaceId: workspace.id})})).json()).toMatchObject({audioAssets: []});
});
