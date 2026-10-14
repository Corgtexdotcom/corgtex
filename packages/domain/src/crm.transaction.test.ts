import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";

// Routing tests deliberately use distinct primary/transaction clients. Source-proof
// semantics are covered separately by crm-producers.lineage.test.ts.
const f = vi.hoisted(() => ({
  primary: new Proxy({ $transaction: vi.fn() }, { get(target, key) {
    if (key === "$transaction") return target.$transaction;
    throw new Error(`Unexpected primary client read: ${String(key)}`);
  } }),
  membership: vi.fn(), prepare: vi.fn(), finish: vi.fn(), fence: vi.fn(), locks: vi.fn(),
  capture: vi.fn(), readable: vi.fn(),
}));
vi.mock("@corgtex/shared", () => ({ prisma: f.primary, env: { APP_URL: "http://synthetic.test" }, toInputJson: (x: unknown) => x }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership, requireGlobalOperator: vi.fn() }));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: f.prepare, finishProducerLineage: f.finish }));
vi.mock("./source-lineage", async () => ({
  sealArtifactInputActor: (await import("./artifact-input-actor")).sealArtifactInputActor,
  assertArtifactInputWriteFence: f.fence, captureArtifactInputProof: f.capture,
  readableArtifactIds: f.readable,
}));
vi.mock("./crm-archive-guards", () => ({ activeCrmParentWhere: () => ({}),
  lockCrmLinkClosure: f.locks, lockCrmLinks: f.locks, lockCrmProspectProvisioning: f.locks }));
import { completeActivity, createActivity, createCommunicationSuggestion } from "./crm";

function fixture() {
  const actor = { kind: "user", user: { id: "author", email: "author@synthetic.test" } } as AppActor;
  const rows: any[] = [];
  const receipts: any[] = [];
  const audits: any[] = [];
  let activity: any = { id: "existing", workspaceId: "ws", title: "Existing", accountId: "account",
    contactId: null, dealId: null, archivedAt: null, completedAt: null, source: "manual" };
  const tx: any = {
    $transaction: vi.fn(() => { throw new Error("Nested transaction"); }),
    crmAccount: { findUnique: vi.fn(async () => ({ id: "account", workspaceId: "ws", archivedAt: null })) },
    member: { findFirst: vi.fn(async () => ({ id: "member" })) },
    crmActivity: {
      findUnique: vi.fn(async () => activity), findFirst: vi.fn(async () => activity),
      create: vi.fn(async ({ data }) => { const row = { id: "created", ...data }; rows.push(row); return row; }),
      update: vi.fn(async ({ data }) => { activity = { ...activity, ...data }; rows.push(activity); return activity; }),
    },
    crmCommunicationSuggestion: { create: vi.fn(async ({ data }) => { const row = { id: "suggestion", ...data }; rows.push(row); return row; }) },
    auditLog: { create: vi.fn(async ({ data }) => { audits.push(data); return data; }) },
  };
  f.membership.mockImplementation(async ({ tx: db }) => { expect(db).toBe(tx); return { id: "member" }; });
  f.fence.mockImplementation(async db => { expect(db).toBe(tx); });
  f.locks.mockImplementation(async db => { expect(db).toBe(tx); });
  f.prepare.mockImplementation(async ({ tx: db }) => { expect(db).toBe(tx); return { mode: "DERIVED", roots: [], inputs: [] }; });
  f.finish.mockImplementation(async ({ tx: db, artifact }) => { expect(db).toBe(tx); receipts.push(artifact); });
  f.capture.mockImplementation(async (_actor, _ws, _inputs, db) => { expect(db).toBe(tx); return []; });
  f.readable.mockImplementation(async (_actor, _ws, _kind, supplied, db) => { expect(db).toBe(tx); return new Set(supplied.map((row: { id: string }) => row.id)); });
  return { actor, tx: tx as Prisma.TransactionClient, rows, receipts, audits, complete: () => { activity.completedAt = new Date(); } };
}
const cases = [
  ["activity", createActivity, { workspaceId: "ws", title: "New activity", accountId: "account", ownerUserId: "owner" }],
  ["completion", completeActivity, { workspaceId: "ws", activityId: "existing" }],
  ["suggestion", createCommunicationSuggestion, { workspaceId: "ws", title: "Follow up", bodyMd: "Synthetic body", accountId: "account" }],
] as const;

describe("CRM caller-owned transaction routing", () => {
  beforeEach(() => { vi.resetAllMocks(); f.primary.$transaction.mockRejectedValue(new Error("Unexpected primary transaction")); });
  it.each(cases)("joins %s membership, locks, receipts, output and audit to the supplied transaction", async (_name, write, input) => {
    const x = fixture();
    await (write as any)(x.actor, { ...input, tx: x.tx });
    expect(f.primary.$transaction).not.toHaveBeenCalled();
    expect((x.tx as any).$transaction).not.toHaveBeenCalled();
    expect(f.membership).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.fence).toHaveBeenCalledTimes(2);
    expect(x.rows).toHaveLength(1);
    expect(x.receipts).toHaveLength(1);
    expect(x.audits).toHaveLength(_name === "activity" ? 0 : 1);
  });
  it.each(cases)("retains exactly one owned transaction for standalone %s", async (_name, write, input) => {
    const x = fixture();
    f.primary.$transaction.mockImplementation(async run => run(x.tx));
    await (write as any)(x.actor, input);
    expect(f.primary.$transaction).toHaveBeenCalledTimes(1);
    expect(f.membership).toHaveBeenCalledWith(expect.objectContaining({ tx: x.tx }));
  });
  it.each(cases)("rejects revoked authority before any %s effect", async (_name, write, input) => {
    const x = fixture();
    f.membership.mockRejectedValue(new Error("Membership revoked"));
    await expect((write as any)(x.actor, { ...input, tx: x.tx })).rejects.toThrow("Membership revoked");
    expect(x.rows).toHaveLength(0); expect(x.receipts).toHaveLength(0); expect(x.audits).toHaveLength(0);
  });
  it("checks the caller fence again before returning an already completed activity", async () => {
    const x = fixture(); x.complete();
    f.fence.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("Lease expired"));
    await expect(completeActivity(x.actor, { workspaceId: "ws", activityId: "existing", tx: x.tx })).rejects.toThrow("Lease expired");
    expect(f.prepare).not.toHaveBeenCalled(); expect(x.rows).toHaveLength(0);
  });
  it("captures parameters before a paused membership read without cloning the caller transaction", async () => {
    const x = fixture();
    let release!: () => void;
    f.membership.mockImplementation(async () => new Promise<void>(resolve => { release = resolve; }));
    const input = { workspaceId: "ws", title: "Captured", accountId: "account", bodyMd: "Original", tx: x.tx,
      lineageRoots: [{ kind: "McpToolInput" as const, id: "native", fingerprint: "exact" }] };
    const operation = createActivity(x.actor, input);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    input.title = "Changed"; input.bodyMd = "Changed"; input.lineageRoots[0].fingerprint = "changed";
    release(); await operation;
    expect(x.rows[0]).toMatchObject({ title: "Captured", bodyMd: "Original" });
    expect(f.prepare.mock.calls[0][0].capture.lineageRoots[0].fingerprint).toBe("exact");
    expect(f.prepare.mock.calls[0][0].actor).toBe(x.actor);
    expect(Object.isFrozen(x.actor)).toBe(true);
  });
});
