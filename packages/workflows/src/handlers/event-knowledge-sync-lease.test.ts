import { afterEach, beforeEach, expect, it, vi } from "vitest";

const {updateMany, queryRaw, transaction} = vi.hoisted(() => ({updateMany: vi.fn(), queryRaw: vi.fn(), transaction: vi.fn()}));
vi.mock("@corgtex/shared", () => ({prisma: {$transaction: transaction, workflowJob: {updateMany}}}));
import { createEventKnowledgeSyncLease, withEventKnowledgeSyncLease } from "./event-knowledge-sync-lease";

const claim = () => ({id: "job", workspaceId: "workspace", type: "knowledge.sync.event", payload: {eventId: "event", filter: ["original"]},
  attempts: 1, lockedBy: "worker", lockedAt: new Date(), startedAt: new Date()});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-17T10:00:00Z")); const row = {...claim(), status: "RUNNING"};
  queryRaw.mockReset().mockImplementation(async () => [structuredClone(row)]);
  transaction.mockReset().mockImplementation(async work => work({$queryRaw: queryRaw, workflowJob: {updateMany}}));
  updateMany.mockReset().mockImplementation(async ({data}) => {Object.assign(row, data); return {count: 1};}); });
afterEach(() => { vi.useRealTimers(); });

it("renews only the acknowledged original tuple and hands the final stamp to settlement", async () => {
  const original = claim(); const lease = createEventKnowledgeSyncLease(original);
  try {
    for (let minute = 0; minute < 7; minute++) await vi.advanceTimersByTimeAsync(60_000);
    expect(updateMany).toHaveBeenCalledTimes(7);
    let previous = original.lockedAt;
    for (const [{where, data}] of updateMany.mock.calls) {
      expect(where).toMatchObject({...original, status: "RUNNING", payload: {equals: original.payload}, lockedAt: {equals: previous, gt: expect.any(Date)}});
      previous = data.lockedAt;
    }
    await lease.stopAndDrain();
    expect(await lease.settle({status: "COMPLETED"})).toEqual({count: 1});
    expect(updateMany.mock.lastCall?.[0].where).toMatchObject({lockedAt: {equals: previous}, attempts: 1, startedAt: original.startedAt});
    lease.assertCurrentRow({...original, payload: {filter: ["original"], eventId: "event"}, lockedAt: previous});
    expect(vi.getTimerCount()).toBe(0);
  } finally { await lease.dispose(); }
});

it("latches a failed CAS and never adopts the replacement stamp", async () => {
  const original = claim(); const lease = createEventKnowledgeSyncLease(original);
  updateMany.mockResolvedValue({count: 0});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lease.signal.aborted).toBe(true);
  await expect(lease.stopAndDrain()).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(await lease.settle({status: "FAILED"})).toEqual({count: 0});
  await vi.advanceTimersByTimeAsync(120_000);
  expect(updateMany).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cannot revive an expired original lease", async () => {
  const original = claim(); original.lockedAt = new Date(Date.now() - 300_001);
  const lease = createEventKnowledgeSyncLease(original);
  try {
    await expect(lease.run(async () => {})).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updateMany).not.toHaveBeenCalled();
  } finally { await lease.dispose(); }
});

it("queues heartbeat before opening a competing transaction and checks the acknowledged stamp inside it", async () => {
  const original = claim(); const lease = createEventKnowledgeSyncLease(original);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const transaction = lease.sourceTransactionGuard(async () => {
    entered = true; lease.assertTransactionOwner();
    await blocked;
    lease.assertCurrentRow(original);
  });
  await Promise.resolve(); expect(entered).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(updateMany).not.toHaveBeenCalled();
  release(); await transaction;
  await lease.readGuard(async () => {
    expect(updateMany).toHaveBeenCalledTimes(1);
    lease.assertCurrentRow({...original, lockedAt: updateMany.mock.calls[0]![0].data.lockedAt});
  });
  await lease.dispose();
});

it("waits for a pending renewal acknowledgment before any subsequent transaction reads its stamp", async () => {
  const original = claim(); const lease = createEventKnowledgeSyncLease(original);
  let acknowledge!: (result: {count: number}) => void;
  updateMany.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  await vi.advanceTimersByTimeAsync(60_000);
  let entered = false;
  const transaction = lease.sourceTransactionGuard(async () => {
    entered = true; lease.assertCurrentRow({...original, lockedAt: updateMany.mock.calls[0]![0].data.lockedAt});
  });
  await Promise.resolve(); expect(entered).toBe(false);
  acknowledge({count: 1}); await transaction; expect(entered).toBe(true);
  await lease.stopAndDrain(); expect(vi.getTimerCount()).toBe(0);
});

it("stops and drains after an ordinary handler failure", async () => {
  await expect(withEventKnowledgeSyncLease(claim(), async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    throw new Error("Provider failed");
  })).rejects.toThrow("Provider failed");
  expect(updateMany).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

// Event ownership is intentionally disjoint from OAuth and SQL publication.
it.each(["oauth.email.sync", "oauth.documents.sync", "external-database.sync"])("rejects another protocol: %s", type => {
  expect(() => createEventKnowledgeSyncLease({...claim(), type})).toThrow("Event lease requires an Event indexing job.");
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["owner", "attempt", "recipe", "startedAt", "stamp", "status"])("does not renew or settle a changed %s", async field => {
  const original=claim(); const lease=createEventKnowledgeSyncLease(original);
  const row={...original,status:"RUNNING", ...(field==="owner"?{lockedBy:"replacement"}:field==="attempt"?{attempts:2}
    :field==="recipe"?{payload:{eventId:"other"}}:field==="startedAt"?{startedAt:new Date(Date.now()+1)}
    :field==="stamp"?{lockedAt:new Date(Date.now()+1)}:{status:"COMPLETED"})};
  queryRaw.mockResolvedValue([row]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lease.signal.aborted).toBe(true);
  expect(updateMany).not.toHaveBeenCalled();
  expect(await lease.settle({status:"FAILED"})).toEqual({count:0});
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects lease expiry incurred while awaiting the row lock", async () => {
  const original=claim(); const lease=createEventKnowledgeSyncLease(original);
  queryRaw.mockImplementationOnce(async () => {vi.setSystemTime(new Date(Date.now()+300_001));return [{...original,status:"RUNNING"}];});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lease.signal.aborted).toBe(true);expect(updateMany).not.toHaveBeenCalled();
  await lease.dispose();expect(vi.getTimerCount()).toBe(0);
});
