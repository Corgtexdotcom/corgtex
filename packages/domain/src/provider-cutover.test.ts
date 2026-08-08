import { describe, it, expect } from "vitest";
import { assessArchiveAvailability, assessRuntimeRollback } from "./provider-cutover";
import type { ArchiveAvailabilityBlockerCode, ArchiveAvailabilityRecord, ProviderCutoverRecord, RuntimeRollbackContext } from "./provider-cutover";

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
  sourceWriteStoppedAt: new Date("2026-08-01T13:00:00Z"),
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
    { n: "unknown offset", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-02T12:00:00-00:00" }, b: ["SOURCE_RUNTIME_OBSERVATION_INVALID"] },
    { n: "stale", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-07-30T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_STALE"] },
    { n: "future", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-08T12:00:00Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_FUTURE"] },
    { n: "fractional future", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-07T12:00:00.0009Z" }, b: ["SOURCE_RUNTIME_OBSERVATION_FUTURE"] },
    { n: "boundary", ev: { ...baseEv, sourceRuntimeObservedAt: "2026-08-01T12:00:00Z" }, b: [] },
  ];
  it.each(obs)("observation $n", ({ ev, b }) => {
    const res = assessRuntimeRollback({ ...baseRec, evidence: ev }, ctx);
    if (b.length === 0) expect(res.rollbackReady).toBe(true);
    else expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
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
    if (b.length === 0) expect(res.rollbackReady).toBe(true);
    else expect(res.summary.blockerCodes).toEqual(expect.arrayContaining(b));
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
    { st: "SHADOW", dstDep: "dep1", ds: new Date("2026-08-01T12:00:00Z"), b: ["INVALID_IDENTITY"] },
    { st: "SHADOW", dstDep: null, ds: new Date("2026-08-01T12:00:00Z"), b: ["INVALID_IDENTITY"] },
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

  it("rejects year 9999 observation with same millisecond sub-ms fraction as future", () => {
    const res = assessRuntimeRollback(
      { ...baseRec, evidence: { ...baseEv, sourceRuntimeObservedAt: "9999-12-31T23:59:59.0009Z" } },
      { ...ctx, assessedAt: new Date("9999-12-31T23:59:59.000Z") }
    );
    expect(res.summary.blockerCodes).toContain("SOURCE_RUNTIME_OBSERVATION_FUTURE");
  });
});

const archiveAt = (hour: number) => new Date(`2026-08-07T${String(hour).padStart(2, "0")}:00:00Z`);
const archiveContext = { assessedAt: archiveAt(14) };
const archiveBase: ArchiveAvailabilityRecord = {
  ...baseRec,
  status: "DELETE_ELIGIBLE",
  sourceWriteStoppedAt: archiveAt(10),
  destinationWriteStartedAt: archiveAt(9),
  finalSnapshotAt: archiveAt(11),
  finalSnapshotChecksum: "a".repeat(64),
  archiveRestoreTestedAt: archiveAt(12),
};
const archiveAssessment = (
  patch: Partial<ArchiveAvailabilityRecord> = {},
  context = archiveContext
) => assessArchiveAvailability({ ...archiveBase, ...patch }, context);

describe("assessArchiveAvailability", () => {
  const statuses = ["PLANNED", "SHADOW", "CUTOVER", "OBSERVING", "ARCHIVE_ONLY", "DELETE_ELIGIBLE", "DELETED", "ROLLED_BACK"];
  it.each(statuses)("keeps complete and incomplete proof evidence-driven in %s", (status) => {
    const destinationless = ["PLANNED", "SHADOW", "ROLLED_BACK"].includes(status);
    const identity = { status, destinationDeploymentId: destinationless ? null : "dep2" };
    expect(archiveAssessment(identity)).toMatchObject({ archiveAvailable: true, summary: { blockerCodes: [] } });
    expect(archiveAssessment({ ...identity, finalSnapshotAt: null }).archiveAvailable).toBe(false);
  });

  const providerPairs = [
    ["RAILWAY", "AZURE"], ["RAILWAY", "SELF_HOSTED"], ["AZURE", "RAILWAY"],
    ["AZURE", "SELF_HOSTED"], ["SELF_HOSTED", "RAILWAY"], ["SELF_HOSTED", "AZURE"],
  ];
  it.each(providerPairs)("accepts provider pair %s/%s", (sourceProvider, destinationProvider) => {
    expect(archiveAssessment({ sourceProvider, destinationProvider }).archiveAvailable).toBe(true);
  });

  it.each(["CUTOVER", "OBSERVING", "ARCHIVE_ONLY", "DELETE_ELIGIBLE", "DELETED"])(
    "requires a destination in %s", (status) => {
      expect(archiveAssessment({ status, destinationDeploymentId: null }).summary.blockerCodes)
        .toEqual(["INVALID_IDENTITY"]);
    });

  it("normalizes only invalid enum-like identity values", () => {
    expect(archiveAssessment({ status: "UNKNOWN" }).summary).toMatchObject({
      status: null, sourceProvider: "RAILWAY", destinationProvider: "AZURE", blockerCodes: ["INVALID_IDENTITY"],
    });
    for (const [sourceProvider, destinationProvider] of [["UNKNOWN", "AZURE"], ["RAILWAY", "ARBITRARY"], ["AZURE", "AZURE"]]) {
      expect(archiveAssessment({ sourceProvider, destinationProvider }).summary).toMatchObject({
        status: "DELETE_ELIGIBLE", sourceProvider: null, destinationProvider: null, blockerCodes: ["INVALID_IDENTITY"],
      });
    }
    const equalDeployments = archiveAssessment({ destinationDeploymentId: "dep1" }).summary;
    expect(equalDeployments).toMatchObject({ sourceProvider: "RAILWAY", destinationProvider: "AZURE", blockerCodes: ["INVALID_IDENTITY"] });
  });

  it("fails invalid context before proof inspection and accepts exact boundaries", () => {
    const badProof = { sourceWriteStoppedAt: null, finalSnapshotAt: null, archiveRestoreTestedAt: null };
    expect(archiveAssessment(badProof, { assessedAt: new Date("invalid") }).summary.blockerCodes)
      .toEqual(["INVALID_CONTEXT"]);
    expect(archiveAssessment(badProof, { assessedAt: "not-a-date" as unknown as Date }).summary.blockerCodes)
      .toEqual(["INVALID_CONTEXT"]);
    expect(archiveAssessment({ sourceWriteStoppedAt: archiveAt(14), finalSnapshotAt: archiveAt(14),
      archiveRestoreTestedAt: archiveAt(14) }).archiveAvailable).toBe(true);
  });

  const proofFailures: [string, Partial<ArchiveAvailabilityRecord>, ArchiveAvailabilityBlockerCode][] = [
    ["stop missing", { sourceWriteStoppedAt: null }, "SOURCE_WRITE_STOP_INVALID"],
    ["stop non-date", { sourceWriteStoppedAt: "bad" as unknown as Date }, "SOURCE_WRITE_STOP_INVALID"],
    ["stop invalid", { sourceWriteStoppedAt: new Date("invalid") }, "SOURCE_WRITE_STOP_INVALID"],
    ["stop future", { sourceWriteStoppedAt: archiveAt(15) }, "SOURCE_WRITE_STOP_FUTURE"],
    ["snapshot missing", { finalSnapshotAt: null }, "FINAL_SNAPSHOT_INVALID"],
    ["snapshot non-date", { finalSnapshotAt: "bad" as unknown as Date }, "FINAL_SNAPSHOT_INVALID"],
    ["snapshot invalid", { finalSnapshotAt: new Date("invalid") }, "FINAL_SNAPSHOT_INVALID"],
    ["snapshot future", { finalSnapshotAt: archiveAt(15) }, "FINAL_SNAPSHOT_FUTURE"],
    ["snapshot before stop", { finalSnapshotAt: archiveAt(9) }, "FINAL_SNAPSHOT_BEFORE_WRITE_STOP"],
    ["restore missing", { archiveRestoreTestedAt: null }, "ARCHIVE_RESTORE_TEST_INVALID"],
    ["restore non-date", { archiveRestoreTestedAt: "bad" as unknown as Date }, "ARCHIVE_RESTORE_TEST_INVALID"],
    ["restore invalid", { archiveRestoreTestedAt: new Date("invalid") }, "ARCHIVE_RESTORE_TEST_INVALID"],
    ["restore future", { archiveRestoreTestedAt: archiveAt(15) }, "ARCHIVE_RESTORE_TEST_FUTURE"],
    ["restore before snapshot", { archiveRestoreTestedAt: archiveAt(10) }, "ARCHIVE_RESTORE_TEST_BEFORE_SNAPSHOT"],
  ];
  it.each(proofFailures)("fails closed for %s", (_name, patch, blocker) => {
    const result = archiveAssessment(patch);
    expect(result.archiveAvailable).toBe(false);
    expect(result.summary.blockerCodes).toContain(blocker);
  });

  it.each([
    "A".repeat(64), "a".repeat(63), "a".repeat(65), `0x${"a".repeat(64)}`,
    ` ${"a".repeat(64)}`, `${"a".repeat(64)} `, "", null, 64,
  ])("rejects malformed checksum %#", (finalSnapshotChecksum) => {
    expect(archiveAssessment({ finalSnapshotChecksum: finalSnapshotChecksum as string | null }).summary.blockerCodes)
      .toEqual(["FINAL_SNAPSHOT_CHECKSUM_INVALID"]);
  });

  it("deduplicates blockers in fixed order and skips proof for invalid identity/context", () => {
    const result = archiveAssessment({ sourceWriteStoppedAt: archiveAt(15), finalSnapshotAt: new Date("invalid"),
      finalSnapshotChecksum: "bad", archiveRestoreTestedAt: archiveAt(15) });
    expect(result.summary.blockerCodes).toEqual(["SOURCE_WRITE_STOP_FUTURE", "FINAL_SNAPSHOT_INVALID",
      "FINAL_SNAPSHOT_CHECKSUM_INVALID", "ARCHIVE_RESTORE_TEST_FUTURE"]);
    const skipped = archiveAssessment({ status: "UNKNOWN", sourceWriteStoppedAt: null,
      finalSnapshotAt: null, archiveRestoreTestedAt: null }, { assessedAt: new Date("invalid") });
    expect(skipped.summary.blockerCodes).toEqual(["INVALID_IDENTITY", "INVALID_CONTEXT"]);
  });

  it("is independent from runtime fields, destination-write timing, and raw evidence", () => {
    const baseline = archiveAssessment().summary;
    const variants: Partial<ArchiveAvailabilityRecord>[] = [
      { evidence: { sourceRuntimeHealthy: true } }, { evidence: { sourceRuntimeHealthy: false } }, { evidence: {} },
      { evidence: { sourceRuntimeObservedAt: "stale" } }, { evidence: { sourceRuntimeObservedAt: "2999-01-01T00:00:00Z" } },
      { evidence: { destinationWritesCompatible: false, arbitrary: "changed" } },
      { sourceDataFreshThroughAt: null }, { sourceDataFreshThroughAt: new Date("invalid") },
      { destinationWriteStartedAt: null }, { destinationWriteStartedAt: new Date("invalid") },
    ];
    for (const variant of variants) expect(archiveAssessment(variant).summary).toEqual(baseline);
  });

  it("compares equivalent Date instants without parsing input strings", () => {
    const instant = new Date("2026-08-07T10:00:00-04:00");
    expect(archiveAssessment({ sourceWriteStoppedAt: instant, finalSnapshotAt: instant,
      archiveRestoreTestedAt: instant }).archiveAvailable).toBe(true);
  });

  it("returns exact keys and redacts hostile values", () => {
    const hostile = assessArchiveAvailability({ ...archiveBase, id: "HOSTILE_ID", customerAccountId: "HOSTILE_CUSTOMER",
      sourceDeploymentId: "HOSTILE_SOURCE", destinationDeploymentId: "HOSTILE_DESTINATION",
      finalSnapshotChecksum: "HOSTILE_CHECKSUM", evidence: { credential: "HOSTILE_SECRET", url: "HOSTILE_URL",
        objectName: "HOSTILE_OBJECT", reason: "HOSTILE_REASON", customerContent: "HOSTILE_CONTENT" },
      timestamp: "HOSTILE_TIMESTAMP", retentionWaiverReason: "HOSTILE_WAIVER", sourceDeletedAt: "HOSTILE_DELETION" } as
      ArchiveAvailabilityRecord & Record<string, unknown>, archiveContext);
    expect(Object.keys(hostile).sort()).toEqual(["archiveAvailable", "summary"]);
    expect(Object.keys(hostile.summary).sort()).toEqual([
      "archiveAvailable", "blockerCodes", "destinationProvider", "sourceProvider", "status",
    ]);
    expect(JSON.stringify(hostile)).not.toContain("HOSTILE");
  });
});
