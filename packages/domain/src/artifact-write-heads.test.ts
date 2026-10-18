import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { LineageInput } from "./source-lineage";
const f = vi.hoisted(() => ({primary: {}, active: false, planTx: null as unknown, workspaceId: "ws", outputs: new Set<string>(),
  compatible: vi.fn(), covered: vi.fn()}));
vi.mock("@corgtex/shared", () => ({prisma: f.primary}));
vi.mock("./source-commit-lock-plan", async importOriginal => ({
  // Physical alias mapping is the real closed registry, not a permissive test map.
  sourceCommitHeadAdvisoryKey: (await importOriginal<typeof import("./source-commit-lock-plan")>()).sourceCommitHeadAdvisoryKey,
  assertSourceCommitTransactionCompatible: f.compatible,
  hasActiveSourceCommitLockPlan: (tx: unknown) => f.active && tx === f.planTx,
  assertSourceCommitOutputHeadReserved: f.covered,
}));
import { reserveArtifactWriteHeads, assertArtifactWriteHeadsReserved, type ArtifactWriteHeadReservation } from "./artifact-write-heads";
import { sourceCommitHeadAdvisoryKey } from "./source-commit-lock-plan";
function client() {return {$executeRaw: vi.fn(async () => 1)} as unknown as Prisma.TransactionClient & {$executeRaw: ReturnType<typeof vi.fn>};}
const action: LineageInput = {kind: "Action", id: "action"};
const article: LineageInput = {kind: "BrainArticle", id: "article"};
const key = (value: LineageInput) => JSON.stringify([value.kind, value.id]);
beforeEach(() => {
  vi.clearAllMocks(); f.active = false; f.planTx = null; f.outputs.clear();
  f.compatible.mockImplementation((tx: unknown) => {if (f.active && tx !== f.planTx) throw Object.assign(new Error("foreign transaction"), {code: "SOURCE_LOCK_UNCOVERED"});});
  f.covered.mockImplementation((tx: unknown, workspaceId: string, output: LineageInput) => {
    if (!f.active || tx !== f.planTx || workspaceId !== f.workspaceId || !f.outputs.has(key(output))) {
      throw Object.assign(new Error("unplanned output"), {code: "SOURCE_LOCK_UNCOVERED"});
    }
  });
});
describe("cooperating artifact write-head intent", () => {
  it("reserves the complete known set in deterministic exclusive order", async () => {
    const tx = client(); const targets = [article, action, {kind: "Meeting", id: "meeting"} as const];
    const receipt = await reserveArtifactWriteHeads(tx, "ws", targets);
    expect(tx.$executeRaw.mock.calls.map(call => call[1])).toEqual(targets.map(target => sourceCommitHeadAdvisoryKey("ws", target)).sort());
    for (const [strings] of tx.$executeRaw.mock.calls) {
      expect(strings.join("?")).toContain("pg_advisory_xact_lock("); expect(strings.join("?")).not.toContain("shared");
      expect(strings.join("?")).not.toContain("SourcePermissionEpoch");
    }
    expect(() => assertArtifactWriteHeadsReserved(tx, "ws", targets, receipt)).not.toThrow();
  });
  it("collapses real Meeting and credential projection aliases to their physical heads", async () => {
    const tx = client(); const targets: LineageInput[] = [
      {kind: "Meeting", id: "meeting"}, {kind: "MeetingTranscript", id: "meeting"}, {kind: "MeetingAgenda", id: "meeting"},
      {kind: "WorkspaceToolLink", id: "link"}, {kind: "WorkspaceToolLinkCredential", id: "link"},
    ];
    const receipt = await reserveArtifactWriteHeads(tx, "ws", targets);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(() => assertArtifactWriteHeadsReserved(tx, "ws", [{kind: "MeetingAgenda", id: "meeting"}], receipt)).not.toThrow();
  });
  it("reuses transaction-owned heads and the same receipt without taking later locks", async () => {
    const tx = client(); const receipt = await reserveArtifactWriteHeads(tx, "ws", [action, article]);
    await reserveArtifactWriteHeads(tx, "ws", [action]); await reserveArtifactWriteHeads(tx, "ws", [article, action]);
    assertArtifactWriteHeadsReserved(tx, "ws", [action], receipt); assertArtifactWriteHeadsReserved(tx, "ws", [article], receipt);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
  it("awaits each lock sequentially and serializes concurrent same-transaction reuse", async () => {
    const tx = client(); let release!: () => void; const first = new Promise<void>(resolve => {release = resolve;});
    tx.$executeRaw.mockImplementationOnce(async () => {await first; return 1;});
    const one = reserveArtifactWriteHeads(tx, "ws", [article, action]);
    const two = reserveArtifactWriteHeads(tx, "ws", [action]);
    await vi.waitFor(() => expect(tx.$executeRaw).toHaveBeenCalledTimes(1));
    release(); await Promise.all([one, two]); expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
  it("binds exact transaction, workspace and complete reservation coverage", async () => {
    const tx = client(), foreign = client(); const receipt = await reserveArtifactWriteHeads(tx, "ws", [action]);
    for (const [clientValue, workspaceId, targets, token] of [
      [foreign, "ws", [action], receipt], [tx, "foreign", [action], receipt], [tx, "ws", [article], receipt],
      [tx, "ws", [action], {}], [tx, "ws", [action], {...receipt}],
    ] as const) expect(() => assertArtifactWriteHeadsReserved(clientValue, workspaceId, targets, token as ArtifactWriteHeadReservation)).toThrow();
    expect(foreign.$executeRaw).not.toHaveBeenCalled();
  });
  it("never acquires a head from a pure unreserved assertion", () => {
    const tx = client(); expect(() => assertArtifactWriteHeadsReserved(tx, "ws", [action])).toThrow();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("under an active plan verifies every declared logical output and takes no SQL locks", async () => {
    const tx = client(); f.active = true; f.planTx = tx; f.outputs.add(key(action));
    const receipt = await reserveArtifactWriteHeads(tx, "ws", [action]);
    assertArtifactWriteHeadsReserved(tx, "ws", [action], receipt);
    await expect(reserveArtifactWriteHeads(tx, "ws", [article])).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(tx.$executeRaw).not.toHaveBeenCalled(); expect(f.covered).toHaveBeenCalledTimes(3);
  });
  it("cannot borrow a held physical alias as an undeclared logical plan output", async () => {
    const tx = client(); f.active = true; f.planTx = tx; f.outputs.add(key({kind: "Meeting", id: "meeting"}));
    await reserveArtifactWriteHeads(tx, "ws", [{kind: "Meeting", id: "meeting"}]);
    await expect(reserveArtifactWriteHeads(tx, "ws", [{kind: "MeetingTranscript", id: "meeting"}])).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("rejects a foreign/default transaction under an active plan before any fallback SQL", async () => {
    const tx = client(), foreign = client(); f.active = true; f.planTx = tx; f.outputs.add(key(action));
    await expect(reserveArtifactWriteHeads(foreign, "ws", [action])).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    await expect(reserveArtifactWriteHeads(f.primary as Prisma.TransactionClient, "ws", [action])).rejects.toMatchObject({code: "SOURCE_LOCK_UNCOVERED"});
    expect(foreign.$executeRaw).not.toHaveBeenCalled(); expect(f.covered).not.toHaveBeenCalled();
  });
  it("captures identities before awaiting and does not follow mutated caller arguments", async () => {
    const tx = client(); const targets = [{...action}]; const promise = reserveArtifactWriteHeads(tx, "ws", targets);
    targets[0].id = "changed"; targets.push(article); await promise;
    expect(tx.$executeRaw.mock.calls.map(call => call[1])).toEqual([sourceCommitHeadAdvisoryKey("ws", action)]);
    expect(() => assertArtifactWriteHeadsReserved(tx, "ws", targets)).toThrow();
  });
  it("rejects virtual, malformed, oversized and primary-client targets before SQL", async () => {
    const tx = client();
    for (const targets of [[{kind: "ExternalMcpConnectionSet", id: "virtual"}], [{kind: "Action", id: ""}], Array.from({length: 10_001}, () => action)] as LineageInput[][]) {
      await expect(reserveArtifactWriteHeads(tx, "ws", targets)).rejects.toThrow();
    }
    await expect(reserveArtifactWriteHeads(f.primary as Prisma.TransactionClient, "ws", [action])).rejects.toThrow();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("never reports a failed partial reservation as a successful complete set", async () => {
    const tx = client(); tx.$executeRaw.mockRejectedValueOnce(new Error("synthetic transaction failure"));
    await expect(reserveArtifactWriteHeads(tx, "ws", [action, article])).rejects.toThrow("synthetic transaction failure");
    expect(() => assertArtifactWriteHeadsReserved(tx, "ws", [action, article])).toThrow();
    await expect(reserveArtifactWriteHeads(tx, "ws", [action])).rejects.toThrow("synthetic transaction failure");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
