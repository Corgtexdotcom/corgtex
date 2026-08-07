import { describe, it, expect } from "vitest";
import { assessRuntimeRollback, ProviderCutoverRecord, RuntimeRollbackContext } from "./provider-cutover";

const ctx: RuntimeRollbackContext = {
  assessedAt: new Date("2026-08-07T12:00:00Z"),
  requiredSourceFreshThroughAt: new Date("2026-08-01T12:00:00Z"),
  requiredSourceRuntimeObservedAt: new Date("2026-08-01T12:00:00Z"),
};

const baseEv = {
  sourceRuntimeHealthy: true,
  sourceRuntimeObservedAt: "2026-08-02T12:00:00Z",
  destinationWritesCompatible: true,
  secretKey: "leak-me-not",
};

const baseRec: ProviderCutoverRecord = {
  id: "rec",
  customerAccountId: "acc",
  sourceDeploymentId: "dep1",
  destinationDeploymentId: "dep2",
  sourceProvider: "RAILWAY",
  destinationProvider: "AZURE",
  status: "SHADOW",
  sourceWriteStoppedAt: null,
  destinationWriteStartedAt: new Date("2026-08-01T12:00:00Z"),
  sourceDataFreshThroughAt: new Date("2026-08-02T12:00:00Z"),
  evidence: { ...baseEv },
};

describe("assessRuntimeRollback", () => {
  it("redacts hostile input and exposes exact summary keys", () => {
    const res = assessRuntimeRollback(baseRec, ctx);
    expect(res.rollbackReady).toBe(true);
    expect(res.summary).toEqual({
      status: "SHADOW",
      sourceProvider: "RAILWAY",
      destinationProvider: "AZURE",
      rollbackReady: true,
      blockerCodes: [],
    });
    expect(Object.keys(res.summary).sort()).toEqual([
      "blockerCodes", "destinationProvider", "rollbackReady", "sourceProvider", "status"
    ]);
  });

  const statuses = [
    { st: "PLANNED", ok: false }, { st: "SHADOW", ok: true },
    { st: "CUTOVER", ok: true }, { st: "OBSERVING", ok: true },
    { st: "ARCHIVE_ONLY", ok: false }, { st: "DELETE_ELIGIBLE", ok: false },
    { st: "DELETED", ok: false }, { st: "ROLLED_BACK", ok: false },
    { st: "UNKNOWN", ok: false },
  ];
  it.each(statuses)("status $st", ({ st, ok }) => {
    const res = assessRuntimeRollback({ ...baseRec, status: st }, ctx);
    expect(res.rollbackReady).toBe(ok);
    if (!ok) expect(res.summary.blockerCodes).toContain("STATUS_NOT_ROLLBACK_ELIGIBLE");
    if (st === "UNKNOWN") expect(res.summary.status).toBeNull();
  });

  const provs = [
    { src: "RAILWAY", dst: "AZURE", ok: true },
    { src: "AZURE", dst: "SELF_HOSTED", ok: true },
    { src: "UNKNOWN", dst: "AZURE", ok: false },
    { src: "RAILWAY", dst: "ARBITRARY", ok: false },
    { src: "AZURE", dst: "AZURE", ok: false },
  ];
  it.each(provs)("providers src=$src dst=$dst", ({ src, dst, ok }) => {
    const res = assessRuntimeRollback({ ...baseRec, sourceProvider: src, destinationProvider: dst }, ctx);
    expect(res.rollbackReady).toBe(ok);
    if (!ok) expect(res.summary.blockerCodes).toContain("INVALID_IDENTITY");
  });

  const ctxs = [
    { n: "future fresh", m: { requiredSourceFreshThroughAt: new Date("2026-08-08T12:00:00Z") } },
    { n: "future obs", m: { requiredSourceRuntimeObservedAt: new Date("2026-08-08T12:00:00Z") } },
    { n: "invalid date", m: { assessedAt: new Date("invalid") } },
  ];
  it.each(ctxs)("context $n", ({ m }) => {
    const res = assessRuntimeRollback(baseRec, { ...ctx, ...m });
    expect(res.rollbackReady).toBe(false);
    expect(res.summary.blockerCodes).toContain("INVALID_CONTEXT");
  });

  const obs = [
    { n: "missing health", ev: { sourceRuntimeObservedAt: "2026-08-02T12:00:00Z", destinationWritesCompatible: true }, b: ["SOURCE_RUNTIME_UNHEALTHY"] },
    { n: "false health", ev: { ...baseEv, sourceRuntimeHealthy: false }, b: ["SOURCE_RUNTIME_UNHEALTHY"] },
    { n: "missing date", ev: { sourceRuntimeHealthy: true, destinationWritesCompatible: true }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "non-string", ev: { ...baseEv, sourceRuntimeObservedAt: 123 }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "date-only", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-02" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "invalid day", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-02-30T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "invalid offset", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-02T12:00:00+25:00" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "stale", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-07-30T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_STALE"] },
    { n: "future", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-08T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_FUTURE"] },
    { n: "boundary", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-01T12:00:00Z" }, b: [] },
  ];
  it.each(obs)("observation $n", ({ ev, b }) => {
    const res = assessRuntimeRollback({ ...baseRec, evidence: ev }, ctx);
    expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
  });

  const fresh = [
    { n: "miss compat", ev: { sourceRuntimeHealthy: true, sourceRuntimeObservedAt: "2026-08-02T12:00:00Z" }, fd: new Date("2026-08-02T12:00:00Z"), b: ["DESTINATION_WRITES_INCOMPATIBLE"] },
    { n: "miss fresh", ev: baseEv, fd: null, b: ["SOURCE_FRESHNESS_MISSING"] },
    { n: "inv fresh", ev: baseEv, fd: new Date("invalid"), b: ["SOURCE_FRESHNESS_INVALID"] },
    { n: "stale fresh", ev: baseEv, fd: new Date("2026-07-30T12:00:00Z"), b: ["SOURCE_FRESHNESS_STALE"] },
    { n: "future fresh", ev: baseEv, fd: new Date("2026-08-08T12:00:00Z"), b: ["SOURCE_FRESHNESS_FUTURE"] },
    { n: "boundary", ev: baseEv, fd: new Date("2026-08-01T12:00:00Z"), b: [] },
  ];
  it.each(fresh)("freshness $n", ({ ev, fd, b }) => {
    const res = assessRuntimeRollback({ ...baseRec, evidence: ev, sourceDataFreshThroughAt: fd }, ctx);
    expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
  });

  const dst = [
    { st: "CUTOVER", ds: null, b: ["DESTINATION_WRITE_START_MISSING"] },
    { st: "OBSERVING", ds: new Date("invalid"), b: ["DESTINATION_WRITE_START_INVALID"] },
    { st: "CUTOVER", ds: new Date("2026-08-08T12:00:00Z"), b: ["DESTINATION_WRITE_START_FUTURE"] },
    { st: "OBSERVING", ds: new Date("2026-08-02T12:00:00Z"), b: ["HORIZON_BEFORE_DESTINATION_WRITES"] },
    { st: "CUTOVER", ds: new Date("2026-08-01T12:00:00Z"), b: [] },
    { st: "SHADOW", ds: null, b: [] },
  ];
  it.each(dst)("dest state $st", ({ st, ds, b }) => {
    const res = assessRuntimeRollback({ ...baseRec, status: st, destinationWriteStartedAt: ds }, ctx);
    expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
  });

  it("allows start before stop ordering", () => {
    const res = assessRuntimeRollback(
      { ...baseRec, status: "CUTOVER", sourceWriteStoppedAt: new Date("2026-08-01T13:00:00Z"), destinationWriteStartedAt: new Date("2026-08-01T10:00:00Z") },
      { ...ctx, requiredSourceFreshThroughAt: new Date("2026-08-01T10:00:00Z") }
    );
    expect(res.rollbackReady).toBe(true);
  });
});
