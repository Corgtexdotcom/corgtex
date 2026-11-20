import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof } from "@corgtex/domain";
import { executeAgentRun } from "./runtime";

const boundary = vi.hoisted(() => ({ beforeTransaction: undefined as (() => Promise<void>) | undefined }));
// Only schedule the race; transactions, membership, receipts and locks stay real.
vi.mock("@corgtex/shared", async original => {
  const actual = await original<typeof import("@corgtex/shared")>();
  return { ...actual, prisma: new Proxy(actual.prisma, { get(target, key, receiver) {
    if (key === "$transaction") return async (work: any, options: any) => {
      await boundary.beforeTransaction?.();
      return target.$transaction(work, options);
    };
    return Reflect.get(target, key, receiver);
  } }) };
});
vi.mock("@corgtex/domain", async original => ({ ...await original<any>(),
  isAgentEnabled: async () => true, getAgentModelOverride: async () => undefined,
  resolveAgentIdentityLimits: async () => null, checkBudget: async () => ({ allowed: true }),
}));
vi.mock("@corgtex/models", () => ({ resolveModel: () => "synthetic-model" }));

const states = ["absent", "blank", "archived"] as const;
type State = typeof states[number];
async function fixture(state: State) {
  const workspace = await prisma.workspace.create({ data: { name: "Governance selection", slug: `selection-${randomUUID()}` } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const config = state === "absent" ? null : await prisma.workspaceAgentConfig.create({ data: { workspaceId: workspace.id,
    agentKey: "inbox-triage", governancePolicy: state === "blank" ? " \n\t" : "Restored policy", archivedAt: state === "archived" ? new Date() : null } });
  return { workspace, actor, config };
}
async function activate(db: Prisma.TransactionClient, f: Awaited<ReturnType<typeof fixture>>) {
  return f.config
    ? db.workspaceAgentConfig.update({ where: { id: f.config.id }, data: { governancePolicy: "New policy", archivedAt: null } })
    : db.workspaceAgentConfig.create({ data: { workspaceId: f.workspace.id, agentKey: "inbox-triage", governancePolicy: "New policy" } });
}
async function run(f: Awaited<ReturnType<typeof fixture>>, executeDone?: () => void, beforeComplete?: (tx: Prisma.TransactionClient) => Promise<void>) {
  const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "Workspace", id: f.workspace.id }]);
  return executeAgentRun({ workspaceId: f.workspace.id, agentKey: "inbox-triage", triggerType: "MANUAL", triggerRef: randomUUID(),
    goal: "Synthetic selection acceptance", payload: {}, plan: ["synthetic"], lineageActor: f.actor, lineageRoots: roots,
    contextLineageRoots: () => roots, buildContext: async () => ({}), beforeComplete,
    execute: async (_context, helpers) => {
      const receipt = await helpers.captureInputs(roots);
      executeDone?.();
      return { lineageReceipt: receipt, resultJson: { summary: "Original no-policy result" } };
    } });
}
beforeEach(truncateAllTables);
afterEach(() => { boundary.beforeTransaction = undefined; vi.restoreAllMocks(); });

describe("governance selection at the final persistence boundary", () => {
  it.each(states)("rejects %s activation committed immediately before the final transaction", async state => {
    const f = await fixture(state);
    await expect(run(f, () => {
      boundary.beforeTransaction = async () => {
        boundary.beforeTransaction = undefined;
        await prisma.$transaction(tx => activate(tx, f));
      };
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const stored = await prisma.agentRun.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    expect(stored.status).toBe("FAILED");
    expect(JSON.stringify(stored.resultJson)).not.toContain("Original no-policy result");
  });

  it.each(states)("serializes concurrent %s activation after the unchanged run commits", async state => {
    const f = await fixture(state);
    const writer = new PrismaClient();
    let write: Promise<unknown> | undefined;
    let settled = false;
    try {
      const result = await run(f, undefined, async () => {
        let started!: (pid: number) => void;
        const pidReady = new Promise<number>(resolve => { started = resolve; });
        write = writer.$transaction(async tx => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          started(pid);
          await activate(tx, f);
        }).finally(() => { settled = true; });
        const pid = await pidReady;
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (!blocked && Date.now() < deadline) {
          const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS waiting`;
          blocked = waiting;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
      });
      await write;
      expect(result).toMatchObject({ status: "COMPLETED", resultJson: { summary: "Original no-policy result" } });
      expect(await prisma.workspaceAgentConfig.findUniqueOrThrow({ where: { workspaceId_agentKey: { workspaceId: f.workspace.id, agentKey: "inbox-triage" } } }))
        .toMatchObject({ governancePolicy: "New policy", archivedAt: null });
    } finally {
      await write?.catch(() => undefined);
      await writer.$disconnect();
    }
  });
});
