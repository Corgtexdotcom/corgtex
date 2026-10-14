// Child process for transfer integration tests: use real readers/consumers and
// a fresh Prisma singleton bound only to the harness's disposable database.
import assert from "node:assert/strict";
import { prisma, type AppActor } from "../../packages/shared/src";
import { captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage, type LineageRoot } from "../../packages/domain/src/source-lineage";

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/transfer_(source|target_[a-f0-9]+)$/);
  const workspaceId = process.env.TRANSFER_TEST_WORKSPACE!;
  const userId = process.env.TRANSFER_TEST_USER!;
  const actor: AppActor = { kind: "user", user: { id: userId, email: "synthetic@example.invalid", displayName: "Synthetic" } };
  if (process.argv[2] === "seed") {
    const article = await prisma.brainArticle.create({ data: { workspaceId, slug: "preserved-original", title: "Original",
      type: "PROJECT", bodyMd: "Exact synthetic historical content", sourceIds: [], authority: "REFERENCE" } });
    await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId,
      artifact: { kind: "BrainArticle", id: article.id }, content: article, origin: "HUMAN_ORIGINAL", inputs: [] }));
    const proof = await captureArtifactInputProof(actor, workspaceId, [{ kind: "BrainArticle", id: article.id }]);
    assert.equal(await isArtifactInputProofReadable(actor, workspaceId, proof), true);
    console.log(JSON.stringify({ articleId: article.id, proof }));
    return;
  }
  const original = JSON.parse(process.env.TRANSFER_TEST_PROOF!) as { articleId: string; proof: LineageRoot[] };
  // The harness explicitly activates a different synthetic reader. The original
  // author's imported membership remains inactive; none of its epochs is edited.
  await prisma.member.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { isActive: true } });
  let matched = 0;
  for (const root of original.proof) for (const entry of root.permissionEpochs?.entries ?? []) {
    const epoch = await prisma.sourcePermissionEpoch.findUnique({ where: { workspaceId_sourceKind_sourceId: { workspaceId, sourceKind: entry.kind, sourceId: entry.id } } });
    assert.equal((epoch?.epoch ?? 0n).toString(), entry.epoch, `Fresh target counter differs for ${entry.kind}`);
    matched++;
  }
  assert.ok(matched > 0, "Compare actual original proof counters with fresh trigger counters");
  assert.equal(await isArtifactInputProofReadable(actor, workspaceId, original.proof), false);
  const article = await prisma.brainArticle.findUniqueOrThrow({ where: { id: original.articleId } });
  assert.equal(article.bodyMd, "Exact synthetic historical content");
  assert.deepEqual(await readableArtifactIds(actor, workspaceId, "BrainArticle", [article]), new Set());

  const { dispatchPendingEvents, runPendingJobs } = await import("../../packages/workflows/src/outbox");
  const activeWorkspace = process.env.TRANSFER_TEST_ACTIVE_WORKSPACE!;
  // Defer unrelated active-tenant rebuild work; target import trigger events are
  // left untouched and must be excluded by the actual inactive marker predicate.
  await prisma.event.updateMany({ where: { workspaceId: activeWorkspace, type: "source-permission.changed" }, data: { availableAt: new Date("2099-01-01") } });
  const heldEvents = await prisma.event.findMany({ where: { workspaceId, status: "PENDING" }, orderBy: { id: "asc" } });
  assert.ok(heldEvents.length > 0);
  const event = await prisma.event.create({ data: { workspaceId: activeWorkspace, type: "synthetic.transfer-hold", payload: {} } });
  const heldJob = await prisma.workflowJob.create({ data: { workspaceId, type: "synthetic.transfer-hold", payload: {}, dedupeKey: "held", createdAt: new Date("2000-01-01") } });
  const activeJob = await prisma.workflowJob.create({ data: { workspaceId: activeWorkspace, type: "synthetic.transfer-hold", payload: {}, dedupeKey: "active" } });
  assert.equal(await dispatchPendingEvents("transfer-fixture", 1), 1);
  assert.equal(await runPendingJobs("transfer-fixture", 1, 5), 1);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status, "DISPATCHED");
  assert.equal((await prisma.workflowJob.findUniqueOrThrow({ where: { id: activeJob.id } })).status, "COMPLETED");
  assert.deepEqual(await prisma.event.findMany({ where: { workspaceId, status: "PENDING" }, orderBy: { id: "asc" } }), heldEvents);
  assert.deepEqual(await prisma.workflowJob.findUniqueOrThrow({ where: { id: heldJob.id } }), heldJob);
  console.log(JSON.stringify({ matchingCounters: matched, readable: false, heldEvents: heldEvents.length, heldJobAttempts: 0, activeEvents: 1, activeJobs: 1 }));
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
