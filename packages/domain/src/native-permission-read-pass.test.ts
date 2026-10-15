import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => ({ primary: {}, tx: {} as any, active: true, phase: true,
  actor: {} as AppActor, current: new Map<string, bigint>() }));
vi.mock("@corgtex/shared", () => ({ prisma: f.primary }));
vi.mock("./artifact-native-commit-phase", () => ({ isArtifactNativeCommitPhase: () => f.phase }));
vi.mock("./external-provider-authority", () => ({ isActiveExternalProviderCommit: (actor: AppActor, ws: string, db: unknown) =>
  f.active && actor === f.actor && ws === "ws" && db === f.tx }));
vi.mock("./source-commit-lock-plan", () => ({ assertSourceCommitTransactionCompatible: () => {},
  hasActiveSourceCommitLockPlan: () => false }));
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, SOURCE_PERMISSION_POLICY_VERSION,
  withExternalProviderPermissionReadPass } from "./source-permission-epochs";
const key = (id: string) => JSON.stringify(["Action", id]);
const proof = (id = "input", epoch = "1") => ({ version: 1 as const, policyVersion: SOURCE_PERMISSION_POLICY_VERSION,
  entries: [{ kind: "Action", id, epoch }] });
const read = (id = "input", epoch = "1") => isArtifactPermissionEpochProofCurrent("ws", proof(id, epoch), f.tx);
const pass = (work: () => Promise<boolean>, mode: "local" | "full" = "local") =>
  withExternalProviderPermissionReadPass(f.actor, f.tx, "ws", mode, work);

describe("bounded exact native commit epoch observations", () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.active = true; f.phase = true;
    f.actor = { kind: "user", user: { id: "owner", email: "owner@example.test", displayName: null } };
    f.current = new Map([[key("input"), 1n]]);
    f.tx = { $executeRaw: vi.fn(), $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const [, ...identities] = query.values; const rows = [];
      for (let i = 0; i < identities.length; i += 2) {
        const sourceKind = String(identities[i]), sourceId = String(identities[i + 1]);
        const epoch = f.current.get(JSON.stringify([sourceKind, sourceId]));
        if (epoch !== undefined) rows.push({ sourceKind, sourceId, epoch });
      }
      return rows;
    }) };
  });
  it("locks the complete first observation, reuses matches and freshly compares before true", async () => {
    expect(await pass(async () => {
      for (let i = 0; i < 100; i++) expect(await read()).toBe(true);
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
      return pass(() => read());
    })).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.tx.$queryRaw.mock.calls[0][0].sql).toContain("FOR SHARE");
  });
  it.each(["update", "delete"])("rejects own-TX %s after a demonstrated hit before a positive return", async action => {
    expect(await pass(async () => {
      expect(await read()).toBe(true);
      if (action === "update") f.current.set(key("input"), 2n); else f.current.delete(key("input"));
      expect(await read()).toBe(true);
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
      return true;
    })).toBe(false);
  });
  it("never grants missing rows or rebases a conflicting original", async () => {
    expect(await pass(() => read("missing", "0"))).toBe(false);
    expect(await pass(async () => { expect(await read()).toBe(true); return read("input", "2"); })).toBe(false);
  });
  it("separates local/full/new invocations and leaves ordinary TX and primary readers uncached", async () => {
    expect(await pass(async () => { await read(); return pass(() => read(), "full"); })).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(await pass(() => read())).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(6);
    f.phase = false;
    expect(await pass(async () => { await read(); await read(); return true; })).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(8);
    await withExternalProviderPermissionReadPass(f.actor, f.primary as never, "ws", "local", async () => true);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(8);
  });
  it("bounds retained count and bytes with uncached overflow", async () => {
    expect(await pass(async () => {
      for (let i = 0; i < 513; i++) { const id = `input-${i}`; f.current.set(key(id), 1n); await read(id); }
      const count = f.tx.$queryRaw.mock.calls.length;
      await read("input-0"); expect(f.tx.$queryRaw).toHaveBeenCalledTimes(count);
      await read("input-512"); expect(f.tx.$queryRaw).toHaveBeenCalledTimes(count + 1);
      const oversized = "x".repeat(40_000); f.current.set(key(oversized), 1n);
      await read(oversized); await read(oversized);
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(count + 3);
      return true;
    })).toBe(true);
    const final = f.tx.$queryRaw.mock.calls.at(-1)[0];
    expect(final.values).toHaveLength(1 + 512 * 2);
  });
  it("rejects foreign clients, workspaces, actors, expired claim and epoch capture", async () => {
    await expect(pass(async () => { await read(); return isArtifactPermissionEpochProofCurrent("other", proof(), f.tx); }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(pass(() => isArtifactPermissionEpochProofCurrent("ws", proof(), {} as never)))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(pass(() => withExternalProviderPermissionReadPass({ ...f.actor }, f.tx, "ws", "local", () => read())))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(pass(async () => { await read(); f.active = false; return read(); })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    f.active = true;
    await expect(pass(async () => { await capturePermissionEpochs(f.tx, "ws", [{ kind: "Action", id: "output" }]); return true; }))
      .rejects.toMatchObject({ code: "SOURCE_LOCK_UNCOVERED" });
  });
  it.each([false, true])("expires detached work after success/throw (%s)", async fail => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let detached!: Promise<boolean>;
    const result = pass(async () => {
      await read(); detached = barrier.then(() => read());
      if (fail) throw new Error("synthetic failure");
      return true;
    });
    if (fail) await expect(result).rejects.toThrow("synthetic failure"); else expect(await result).toBe(true);
    release(); await expect(detached).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });
});
