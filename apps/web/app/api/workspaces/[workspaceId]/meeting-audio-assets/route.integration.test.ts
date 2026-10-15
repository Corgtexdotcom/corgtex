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

it("finds an owner-private proven upload behind 5,100 legacy rows and withholds its revoked original", async () => {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic audio route", slug: `audio-route-${randomUUID()}`}});
  const owner = await prisma.user.create({data: {email: `owner-${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const peer = await prisma.user.create({data: {email: `peer-${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: owner.id, role: "CONTRIBUTOR"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: peer.id, role: "CONTRIBUTOR"}});
  requestActor.current = {kind: "user", user: {id: owner.id, email: owner.email}};
  const storage = {put: async () => ({key: "synthetic"}), get: async () => null, delete: async () => undefined} as never;
  const visible = await createMeetingAudioAsset(requestActor.current, {workspaceId: workspace.id,
    fileName: "owner-private.m4a", mimeType: "audio/mp4", fileBuffer: Buffer.from("synthetic audio"), storage});
  await prisma.meetingAudioAsset.createMany({data: Array.from({length: 5100}, (_, index) => ({
    workspaceId: workspace.id, uploadedByUserId: owner.id, fileName: `legacy-${index}.m4a`,
    storageKey: `synthetic-legacy-${workspace.id}-${index}`, sizeBytes: 10, createdAt: new Date(Date.now() + 1000 + index),
  }))});
  const {GET} = await import("./route");
  const request = () => new NextRequest(`http://localhost/api/workspaces/${workspace.id}/meeting-audio-assets?take=1`);
  const response = await GET(request(), {params: Promise.resolve({workspaceId: workspace.id})});
  const body = await response.json();
  expect(body).toHaveProperty("audioAssets");
  expect(response.status).toBe(200);
  expect(body.audioAssets).toEqual([expect.objectContaining({id: visible.audioAsset.id, fileName: "owner-private.m4a"})]);
  expect(body.audioAssets[0]).not.toHaveProperty("storageKey");
  expect(body.audioAssets[0]).not.toHaveProperty("transcriptText");

  requestActor.current = {kind: "user", user: {id: peer.id, email: peer.email}};
  expect(await (await GET(request(), {params: Promise.resolve({workspaceId: workspace.id})})).json()).toEqual({audioAssets: []});
  requestActor.current = {kind: "user", user: {id: owner.id, email: owner.email}};
  requestActor.beforeRelease = async () => {
    await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
    await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
  };
  const changed = await GET(request(), {params: Promise.resolve({workspaceId: workspace.id})});
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({code: "SOURCE_CHANGED"});
  requestActor.beforeRelease = null;
  expect(await (await GET(request(), {params: Promise.resolve({workspaceId: workspace.id})})).json()).toEqual({audioAssets: []});
});
