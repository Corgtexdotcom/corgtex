export type ProviderCutoverRecord = {
  id: string; customerAccountId: string; sourceDeploymentId: string; destinationDeploymentId: string | null;
  sourceProvider: string; destinationProvider: string; status: string;
  sourceWriteStoppedAt: Date | null; destinationWriteStartedAt: Date | null;
  finalSnapshotAt: Date | null; finalSnapshotChecksum: string | null;
  sourceDataFreshThroughAt: Date | null; observationCompletedAt: Date | null;
  archiveRestoreTestedAt: Date | null; archiveRetentionDeadline: Date | null;
  retentionWaiverApprovedAt: Date | null; retentionWaiverApprovedBy: string | null; retentionWaiverReason: string | null;
  sourceDeletedAt: Date | null; evidence: Record<string, unknown> | null; reason: string; createdAt: Date; updatedAt: Date;
};

export type CutoverAssessmentContext = { assessedAt: Date; requiredSourceFreshThroughAt: Date; requiredSourceRuntimeObservedAt: Date; };

export type CutoverReadinessAssessment = { rollbackReady: boolean; archiveAvailable: boolean; deleteEligible: boolean; };

export type CutoverBlockerCode =
  | "INVALID_IDENTITY" | "INVALID_CONTEXT" | "MALFORMED_RECORD_DATE" | "FUTURE_HORIZON"
  | "SOURCE_RUNTIME_DOWN" | "SOURCE_RUNTIME_UNOBSERVED" | "DESTINATION_WRITES_INCOMPATIBLE"
  | "SOURCE_DATA_STALE" | "SOURCE_DATA_FUTURE" | "HORIZON_BEFORE_DESTINATION_WRITES"
  | "MISSING_WRITE_STOP" | "MISSING_SNAPSHOT" | "MISSING_CHECKSUM" | "MALFORMED_CHECKSUM"
  | "MISSING_RESTORE" | "SNAPSHOT_BEFORE_STOP" | "RESTORE_BEFORE_SNAPSHOT" | "MISSING_OBSERVATION"
  | "OBSERVATION_BEFORE_DESTINATION_WRITES" | "WAIVER_INCOMPLETE" | "WAIVER_FUTURE"
  | "DEADLINE_BEFORE_SNAPSHOT" | "RETENTION_NOT_REACHED" | "CONTRADICTORY_DELETION" | "MISSING_DELETION_EVIDENCE";

export type SanitizedCutoverSummary = {
  status: string | null; sourceProvider: string | null; destinationProvider: string | null;
  rollbackReady: boolean; archiveAvailable: boolean; deleteEligible: boolean;
  observationCompletedAt: Date | null; archiveRetentionDeadline: Date | null;
  retentionWaiverPresent: boolean; sourceDeletedAt: Date | null; blockerCodes: CutoverBlockerCode[];
};

const VALID_PROVIDERS = new Set(["RAILWAY", "AZURE", "SELF_HOSTED"]);
const VALID_STATUSES = new Set(["PLANNED", "SHADOW", "CUTOVER", "OBSERVING", "ARCHIVE_ONLY", "DELETE_ELIGIBLE", "DELETED", "ROLLED_BACK"]);

const okD = (d: unknown): d is Date => d instanceof Date && !isNaN(d.getTime());
const okND = (d: unknown): boolean => d === null || okD(d);
const isRfc3339 = (s: unknown): boolean => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s);

function fail(s: string | null, sp: string | null, dp: string | null, b: Set<CutoverBlockerCode>) {
  return {
    readiness: { rollbackReady: false, archiveAvailable: false, deleteEligible: false },
    summary: {
      status: s, sourceProvider: sp, destinationProvider: dp,
      rollbackReady: false, archiveAvailable: false, deleteEligible: false,
      observationCompletedAt: null, archiveRetentionDeadline: null,
      retentionWaiverPresent: false, sourceDeletedAt: null,
      blockerCodes: Array.from(b).sort(),
    },
  };
}

export function assessCutoverReadiness(r: ProviderCutoverRecord, c: CutoverAssessmentContext): { readiness: CutoverReadinessAssessment; summary: SanitizedCutoverSummary } {
  const b = new Set<CutoverBlockerCode>();

  if (!okD(c.assessedAt) || !okD(c.requiredSourceFreshThroughAt) || !okD(c.requiredSourceRuntimeObservedAt)) {
    b.add("INVALID_CONTEXT"); return fail(null, null, null, b);
  }
  if (c.requiredSourceFreshThroughAt.getTime() > c.assessedAt.getTime() || c.requiredSourceRuntimeObservedAt.getTime() > c.assessedAt.getTime()) {
    b.add("FUTURE_HORIZON"); return fail(null, null, null, b);
  }

  const recordDates = [
    r.sourceWriteStoppedAt, r.destinationWriteStartedAt, r.finalSnapshotAt, r.sourceDataFreshThroughAt,
    r.observationCompletedAt, r.archiveRestoreTestedAt, r.archiveRetentionDeadline,
    r.retentionWaiverApprovedAt, r.sourceDeletedAt, r.createdAt, r.updatedAt
  ];
  if (!recordDates.every(okND)) {
    b.add("MALFORMED_RECORD_DATE"); return fail(null, null, null, b);
  }

  const ss = VALID_STATUSES.has(r.status) ? r.status : null;
  const sp = VALID_PROVIDERS.has(r.sourceProvider) ? r.sourceProvider : null;
  const dp = VALID_PROVIDERS.has(r.destinationProvider) ? r.destinationProvider : null;
  if (!ss || !sp || !dp || sp === dp) {
    b.add("INVALID_IDENTITY"); return fail(ss, sp, dp, b);
  }

  let rr = false, aa = false, de = false;
  if (["SHADOW", "CUTOVER", "OBSERVING"].includes(ss)) {
    const ev = r.evidence || {};
    const hl = ev.sourceRuntimeHealthy === true;
    const dc = ev.destinationWritesCompatible === true;
    let ot = false;
    if (isRfc3339(ev.sourceRuntimeObservedAt)) {
      const obs = new Date(ev.sourceRuntimeObservedAt as string);
      if (okD(obs) && obs.getTime() >= c.requiredSourceRuntimeObservedAt.getTime() && obs.getTime() <= c.assessedAt.getTime()) ot = true;
    }
    let fv = false;
    if (r.sourceDataFreshThroughAt) {
      if (r.sourceDataFreshThroughAt.getTime() > c.assessedAt.getTime()) b.add("SOURCE_DATA_FUTURE");
      else if (r.sourceDataFreshThroughAt.getTime() >= c.requiredSourceFreshThroughAt.getTime()) fv = true;
      else b.add("SOURCE_DATA_STALE");
    } else {
      b.add("SOURCE_DATA_STALE");
    }
    let hz = true;
    if (["CUTOVER", "OBSERVING"].includes(ss)) {
      if (!r.destinationWriteStartedAt || c.requiredSourceFreshThroughAt.getTime() < r.destinationWriteStartedAt.getTime()) {
        hz = false; b.add("HORIZON_BEFORE_DESTINATION_WRITES");
      }
    }
    if (!hl) b.add("SOURCE_RUNTIME_DOWN");
    if (!ot) b.add("SOURCE_RUNTIME_UNOBSERVED");
    if (!dc) b.add("DESTINATION_WRITES_INCOMPATIBLE");
    rr = hl && ot && dc && fv && hz;
  }

  const hStop = r.sourceWriteStoppedAt !== null;
  const hSnap = r.finalSnapshotAt !== null;
  const hRest = r.archiveRestoreTestedAt !== null;
  const hChk = typeof r.finalSnapshotChecksum === "string" && /^[a-f0-9]{64}$/.test(r.finalSnapshotChecksum);

  if (!hStop) b.add("MISSING_WRITE_STOP");
  if (!hSnap) b.add("MISSING_SNAPSHOT");
  if (!hChk) { if (r.finalSnapshotChecksum) b.add("MALFORMED_CHECKSUM"); else b.add("MISSING_CHECKSUM"); }
  if (!hRest) b.add("MISSING_RESTORE");

  let aOrd = true;
  if (hStop && hSnap && r.finalSnapshotAt!.getTime() < r.sourceWriteStoppedAt!.getTime()) { b.add("SNAPSHOT_BEFORE_STOP"); aOrd = false; }
  if (hSnap && hRest && r.archiveRestoreTestedAt!.getTime() < r.finalSnapshotAt!.getTime()) { b.add("RESTORE_BEFORE_SNAPSHOT"); aOrd = false; }
  if (hStop && hSnap && hChk && hRest && aOrd) aa = true;

  let wp = false, wi = false;
  if (r.retentionWaiverApprovedAt || r.retentionWaiverApprovedBy || r.retentionWaiverReason) {
    const isComp = okD(r.retentionWaiverApprovedAt) && typeof r.retentionWaiverApprovedBy === "string" && r.retentionWaiverApprovedBy.trim() !== "" && typeof r.retentionWaiverReason === "string" && r.retentionWaiverReason.trim() !== "";
    if (!isComp) { b.add("WAIVER_INCOMPLETE"); wi = true; }
    else if (r.retentionWaiverApprovedAt!.getTime() > c.assessedAt.getTime()) { b.add("WAIVER_FUTURE"); wi = true; }
    else wp = true;
  }

  if (ss === "DELETED") {
    if (!r.sourceDeletedAt) b.add("MISSING_DELETION_EVIDENCE");
  } else if (r.sourceDeletedAt) {
    b.add("CONTRADICTORY_DELETION");
  }

  if (r.sourceDeletedAt) {
    if (r.observationCompletedAt && r.sourceDeletedAt.getTime() < r.observationCompletedAt.getTime()) b.add("CONTRADICTORY_DELETION");
    if (r.archiveRestoreTestedAt && r.sourceDeletedAt.getTime() < r.archiveRestoreTestedAt.getTime()) b.add("CONTRADICTORY_DELETION");
  }

  if (ss === "DELETE_ELIGIBLE" && !r.sourceDeletedAt) {
    let oVal = true;
    if (!r.observationCompletedAt) { b.add("MISSING_OBSERVATION"); oVal = false; }
    else if (!r.destinationWriteStartedAt || r.observationCompletedAt.getTime() < r.destinationWriteStartedAt.getTime()) {
      b.add("OBSERVATION_BEFORE_DESTINATION_WRITES"); oVal = false;
    }
    let dReach = false, dVal = true;
    if (r.archiveRetentionDeadline) {
      if (r.finalSnapshotAt && r.archiveRetentionDeadline.getTime() < r.finalSnapshotAt.getTime()) { b.add("DEADLINE_BEFORE_SNAPSHOT"); dVal = false; }
      else if (r.archiveRetentionDeadline.getTime() <= c.assessedAt.getTime()) dReach = true;
      else b.add("RETENTION_NOT_REACHED");
    } else if (!wp) b.add("RETENTION_NOT_REACHED");
    if (oVal && aa && !wi) {
      if ((r.archiveRetentionDeadline && dVal && dReach) || wp) de = true;
    }
  }

  return {
    readiness: { rollbackReady: rr, archiveAvailable: aa, deleteEligible: de },
    summary: {
      status: ss, sourceProvider: sp, destinationProvider: dp,
      rollbackReady: rr, archiveAvailable: aa, deleteEligible: de,
      observationCompletedAt: r.observationCompletedAt, archiveRetentionDeadline: r.archiveRetentionDeadline,
      retentionWaiverPresent: wp, sourceDeletedAt: r.sourceDeletedAt, blockerCodes: Array.from(b).sort(),
    },
  };
}
