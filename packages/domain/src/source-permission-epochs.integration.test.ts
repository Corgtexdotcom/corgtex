import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { artifactPermissionEpochIdentities, capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  type PermissionEpochIdentity, type PermissionEpochProof } from "./source-permission-epochs";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";

// Real triggers and transactions; use the integration runner's disposable database.
beforeEach(async () => { await truncateAllTables(); });
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic epoch policy", slug: `epoch-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic foreign epoch", slug: `epoch-foreign-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `epoch-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", isActive: true } });
  const actor: AppActor = { kind: "user", user: { id: user.id, email: user.email, displayName: null, globalRole: "USER" } };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "ARTICLE", tier: 1,
    title: "Synthetic original", content: "Synthetic unchanged source body", authorMemberId: member.id, accessDomain: "WORKSPACE" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  return { workspace, foreign, user, member, actor, source };
}
const capture = (workspaceId: string, identities: PermissionEpochIdentity[]) => prisma.$transaction(tx => capturePermissionEpochs(tx, workspaceId, identities));
function epoch(proof: PermissionEpochProof, kind: string, id: string) {
  const value = proof.entries.find(entry => entry.kind === kind && entry.id === id);
  expect(value).toBeDefined(); return BigInt(value!.epoch);
}
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>(resolve => { open = resolve; });
  return { promise, open };
}
async function waitForDatabaseLock(pid: number) {
  const deadline = Date.now() + 4_000;
  do {
    const rows = await prisma.$queryRaw<Array<{ wait_event_type: string | null }>>`
      SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("The concurrent synthetic revocation did not reach its database lock.");
}

describe("real SourcePermissionEpoch transition triggers", () => {
  it("never redeems an old proof after byte-identical source domain revoke/restore", async () => {
    const f = await fixture(); const identity = { kind: "BrainSource", id: f.source.id };
    const initial = await capture(f.workspace.id, [identity]);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, initial)).toBe(true);
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "FINANCE" } });
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, initial)).toBe(false);
    const revoked = await capture(f.workspace.id, [identity]);
    const restored = await prisma.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "WORKSPACE" } });
    expect(restored).toEqual(f.source);
    expect(lineageContentFingerprint("BrainSource", restored)).toBe(lineageContentFingerprint("BrainSource", f.source));
    const fresh = await capture(f.workspace.id, [identity]);
    expect(epoch(fresh, identity.kind, identity.id)).toBeGreaterThan(epoch(revoked, identity.kind, identity.id));
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, initial)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, revoked)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, fresh)).toBe(true);
    expect(await isArtifactPermissionEpochProofCurrent(f.foreign.id, fresh)).toBe(false);
  });

  it("keeps target archive/restore epochs stale even when approval status is restored", async () => {
    const f = await fixture();
    const target = await prisma.contextGraphObject.create({ data: { workspaceId: f.workspace.id, objectType: "Team", title: "Synthetic target", status: "approved" } });
    const identity = { kind: "ContextGraphObject", id: target.id };
    const before = await capture(f.workspace.id, [identity]);
    await prisma.contextGraphObject.update({ where: { id: target.id }, data: { status: "archived" } });
    const archived = await capture(f.workspace.id, [identity]);
    await prisma.contextGraphObject.update({ where: { id: target.id }, data: { status: "approved" } });
    const restored = await capture(f.workspace.id, [identity]);
    expect(epoch(archived, identity.kind, identity.id)).toBeGreaterThan(epoch(before, identity.kind, identity.id));
    expect(epoch(restored, identity.kind, identity.id)).toBeGreaterThan(epoch(archived, identity.kind, identity.id));
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, archived)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, restored)).toBe(true);
  });

  it("invalidates both member identity and stable user policy through deactivation/restoration", async () => {
    const f = await fixture();
    const ids = [{ kind: "Member", id: f.member.id }, { kind: "MemberUserPolicy", id: f.user.id }];
    const before = await capture(f.workspace.id, ids);
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
    const inactive = await capture(f.workspace.id, ids);
    await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    const restored = await capture(f.workspace.id, ids);
    for (const id of ids) {
      expect(epoch(inactive, id.kind, id.id)).toBeGreaterThan(epoch(before, id.kind, id.id));
      expect(epoch(restored, id.kind, id.id)).toBeGreaterThan(epoch(inactive, id.kind, id.id));
    }
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, restored)).toBe(true);
  });

  it("preserves the stable ModulePolicy epoch across grant deletion and a new physical grant", async () => {
    const f = await fixture(); const identity = { kind: "ModulePolicy", id: "finance" };
    const absent = await capture(f.workspace.id, [identity]);
    const data = { workspaceId: f.workspace.id, moduleKey: "finance", principalType: "MEMBER" as const, principalId: f.member.id, accessLevel: "READ" as const };
    const grant = await prisma.workspaceModuleGrant.create({ data });
    const present = await capture(f.workspace.id, [identity]);
    await prisma.workspaceModuleGrant.delete({ where: { id: grant.id } });
    const removed = await capture(f.workspace.id, [identity]);
    const replacement = await prisma.workspaceModuleGrant.create({ data });
    const recreated = await capture(f.workspace.id, [identity]);
    expect(replacement.id).not.toBe(grant.id);
    const values = [absent, present, removed, recreated].map(proof => epoch(proof, identity.kind, identity.id));
    expect(values[0]).toBe(0n);
    values.slice(1).forEach((value, index) => expect(value).toBeGreaterThan(values[index]));
    for (const old of [absent, present, removed]) expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, old)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, recreated)).toBe(true);
  });

  it("preserves stable channel policy through deletion/recreation independently of channel row IDs", async () => {
    const f = await fixture();
    const installation = await prisma.communicationInstallation.create({ data: { workspaceId: f.workspace.id, provider: "SLACK", externalWorkspaceId: `synthetic-${randomUUID()}` } });
    const data = { workspaceId: f.workspace.id, installationId: installation.id, provider: "SLACK" as const, externalChannelId: "synthetic-public", kind: "PUBLIC" as const, isIngestEnabled: true };
    const identity = { kind: "CommunicationChannelPolicy", id: JSON.stringify([installation.id, data.externalChannelId]) };
    expect(artifactPermissionEpochIdentities("CommunicationChannel", data)).toContainEqual(identity);
    const absent = await capture(f.workspace.id, [identity]);
    const channel = await prisma.communicationChannel.create({ data });
    const before = await capture(f.workspace.id, [identity]);
    await prisma.communicationChannel.delete({ where: { id: channel.id } });
    const deleted = await capture(f.workspace.id, [identity]);
    const recreated = await prisma.communicationChannel.create({ data });
    const after = await capture(f.workspace.id, [identity]);
    expect(recreated.id).not.toBe(channel.id);
    const values = [absent, before, deleted, after].map(proof => epoch(proof, identity.kind, identity.id));
    values.slice(1).forEach((value, index) => expect(value).toBeGreaterThan(values[index]));
    for (const old of [absent, before, deleted]) expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, old)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, after)).toBe(true);
  });

  async function externalFixture() {
    const f = await fixture();
    const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: f.workspace.id, userId: f.user.id,
      providerKey: "synthetic", displayName: "Synthetic epoch provider", serverUrl: "https://provider.example.test/mcp" } });
    const source = await prisma.externalContentSource.create({ data: { workspaceId: f.workspace.id, connectionId: connection.id,
      selectedByUserId: f.user.id, providerKey: connection.providerKey, sourceKind: "FILE", externalId: "synthetic-file",
      title: "Synthetic selected file", metadata: { materialized: false }, status: "ACTIVE" } });
    return { ...f, connection, external: source, identity: { kind: "ExternalContentSource", id: source.id } };
  }

  it("keeps external sync progress epochs stable while full content fingerprints change", async () => {
    const f = await externalFixture(); const before = await capture(f.workspace.id, [f.identity]);
    const originalHash = lineageContentFingerprint("ExternalContentSource", f.external);
    const syncing = await prisma.externalContentSource.update({ where: { id: f.external.id }, data: {
      status: "SYNCING", metadata: { materialized: false, progress: 0.5 }, syncMode: "INCREMENTAL", lastSyncError: null,
    } });
    expect(lineageContentFingerprint("ExternalContentSource", syncing)).not.toBe(originalHash);
    expect(await capture(f.workspace.id, [f.identity])).toEqual(before);
    const active = await prisma.externalContentSource.update({ where: { id: f.external.id }, data: {
      status: "ACTIVE", metadata: { materialized: true, documentId: "synthetic-output" }, lastRemoteVersion: "revision-2",
      lastSyncedAt: new Date(), lastSyncError: null,
    } });
    expect(lineageContentFingerprint("ExternalContentSource", active)).not.toBe(lineageContentFingerprint("ExternalContentSource", syncing));
    expect(await capture(f.workspace.id, [f.identity])).toEqual(before);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(true);
  });

  it("invalidates external source epochs through ARCHIVED-to-ACTIVE restoration", async () => {
    const f = await externalFixture(); const before = await capture(f.workspace.id, [f.identity]);
    await prisma.externalContentSource.update({ where: { id: f.external.id }, data: { status: "ARCHIVED" } });
    const archived = await capture(f.workspace.id, [f.identity]);
    await prisma.externalContentSource.update({ where: { id: f.external.id }, data: { status: "ACTIVE" } });
    const restored = await capture(f.workspace.id, [f.identity]);
    expect(epoch(archived, f.identity.kind, f.identity.id)).toBeGreaterThan(epoch(before, f.identity.kind, f.identity.id));
    expect(epoch(restored, f.identity.kind, f.identity.id)).toBeGreaterThan(epoch(archived, f.identity.kind, f.identity.id));
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, archived)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, restored)).toBe(true);
  });

  it.each(["sourceKind", "connectionId"] as const)("does not redeem old external proofs after %s binding changes and restoration", async field => {
    const f = await externalFixture(); const before = await capture(f.workspace.id, [f.identity]);
    const alternate = await prisma.externalMcpConnection.create({ data: { workspaceId: f.workspace.id, userId: f.user.id,
      providerKey: "synthetic-alternate", displayName: "Alternate synthetic provider", serverUrl: "https://alternate.example.test/mcp" } });
    await prisma.externalContentSource.update({ where: { id: f.external.id },
      data: field === "sourceKind" ? { sourceKind: "FOLDER" } : { connectionId: alternate.id } });
    const rebound = await capture(f.workspace.id, [f.identity]);
    await prisma.externalContentSource.update({ where: { id: f.external.id },
      data: field === "sourceKind" ? { sourceKind: f.external.sourceKind } : { connectionId: f.connection.id } });
    const restored = await capture(f.workspace.id, [f.identity]);
    expect(epoch(rebound, f.identity.kind, f.identity.id)).toBeGreaterThan(epoch(before, f.identity.kind, f.identity.id));
    expect(epoch(restored, f.identity.kind, f.identity.id)).toBeGreaterThan(epoch(rebound, f.identity.kind, f.identity.id));
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, rebound)).toBe(false);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, restored)).toBe(true);
  });

  it.each(["capture", "current-check"] as const)("holds a concurrent revoke behind the %s FOR SHARE fence until publication commits", async mode => {
    const f = await fixture(); const identity = { kind: "BrainSource", id: f.source.id };
    const before = await capture(f.workspace.id, [identity]);
    const entered = gate(), release = gate(), revokerStarted = gate<number>();
    let revokeCommitted = false;
    const publication = prisma.$transaction(async tx => {
      if (mode === "capture") await capturePermissionEpochs(tx, f.workspace.id, [identity]);
      else expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before, tx)).toBe(true);
      entered.open(); await release.promise;
      expect(revokeCommitted).toBe(false);
      expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before, tx)).toBe(true);
      // Static synthetic commit marker; no new provenance is invented for it.
      return tx.contextGraphObject.create({ data: { workspaceId: f.workspace.id, objectType: "Team", title: "Synthetic publication marker" } });
    }, { timeout: 15_000 });
    await entered.promise;
    const revocation = prisma.$transaction(async tx => {
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      revokerStarted.open(connection.pid);
      await tx.brainSource.update({ where: { id: f.source.id }, data: { accessDomain: "FINANCE" } });
    }, { timeout: 15_000 }).then(() => { revokeCommitted = true; });
    // Observe an actual database lock wait, not a timing assumption that a promise has started.
    try {
      await waitForDatabaseLock(await revokerStarted.promise);
      expect(revokeCommitted).toBe(false);
      expect(await prisma.contextGraphObject.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { release.open(); }
    const [marker] = await Promise.all([publication, revocation]);
    expect(marker.id).toBeTruthy(); expect(revokeCommitted).toBe(true);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(false);
  });

  it("does not invalidate a fresh graph receipt merely for pending-to-approved status", async () => {
    const f = await fixture();
    const target = await prisma.contextGraphObject.create({ data: { workspaceId: f.workspace.id, objectType: "Team", title: "Synthetic complete graph", status: "pending" } });
    const identity = { kind: "ContextGraphObject", id: target.id };
    const before = await capture(f.workspace.id, [identity]);
    const approved = await prisma.$transaction(async tx => {
      const sourceRoots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "BrainSource", id: f.source.id, snapshot: f.source }], tx);
      const saved = await tx.contextGraphObject.update({ where: { id: target.id }, data: { status: "approved" } });
      await recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
        artifact: identity as { kind: "ContextGraphObject"; id: string }, content: saved, origin: "DERIVED", inputs: [], inheritedRoots: sourceRoots });
      return saved;
    });
    expect(await capture(f.workspace.id, [identity])).toEqual(before);
    const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ContextGraphObject", id: approved.id, snapshot: approved }]);
    expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, before)).toBe(true);
  });
});
