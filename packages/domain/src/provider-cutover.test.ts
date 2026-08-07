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
    const hostileRec: ProviderCutoverRecord = {
      ...baseRec,
      id: "HOSTILE_ID",
      customerAccountId: "HOSTILE_ACCOUNT",
      sourceDeploymentId: "HOSTILE_SRC_DEP",
      destinationDeploymentId: "HOSTILE_DST_DEP",
      evidence: {
        ...baseEv,
        secretKey: "HOSTILE_CREDENTIAL",
        url: "https://HOSTILE.URL",
        reason: "HOSTILE_REASON",
        objectName: "HOSTILE_OBJECT",
        customerContent: "HOSTILE_CONTENT",
        someTimestamp: "2026-08-01T12:34:56Z_HOSTILE",
      },
    };
    const res = assessRuntimeRollback(hostileRec, ctx);
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
    expect(JSON.stringify(res.summary)).not.toContain("HOSTILE");
  });

  it("returns STATUS_NOT_ROLLBACK_ELIGIBLE with INVALID_CONTEXT and skips runtime evidence", () => {
    const res = assessRuntimeRollback(
      { ...baseRec, status: "PLANNED", evidence: {} },
      { ...ctx, assessedAt: new Date("invalid") }
    );
    expect(res.rollbackReady).toBe(false);
    expect(res.summary.blockerCodes).toContain("STATUS_NOT_ROLLBACK_ELIGIBLE");
    expect(res.summary.blockerCodes).toContain("INVALID_CONTEXT");
    expect(res.summary.blockerCodes).not.toContain("SOURCE_RUNTIME_UNHEALTHY");
    expect(res.summary.blockerCodes).not.toContain("SOURCE_RUNTIME_OBSERVATION_INVALID");
    expect(res.summary.blockerCodes).not.toContain("DESTINATION_WRITES_INCOMPATIBLE");
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
    if (!ok && st !== "UNKNOWN") expect(res.summary.blockerCodes).toContain("STATUS_NOT_ROLLBACK_ELIGIBLE");
    if (st === "UNKNOWN") {
      expect(res.summary.status).toBeNull();
      expect(res.summary.blockerCodes).toContain("INVALID_IDENTITY");
      expect(res.summary.blockerCodes).not.toContain("STATUS_NOT_ROLLBACK_ELIGIBLE");
    }
  });

  const provs = [
    { src: "RAILWAY", dst: "AZURE", ok: true },
    { src: "RAILWAY", dst: "SELF_HOSTED", ok: true },
    { src: "AZURE", dst: "RAILWAY", ok: true },
    { src: "AZURE", dst: "SELF_HOSTED", ok: true },
    { src: "SELF_HOSTED", dst: "RAILWAY", ok: true },
    { src: "SELF_HOSTED", dst: "AZURE", ok: true },
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
    { n: "invalid req fresh", m: { requiredSourceFreshThroughAt: new Date("invalid") } },
    { n: "invalid req obs", m: { requiredSourceRuntimeObservedAt: new Date("invalid") } },
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
    { n: "locale", ev: { ...baseEv, sourceRuntimeObservedAt: "8/2/2026, 12:00:00 PM" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "invalid day", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-02-30T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "invalid hour", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-02T25:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "invalid offset", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-02T12:00:00+25:00" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "stale", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-07-30T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_STALE"] },
    { n: "future", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-08T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_FUTURE"] },
    { n: "fractional future", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-07T12:00:00.0009Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_FUTURE"] },
    { n: "boundary", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-01T12:00:00Z" }, b: [] },
  ];
  it.each(obs)("observation $n", ({ ev, b }) => {
    const res = assessRuntimeRollback({ ...baseRec, evidence: ev }, ctx);
    expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
  });

  const fresh = [
    { n: "miss compat", ev: { sourceRuntimeHealthy: true, sourceRuntimeObservedAt: "2026-08-02T12:00:00Z" }, fd: new Date("2026-08-02T12:00:00Z"), b: ["DESTINATION_WRITES_INCOMPATIBLE"] },
    { n: "false compat", ev: { sourceRuntimeHealthy: true, sourceRuntimeObservedAt: "2026-08-02T12:00:00Z", destinationWritesCompatible: false }, fd: new Date("2026-08-02T12:00:00Z"), b: ["DESTINATION_WRITES_INCOMPATIBLE"] },
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
    { st: "CUTOVER", dstDep: null, ds: new Date("2026-08-01T12:00:00Z"), b: ["INVALID_IDENTITY"] },
    { st: "OBSERVING", dstDep: null, ds: new Date("2026-08-01T12:00:00Z"), b: ["INVALID_IDENTITY"] },
    { st: "CUTOVER", dstDep: "dep2", ds: null, b: ["DESTINATION_WRITE_START_MISSING"] },
    { st: "OBSERVING", dstDep: "dep2", ds: new Date("invalid"), b: ["DESTINATION_WRITE_START_INVALID"] },
    { st: "CUTOVER", dstDep: "dep2", ds: new Date("2026-08-08T12:00:00Z"), b: ["DESTINATION_WRITE_START_FUTURE"] },
    { st: "OBSERVING", dstDep: "dep2", ds: new Date("2026-08-02T12:00:00Z"), b: ["HORIZON_BEFORE_DESTINATION_WRITES"] },
    { st: "CUTOVER", dstDep: "dep2", ds: new Date("2026-08-01T12:00:00Z"), b: [] },
    { st: "SHADOW", dstDep: null, ds: null, b: [] },
    { st: "SHADOW", dstDep: "dep2", ds: new Date("invalid"), b: ["DESTINATION_WRITE_START_INVALID"] },
    { st: "SHADOW", dstDep: "dep2", ds: new Date("2026-08-08T12:00:00Z"), b: ["DESTINATION_WRITE_START_FUTURE"] },
  ];
  it.each(dst)("dest state $st", ({ st, dstDep, ds, b }) => {
    const res = assessRuntimeRollback(
      { ...baseRec, status: st, destinationDeploymentId: dstDep, destinationWriteStartedAt: ds },
      ctx
    );
    if (b.length === 0) expect(res.rollbackReady).toBe(true);
    else expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
  });

  it("allows start before stop ordering", () => {
    const res = assessRuntimeRollback(
      { ...baseRec, status: "CUTOVER", sourceWriteStoppedAt: new Date("2026-08-01T13:00:00Z"), destinationWriteStartedAt: new Date("2026-08-01T10:00:00Z") },
      { ...ctx, requiredSourceFreshThroughAt: new Date("2026-08-01T10:00:00Z") }
    );
    expect(res.rollbackReady).toBe(true);
  });

  it("rejects year 9999 observation with same millisecond sub-ms fraction as future", () => {
    const res = assessRuntimeRollback(
      { ...baseRec, evidence: { ...baseEv, sourceRuntimeObservedAt: "9999-12-31T23:59:59.0009Z" } },
      { ...ctx, assessedAt: new Date("9999-12-31T23:59:59.000Z") }
    );
    expect(res.summary.blockerCodes).toContain("SOURCE_RUNTIME_OBSERVATION_FUTURE");
  });
});
