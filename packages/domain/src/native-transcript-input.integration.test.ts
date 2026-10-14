import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createMeetingAudioAsset } from "./meeting-audio-assets";
import { readableArtifactIds } from "./source-lineage";

const previousEncryptionKey = process.env.ENCRYPTION_KEY;

describe("native meeting audio source lineage", () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY ??= "1".repeat(64);
    await truncateAllTables();
  });
  afterEach(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });

  it("saves an atomic owner-private receipt and withholds it after owner grant restoration", async () => {
    const workspace = await prisma.workspace.create({ data: { name: "Synthetic audio proof",
      slug: `audio-proof-${randomUUID()}` } });
    const owner = await prisma.user.create({ data: { email: `audio-owner-${randomUUID()}@example.test`,
      passwordHash: "synthetic" } });
    const peer = await prisma.user.create({ data: { email: `audio-peer-${randomUUID()}@example.test`,
      passwordHash: "synthetic" } });
    const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id,
      role: "CONTRIBUTOR" } });
    await prisma.member.create({ data: { workspaceId: workspace.id, userId: peer.id,
      role: "CONTRIBUTOR" } });
    const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
    const peerActor: AppActor = { kind: "user", user: { id: peer.id, email: peer.email, displayName: "Peer" } };
    const storage = { put: async () => ({ key: "synthetic" }), get: async () => null,
      delete: async () => undefined } as never;

    const result = await createMeetingAudioAsset(ownerActor, { workspaceId: workspace.id,
      fileName: "Synthetic audio.m4a", mimeType: "audio/mp4", fileBuffer: Buffer.from("audio"),
      title: "PRIVATE OWNER TITLE", storage });
    const asset = await prisma.meetingAudioAsset.findUniqueOrThrow({ where: { id: result.audioAsset.id } });
    const input = await prisma.nativeTranscriptInput.findFirstOrThrow({ where: {
      workspaceId: workspace.id, meetingAudioAssetId: asset.id, mode: "AUDIO_UPLOAD",
    } });
    const manifest = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
      workspaceId: workspace.id, artifactType: "MeetingAudioAsset", artifactId: asset.id,
    }, orderBy: { revision: "desc" } });
    expect(asset.workflowJobId).toBe(result.workflowJobId);
    expect(manifest.origin).toBe("DERIVED");
    expect(JSON.stringify(manifest.rootsJson)).toContain(input.id);
    expect(await readableArtifactIds(ownerActor, workspace.id, "MeetingAudioAsset", [asset]))
      .toEqual(new Set([asset.id]));
    expect(await readableArtifactIds(peerActor, workspace.id, "MeetingAudioAsset", [asset]))
      .toEqual(new Set());

    await prisma.member.update({ where: { id: ownerMember.id }, data: { isActive: false } });
    await expect(readableArtifactIds(ownerActor, workspace.id, "MeetingAudioAsset", [asset]))
      .rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await prisma.member.update({ where: { id: ownerMember.id }, data: { isActive: true } });
    expect(await readableArtifactIds(ownerActor, workspace.id, "MeetingAudioAsset", [asset]))
      .toEqual(new Set());
  });
});
