import { describe, it, expect } from "vitest";
import { assessArchiveAvailability, assessDeletionEligibility, assessRuntimeRollback } from "./provider-cutover";
import type { ArchiveAvailabilityBlockerCode, ArchiveAvailabilityRecord, DeletionEligibilityBlockerCode,
  DeletionEligibilityRecord, ProviderCutoverRecord, RuntimeRollbackContext } from "./provider-cutover";

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
    ["future stop after snapshot", { sourceWriteStoppedAt: archiveAt(15), finalSnapshotAt: archiveAt(13), archiveRestoreTestedAt: archiveAt(13) },
      ["SOURCE_WRITE_STOP_FUTURE", "FINAL_SNAPSHOT_BEFORE_WRITE_STOP"]],
    ["future stop after future snapshot", { sourceWriteStoppedAt: archiveAt(16), finalSnapshotAt: archiveAt(15), archiveRestoreTestedAt: archiveAt(17) },
      ["SOURCE_WRITE_STOP_FUTURE", "FINAL_SNAPSHOT_FUTURE", "FINAL_SNAPSHOT_BEFORE_WRITE_STOP", "ARCHIVE_RESTORE_TEST_FUTURE"]],
    ["future snapshot after restore", { finalSnapshotAt: archiveAt(15), archiveRestoreTestedAt: archiveAt(13) },
      ["FINAL_SNAPSHOT_FUTURE", "ARCHIVE_RESTORE_TEST_BEFORE_SNAPSHOT"]],
    ["future snapshot after future restore", { finalSnapshotAt: archiveAt(16), archiveRestoreTestedAt: archiveAt(15) },
      ["FINAL_SNAPSHOT_FUTURE", "ARCHIVE_RESTORE_TEST_FUTURE", "ARCHIVE_RESTORE_TEST_BEFORE_SNAPSHOT"]],
  ] as [string, Partial<ArchiveAvailabilityRecord>, ArchiveAvailabilityBlockerCode[]][])("reports future and causal blockers: %s", (_name, patch, blockers) => {
    expect(archiveAssessment(patch).summary.blockerCodes).toEqual(blockers);
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

const deletionBase: DeletionEligibilityRecord = {
  ...archiveBase, evidence: { ...baseEv, runtimeRollbackClaimed: false },
  observationCompletedAt: archiveAt(13), archiveRetentionDeadline: archiveAt(14),
  retentionWaiverApprovedAt: null, retentionWaiverApprovedBy: null,
  retentionWaiverReason: null, sourceDeletedAt: null,
};
const deletionAssessment = (patch: Record<string, unknown> = {}, context = archiveContext) =>
  assessDeletionEligibility({ ...deletionBase, ...patch } as DeletionEligibilityRecord, context);
const deletionCodes = (patch: Record<string, unknown> = {}, context = archiveContext) =>
  deletionAssessment(patch, context).summary.blockerCodes;

describe("assessDeletionEligibility", () => {
  const lifecycle = ["PLANNED", "SHADOW", "CUTOVER", "OBSERVING", "ARCHIVE_ONLY",
    "DELETE_ELIGIBLE", "DELETED", "ROLLED_BACK"];
  it.each(lifecycle)("gates complete proof in %s", (status) => {
    const result = deletionAssessment({ status, sourceDeletedAt: status === "DELETED" ? archiveAt(14) : null });
    expect(result.deleteEligible).toBe(status === "DELETE_ELIGIBLE");
    expect(result.summary.blockerCodes).toEqual(status === "DELETE_ELIGIBLE" ? [] : ["STATUS_NOT_DELETE_ELIGIBLE"]);
  });

  it("propagates every archive blocker once across deletion evidence and short-circuits unsafe inputs", () => {
    const archiveCases: [Record<string, unknown>, ArchiveAvailabilityBlockerCode][] = [
      [{ sourceWriteStoppedAt: null }, "SOURCE_WRITE_STOP_INVALID"], [{ sourceWriteStoppedAt: archiveAt(15) }, "SOURCE_WRITE_STOP_FUTURE"],
      [{ finalSnapshotAt: null }, "FINAL_SNAPSHOT_INVALID"], [{ finalSnapshotAt: archiveAt(15) }, "FINAL_SNAPSHOT_FUTURE"],
      [{ finalSnapshotAt: archiveAt(9) }, "FINAL_SNAPSHOT_BEFORE_WRITE_STOP"], [{ finalSnapshotChecksum: "bad" }, "FINAL_SNAPSHOT_CHECKSUM_INVALID"],
      [{ archiveRestoreTestedAt: null }, "ARCHIVE_RESTORE_TEST_INVALID"], [{ archiveRestoreTestedAt: archiveAt(15) }, "ARCHIVE_RESTORE_TEST_FUTURE"],
      [{ archiveRestoreTestedAt: archiveAt(10) }, "ARCHIVE_RESTORE_TEST_BEFORE_SNAPSHOT"],
    ];
    for (const [patch, blocker] of archiveCases) for (const runtimeRollbackClaimed of [false, true]) {
      const record = { ...deletionBase, ...patch, evidence: { runtimeRollbackClaimed } } as DeletionEligibilityRecord;
      const archiveBlockers = assessArchiveAvailability(record, archiveContext).summary.blockerCodes;
      const observed = deletionCodes({ ...patch, evidence: { runtimeRollbackClaimed } });
      expect(observed.slice(0, archiveBlockers.length)).toEqual(archiveBlockers);
      expect(observed.filter((code) => code === blocker)).toHaveLength(1);
    }
    expect(deletionCodes({ status: "UNKNOWN", observationCompletedAt: null })).toEqual(["INVALID_IDENTITY"]);
    expect(deletionAssessment({ status: "UNKNOWN" }, { assessedAt: new Date("invalid") }).summary).toMatchObject({
      status: null, sourceProvider: "RAILWAY", destinationProvider: "AZURE", blockerCodes: ["INVALID_IDENTITY", "INVALID_CONTEXT"],
    });
  });

  it.each([
    ["destination missing", { destinationWriteStartedAt: null }, ["DESTINATION_WRITE_START_MISSING"]],
    ["destination invalid", { destinationWriteStartedAt: "bad" }, ["DESTINATION_WRITE_START_INVALID"]],
    ["destination invalid date", { destinationWriteStartedAt: new Date("invalid") }, ["DESTINATION_WRITE_START_INVALID"]],
    ["future destination stays causal", { destinationWriteStartedAt: archiveAt(15), observationCompletedAt: archiveAt(13) }, ["DESTINATION_WRITE_START_FUTURE", "OBSERVATION_BEFORE_DESTINATION_WRITE_START"]],
    ["observation missing", { observationCompletedAt: null }, ["OBSERVATION_COMPLETION_INVALID"]],
    ["observation non-date", { observationCompletedAt: "bad" }, ["OBSERVATION_COMPLETION_INVALID"]],
    ["observation invalid", { observationCompletedAt: new Date("invalid") }, ["OBSERVATION_COMPLETION_INVALID"]],
    ["future observation", { observationCompletedAt: archiveAt(15) }, ["OBSERVATION_COMPLETION_FUTURE"]],
    ["observation before both", { observationCompletedAt: archiveAt(8) }, ["OBSERVATION_BEFORE_SOURCE_WRITE_STOP", "OBSERVATION_BEFORE_DESTINATION_WRITE_START"]],
  ])("validates destination/observation: %s", (_name, patch, expected) => {
    expect(deletionCodes(patch as Record<string, unknown>)).toEqual(expect.arrayContaining(expected as DeletionEligibilityBlockerCode[]));
  });
  it("accepts destination, observation, and assessed-at equality boundaries", () => {
    expect(deletionCodes({ destinationWriteStartedAt: archiveAt(10), observationCompletedAt: archiveAt(10) })).toEqual([]);
    expect(deletionCodes({ observationCompletedAt: archiveAt(14) })).toEqual([]);
  });

  it("requires an own exact false runtime claim", () => {
    for (const evidence of [null, {}, Object.create({ runtimeRollbackClaimed: false }), { unrelated: false }])
      expect(deletionCodes({ evidence })).toContain("RUNTIME_ROLLBACK_CLAIM_MISSING");
    for (const value of [undefined, null, "false", 0])
      expect(deletionCodes({ evidence: { runtimeRollbackClaimed: value } })).toContain("RUNTIME_ROLLBACK_CLAIM_INVALID");
    expect(deletionCodes({ evidence: { runtimeRollbackClaimed: true } })).toContain("RUNTIME_ROLLBACK_CLAIMED");
    const nullPrototype = Object.assign(Object.create(null), { runtimeRollbackClaimed: false });
    expect(deletionCodes({ evidence: nullPrototype })).toEqual([]);
  });

  it("implements exact deadline and waiver OR precedence", () => {
    expect(deletionCodes({ archiveRetentionDeadline: null })).toEqual(["RETENTION_EVIDENCE_MISSING"]);
    expect(deletionCodes({ archiveRetentionDeadline: "bad" })).toContain("RETENTION_DEADLINE_INVALID");
    expect(deletionCodes({ archiveRetentionDeadline: new Date("invalid") })).toContain("RETENTION_DEADLINE_INVALID");
    expect(deletionCodes({ archiveRetentionDeadline: archiveAt(10) })).toContain("RETENTION_DEADLINE_BEFORE_FINAL_SNAPSHOT");
    expect(deletionCodes({ archiveRetentionDeadline: archiveAt(15) })).toContain("RETENTION_DEADLINE_NOT_REACHED");
    expect(deletionCodes({ archiveRetentionDeadline: archiveAt(11) })).toEqual([]);
    const partialWaivers = [
      [archiveAt(13), null, null], [null, "actor", null], [null, null, "reason"],
      [archiveAt(13), "actor", null], [archiveAt(13), null, "reason"], [null, "actor", "reason"],
    ];
    for (const [retentionWaiverApprovedAt, retentionWaiverApprovedBy, retentionWaiverReason] of partialWaivers)
      expect(deletionCodes({ archiveRetentionDeadline: null, retentionWaiverApprovedAt,
        retentionWaiverApprovedBy, retentionWaiverReason })).toEqual(["RETENTION_WAIVER_INCOMPLETE"]);
    const waiver = { retentionWaiverApprovedAt: archiveAt(13), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" };
    expect(deletionCodes({ ...waiver, archiveRetentionDeadline: null })).toEqual([]);
    expect(deletionCodes({ ...waiver, archiveRetentionDeadline: archiveAt(15) })).toEqual([]);
    expect(deletionCodes({ ...waiver, archiveRetentionDeadline: archiveAt(10) })).toEqual(["RETENTION_DEADLINE_BEFORE_FINAL_SNAPSHOT"]);
    expect(deletionCodes({ archiveRetentionDeadline: archiveAt(15), retentionWaiverApprovedAt: "bad",
      retentionWaiverApprovedBy: " ", retentionWaiverReason: "" })).toEqual(["RETENTION_DEADLINE_NOT_REACHED",
      "RETENTION_WAIVER_APPROVAL_INVALID", "RETENTION_WAIVER_ACTOR_INVALID", "RETENTION_WAIVER_REASON_INVALID"]);
  });

  it("does not let a valid waiver suppress an invalid supplied deadline", () => {
    expect(deletionCodes({ archiveRetentionDeadline: "bad", retentionWaiverApprovedAt: archiveAt(13),
      retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" })).toEqual(["RETENTION_DEADLINE_INVALID"]);
  });

  it("state-gates deletion history and uses the earliest valid retention milestone", () => {
    for (const status of lifecycle.filter((value) => value !== "DELETED")) for (const sourceDeletedAt of [archiveAt(13), "bad", new Date("invalid"), archiveAt(15)]) {
      const history = deletionCodes({ status, sourceDeletedAt }).filter((code) => code.startsWith("SOURCE_DELETION"));
      expect(history).toEqual(["SOURCE_DELETION_STATUS_CONTRADICTION"]);
    }
    for (const sourceDeletedAt of [null, "bad", new Date("invalid")]) expect(deletionCodes({ status: "DELETED", sourceDeletedAt })
      .filter((code) => code.startsWith("SOURCE_DELETION"))).toEqual(["SOURCE_DELETION_INVALID"]);
    expect(deletionCodes({ status: "DELETED", sourceDeletedAt: archiveAt(11) })).toEqual(["STATUS_NOT_DELETE_ELIGIBLE",
      "SOURCE_DELETION_BEFORE_OBSERVATION", "SOURCE_DELETION_BEFORE_ARCHIVE_RESTORE", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]);
    expect(deletionCodes({ status: "DELETED", sourceDeletedAt: archiveAt(15) })).toEqual(["STATUS_NOT_DELETE_ELIGIBLE", "SOURCE_DELETION_FUTURE"]);
    expect(deletionCodes({ status: "DELETED", sourceDeletedAt: archiveAt(13), archiveRetentionDeadline: archiveAt(13),
      retentionWaiverApprovedAt: archiveAt(14), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" }))
      .toEqual(["STATUS_NOT_DELETE_ELIGIBLE"]);
  });

  it.each([
    ["future observation remains causal for deletion", { status: "DELETED", observationCompletedAt: archiveAt(15), sourceDeletedAt: archiveAt(14) },
      ["STATUS_NOT_DELETE_ELIGIBLE", "OBSERVATION_COMPLETION_FUTURE", "SOURCE_DELETION_BEFORE_OBSERVATION"]],
    ["future restore propagates and remains causal", { status: "DELETED", archiveRestoreTestedAt: archiveAt(15), sourceDeletedAt: archiveAt(14) },
      ["ARCHIVE_RESTORE_TEST_FUTURE", "STATUS_NOT_DELETE_ELIGIBLE", "SOURCE_DELETION_BEFORE_ARCHIVE_RESTORE"]],
    ["deleted with absent retention", { status: "DELETED", sourceDeletedAt: archiveAt(14), archiveRetentionDeadline: null },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_EVIDENCE_MISSING", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["deleted with partial waiver", { status: "DELETED", sourceDeletedAt: archiveAt(14), archiveRetentionDeadline: null, retentionWaiverApprovedAt: archiveAt(13) },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_WAIVER_INCOMPLETE", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["deleted with invalid retention", { status: "DELETED", sourceDeletedAt: archiveAt(14), archiveRetentionDeadline: "bad", retentionWaiverApprovedAt: "bad", retentionWaiverApprovedBy: 7, retentionWaiverReason: {} },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_DEADLINE_INVALID", "RETENTION_WAIVER_APPROVAL_INVALID", "RETENTION_WAIVER_ACTOR_INVALID", "RETENTION_WAIVER_REASON_INVALID", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["future deadline is no milestone", { status: "DELETED", sourceDeletedAt: archiveAt(15), archiveRetentionDeadline: archiveAt(16) },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_DEADLINE_NOT_REACHED", "SOURCE_DELETION_FUTURE", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["future waiver is no milestone", { status: "DELETED", sourceDeletedAt: archiveAt(15), archiveRetentionDeadline: null, retentionWaiverApprovedAt: archiveAt(16), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_WAIVER_APPROVAL_FUTURE", "SOURCE_DELETION_FUTURE", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["reached deadline wins over future waiver", { status: "DELETED", sourceDeletedAt: archiveAt(13), archiveRetentionDeadline: archiveAt(13), retentionWaiverApprovedAt: archiveAt(15), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_WAIVER_APPROVAL_FUTURE"]],
    ["deletion before reached deadline still fails", { status: "DELETED", sourceDeletedAt: archiveAt(12), observationCompletedAt: archiveAt(12), archiveRetentionDeadline: archiveAt(13), retentionWaiverApprovedAt: archiveAt(15), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" },
      ["STATUS_NOT_DELETE_ELIGIBLE", "RETENTION_WAIVER_APPROVAL_FUTURE", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["waiver suppresses future deadline before approval", { status: "DELETED", sourceDeletedAt: archiveAt(12), observationCompletedAt: archiveAt(12), archiveRetentionDeadline: archiveAt(15), retentionWaiverApprovedAt: archiveAt(13), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" },
      ["STATUS_NOT_DELETE_ELIGIBLE", "SOURCE_DELETION_BEFORE_RETENTION_SATISFIED"]],
    ["waiver suppresses future deadline at approval", { status: "DELETED", sourceDeletedAt: archiveAt(13), archiveRetentionDeadline: archiveAt(15), retentionWaiverApprovedAt: archiveAt(13), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" }, ["STATUS_NOT_DELETE_ELIGIBLE"]],
    ["waiver-only and restore equality", { status: "DELETED", sourceDeletedAt: archiveAt(12), observationCompletedAt: archiveAt(12), archiveRetentionDeadline: null, retentionWaiverApprovedAt: archiveAt(12), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" }, ["STATUS_NOT_DELETE_ELIGIBLE"]],
    ["future observation compares to future prerequisites", { sourceWriteStoppedAt: archiveAt(17), destinationWriteStartedAt: archiveAt(16), finalSnapshotAt: archiveAt(17), archiveRestoreTestedAt: archiveAt(17), observationCompletedAt: archiveAt(15), archiveRetentionDeadline: null, retentionWaiverApprovedAt: archiveAt(14), retentionWaiverApprovedBy: "actor", retentionWaiverReason: "reason" },
      ["SOURCE_WRITE_STOP_FUTURE", "FINAL_SNAPSHOT_FUTURE", "ARCHIVE_RESTORE_TEST_FUTURE", "DESTINATION_WRITE_START_FUTURE", "OBSERVATION_COMPLETION_FUTURE", "OBSERVATION_BEFORE_SOURCE_WRITE_STOP", "OBSERVATION_BEFORE_DESTINATION_WRITE_START"]],
    ["noneligible status does not short-circuit", { status: "ARCHIVE_ONLY", destinationWriteStartedAt: archiveAt(15), observationCompletedAt: archiveAt(8), evidence: { runtimeRollbackClaimed: true }, archiveRetentionDeadline: archiveAt(15), sourceDeletedAt: "bad" },
      ["STATUS_NOT_DELETE_ELIGIBLE", "DESTINATION_WRITE_START_FUTURE", "OBSERVATION_BEFORE_SOURCE_WRITE_STOP", "OBSERVATION_BEFORE_DESTINATION_WRITE_START", "RUNTIME_ROLLBACK_CLAIMED", "RETENTION_DEADLINE_NOT_REACHED", "SOURCE_DELETION_STATUS_CONTRADICTION"]],
    ["stable order spans archive and deletion blockers", { status: "ARCHIVE_ONLY", sourceWriteStoppedAt: archiveAt(15), finalSnapshotAt: archiveAt(14), archiveRestoreTestedAt: archiveAt(15), destinationWriteStartedAt: archiveAt(16), observationCompletedAt: archiveAt(13), evidence: { runtimeRollbackClaimed: true }, archiveRetentionDeadline: archiveAt(10), retentionWaiverApprovedAt: archiveAt(15), retentionWaiverApprovedBy: " ", retentionWaiverReason: "", sourceDeletedAt: "bad" },
      ["SOURCE_WRITE_STOP_FUTURE", "FINAL_SNAPSHOT_BEFORE_WRITE_STOP", "ARCHIVE_RESTORE_TEST_FUTURE", "STATUS_NOT_DELETE_ELIGIBLE", "DESTINATION_WRITE_START_FUTURE", "OBSERVATION_BEFORE_SOURCE_WRITE_STOP", "OBSERVATION_BEFORE_DESTINATION_WRITE_START", "RUNTIME_ROLLBACK_CLAIMED", "RETENTION_DEADLINE_BEFORE_FINAL_SNAPSHOT", "RETENTION_WAIVER_APPROVAL_FUTURE", "RETENTION_WAIVER_ACTOR_INVALID", "RETENTION_WAIVER_REASON_INVALID", "SOURCE_DELETION_STATUS_CONTRADICTION"]],
  ] as [string, Record<string, unknown>, DeletionEligibilityBlockerCode[]][]) ("covers mandatory cross-product: %s", (_name, patch, expected) => {
    expect(deletionCodes(patch)).toEqual(expected);
  });

  it("returns exact sanitized keys and stable blocker order", () => {
    const result = deletionAssessment({ id: "HOSTILE_ID", customerAccountId: "HOSTILE_CUSTOMER",
      finalSnapshotChecksum: "HOSTILE_CHECKSUM", retentionWaiverApprovedBy: "HOSTILE_WAIVER_ACTOR",
      retentionWaiverReason: "HOSTILE_WAIVER_REASON", archiveRetentionDeadline: archiveAt(15),
      retentionWaiverApprovedAt: "bad", evidence: { runtimeRollbackClaimed: true,
        credential: "HOSTILE_EVIDENCE_CREDENTIAL", url: "HOSTILE_EVIDENCE_URL", raw: "HOSTILE_EVIDENCE_RAW" },
      destinationWriteStartedAt: archiveAt(15), observationCompletedAt: archiveAt(13), sourceDeletedAt: "HOSTILE_DELETION",
      credential: "HOSTILE_CREDENTIAL", url: "HOSTILE_URL", objectName: "HOSTILE_OBJECT",
      timestamp: "HOSTILE_TIMESTAMP", customerContent: "HOSTILE_CONTENT" });
    expect(result.summary.blockerCodes).toEqual(["FINAL_SNAPSHOT_CHECKSUM_INVALID", "DESTINATION_WRITE_START_FUTURE", "OBSERVATION_BEFORE_DESTINATION_WRITE_START",
      "RUNTIME_ROLLBACK_CLAIMED", "RETENTION_DEADLINE_NOT_REACHED", "RETENTION_WAIVER_APPROVAL_INVALID",
      "SOURCE_DELETION_STATUS_CONTRADICTION"]);
    expect(Object.keys(result)).toEqual(["deleteEligible", "summary"]);
    expect(Object.keys(result.summary).sort()).toEqual(["blockerCodes", "deleteEligible", "destinationProvider", "sourceProvider", "status"]);
    expect(JSON.stringify(result)).not.toContain("HOSTILE");
  });
});
