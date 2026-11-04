import {AsyncResource} from "node:async_hooks";
import {WorkItemReadRelease} from "./work-item-readable-page";
import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {Prisma} from "@prisma/client";
import {prisma, getPrismaClient, type AppActor} from "@corgtex/shared";
import {truncateAllTables} from "../../shared/src/db-test-utils";
import {getProposal, listProposals} from "./proposals";
import {recordArtifactInputLineage, readableArtifactIds, invalidateArtifactInputLineage} from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Bounded proposal relations", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "fixture"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user: {id: user.id, email: user.email, displayName: null}};
  const proposal = await prisma.proposal.create({data: {workspaceId: workspace.id, authorUserId: user.id, title: "Proposal", bodyMd: "Original", isPrivate: false, status: "OPEN"}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
    artifact: {kind: "Proposal", id: proposal.id}, content: proposal, origin: "HUMAN_ORIGINAL", inputs: []}));
  return {workspaceId: workspace.id, user, member, actor, proposal};
}

it("transfers only actual latest full heads, never older valid histories or a foreign workspace head", async () => {
  const f = await fixture();
  const original = await prisma.artifactInputLineage.findFirstOrThrow({where: {workspaceId: f.workspaceId, artifactId: f.proposal.id}});
  await prisma.artifactInputLineage.createMany({data: Array.from({length: 1001}, (_, i) => ({
    workspaceId: f.workspaceId, artifactType: "Proposal", artifactId: f.proposal.id, revision: i + 2,
    origin: "UNKNOWN" as const, contentHash: original.contentHash, rootsJson: Prisma.JsonNull, inputsJson: Prisma.JsonNull,
  }))});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "Proposal", id: f.proposal.id}, content: f.proposal, origin: "HUMAN_ORIGINAL", inputs: []}));
  const raw = prisma.$queryRaw.bind(prisma);
  const transferred: Array<{artifactId: string; revision: number}> = [];
  const db = new Proxy(prisma, {get(target, property, receiver) {
    if (property === "$queryRaw") return async (...args: Parameters<typeof prisma.$queryRaw>) => {
      const rows = await raw(...args);
      if (String((args[0] as Prisma.Sql).sql).includes('SELECT DISTINCT ON ("artifactId") *')) transferred.push(...rows as Array<{artifactId: string; revision: number}>);
      return rows;
    };
    if (property === "artifactInputLineage") return new Proxy(target.artifactInputLineage, {get(delegate, method, delegateReceiver) {
      if (method === "findMany") return async (...args: Parameters<typeof prisma.artifactInputLineage.findMany>) => {
        const rows = await delegate.findMany(...args);
        transferred.push(...rows);
        return rows;
      };
      return Reflect.get(delegate, method, delegateReceiver);
    }});
    return Reflect.get(target, property, receiver);
  }});
  expect(await readableArtifactIds(f.actor, f.workspaceId, "Proposal", [f.proposal], db)).toEqual(new Set([f.proposal.id]));
  expect(transferred).toHaveLength(1);
  expect(transferred[0]).toMatchObject({artifactId: f.proposal.id, revision: 1003});
  const other = await prisma.workspace.create({data: {name: "Other", slug: randomUUID()}});
  await prisma.artifactInputLineage.create({data: {workspaceId: other.id, artifactType: "Proposal", artifactId: f.proposal.id,
    revision: 9999, origin: "UNKNOWN", contentHash: original.contentHash, rootsJson: Prisma.JsonNull, inputsJson: Prisma.JsonNull}});
  expect(await readableArtifactIds(f.actor, f.workspaceId, "Proposal", [f.proposal])).toEqual(new Set([f.proposal.id]));
  await prisma.$transaction(tx => invalidateArtifactInputLineage({tx, workspaceId: f.workspaceId, artifact: {kind: "Proposal", id: f.proposal.id}, content: f.proposal}));
  expect(await readableArtifactIds(f.actor, f.workspaceId, "Proposal", [f.proposal])).toEqual(new Set());
});

it("bounds all three list relation families beyond 5000 and rejects incomplete exact detail", async () => {
  const f = await fixture();
  const process = await prisma.adviceProcess.create({data: {workspaceId: f.workspaceId, proposalId: f.proposal.id, authorMemberId: f.member.id, subjectId: f.proposal.id}});
  const hidden = Array.from({length: 5001}, (_, i) => ({id: `a-${String(i).padStart(5, "0")}`, workspaceId: f.workspaceId,
    proposalId: f.proposal.id, authorUserId: f.user.id, title: "Unproved", bodyMd: "Unknown", isPrivate: false, status: "OPEN" as const}));
  await prisma.action.createMany({data: hidden});
  await prisma.tension.createMany({data: hidden});
  await prisma.adviceRequest.createMany({data: hidden.map(row => ({id: row.id, workspaceId: f.workspaceId, processId: process.id,
    requestedByUserId: f.user.id, audienceType: "WORKSPACE", messageMd: "Unproved", status: "ACTIVE"}))});
  const action = await prisma.action.create({data: {...hidden[0], id: "z-action", title: "Visible action"}});
  const tension = await prisma.tension.create({data: {...hidden[0], id: "z-tension", title: "Visible tension"}});
  const request = await prisma.adviceRequest.create({data: {id: "z-advice", workspaceId: f.workspaceId, processId: process.id,
    requestedByUserId: f.user.id, audienceType: "WORKSPACE", messageMd: "Visible request", status: "ACTIVE"}});
  for (const [kind, row] of [["Action", action], ["Tension", tension], ["AdviceRequest", request]] as const) {
    await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
      artifact: {kind, id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  }
  // Measure a successful serving snapshot separately from first-use epoch initialization.
  await listProposals(f.actor, f.workspaceId, {take: 1});
  const queries = [vi.spyOn(prisma.action, "findMany"), vi.spyOn(prisma.tension, "findMany"), vi.spyOn(prisma.adviceRequest, "findMany")];
  const transactionPages = {action: [] as any[], tension: [] as any[], adviceRequest: [] as any[]};
  const transaction = prisma.$transaction.bind(prisma);
  vi.spyOn(getPrismaClient(), "$transaction").mockImplementation(((operation: any, options: any) => transaction(async tx => operation(new Proxy(tx, {
    get(target, property) {
      if (property === "action" || property === "tension" || property === "adviceRequest") return new Proxy(target[property], {get(model, method) {
        if (method === "findMany") return (args: any) => {transactionPages[property].push(args); return (model.findMany as any)(args);};
        const value = Reflect.get(model, method); return typeof value === "function" ? value.bind(model) : value;
      }});
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    },
  })), options)) as typeof prisma.$transaction);
  const list = await listProposals(f.actor, f.workspaceId, {take: 1});
  expect(list.items[0]).toMatchObject({actions: [], tensions: [], adviceProcess: {requests: []},
    relationWindow: {scope: "WINDOW", complete: false, actionsComplete: false, tensionsComplete: false, adviceRequestsComplete: false}});
  await expect(getProposal(f.actor, {workspaceId: f.workspaceId, proposalId: f.proposal.id}))
    .rejects.toMatchObject({code: "SOURCE_READ_SCAN_LIMIT"});
  for (const [index, kind] of (["action", "tension", "adviceRequest"] as const).entries()) {
    const globalPages = queries[index].mock.calls.map(([args]) => args).filter(args => args?.take !== undefined);
    const snapshotPages = transactionPages[kind].filter(args => args?.take !== undefined);
    expect(globalPages).toHaveLength(1);
    expect(snapshotPages).toHaveLength(1);
    expect([...globalPages, ...snapshotPages].every(args => args?.take === 200 && !args.select && args.where?.workspaceId === f.workspaceId)).toBe(true);
  }

});

it.each([["head", "detail"], ["membership", "detail"], ["head", "list"], ["membership", "list"]] as const)("rejects a %s change after relation admission before %s release", async (change, surface) => {
  const f = await fixture();
  const action = await prisma.action.create({data: {workspaceId: f.workspaceId, proposalId: f.proposal.id,
    authorUserId: f.user.id, title: "Original action", bodyMd: "Original", isPrivate: false}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "Action", id: action.id}, content: action, origin: "HUMAN_ORIGINAL", inputs: []}));
  await getProposal(f.actor, {workspaceId: f.workspaceId, proposalId: f.proposal.id});
  await listProposals(f.actor, f.workspaceId, {take: 1});
  const writer = new AsyncResource("independent-proposal-withdrawal");
  const original = WorkItemReadRelease.prototype.admit;
  let changed = false;
  vi.spyOn(WorkItemReadRelease.prototype, "admit").mockImplementation((async function(this: WorkItemReadRelease, kind: "Action" | "Proposal" | "Tension", rows: Array<{id: string}>) {
    const admitted = await original.call(this, kind, rows);
    if (!changed && kind === "Action" && admitted.some(row => row.id === action.id)) {
      changed = true;
      await writer.runInAsyncScope(async () => {
        if (change === "head") await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
          artifact: {kind: "Action", id: action.id}, content: action, origin: "HUMAN_ORIGINAL", inputs: []}));
        else {
          await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
          await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
        }
      });
    }
    return admitted;
  }) as typeof original);
  await expect(surface === "list" ? listProposals(f.actor, f.workspaceId, {take: 1})
    : getProposal(f.actor, {workspaceId: f.workspaceId, proposalId: f.proposal.id})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);

});
