import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma as db, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { inspectLegacyRecovery, recoverLegacyArtifact } from "./legacy-recovery";
import { captureArtifactInputProof, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";

beforeEach(() => truncateAllTables());
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Recovery budget", slug: randomUUID(), plan: "PAYG_AI" } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@recovery.test`, passwordHash: "synthetic" } });
  await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const action = await db.action.create({ data: { workspaceId: workspace.id, authorUserId: user.id, title: "Historical Action", status: "OPEN" } });
  const selection = { workspaceId: workspace.id, kind: "Action" as const, id: action.id };
  const request = { ...selection, expectedFingerprint: lineageContentFingerprint("Action", action), requestId: randomUUID(), consent: "RESTORE_SELECTED_HISTORY" as const };
  const manifests = (count: number, roots: Prisma.InputJsonValue = []) => db.artifactInputLineage.createMany({ data: Array.from({ length: count }, (_, index) => ({
    workspaceId: workspace.id, artifactType: "Action", artifactId: action.id, revision: index + 1,
    origin: "UNKNOWN" as const, contentHash: request.expectedFingerprint, inputsJson: [], rootsJson: roots,
  })) });
  const sources = (count: number) => db.actionCreationSource.createMany({ data: Array.from({ length: count }, (_, index) => ({
    id: `source-${String(index).padStart(6, "0")}`, workspaceId: workspace.id, actionId: action.id, sourceType: "LEGACY_LABEL", sourceId: String(index),
  })) });
  return { workspace, actor, action, selection, request, manifests, sources };
}

describe("bounded complete legacy recovery evidence", () => {
  it.each(["empty", "duplicate"] as const)("rejects 5001 %s-root manifests before preview or publication", async mode => {
    const f = await fixture();
    let roots: Prisma.InputJsonValue = [];
    if (mode === "duplicate") {
      const document = await db.document.create({ data: { workspaceId: f.workspace.id, title: "Original", source: "manual", storageKey: `workspaces/${f.workspace.id}/original.txt` } });
      await db.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspace.id,
        artifact: { kind: "Document", id: document.id }, content: document, origin: "HUMAN_ORIGINAL", inputs: [] }));
      roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "Document", id: document.id }]) as unknown as Prisma.InputJsonValue;
    }
    await f.manifests(5001, roots);
    const read = db.artifactInputLineage.findMany.bind(db.artifactInputLineage);
    const takes: number[] = [];
    vi.spyOn(db.artifactInputLineage, "findMany").mockImplementation((async args => {
      if (args?.where?.artifactId === f.action.id) takes.push(args.take!);
      return read(args);
    }) as typeof db.artifactInputLineage.findMany);
    await expect(inspectLegacyRecovery(f.actor, f.selection)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
    expect(takes).toEqual([...Array<number>(50).fill(100), 1]);
    await expect(recoverLegacyArtifact(f.actor, f.request)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
    expect(await db.conversationOperationOutcome.count()).toBe(0);
    expect(await db.artifactInputLineage.count({ where: { artifactId: f.action.id, origin: "DERIVED" } })).toBe(0);
  });

  it("rejects 5001 non-contributing Action sources rather than treating zero roots as bounded work", async () => {
    const f = await fixture();
    await f.sources(5001);
    const read = db.actionCreationSource.findMany.bind(db.actionCreationSource);
    const takes: number[] = [];
    vi.spyOn(db.actionCreationSource, "findMany").mockImplementation((async args => {
      takes.push(args!.take!);
      return read(args);
    }) as typeof db.actionCreationSource.findMany);
    await expect(inspectLegacyRecovery(f.actor, f.selection)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
    expect(takes).toEqual([...Array<number>(50).fill(100), 1]);
    await expect(recoverLegacyArtifact(f.actor, f.request)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
    expect(await db.conversationOperationOutcome.count()).toBe(0);
  });

  it("probes exhaustion and recovers exactly 5000 manifests and 5000 Action sources", async () => {
    const f = await fixture();
    await f.manifests(5000);
    await f.sources(5000);
    expect(await inspectLegacyRecovery(f.actor, f.selection)).toMatchObject({ knownContributors: 0 });
    const result = await recoverLegacyArtifact(f.actor, f.request);
    expect(result.receiptId).toEqual(expect.any(String));
    expect(await db.conversationOperationOutcome.count()).toBe(1);
    expect(await db.artifactInputLineage.count({ where: { artifactId: f.action.id } })).toBe(5001);
    expect(await db.action.findUnique({ where: { id: f.action.id } })).toEqual(f.action);
  });

  it("rejects transaction-time evidence overflow without publishing a partial recovery", async () => {
    const f = await fixture();
    await f.sources(5000);
    const client = getPrismaClient();
    const transaction = client.$transaction.bind(client);
    let inserted = false;
    vi.spyOn(client, "$transaction").mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => {
      return transaction(async tx => {
        if (options?.isolationLevel === Prisma.TransactionIsolationLevel.Serializable) {
          const read = tx.actionCreationSource.findMany.bind(tx.actionCreationSource);
          vi.spyOn(tx.actionCreationSource, "findMany").mockImplementation((async args => {
            if (!inserted) {
              inserted = true;
              await tx.actionCreationSource.create({ data: { workspaceId: f.workspace.id, actionId: f.action.id, sourceType: "LEGACY_LABEL", sourceId: "late" } });
            }
            return read(args);
          }) as typeof tx.actionCreationSource.findMany);
        }
        return work(tx);
      }, options);
    }) as unknown as typeof db.$transaction);
    await expect(recoverLegacyArtifact(f.actor, f.request)).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_LIMIT" });
    expect(inserted).toBe(true);
    expect(await db.actionCreationSource.count({ where: { actionId: f.action.id } })).toBe(5000);
    expect(await db.conversationOperationOutcome.count()).toBe(0);
    expect(await db.artifactInputLineage.count({ where: { artifactId: f.action.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "legacy-history.recovered" } })).toBe(0);
  });
});
