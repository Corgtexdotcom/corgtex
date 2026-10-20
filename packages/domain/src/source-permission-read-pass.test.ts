import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const f = vi.hoisted(() => ({ primary: {}, tx: {} as any, planned: true,
  current: new Map<string, bigint>(),
  held: [{kind: "Action", id: "input", epoch: "1"}, {kind: "Workspace", id: "ws", epoch: "1"}],
  identities: [{kind: "Action", id: "input"}, {kind: "BrainArticle", id: "output"}, {kind: "Workspace", id: "ws"}],
}));
vi.mock("@corgtex/shared", () => ({prisma: f.primary}));
vi.mock("./source-commit-lock-plan", () => ({
  assertSourceCommitTransactionCompatible: (db: unknown) => {
    if (f.planned && db !== f.tx) throw Object.assign(new Error("foreign client"), {code: "SOURCE_LOCK_UNCOVERED"});
  },
  hasActiveSourceCommitLockPlan: (db: unknown) => f.planned && db === f.tx,
  sourceCommitPermissionReadIdentities: () => f.identities,
  isSourceCommitHeldPermissionUnionCurrent: (_db: unknown, ws: string, rows: any[]) => ws === "ws"
    && f.held.every(entry => rows.some(row => row.kind === entry.kind && row.id === entry.id && row.epoch === entry.epoch)),
  assertSourceCommitPermissionReadCovered: vi.fn((_db: unknown, ws: string, proof: any) => {
    if (ws !== "ws" || !proof.entries.every((entry: any) => f.identities.some(key => key.kind === entry.kind && key.id === entry.id)
      && (!f.held.some(key => key.kind === entry.kind && key.id === entry.id)
        || f.held.some(key => key.kind === entry.kind && key.id === entry.id && key.epoch === entry.epoch)))) {
      throw Object.assign(new Error("unplanned vector"), {code: "SOURCE_LOCK_UNCOVERED"});
    }
  }),
  assertSourceCommitEpochCaptureCovered: vi.fn(() => []),
}));

import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent,
  SOURCE_PERMISSION_POLICY_VERSION, withSourceCommitPermissionReadPass } from "./source-permission-epochs";
import { assertSourceCommitPermissionReadCovered } from "./source-commit-lock-plan";

const key = (kind: string, id: string) => JSON.stringify([kind, id]);
const proof = (entries = f.held) => ({version: 1, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
  entries: [...entries].sort((a, b) => key(a.kind, a.id).localeCompare(key(b.kind, b.id)))});
const read = (value = proof()) => isArtifactPermissionEpochProofCurrent("ws", value, f.tx);
const pass = (work: () => Promise<boolean>) => withSourceCommitPermissionReadPass(f.tx, "ws", work);

describe("exact source-plan permission read passes", () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.planned = true;
    f.current = new Map(f.held.map(entry => [key(entry.kind, entry.id), BigInt(entry.epoch)]));
    f.tx = {$executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const [, ...identities] = query.values;
      const rows = [];
      for (let index = 0; index < identities.length; index += 2) {
        const kind = String(identities[index]), id = String(identities[index + 1]);
        const epoch = f.current.get(key(kind, id));
        if (epoch !== undefined) rows.push({sourceKind: kind, sourceId: id, epoch});
      }
      return rows;
    })};
  });

  it("uses two fresh union queries for repeated and nested saved vectors", async () => {
    expect(await pass(async () => {
      for (let index = 0; index < 100; index++) if (!await read()) return false;
      return pass(() => read(proof([f.held[0]])));
    })).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(assertSourceCommitPermissionReadCovered).toHaveBeenCalledTimes(101);
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("detects same-transaction permission changes before returning a positive read", async () => {
    expect(await pass(async () => {
      expect(await read()).toBe(true);
      f.current.set(key("Action", "input"), 2n);
      return true;
    })).toBe(false);
    const work = vi.fn(async () => true);
    expect(await pass(work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it("requires a referenced newborn to exist and checks its final epoch", async () => {
    expect(await pass(() => read())).toBe(true); // Unused output may still be absent.
    const output = proof([{kind: "BrainArticle", id: "output", epoch: "0"}]);
    expect(await pass(() => read(output))).toBe(false);
    f.current.set(key("BrainArticle", "output"), 0n);
    expect(await pass(() => read(output))).toBe(true); // New invocation queries afresh.
    expect(await pass(async () => {
      expect(await read(output)).toBe(true);
      f.current.set(key("BrainArticle", "output"), 1n);
      return true;
    })).toBe(false);
  });

  it("does not redeem mismatched saved vectors or unplanned identities", async () => {
    await expect(pass(() => read(proof([{kind: "Action", id: "input", epoch: "2"}]))))
      .rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    await expect(pass(() => read(proof([{kind: "Action", id: "other", epoch: "1"}]))))
      .rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(await pass(() => read({version: 1, entries: []} as any))).toBe(false);
  });

  it("denies foreign clients and workspaces before using cached values", async () => {
    await expect(pass(() => isArtifactPermissionEpochProofCurrent("ws", proof(), {} as any)))
      .rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    await expect(pass(() => withSourceCommitPermissionReadPass(f.tx, "other", () => read())))
      .rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
  });

  it("expires its map for detached continuations", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release = resolve;});
    let detached!: Promise<boolean>;
    expect(await pass(async () => {
      detached = ready.then(() => read());
      return read();
    })).toBe(true);
    release();
    await expect(detached).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("keeps epoch construction outside the read-only pass", async () => {
    await expect(pass(async () => {
      await capturePermissionEpochs(f.tx, "ws", [{kind: "Action", id: "input"}]);
      return true;
    })).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("retains fresh SQL checks without an active source plan", async () => {
    f.planned = false;
    expect(await pass(async () => {
      if (!await read()) return false;
      f.current.set(key("Action", "input"), 2n);
      return read();
    })).toBe(false);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
