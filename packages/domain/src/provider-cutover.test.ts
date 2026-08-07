import { describe, it, expect } from "vitest";
import { assessCutoverReadiness, ProviderCutoverRecord, CutoverAssessmentContext } from "./provider-cutover";

const assessedAt = new Date("2026-08-07T12:00:00.000Z");
const past = new Date(assessedAt.getTime() - 100000);
const future = new Date(assessedAt.getTime() + 100000);
const validChecksum = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const baseCtx: CutoverAssessmentContext = { assessedAt, requiredSourceFreshThroughAt: past, requiredSourceRuntimeObservedAt: past };
const buildRecord = (overrides: Partial<ProviderCutoverRecord> = {}): ProviderCutoverRecord => ({
  id: "r-1", customerAccountId: "a-1", sourceDeploymentId: "s-1", destinationDeploymentId: "d-1",
  sourceProvider: "AZURE", destinationProvider: "RAILWAY", status: "PLANNED",
  sourceWriteStoppedAt: null, destinationWriteStartedAt: null, finalSnapshotAt: null, finalSnapshotChecksum: null,
  sourceDataFreshThroughAt: null, observationCompletedAt: null, archiveRestoreTestedAt: null, archiveRetentionDeadline: null,
  retentionWaiverApprovedAt: null, retentionWaiverApprovedBy: null, retentionWaiverReason: null, sourceDeletedAt: null, evidence: null,
  reason: "Test", createdAt: past, updatedAt: past, ...overrides,
});

describe("assessCutoverReadiness", () => {
  it("rejects invalid identity", () => {
    expect(assessCutoverReadiness(buildRecord({ sourceProvider: "UNKNOWN" }), baseCtx).summary.blockerCodes).toContain("INVALID_IDENTITY");
    expect(assessCutoverReadiness(buildRecord({ sourceProvider: "AZURE", destinationProvider: "AZURE" }), baseCtx).summary.blockerCodes).toContain("INVALID_IDENTITY");
    expect(assessCutoverReadiness(buildRecord({ status: "MAGIC" }), baseCtx).summary.blockerCodes).toContain("INVALID_IDENTITY");
  });

  it("rejects invalid context and malformed dates", () => {
    expect(assessCutoverReadiness(buildRecord(), { ...baseCtx, assessedAt: "invalid" as any }).summary.blockerCodes).toContain("INVALID_CONTEXT");
    expect(assessCutoverReadiness(buildRecord(), { ...baseCtx, requiredSourceFreshThroughAt: future }).summary.blockerCodes).toContain("FUTURE_HORIZON");
    expect(assessCutoverReadiness(buildRecord({ sourceWriteStoppedAt: new Date("invalid") }), baseCtx).summary.blockerCodes).toContain("MALFORMED_RECORD_DATE");
  });

  describe("Rollback Readiness", () => {
    const validRollback = buildRecord({
      status: "SHADOW", sourceDataFreshThroughAt: assessedAt,
      evidence: { sourceRuntimeHealthy: true, destinationWritesCompatible: true, sourceRuntimeObservedAt: assessedAt.toISOString() },
    });

    it("accepts valid SHADOW/CUTOVER/OBSERVING", () => {
      expect(assessCutoverReadiness(validRollback, baseCtx).readiness.rollbackReady).toBe(true);
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "CUTOVER", destinationWriteStartedAt: past }), baseCtx).readiness.rollbackReady).toBe(true);
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "OBSERVING", destinationWriteStartedAt: past }), baseCtx).readiness.rollbackReady).toBe(true);
    });

    it("rejects non-rollback statuses", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "PLANNED" }), baseCtx).readiness.rollbackReady).toBe(false);
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "ARCHIVE_ONLY" }), baseCtx).readiness.rollbackReady).toBe(false);
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "DELETE_ELIGIBLE" }), baseCtx).readiness.rollbackReady).toBe(false);
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "DELETED" }), baseCtx).readiness.rollbackReady).toBe(false);
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "ROLLED_BACK" }), baseCtx).readiness.rollbackReady).toBe(false);
    });

    it("rejects when source runtime is down or unobserved", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, evidence: { ...validRollback.evidence!, sourceRuntimeHealthy: false } }), baseCtx).summary.blockerCodes).toContain("SOURCE_RUNTIME_DOWN");
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, evidence: { ...validRollback.evidence!, sourceRuntimeObservedAt: new Date(0).toISOString() } }), baseCtx).summary.blockerCodes).toContain("SOURCE_RUNTIME_UNOBSERVED");
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, evidence: { ...validRollback.evidence!, sourceRuntimeObservedAt: "Tue Aug 07 2026" } }), baseCtx).summary.blockerCodes).toContain("SOURCE_RUNTIME_UNOBSERVED");
    });

    it("rejects when destination writes incompatible or source data stale/future", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, evidence: { ...validRollback.evidence!, destinationWritesCompatible: false } }), baseCtx).summary.blockerCodes).toContain("DESTINATION_WRITES_INCOMPATIBLE");
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, sourceDataFreshThroughAt: new Date(0) }), baseCtx).summary.blockerCodes).toContain("SOURCE_DATA_STALE");
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, sourceDataFreshThroughAt: future }), baseCtx).summary.blockerCodes).toContain("SOURCE_DATA_FUTURE");
    });

    it("rejects CUTOVER/OBSERVING when horizon is before destination writes started", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "CUTOVER", destinationWriteStartedAt: assessedAt }), baseCtx).summary.blockerCodes).toContain("HORIZON_BEFORE_DESTINATION_WRITES");
      expect(assessCutoverReadiness(buildRecord({ ...validRollback, status: "CUTOVER", destinationWriteStartedAt: null }), baseCtx).summary.blockerCodes).toContain("HORIZON_BEFORE_DESTINATION_WRITES");
    });
  });

  describe("Archive Availability", () => {
    const validArchive = buildRecord({ sourceWriteStoppedAt: past, finalSnapshotAt: past, finalSnapshotChecksum: validChecksum, archiveRestoreTestedAt: assessedAt });

    it("accepts valid archive", () => {
      expect(assessCutoverReadiness(validArchive, baseCtx).readiness.archiveAvailable).toBe(true);
    });

    it("rejects missing parts", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, sourceWriteStoppedAt: null }), baseCtx).summary.blockerCodes).toContain("MISSING_WRITE_STOP");
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, finalSnapshotAt: null }), baseCtx).summary.blockerCodes).toContain("MISSING_SNAPSHOT");
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, finalSnapshotChecksum: null }), baseCtx).summary.blockerCodes).toContain("MISSING_CHECKSUM");
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, finalSnapshotChecksum: "bad" }), baseCtx).summary.blockerCodes).toContain("MALFORMED_CHECKSUM");
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, archiveRestoreTestedAt: null }), baseCtx).summary.blockerCodes).toContain("MISSING_RESTORE");
    });

    it("rejects chronological contradictions", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, sourceWriteStoppedAt: assessedAt, finalSnapshotAt: past }), baseCtx).summary.blockerCodes).toContain("SNAPSHOT_BEFORE_STOP");
      expect(assessCutoverReadiness(buildRecord({ ...validArchive, finalSnapshotAt: assessedAt, archiveRestoreTestedAt: past }), baseCtx).summary.blockerCodes).toContain("RESTORE_BEFORE_SNAPSHOT");
    });
    
    it("source runtime down while archive remains available", () => {
      const rec = buildRecord({ ...validArchive, status: "SHADOW", evidence: { sourceRuntimeHealthy: false } });
      const res = assessCutoverReadiness(rec, baseCtx);
      expect(res.readiness.rollbackReady).toBe(false);
      expect(res.summary.blockerCodes).toContain("SOURCE_RUNTIME_DOWN");
      expect(res.readiness.archiveAvailable).toBe(true);
    });
  });

  describe("Delete Eligibility", () => {
    const validArchiveParams = { sourceWriteStoppedAt: past, finalSnapshotAt: past, finalSnapshotChecksum: validChecksum, archiveRestoreTestedAt: past };
    const validDelete = buildRecord({ ...validArchiveParams, status: "DELETE_ELIGIBLE", observationCompletedAt: past, destinationWriteStartedAt: new Date(past.getTime() - 1000), archiveRetentionDeadline: past });

    it("accepts valid delete eligible via deadline", () => {
      expect(assessCutoverReadiness(validDelete, baseCtx).readiness.deleteEligible).toBe(true);
    });

    it("accepts valid delete eligible via waiver", () => {
      const validWaiver = buildRecord({ ...validDelete, archiveRetentionDeadline: null, retentionWaiverApprovedAt: past, retentionWaiverApprovedBy: "u1", retentionWaiverReason: "valid reason" });
      expect(assessCutoverReadiness(validWaiver, baseCtx).readiness.deleteEligible).toBe(true);
    });

    it("rejects incomplete or future waivers", () => {
      const incomplete = assessCutoverReadiness(buildRecord({ ...validDelete, retentionWaiverApprovedAt: past, retentionWaiverApprovedBy: null }), baseCtx);
      expect(incomplete.summary.blockerCodes).toContain("WAIVER_INCOMPLETE");
      expect(incomplete.readiness.deleteEligible).toBe(false);
      
      const blankStr = assessCutoverReadiness(buildRecord({ ...validDelete, retentionWaiverApprovedAt: past, retentionWaiverApprovedBy: "  ", retentionWaiverReason: "" }), baseCtx);
      expect(blankStr.summary.blockerCodes).toContain("WAIVER_INCOMPLETE");
      expect(blankStr.readiness.deleteEligible).toBe(false);

      const futWaiver = assessCutoverReadiness(buildRecord({ ...validDelete, retentionWaiverApprovedAt: future, retentionWaiverApprovedBy: "u1", retentionWaiverReason: "reason" }), baseCtx);
      expect(futWaiver.summary.blockerCodes).toContain("WAIVER_FUTURE");
      expect(futWaiver.readiness.deleteEligible).toBe(false);
    });

    it("rejects missing/invalid observation", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, observationCompletedAt: null }), baseCtx).summary.blockerCodes).toContain("MISSING_OBSERVATION");
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, observationCompletedAt: past, destinationWriteStartedAt: assessedAt }), baseCtx).summary.blockerCodes).toContain("OBSERVATION_BEFORE_DESTINATION_WRITES");
    });
    
    it("accepts valid dual-write ordering (destination started before source stopped)", () => {
        const dualWriteDelete = buildRecord({
            ...validDelete,
            destinationWriteStartedAt: new Date(past.getTime() - 2000),
            sourceWriteStoppedAt: past
        });
        expect(assessCutoverReadiness(dualWriteDelete, baseCtx).readiness.deleteEligible).toBe(true);
    });

    it("rejects chronological contradictions in retention deadline", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, archiveRetentionDeadline: new Date(past.getTime() - 10000) }), baseCtx).summary.blockerCodes).toContain("DEADLINE_BEFORE_SNAPSHOT");
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, archiveRetentionDeadline: future }), baseCtx).summary.blockerCodes).toContain("RETENTION_NOT_REACHED");
    });

    it("handles DELETED status correctly", () => {
      expect(assessCutoverReadiness(buildRecord({ status: "DELETED", sourceDeletedAt: null }), baseCtx).summary.blockerCodes).toContain("MISSING_DELETION_EVIDENCE");
      expect(assessCutoverReadiness(buildRecord({ status: "DELETED", sourceDeletedAt: null }), baseCtx).readiness.deleteEligible).toBe(false);
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, status: "DELETED", sourceDeletedAt: assessedAt }), baseCtx).readiness.deleteEligible).toBe(false);
    });

    it("rejects contradictory deletion dates", () => {
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, status: "SHADOW", sourceDeletedAt: assessedAt }), baseCtx).summary.blockerCodes).toContain("CONTRADICTORY_DELETION");
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, status: "DELETED", sourceDeletedAt: new Date(past.getTime() - 10000) }), baseCtx).summary.blockerCodes).toContain("CONTRADICTORY_DELETION");
      expect(assessCutoverReadiness(buildRecord({ ...validDelete, status: "DELETED", sourceDeletedAt: new Date(past.getTime() - 1000), archiveRestoreTestedAt: past }), baseCtx).summary.blockerCodes).toContain("CONTRADICTORY_DELETION");
    });
  });
  
  describe("Future Evidence Rejection (P1 Deletion Safety)", () => {
      it("rejects direct counterexample: operational evidence after assessedAt fails archive and deletion", () => {
          const t1 = new Date(assessedAt.getTime() + 1000);
          const t2 = new Date(assessedAt.getTime() + 2000);
          const t3 = new Date(assessedAt.getTime() + 3000);
          const t4 = new Date(assessedAt.getTime() + 4000);
          const badRecord = buildRecord({
             status: "DELETE_ELIGIBLE",
             sourceWriteStoppedAt: t1,
             finalSnapshotAt: t2,
             finalSnapshotChecksum: validChecksum,
             archiveRestoreTestedAt: t3,
             observationCompletedAt: t4,
             destinationWriteStartedAt: past,
             retentionWaiverApprovedAt: past,
             retentionWaiverApprovedBy: "u1",
             retentionWaiverReason: "valid"
          });
          
          const res = assessCutoverReadiness(badRecord, baseCtx);
          expect(res.summary.blockerCodes).toContain("FUTURE_EVIDENCE");
          expect(res.readiness.archiveAvailable).toBe(false);
          expect(res.readiness.deleteEligible).toBe(false);
      });
      
      it("rejects single piece of future evidence", () => {
         const baseArchive = buildRecord({
             sourceWriteStoppedAt: past, finalSnapshotAt: past, finalSnapshotChecksum: validChecksum, archiveRestoreTestedAt: past 
         });
         
         const futStop = assessCutoverReadiness(buildRecord({...baseArchive, sourceWriteStoppedAt: future}), baseCtx);
         expect(futStop.summary.blockerCodes).toContain("FUTURE_EVIDENCE");
         expect(futStop.readiness.archiveAvailable).toBe(false);
         
         const futSnap = assessCutoverReadiness(buildRecord({...baseArchive, finalSnapshotAt: future}), baseCtx);
         expect(futSnap.summary.blockerCodes).toContain("FUTURE_EVIDENCE");
         expect(futSnap.readiness.archiveAvailable).toBe(false);
         
         const futRest = assessCutoverReadiness(buildRecord({...baseArchive, archiveRestoreTestedAt: future}), baseCtx);
         expect(futRest.summary.blockerCodes).toContain("FUTURE_EVIDENCE");
         expect(futRest.readiness.archiveAvailable).toBe(false);
         
         const futObs = assessCutoverReadiness(buildRecord({...baseArchive, status: "DELETE_ELIGIBLE", observationCompletedAt: future, destinationWriteStartedAt: past, retentionWaiverApprovedAt: past, retentionWaiverApprovedBy: "u", retentionWaiverReason: "r"}), baseCtx);
         expect(futObs.summary.blockerCodes).toContain("FUTURE_EVIDENCE");
         expect(futObs.readiness.deleteEligible).toBe(false);
         
         const futDel = assessCutoverReadiness(buildRecord({...baseArchive, status: "DELETED", sourceDeletedAt: future}), baseCtx);
         expect(futDel.summary.blockerCodes).toContain("FUTURE_EVIDENCE");
         expect(futDel.readiness.deleteEligible).toBe(false); // DELETED is never eligible anyway, but just checking it gets blocker
      });
  });

  describe("Sanitized Summary", () => {
    it("exact summary key equality and redaction", () => {
      const res = assessCutoverReadiness(buildRecord({ id: "sec-id", evidence: { hostiletrait: "secret-value" }, reason: "reason-string", retentionWaiverReason: "waiver-text" }), baseCtx);
      expect(Object.keys(res.summary)).toEqual(["status", "sourceProvider", "destinationProvider", "rollbackReady", "archiveAvailable", "deleteEligible", "observationCompletedAt", "archiveRetentionDeadline", "retentionWaiverPresent", "sourceDeletedAt", "blockerCodes"]);
      const jsonStr = JSON.stringify(res.summary);
      expect(jsonStr).not.toContain("sec-id");
      expect(jsonStr).not.toContain("secret-value");
      expect(jsonStr).not.toContain("reason-string");
      expect(jsonStr).not.toContain("waiver-text");
    });
    
    it("redacts boolean false values correctly without asserting output contains no 'f'", () => {
       const res = assessCutoverReadiness(buildRecord({ status: "PLANNED" }), baseCtx);
       const jsonStr = JSON.stringify(res.summary);
       expect(res.summary.rollbackReady).toBe(false);
       expect(res.summary.archiveAvailable).toBe(false);
       expect(res.summary.deleteEligible).toBe(false);
       // We DO NOT assert that jsonStr.indexOf("f") === -1 because false has 'f' in it
       // Ensure redaction of sensitive info instead
       expect(jsonStr).not.toContain("reason");
       expect(jsonStr).not.toContain("evidence");
    });
  });
});
