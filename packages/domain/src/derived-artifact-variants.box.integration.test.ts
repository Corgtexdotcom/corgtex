import { randomUUID } from "node:crypto";
import { isArtifactPermissionEpochProofCurrent, SOURCE_PERMISSION_POLICY_VERSION,
  withExternalProviderPermissionReadPass } from "./source-permission-epochs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, encryptSecret, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";

const provider = vi.hoisted(() => ({ transport: vi.fn(), body: { text: "The product team owns onboarding.", etag: "same-version" },
  transactionDepth: 0, callsInTransaction: 0, measureApply: false, applyOperations: 0, applySnapshotReads: 0, operations: {} as Record<string, number>, transactions: [] as Array<{ milliseconds: number; operations: number }> }));
vi.mock("./external-mcp", async importOriginal => ({ ...await importOriginal<typeof import("./external-mcp")>(),
  readBoxExternalMcpNativeResponse: provider.transport }));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  // Prisma's extension proxy exposes no method descriptors for spyOn. Wrap
  // only the interactive callback entry; every operation still uses real SQL.
  const instrumented = new Proxy(actual.prisma, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const original = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return original(...args);
      const callback = args[0];
      return original(async (tx: any) => {
        provider.transactionDepth++;
        const measured = provider.measureApply, started = performance.now(), initialOperations = provider.applyOperations;
        const delegates = new Map<PropertyKey, unknown>();
        const observed = !provider.measureApply ? tx : new Proxy(tx, { get(client, name) {
          const value = Reflect.get(client, name, client);
          const count = (receiver: any, method: any, operation: PropertyKey) => (...params: any[]) => {
            provider.applyOperations++;
            const sqlParts = params[0]?.strings ?? (Array.isArray(params[0]) ? params[0] : []);
            const label = name === "$queryRaw" ? `$queryRaw:${sqlParts.join(" ").includes("SourcePermissionEpoch") ? "SourcePermissionEpoch" : "other"}` : `${String(name)}.${String(operation)}`;
            provider.operations[label] = (provider.operations[label] ?? 0) + 1;
            if (name === "artifactInputSnapshot" && operation === "findFirst") provider.applySnapshotReads++;
            return Reflect.apply(method, receiver, params);
          };
          if (typeof value === "function") return count(client, value, name);
          if (!value || typeof value !== "object") return value;
          if (!delegates.has(name)) delegates.set(name, new Proxy(value, { get(model, operation) {
            const method = Reflect.get(model, operation, model);
            return typeof method === "function" ? count(model, method, operation) : method;
          } }));
          return delegates.get(name);
        } });
        try { return await callback(observed); } finally {
          if (measured) provider.transactions.push({ milliseconds: performance.now() - started, operations: provider.applyOperations - initialOperations });
          provider.transactionDepth--;
        }
      }, ...args.slice(1));
    };
  } });
  return { ...actual, prisma: instrumented };
});

import { selectExternalContentSource } from "./external-content-sources";
import { captureExternalProviderFetchInput, prepareExternalProviderCommitPreflight,
  prepareExternalProviderRootCommitPreflight, withExternalProviderCommitPreflight } from "./external-provider-authority";
import { captureArtifactInputProof, readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
import { requestGraphSourceVariant, generateGraphSourceVariant, getReadableGraphSourceVariants,
  revalidateGraphSourceVariants, type GraphVariantCandidate } from "./derived-artifact-variants";
import type { PermittedDerivationSource } from "./permitted-derivation-inputs";
import { reviewContextGraphProposedDiff, applyContextGraphProposedDiff } from "./context-graph";

// Only the external transport is synthetic. Every row, native constructor,
// permission transition trigger, manifest, snapshot and commit scope is real.
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic Box variants", slug: `box-variants-${randomUUID()}` } });
  const foreign = await prisma.workspace.create({ data: { name: "Synthetic foreign Box workspace", slug: `box-foreign-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { email: `box-owner-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `box-other-${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const otherMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "ADMIN" } });
  await prisma.member.create({ data: { workspaceId: foreign.id, userId: owner.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: null, globalRole: "USER" } };
  const otherActor: AppActor = { kind: "user", user: { id: other.id, email: other.email, displayName: null, globalRole: "USER" } };
  const connection = await prisma.externalMcpConnection.create({ data: { workspaceId: workspace.id, userId: owner.id,
    providerKey: "box", displayName: "Synthetic Box principal", serverUrl: "https://mcp.box.com", providerAccountId: "synthetic-box-owner",
    accessTokenEnc: encryptSecret("synthetic-only-token"), scopes: ["root_readwrite"] } });
  const selection = await selectExternalContentSource(actor, { workspaceId: workspace.id, providerKey: "box", sourceKind: "FILE",
    externalId: "synthetic-file", connectionId: connection.id, title: "Explicit synthetic file selection" });
  const receipt = await captureExternalProviderFetchInput(actor, { workspaceId: workspace.id, externalContentSourceId: selection.id,
    connectionId: connection.id, sourceKind: "FILE", externalId: "synthetic-file", toolName: "get_file_content", arguments: { file_id: "synthetic-file" } });
  const nativeRoots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "ExternalProviderFetchInput", id: receipt.input.id }]);
  const sourceCap = await prepareExternalProviderCommitPreflight(actor, workspace.id, { roots: nativeRoots, receipts: [receipt] });
  const source = await prisma.$transaction(tx => withExternalProviderCommitPreflight(actor, workspace.id, tx, sourceCap, async () => {
    const row = await tx.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "EXTERNAL_CONTENT", tier: 2,
      title: "Known native Box source", content: (receipt.payload as { text: string }).text, channel: "box", metadata: { externalContentSourceId: selection.id } } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "BrainSource", id: row.id },
      content: row, origin: "DERIVED", inputs: [], inheritedRoots: nativeRoots });
    return row;
  }));
  const article = await prisma.brainArticle.create({ data: { workspaceId: workspace.id, slug: "private-original", type: "STRATEGY", authority: "DRAFT",
    title: "PRIVATE OLD INPUT TITLE", bodyMd: "PRIVATE OLD INPUT BODY", isPrivate: true, ownerMemberId: ownerMember.id } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const roots = await captureArtifactInputProof(actor, workspace.id, [{ kind: "BrainSource", id: source.id }, { kind: "BrainArticle", id: article.id }]);
  const targetCap = await prepareExternalProviderRootCommitPreflight(actor, workspace.id, roots);
  const targets = await prisma.$transaction(tx => withExternalProviderCommitPreflight(actor, workspace.id, tx, targetCap, async () => {
    const output = [];
    for (const label of ["A", "B"]) {
      const row = await tx.contextGraphObject.create({ data: { workspaceId: workspace.id, objectType: "Team", status: "approved",
        title: `PRIVATE OLD TARGET ${label}`, summary: "PRIVATE OLD TARGET SUMMARY", properties: { hidden: "PRIVATE OLD TARGET PROPERTY" },
        createdByType: "agent", createdByUserId: owner.id } });
      await recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id, artifact: { kind: "ContextGraphObject", id: row.id },
        content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots });
      output.push(row);
    }
    return output;
  }));
  // Real policy trigger revokes the old proof. Preserve the original semantic
  // body and historical receipts; the new owner revision remains unproven.
  await prisma.brainArticle.update({ where: { id: article.id }, data: { ownerMemberId: otherMember.id } });
  const request = { workspaceId: workspace.id, target: { kind: "ContextGraphObject" as const, id: targets[0].id },
    scope: { kind: "default" as const, mapKey: "critical-path" as const } };
  return { workspace, foreign, actor, otherActor, connection, source, receipt, targets, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function claim(f: Fixture) {
  const result = await requestGraphSourceVariant(f.actor, f.request);
  if (result.status !== "QUEUED") throw new Error(`Expected queued variant: ${JSON.stringify(result)}`);
  await prisma.workflowJob.update({ where: { id: result.jobId }, data: { status: "RUNNING", attempts: 1,
    lockedBy: "synthetic-box-worker", lockedAt: new Date(), startedAt: new Date() } });
  return { workspaceId: f.workspace.id, jobId: result.jobId, expectedAttempt: 1, expectedOwner: "synthetic-box-worker" };
}
function candidate(f: Fixture, sources: PermittedDerivationSource[]): GraphVariantCandidate {
  expect(sources.map(source => [source.kind, source.id])).toEqual([["BrainSource", f.source.id]]);
  expect(JSON.stringify(sources)).not.toContain("PRIVATE");
  expect(provider.transactionDepth).toBe(0);
  return { objects: [{ ref: "team", objectType: "Team", title: "Product team" }, { ref: "process", objectType: "Process", title: "Onboarding" }],
    relationships: [{ ref: "owns", sourceRef: "team", targetRef: "process", relationshipType: "owns" }],
    evidenceRefs: [{ relationshipRef: "owns", sourceKind: "BrainSource", sourceId: f.source.id, quote: "product team owns onboarding" }] };
}

describe("Box phase authority in real disposable database transactions", () => {
  beforeEach(async () => {
    await truncateAllTables();
    provider.transactionDepth = 0; provider.callsInTransaction = 0;
    provider.measureApply = false; provider.applyOperations = 0; provider.applySnapshotReads = 0; provider.operations = {}; provider.transactions = [];
    provider.body = { text: "The product team owns onboarding.", etag: "same-version" };
    provider.transport.mockClear().mockImplementation(async () => {
      if (provider.transactionDepth) { provider.callsInTransaction++; throw new Error("Provider inside interactive transaction"); }
      return structuredClone(provider.body);
    });
  });
  it("rebuilds a whole permitted Box bundle from unreadable old graph ancestry with no provider transport inside any interactive transaction", async () => {
    const f = await fixture();
    expect(await readableArtifactIds(f.actor, f.workspace.id, "ContextGraphObject", f.targets)).toEqual(new Set());
    const lease = await claim(f);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => candidate(f, sources) });
    expect(result.phase).toBe("APPLIED");
    const rows = await getReadableGraphSourceVariants(f.actor, { workspaceId: f.workspace.id, scope: f.request.scope });
    expect(rows).toHaveLength(1); expect(rows[0].targets.map(target => target.id).sort()).toEqual(f.targets.map(target => target.id).sort());
    expect(rows[0].bundle.relationships[0].targetObjectId).toBe(rows[0].bundle.objects[1].id);
    expect(rows[0].bundle.evidenceRefs[0].relationshipId).toBe(rows[0].bundle.relationships[0].id);
    expect(rows[0].bundle.proposedDiff.status).toBe("pending"); expect(JSON.stringify(rows[0].bundle)).not.toContain("PRIVATE");
    expect(await revalidateGraphSourceVariants(f.actor, { workspaceId: f.workspace.id, variantIds: [rows[0].id] })).toBe(true);
    expect(await getReadableGraphSourceVariants(f.otherActor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    expect(await getReadableGraphSourceVariants(f.actor, { workspaceId: f.foreign.id, scope: f.request.scope })).toEqual([]);
    expect(await prisma.contextGraphObject.findMany({ where: { workspaceId: f.workspace.id }, orderBy: { id: "asc" } }))
      .toEqual([...f.targets].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await prisma.externalProviderFetchInput.count()).toBe(1);
    expect(provider.transport).toHaveBeenCalled(); expect(provider.callsInTransaction).toBe(0);
  });
  it("reviews and applies a native provider variant with all replay outside SQL", async () => {
    const f = await fixture(); const lease = await claim(f);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => candidate(f, sources) });
    if (result.phase !== "APPLIED") throw new Error("Expected generated variant");
    const variant = await prisma.genericDerivedArtifactVariant.findUniqueOrThrow({ where: { id: result.variantId } });
    const id = (variant.payloadJson as any).proposedDiff.id;
    await reviewContextGraphProposedDiff(f.actor, { workspaceId: f.workspace.id, proposedDiffId: id, status: "approved" });
    provider.measureApply = true;
    try {
      expect(await applyContextGraphProposedDiff(f.actor, { workspaceId: f.workspace.id, proposedDiffId: id })).toMatchObject({ status: "applied" });
    } finally {
      provider.measureApply = false;
      process.stderr.write(`BOX_TRANSACTION_METRICS ${JSON.stringify({ transactions: provider.transactions, operations: provider.operations })}\n`);
    }
    // This two-object native proposal previously issued 6,573 transaction
    // operations / 2,516 snapshot reads and repeatedly exceeded the default 5s.
    // Count work rather than relaxing the timeout or asserting host timing.
    // The later native commit still issued 1,254 epoch queries / 5,575 total
    // after snapshot deduplication. Locked pass observations remove that repeat.
    expect(provider.operations["$queryRaw:SourcePermissionEpoch"]).toBeLessThan(900);
    expect(provider.applyOperations).toBeLessThan(5_500);
    expect(provider.applySnapshotReads).toBeLessThan(1_500);
    expect(provider.callsInTransaction).toBe(0);
    const objects = await prisma.contextGraphObject.findMany({ where: { workspaceId: f.workspace.id, id: { notIn: f.targets.map(row => row.id) } } });
    expect(objects).toHaveLength(2);
    expect((await readableArtifactIds(f.actor, f.workspace.id, "ContextGraphObject", objects)).size).toBe(2);
    provider.body.text = "Changed after publication";
    expect((await readableArtifactIds(f.actor, f.workspace.id, "ContextGraphObject", objects)).size).toBe(0);
  });
  it.each(["update", "delete"])("rejects a same-TX epoch %s after a real locked observation and reuse", async mutation => {
    const f = await fixture();
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ExternalProviderFetchInput", id: f.receipt.input.id }]);
    const cap = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, roots);
    const control = randomUUID();
    await prisma.$executeRaw`INSERT INTO "SourcePermissionEpoch" ("id", "workspaceId", "sourceKind", "sourceId", "epoch")
      VALUES (${randomUUID()}, ${f.workspace.id}, 'Action', ${control}, 0)`;
    const proof = { version: 1 as const, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: "Action", id: control, epoch: "0" }] };
    provider.measureApply = true;
    try {
      await prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id, tx, cap, async () => {
        const result = await withExternalProviderPermissionReadPass(f.actor, tx, f.workspace.id, "local", async () => {
          const before = provider.operations["$queryRaw:SourcePermissionEpoch"] ?? 0;
          expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, proof, tx)).toBe(true);
          expect(provider.operations["$queryRaw:SourcePermissionEpoch"]).toBe(before + 1);
          if (mutation === "update") await tx.$executeRaw`UPDATE "SourcePermissionEpoch" SET "epoch" = 1
            WHERE "workspaceId" = ${f.workspace.id} AND "sourceKind" = 'Action' AND "sourceId" = ${control}`;
          else await tx.$executeRaw`DELETE FROM "SourcePermissionEpoch"
            WHERE "workspaceId" = ${f.workspace.id} AND "sourceKind" = 'Action' AND "sourceId" = ${control}`;
          expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, proof, tx)).toBe(true);
          expect(provider.operations["$queryRaw:SourcePermissionEpoch"]).toBe(before + 1); // Actual hit, no SQL.
          return true;
        });
        expect(result).toBe(false); // Fresh final comparison observes own writes.
      }));
    } finally { provider.measureApply = false; }
    expect(provider.callsInTransaction).toBe(0);
  });

  it("holds the first epoch observation against a concurrent writer until the real commit ends", async () => {
    const f = await fixture();
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "ExternalProviderFetchInput", id: f.receipt.input.id }]);
    const cap = await prepareExternalProviderRootCommitPreflight(f.actor, f.workspace.id, roots);
    const control = randomUUID();
    await prisma.$executeRaw`INSERT INTO "SourcePermissionEpoch" ("id", "workspaceId", "sourceKind", "sourceId", "epoch")
      VALUES (${randomUUID()}, ${f.workspace.id}, 'Action', ${control}, 0)`;
    const proof = { version: 1 as const, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
      entries: [{ kind: "Action", id: control, epoch: "0" }] };
    let writer: Promise<unknown> | undefined;
    let writerFinished = false;
    try {
      await prisma.$transaction(tx => withExternalProviderCommitPreflight(f.actor, f.workspace.id, tx, cap, async () => {
        expect(await withExternalProviderPermissionReadPass(f.actor, tx, f.workspace.id, "local", async () => {
          expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, proof, tx)).toBe(true);
          const [{ pid: readerPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          let started!: (pid: number) => void;
          const ready = new Promise<number>(resolve => { started = resolve; });
          writer = prisma.$transaction(async other => {
            const [{ pid }] = await other.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            started(pid);
            await other.$executeRaw`UPDATE "SourcePermissionEpoch" SET "epoch" = 1
              WHERE "workspaceId" = ${f.workspace.id} AND "sourceKind" = 'Action' AND "sourceId" = ${control}`;
            writerFinished = true;
          });
          const writerPid = await ready;
          let blocked = false;
          for (let i = 0; i < 100 && !blocked; i++) {
            const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${readerPid} = ANY(pg_blocking_pids(${writerPid}::integer)) AS blocked`;
            blocked = row.blocked;
            if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          expect(writerFinished).toBe(false);
          return isArtifactPermissionEpochProofCurrent(f.workspace.id, proof, tx);
        })).toBe(true);
        expect(writerFinished).toBe(false);
      }));
    } finally { await writer; }
    expect(writerFinished).toBe(true);
    expect(await isArtifactPermissionEpochProofCurrent(f.workspace.id, proof)).toBe(false);
  });

  it("rejects changed real provider bytes after model with no partial bundle despite an unchanged provider version label", async () => {
    const f = await fixture(); const lease = await claim(f);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => {
      const value = candidate(f, sources); provider.body.text = "Changed native provider bytes"; return value;
    } });
    expect(result.phase).toBe("STALE"); expect(await prisma.genericDerivedArtifactVariant.count()).toBe(0);
    expect(provider.body.etag).toBe("same-version"); expect(provider.callsInTransaction).toBe(0);
  });
  it("real grant revocation and restoration cannot redeem old byte-identical bundles", async () => {
    const f = await fixture(); const lease = await claim(f);
    const result = await generateGraphSourceVariant({ ...lease, generate: async sources => candidate(f, sources) });
    if (result.phase !== "APPLIED") throw new Error("Expected proven variant");
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { scopes: [] } });
    await prisma.externalMcpConnection.update({ where: { id: f.connection.id }, data: { scopes: ["root_readwrite"] } });
    expect(await revalidateGraphSourceVariants(f.actor, { workspaceId: f.workspace.id, variantIds: [result.variantId] })).toBe(false);
    expect(await getReadableGraphSourceVariants(f.actor, { workspaceId: f.workspace.id, scope: f.request.scope })).toEqual([]);
    expect(await prisma.genericDerivedArtifactVariant.findUnique({ where: { id: result.variantId } })).not.toBeNull();
    expect(provider.callsInTransaction).toBe(0);
  });
});
