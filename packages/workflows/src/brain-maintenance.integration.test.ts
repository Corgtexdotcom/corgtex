import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { readableArtifactIds, recordArtifactInputLineage } from "@corgtex/domain";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { runPendingJobs } from "./outbox";
import { prepareMaintenanceClaim } from "./brain-maintenance-jobs";

beforeEach(truncateAllTables);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const workspace = await prisma.workspace.create({data: {slug: randomUUID(), name: "Synthetic maintenance", plan: "PAYG_AI"}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const article = async (slug: string, bodyMd = "Genuine authored source", extra: {id?: string; title?: string; isPrivate?: boolean; frontmatterJson?: {also: string[]}} = {}) => prisma.$transaction(async tx => {
    const row = await tx.brainArticle.create({data: {workspaceId: workspace.id, slug, title: slug, type: "PROCESS", bodyMd, sourceIds: [],
      ownerMemberId: extra.isPrivate ? member.id : null, ...extra}});
    await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "BrainArticle", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
    return row;
  });
  const job = () => prisma.workflowJob.create({data: {workspaceId: workspace.id, type: "agent.brain-maintenance", payload: {}, dedupeKey: randomUUID()}});
  return {workspace, actor, member, article, job};
}

it("atomically publishes a proved batch and its exact continuation through the real dispatcher", async () => {
  const f = await fixture();
  const target = await f.article("foo");
  const shadow = await f.article("old-alias", "Original alias", {frontmatterJson: {also: ["foo"]}});
  const hidden = await f.article("hidden", "Private original", {isPrivate: true});
  const source = await f.article("source", "Read [[foo]] and [[hidden]]");
  await prisma.brainBacklink.createMany({data: [{workspaceId: f.workspace.id, fromArticleId: source.id, toArticleId: shadow.id},
    {workspaceId: f.workspace.id, fromArticleId: source.id, toArticleId: hidden.id}]});
  const first = await f.job();
  expect(await runPendingJobs("maintenance-worker", 1, 1)).toBe(1);
  const completed = await prisma.workflowJob.findUniqueOrThrow({where: {id: first.id}});
  expect(completed.status, completed.error ?? "").toBe("COMPLETED");
  const run = await prisma.agentRun.findFirstOrThrow({where: {triggerRef: first.id}});
  expect(run.status).toBe("COMPLETED");
  expect(run.resultJson).toMatchObject({scope: "BATCH", phase: "LINKS"});
  expect(JSON.stringify(run.resultJson)).not.toContain("selectedIds");
  expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [run])).toEqual(new Set([run.id]));
  const child = await prisma.workflowJob.findFirstOrThrow({where: {dependsOnJobId: first.id}});
  expect(child.payload).toHaveProperty("maintenance.request.cohortId", first.id);
  // Lost completion acknowledgement: a fresh real claim verifies the already
  // atomic child instead of running the batch or creating a second child.
  await prisma.workflowJob.update({where: {id: first.id}, data: {status: "PENDING", runAfter: new Date()}});
  expect(await runPendingJobs("maintenance-retry", 1, 1)).toBe(1);
  expect(await prisma.workflowJob.count({where: {dependsOnJobId: first.id}})).toBe(1);
  expect(await prisma.agentRun.count({where: {triggerRef: first.id}})).toBe(1);
  for (let index = 0; index < 20 && await runPendingJobs("continuation-worker", 1, 1); index++) {
    const failed = await prisma.workflowJob.findFirst({where: {workspaceId: f.workspace.id, error: {not: null}}});
    expect(failed, failed?.error ?? "").toBeNull();
  }
  const edges = await prisma.brainBacklink.findMany({where: {fromArticleId: source.id}});
  expect(edges.map(row => row.toArticleId).sort()).toEqual([target.id, hidden.id].sort());
}, 120_000);

it.each(["disabled", "budget", "hourly", "daily", "concurrency", "kill"])("defers %s maintenance without completing or consuming a failure attempt", async mode => {
  const f = await fixture();
  if (mode === "disabled") await prisma.workspaceAgentConfig.create({data: {workspaceId: f.workspace.id, agentKey: "brain-maintenance", enabled: false}});
  if (mode === "budget") await prisma.workspace.update({where: {id: f.workspace.id}, data: {plan: "CORE_FREE"}});
  if (mode === "kill") vi.stubEnv("AGENT_KILL_SWITCH", "true");
  if (mode === "hourly" || mode === "daily") await prisma.agentIdentity.create({data: {workspaceId: f.workspace.id, agentKey: "brain-maintenance", displayName: "Bounded maintenance",
    ...(mode === "hourly" ? {maxRunsPerHour: 0} : {maxRunsPerDay: 0})}});
  if (mode === "concurrency") await prisma.agentRun.createMany({data: Array.from({length: 4}, () => ({workspaceId: f.workspace.id, agentKey: "brain-maintenance",
    triggerType: "SCHEDULE" as const, status: "RUNNING" as const, goal: "Synthetic occupied worker slot"}))});
  const first = await f.job();
  expect(await runPendingJobs("maintenance-worker", 1, 1)).toBe(1);
  const row = await prisma.workflowJob.findUniqueOrThrow({where: {id: first.id}});
  expect(row).toMatchObject({status: "PENDING", attempts: 0, lockedAt: null, lockedBy: null});
  expect(row.runAfter.getTime()).toBeGreaterThan(Date.now());
  expect(await prisma.workflowJob.count({where: {dependsOnJobId: first.id}})).toBe(0);
  expect(await prisma.agentRun.count({where: {workspaceId: f.workspace.id}})).toBe(mode === "concurrency" ? 4 : 0);
});

it("rejects replacement claims and rolls back child publication with its enclosing transaction", async () => {
  const f = await fixture(); await f.article("one");
  const first = await f.job();
  const claimed = await prisma.workflowJob.update({where: {id: first.id}, data: {status: "RUNNING", attempts: 1, lockedBy: "owner", lockedAt: new Date()}});
  const claim = await prepareMaintenanceClaim({...claimed, lockedAt: claimed.lockedAt!}, "owner");
  await expect(prisma.$transaction(async tx => {
    await claim.finish(tx, {...claim.state, index: claim.state.selectedIds.length});
    throw new Error("synthetic final receipt failure");
  })).rejects.toThrow("synthetic final receipt failure");
  expect(await prisma.workflowJob.count({where: {dependsOnJobId: first.id}})).toBe(0);
  expect((await prisma.workflowJob.findUniqueOrThrow({where: {id: first.id}})).payload).not.toHaveProperty("maintenance.completion");
  await prisma.workflowJob.update({where: {id: first.id}, data: {lockedBy: "replacement", attempts: 2, lockedAt: new Date()}});
  await expect(prisma.$transaction(tx => claim.assertCurrent(tx))).rejects.toMatchObject({code: "MAINTENANCE_JOB_LOST"});
});

it("processes more than 5000 genuine originals as independently proved bounded runtime batches", async () => {
  const f = await fixture();
  const age = new Date(Date.now() - 181 * 86400000);
  const started = Date.now();
  // One synthetic cohort, genuine human originals. No inherited-root shortcut,
  // model call, elevated budget, or transaction timeout override.
  for (let page = 0; page < 5001; page += 25) {
    for (let index = page; index < Math.min(page + 25, 5001); index++) {
      await prisma.$transaction(async tx => {
        const row = await tx.brainSource.create({data: {workspaceId: f.workspace.id, sourceType: "DOC", tier: 3,
          content: `Genuine authored synthetic source ${index}`, createdAt: age}});
        await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "BrainSource", id: row.id},
          content: row, origin: "HUMAN_ORIGINAL", inputs: []});
      });
    }
  }
  console.info("Maintenance genuine originals admitted", {count: 5001, elapsedMs: Date.now() - started});
  await f.job();
  let jobs = 0;
  while (await runPendingJobs("cohort-worker", 1, 1)) {
    jobs++;
    const bad = await prisma.workflowJob.findFirst({where: {workspaceId: f.workspace.id, type: "agent.brain-maintenance", status: {in: ["FAILED", "PENDING"]}, error: {not: null}}});
    expect(bad, bad?.error ?? "").toBeNull();
    if (jobs % 25 === 0) console.info("Maintenance durable batches", {jobs, elapsedMs: Date.now() - started});
    expect(jobs).toBeLessThan(210);
  }
  expect(jobs).toBe(205); // Empty LINKS/ORPHANS/DISCUSSIONS/RETENTION +201 source pages.
  const runs = await prisma.agentRun.findMany({where: {workspaceId: f.workspace.id}, orderBy: {createdAt: "asc"}});
  expect(runs.every(row => row.status === "COMPLETED")).toBe(true);
  const batches = runs.filter(row => (row.resultJson as Record<string, unknown>)?.phase === "SOURCES");
  expect(batches).toHaveLength(201);
  let admitted = 0;
  for (const run of batches) {
    const report = run.resultJson as {scope: string; tier3CleanupCandidates: number};
    expect(report.scope).toBe("BATCH");
    expect(report.tier3CleanupCandidates).toBeGreaterThan(0);
    expect(report.tier3CleanupCandidates).toBeLessThanOrEqual(25);
    expect(JSON.stringify(run.resultJson)).not.toMatch(/selectedIds|cohortId|upperId|afterId/);
    admitted += report.tier3CleanupCandidates;
  }
  // Aggregate only in this private test assertion, never in a published receipt.
  expect(admitted).toBe(5001);
  for (const run of [batches[0], batches.at(-1)!]) {
    expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [run])).toEqual(new Set([run.id]));
    const lineage = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspace.id, artifactType: "AgentRun", artifactId: run.id}, orderBy: {revision: "desc"}});
    expect(lineage.origin).toBe("DERIVED");
  }
  expect(await prisma.brainSource.count({where: {workspaceId: f.workspace.id}})).toBe(5001);
  console.info("Maintenance cohort complete", {jobs, admitted, elapsedMs: Date.now() - started});
}, 600_000);

it("rolls back proved backlink mutation and continuation when final runtime publication fails", async () => {
  const f = await fixture(); const target = await f.article("target"); const source = await f.article("source", "[[target]]");
  const first = await f.job();
  await prisma.$executeRawUnsafe(`CREATE FUNCTION maintenance_fixture_fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type = 'agent.run.completed' THEN RAISE EXCEPTION 'synthetic completion rollback'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER maintenance_fixture_fail_completion BEFORE INSERT ON "Event" FOR EACH ROW EXECUTE FUNCTION maintenance_fixture_fail_completion()`);
  try {
    expect(await runPendingJobs("rollback-worker", 1, 1)).toBe(1);
    const job = await prisma.workflowJob.findUniqueOrThrow({where: {id: first.id}});
    expect(job.status).toBe("PENDING");
    expect(await prisma.brainBacklink.count({where: {fromArticleId: source.id, toArticleId: target.id}})).toBe(0);
    expect(await prisma.workflowJob.count({where: {dependsOnJobId: first.id}})).toBe(0);
    expect(await prisma.agentRun.count({where: {triggerRef: first.id, status: "COMPLETED"}})).toBe(0);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER maintenance_fixture_fail_completion ON "Event"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION maintenance_fixture_fail_completion()`);
  }
  await prisma.workflowJob.update({where: {id: first.id}, data: {runAfter: new Date()}});
  expect(await runPendingJobs("retry-worker", 1, 1)).toBe(1);
  expect((await prisma.workflowJob.findUniqueOrThrow({where: {id: first.id}})).status).toBe("COMPLETED");
  expect(await prisma.brainBacklink.count({where: {fromArticleId: source.id, toArticleId: target.id}})).toBe(1);
});

it("rejects replacement ownership before actual runtime mutations", async () => {
  const f = await fixture(); const target = await f.article("target"); const source = await f.article("source", "[[target]]");
  const first = await f.job();
  const actual = prisma.brainArticle.findFirst.bind(prisma.brainArticle);
  let replaced = false;
  vi.spyOn(prisma.brainArticle, "findFirst").mockImplementation((async args => {
    const row = await actual(args);
    if (!replaced && row && "id" in row && row.id === source.id) {
      replaced = true;
      await prisma.workflowJob.update({where: {id: first.id}, data: {lockedBy: "new-owner", attempts: 2, lockedAt: new Date(), error: "replacement-marker"}});
    }
    return row;
  }) as typeof prisma.brainArticle.findFirst);
  expect(await runPendingJobs("old-owner", 1, 1)).toBe(1);
  expect(replaced).toBe(true);
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: first.id}})).toMatchObject({status: "RUNNING", lockedBy: "new-owner", attempts: 2, error: "replacement-marker"});
  expect(await prisma.brainBacklink.count({where: {fromArticleId: source.id, toArticleId: target.id}})).toBe(0);
  expect(await prisma.workflowJob.count({where: {dependsOnJobId: first.id}})).toBe(0);
});


it("binds same-body original heads and denies a continued source after revoke and restore", async () => {
  const {runBrainMaintenance} = await import("../../agents/src/brain-maintenance");
  const f = await fixture(); const source = await f.article("source", Array.from({length: 26}, () => "[[unresolved]]").join(" "));
  const actor: AppActor = {kind: "agent", authProvider: "bootstrap", label: "brain-maintenance", workspaceIds: [f.workspace.id]};
  const state = {version: 1 as const, cohortId: "synthetic-cohort", admittedAt: new Date().toISOString(), phase: "LINKS" as const,
    upperId: source.id, afterId: null, selectedIds: [source.id], pageLastId: source.id, pageComplete: true, index: 0};
  const prepared = await runBrainMaintenance({workspaceId: f.workspace.id, actor, state});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id,
    artifact: {kind: "BrainArticle", id: source.id}, content: source, origin: "HUMAN_ORIGINAL", inputs: []}));
  await expect(prepared.assertCurrent()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  await expect(prisma.$transaction(tx => prepared.apply(tx))).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  const current = await runBrainMaintenance({workspaceId: f.workspace.id, actor, state});
  await prisma.brainArticle.update({where: {id: source.id}, data: {isPrivate: true, ownerMemberId: f.member.id}});
  await prisma.brainArticle.update({where: {id: source.id}, data: {isPrivate: false, ownerMemberId: null}});
  await expect(runBrainMaintenance({workspaceId: f.workspace.id, actor, state: current.next})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
});

it("absorbs a real resolved thread with a readable final run and honestly retains unsupported old events", async () => {
  const f = await fixture(); const article = await f.article("thread-source");
  const thread = await prisma.$transaction(async tx => {
    const row = await tx.brainDiscussionThread.create({data: {articleId: article.id, authorMemberId: f.member.id, targetType: "ARTICLE", status: "RESOLVED"}});
    await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "BrainDiscussionThread", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
    return row;
  });
  const event = await prisma.knowledgeChunk.create({data: {workspaceId: f.workspace.id, sourceType: "EVENT", sourceId: randomUUID(),
    content: "Preserved unsupported original event bytes", createdAt: new Date(Date.now() - 20 * 86400000)}});
  await f.job();
  for (let index = 0; index < 8 && await runPendingJobs("thread-worker", 1, 1); index++) {
    const failed = await prisma.workflowJob.findFirst({where: {workspaceId: f.workspace.id, error: {not: null}}});
    expect(failed, failed?.error ?? "").toBeNull();
  }
  expect((await prisma.brainDiscussionThread.findUniqueOrThrow({where: {id: thread.id}})).status).toBe("ABSORBED");
  const runs = await prisma.agentRun.findMany({where: {workspaceId: f.workspace.id}});
  const discussion = runs.find(row => (row.resultJson as Record<string, unknown>)?.phase === "DISCUSSIONS")!;
  expect(discussion.resultJson).toMatchObject({scope: "BATCH", absorbedThreadCount: 1});
  expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [discussion])).toEqual(new Set([discussion.id]));
  const retention = runs.find(row => (row.resultJson as Record<string, unknown>)?.phase === "RETENTION")!;
  expect(retention.resultJson).toMatchObject({phase: "RETENTION", status: "RETAINED_UNSUPPORTED_CUSTODY"});
  expect(JSON.stringify(retention.resultJson)).not.toMatch(/prunedEventsCount|Preserved unsupported|sourceId/);
  expect(await prisma.knowledgeChunk.findUniqueOrThrow({where: {id: event.id}})).toEqual(event);
});

it("replenishes more than100 denied incoming and title candidates and finishes26-reference cleanup", async () => {
  const {runBrainMaintenance} = await import("../../agents/src/brain-maintenance");
  const f = await fixture(); const canonical = await f.article("foo");
  const shadow = await f.article("shadow", "Original shadow", {frontmatterJson: {also: ["foo"]}});
  const source = await f.article("source", Array.from({length: 26}, () => "[[foo]]").join(" ") + " [[Shared title]]");
  await prisma.brainBacklink.create({data: {workspaceId: f.workspace.id, fromArticleId: source.id, toArticleId: shadow.id}});
  const orphan = await f.article("orphan");
  for (let index = 0; index < 101; index++) {
    const hidden = await f.article(`hidden-${index}`, "[[orphan]]", {isPrivate: true, title: "Shared title", id: `candidate-${String(index).padStart(3, "0")}`});
    await prisma.brainBacklink.create({data: {workspaceId: f.workspace.id, fromArticleId: hidden.id, toArticleId: orphan.id}});
  }
  const late = await f.article("late-title", "Current admitted title", {id: "zz-candidate", title: "Shared title"});
  const actor: AppActor = {kind: "agent", authProvider: "bootstrap", label: "brain-maintenance", workspaceIds: [f.workspace.id]};
  const observe = async (phase: "LINKS" | "ORPHANS", id: string) => {
    let state: import("../../agents/src/brain-maintenance-state").MaintenanceState = {version: 1, cohortId: "fixture", admittedAt: new Date().toISOString(), phase,
      upperId: id, afterId: null, selectedIds: [id], pageLastId: id, pageComplete: true, index: 0};
    const reports = [];
    for (let attempt = 0; state.index < 1 && attempt < 100; attempt++) {
      const prepared = await runBrainMaintenance({workspaceId: f.workspace.id, actor, state});
      await prepared.assertCurrent(); await prisma.$transaction(tx => prepared.apply(tx));
      state = prepared.next; reports.push(prepared.report);
    }
    expect(state.index).toBe(1); return reports;
  };
  await observe("LINKS", source.id);
  expect((await prisma.brainBacklink.findMany({where: {fromArticleId: source.id}})).map(row => row.toArticleId).sort()).toEqual([canonical.id, late.id].sort());
  const reports = await observe("ORPHANS", orphan.id);
  expect(reports.length).toBeGreaterThan(12);
  expect(reports.reduce((sum, report) => sum + (report.orphanCount ?? 0), 0)).toBe(1);
});


it("publishes a full25-source page with original heads through the final dispatcher and serving path", async () => {
  const f = await fixture();
  for (let index = 0; index < 25; index++) await prisma.$transaction(async tx => {
    const row = await tx.brainSource.create({data: {workspaceId: f.workspace.id, sourceType: "DOC", tier: 3,
      content: `Final bounded source ${index}`, createdAt: new Date(Date.now() - 181 * 86400000)}});
    await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "BrainSource", id: row.id}, content: row,
      origin: "HUMAN_ORIGINAL", inputs: []});
  });
  await f.job();
  for (let index = 0; index < 3; index++) expect(await runPendingJobs("final-page-worker", 1, 1)).toBe(1);
  const runs = await prisma.agentRun.findMany({where: {workspaceId: f.workspace.id}});
  const run = runs.find(row => (row.resultJson as Record<string, unknown>)?.phase === "SOURCES")!;
  expect(run?.status).toBe("COMPLETED");
  expect(run.resultJson).toMatchObject({scope: "BATCH", phase: "SOURCES", tier3CleanupCandidates: 25});
  expect(await readableArtifactIds(f.actor, f.workspace.id, "AgentRun", [run])).toEqual(new Set([run.id]));
  expect(await prisma.workflowJob.count({where: {workspaceId: f.workspace.id, status: "COMPLETED"}})).toBe(3);
  expect(await prisma.brainSource.count({where: {workspaceId: f.workspace.id}})).toBe(25);
});
