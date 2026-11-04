import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listActions } from "./actions";
import { recordArtifactInputLineage } from "./source-lineage";
import { WorkItemReadRelease } from "./work-item-readable-page";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
it("preserves the exact permission-aware total contract with bounded canonical SQL pages", async () => {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic exact page total", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@page.test`, passwordHash: "synthetic"}});
  await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR"}});
  const actor: AppActor = {kind: "user", user};
  await prisma.action.createMany({data: Array.from({length: 201}, (_, index) => ({
    id: `action-${String(index).padStart(3, "0")}`, workspaceId: workspace.id, authorUserId: user.id,
    title: `Action ${String(index).padStart(3, "0")}`, isPrivate: false, status: "OPEN",
  }))});
  const readable = await prisma.action.findMany({where: {workspaceId: workspace.id, id: {gte: "action-100"}}});
  for (const row of readable) await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
    artifact: {kind: "Action", id: row.id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
  // Seed first-use joined identity epochs before measuring one successful snapshot.
  await listActions(actor,workspace.id,{take:20,sort:"alpha"});
  const reads = vi.fn<(args: {take?:number}) => void>();
  const transaction = prisma.$transaction.bind(prisma);
  vi.spyOn(getPrismaClient(),"$transaction").mockImplementation(((operation: any,options: any) => transaction(async tx => operation(new Proxy(tx, {
    get(target,property) {
      if (property === "action") return new Proxy(target.action,{get(model,method) {
        if (method === "findMany") return (args: any) => { reads(args); return model.findMany(args); };
        const value = Reflect.get(model,method); return typeof value === "function" ? value.bind(model) : value;
      }});
      const value = Reflect.get(target,property); return typeof value === "function" ? value.bind(target) : value;
    },
  })),options)) as typeof prisma.$transaction);
  const page = await listActions(actor, workspace.id, {take: 20, sort: "alpha"});
  expect(page.items).toHaveLength(20);
  expect(page.items[0].id).toBe("action-100");
  expect(page.total).toBe(101);
  expect(reads.mock.calls.filter(([args]) => args?.take === 100)).toHaveLength(3);
  reads.mockClear();
  expect(await listActions(actor, workspace.id, {take: 0, sort: "alpha"})).toMatchObject({items: [], total: 101});
  expect(reads.mock.calls.filter(([args]) => args?.take === 100)).toHaveLength(3);
  const finish = WorkItemReadRelease.prototype.finish;
  vi.spyOn(WorkItemReadRelease.prototype, "finish").mockImplementation(async function<T>(this: WorkItemReadRelease, value: T) {
    // This row contributed to total but is not in the selected page. Its original proof must remain binding.
    await prisma.action.update({where: {id: "action-200"}, data: {bodyMd: "Changed after counting"}});
    return finish.call(this, value) as Promise<T>;
  });
  await expect(listActions(actor, workspace.id, {take: 20, sort: "alpha"})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
}, 180_000);
