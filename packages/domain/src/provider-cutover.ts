/**
 * Represents a raw record of a provider cutover.
 */
export type ProviderCutoverRecord = {
  id: string;
  customerAccountId: string;
  sourceDeploymentId: string;
  destinationDeploymentId: string | null;
  sourceProvider: string;
  destinationProvider: string;
  status: string;
  sourceWriteStoppedAt: Date | null;
  destinationWriteStartedAt: Date | null;
  sourceDataFreshThroughAt: Date | null;
  evidence: Record<string, unknown> | null;
};

/**
 * The horizons required to assess rollback readiness.
 */
export type RuntimeRollbackContext = {
  assessedAt: Date;
  requiredSourceFreshThroughAt: Date;
  requiredSourceRuntimeObservedAt: Date;
};

/**
 * Fixed blocker codes for runtime rollback assessments.
 */
export type RuntimeRollbackBlockerCode =
  | "INVALID_IDENTITY"
  | "INVALID_CONTEXT"
  | "STATUS_NOT_ROLLBACK_ELIGIBLE"
  | "SOURCE_RUNTIME_UNHEALTHY"
  | "SOURCE_RUNTIME_OBSERVATION_INVALID"
  | "SOURCE_RUNTIME_OBSERVATION_STALE"
  | "SOURCE_RUNTIME_OBSERVATION_FUTURE"
  | "DESTINATION_WRITES_INCOMPATIBLE"
  | "SOURCE_FRESHNESS_MISSING"
  | "SOURCE_FRESHNESS_INVALID"
  | "SOURCE_FRESHNESS_STALE"
  | "SOURCE_FRESHNESS_FUTURE"
  | "DESTINATION_WRITE_START_MISSING"
  | "DESTINATION_WRITE_START_INVALID"
  | "DESTINATION_WRITE_START_FUTURE"
  | "HORIZON_BEFORE_DESTINATION_WRITES";

/**
 * Summary of a runtime rollback assessment, safe for exposure.
 */
export type RuntimeRollbackSummary = {
  status: string | null;
  sourceProvider: string | null;
  destinationProvider: string | null;
  rollbackReady: boolean;
  blockerCodes: RuntimeRollbackBlockerCode[];
};

/**
 * The full result of an assessment.
 */
export type RuntimeRollbackAssessment = {
  rollbackReady: boolean;
  summary: RuntimeRollbackSummary;
};

/** Persisted cutover data required to prove source-archive availability. */
export type ArchiveAvailabilityRecord = ProviderCutoverRecord & {
  finalSnapshotAt: Date | null;
  finalSnapshotChecksum: string | null;
  archiveRestoreTestedAt: Date | null;
};

/** Explicit assessment time for archive-availability comparisons. */
export type ArchiveAvailabilityContext = {
  assessedAt: Date;
};

/** Fixed, sanitized reasons why an archive is unavailable. */
export type ArchiveAvailabilityBlockerCode =
  | "INVALID_IDENTITY"
  | "INVALID_CONTEXT"
  | "SOURCE_WRITE_STOP_INVALID"
  | "SOURCE_WRITE_STOP_FUTURE"
  | "FINAL_SNAPSHOT_INVALID"
  | "FINAL_SNAPSHOT_FUTURE"
  | "FINAL_SNAPSHOT_BEFORE_WRITE_STOP"
  | "FINAL_SNAPSHOT_CHECKSUM_INVALID"
  | "ARCHIVE_RESTORE_TEST_INVALID"
  | "ARCHIVE_RESTORE_TEST_FUTURE"
  | "ARCHIVE_RESTORE_TEST_BEFORE_SNAPSHOT";

/** Fixed-shape archive result safe for logs and API projections. */
export type ArchiveAvailabilitySummary = {
  status: string | null;
  sourceProvider: string | null;
  destinationProvider: string | null;
  archiveAvailable: boolean;
  blockerCodes: ArchiveAvailabilityBlockerCode[];
};

/** Full result of a pure source-archive availability assessment. */
export type ArchiveAvailabilityAssessment = {
  archiveAvailable: boolean;
  summary: ArchiveAvailabilitySummary;
};

const ALLOWED_PROVIDERS = new Set(["RAILWAY", "AZURE", "SELF_HOSTED"]);
const ALLOWED_STATUSES = new Set([
  "PLANNED", "SHADOW", "CUTOVER", "OBSERVING",
  "ARCHIVE_ONLY", "DELETE_ELIGIBLE", "DELETED", "ROLLED_BACK"
]);

const RFC3339_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-]\d{2}):(\d{2}))$/i;

function parseRFC3339(dateStr: unknown): [number, boolean] | null {
  if (typeof dateStr !== "string") return null;
  const m = dateStr.match(RFC3339_REGEX);
  if (!m) return null;

  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const h = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const s = parseInt(m[6], 10);

  if (mo < 1 || mo > 12 || h > 23 || min > 59 || s > 59) return null;
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d < 1 || d > days[mo]) return null;

  if (m[8] === "-00" && m[9] === "00") return null;
  if (m[8] && (Math.abs(parseInt(m[8], 10)) > 23 || parseInt(m[9], 10) > 59)) return null;

  const time = new Date(dateStr).getTime();
  if (isNaN(time)) return null;
  const subMs = Boolean(m[7] && m[7].length > 3 && parseInt(m[7].substring(3), 10) > 0);
  return [time, subMs];
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !isNaN(d.getTime());
}

const DESTINATION_REQUIRED_STATUSES = new Set([
  "CUTOVER", "OBSERVING", "ARCHIVE_ONLY", "DELETE_ELIGIBLE", "DELETED"
]);

function archiveResult(
  status: string | null,
  sourceProvider: string | null,
  destinationProvider: string | null,
  blockerCodes: ArchiveAvailabilityBlockerCode[]
): ArchiveAvailabilityAssessment {
  const archiveAvailable = blockerCodes.length === 0;
  return {
    archiveAvailable,
    summary: { status, sourceProvider, destinationProvider, archiveAvailable, blockerCodes },
  };
}

/**
 * Proves source-archive availability from persisted evidence and an explicit time.
 */
export function assessArchiveAvailability(
  record: ArchiveAvailabilityRecord,
  context: ArchiveAvailabilityContext
): ArchiveAvailabilityAssessment {
  const blockers: ArchiveAvailabilityBlockerCode[] = [];
  const status = ALLOWED_STATUSES.has(record.status) ? record.status : null;
  let sourceProvider: string | null = record.sourceProvider;
  let destinationProvider: string | null = record.destinationProvider;
  if (!ALLOWED_PROVIDERS.has(sourceProvider) ||
    !ALLOWED_PROVIDERS.has(destinationProvider) || sourceProvider === destinationProvider) {
    sourceProvider = null;
    destinationProvider = null;
  }

  const destinationRequired = status !== null && DESTINATION_REQUIRED_STATUSES.has(status);
  if (status === null || sourceProvider === null ||
    record.destinationDeploymentId === record.sourceDeploymentId ||
    (destinationRequired && !record.destinationDeploymentId)) {
    blockers.push("INVALID_IDENTITY");
  }
  const assessedAt = isValidDate(context.assessedAt) ? context.assessedAt.getTime() : null;
  if (assessedAt === null) blockers.push("INVALID_CONTEXT");
  if (blockers.length > 0 || assessedAt === null) {
    return archiveResult(status, sourceProvider, destinationProvider, blockers);
  }

  let writeStop: number | null = null;
  if (!isValidDate(record.sourceWriteStoppedAt)) blockers.push("SOURCE_WRITE_STOP_INVALID");
  else if (record.sourceWriteStoppedAt.getTime() > assessedAt) blockers.push("SOURCE_WRITE_STOP_FUTURE");
  else writeStop = record.sourceWriteStoppedAt.getTime();

  let snapshot: number | null = null;
  if (!isValidDate(record.finalSnapshotAt)) blockers.push("FINAL_SNAPSHOT_INVALID");
  else if (record.finalSnapshotAt.getTime() > assessedAt) blockers.push("FINAL_SNAPSHOT_FUTURE");
  else snapshot = record.finalSnapshotAt.getTime();
  if (writeStop !== null && snapshot !== null && snapshot < writeStop) {
    blockers.push("FINAL_SNAPSHOT_BEFORE_WRITE_STOP");
  }
  if (typeof record.finalSnapshotChecksum !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.finalSnapshotChecksum)) {
    blockers.push("FINAL_SNAPSHOT_CHECKSUM_INVALID");
  }

  let restore: number | null = null;
  if (!isValidDate(record.archiveRestoreTestedAt)) blockers.push("ARCHIVE_RESTORE_TEST_INVALID");
  else if (record.archiveRestoreTestedAt.getTime() > assessedAt) blockers.push("ARCHIVE_RESTORE_TEST_FUTURE");
  else restore = record.archiveRestoreTestedAt.getTime();
  if (snapshot !== null && restore !== null && restore < snapshot) {
    blockers.push("ARCHIVE_RESTORE_TEST_BEFORE_SNAPSHOT");
  }

  return archiveResult(status, sourceProvider, destinationProvider, blockers);
}

/**
 * Assesses whether a provider cutover can safely be rolled back based purely on runtime evidence.
 *
 * @param record - The provider cutover record containing state and evidence.
 * @param context - The context with required dates/horizons.
 * @returns A RuntimeRollbackAssessment indicating if rollback is safe and any blockers.
 */
export function assessRuntimeRollback(
  record: ProviderCutoverRecord,
  context: RuntimeRollbackContext
): RuntimeRollbackAssessment {
  const blockers: RuntimeRollbackBlockerCode[] = [];

  let src: string | null = record.sourceProvider;
  let dst: string | null = record.destinationProvider;
  if (!ALLOWED_PROVIDERS.has(src) || !ALLOWED_PROVIDERS.has(dst) || src === dst) {
    src = null;
    dst = null;
  }

  const status = ALLOWED_STATUSES.has(record.status) ? record.status : null;
  if (
    src === null ||
    status === null ||
    record.destinationDeploymentId === record.sourceDeploymentId ||
    (status === "SHADOW" && !record.destinationDeploymentId && record.destinationWriteStartedAt !== null) ||
    ((status === "CUTOVER" || status === "OBSERVING") && !record.destinationDeploymentId)
  ) {
    blockers.push("INVALID_IDENTITY");
  }

  if (
    !isValidDate(context.assessedAt) ||
    !isValidDate(context.requiredSourceFreshThroughAt) ||
    !isValidDate(context.requiredSourceRuntimeObservedAt) ||
    context.requiredSourceFreshThroughAt.getTime() > context.assessedAt.getTime() ||
    context.requiredSourceRuntimeObservedAt.getTime() > context.assessedAt.getTime()
  ) {
    blockers.push("INVALID_CONTEXT");
  }

  if (status !== null && status !== "SHADOW" && status !== "CUTOVER" && status !== "OBSERVING") {
    blockers.push("STATUS_NOT_ROLLBACK_ELIGIBLE");
  }

  if (blockers.length > 0) {
    return {
      rollbackReady: false,
      summary: { status, sourceProvider: src, destinationProvider: dst, rollbackReady: false, blockerCodes: blockers },
    };
  }

  const ev = record.evidence || {};
  if (ev.sourceRuntimeHealthy !== true) {
    blockers.push("SOURCE_RUNTIME_UNHEALTHY");
  }

  const obs = parseRFC3339(ev.sourceRuntimeObservedAt);
  if (obs === null) {
    blockers.push("SOURCE_RUNTIME_OBSERVATION_INVALID");
  } else if (obs[0] > context.assessedAt.getTime() || (obs[0] === context.assessedAt.getTime() && obs[1])) {
    blockers.push("SOURCE_RUNTIME_OBSERVATION_FUTURE");
  } else if (obs[0] < context.requiredSourceRuntimeObservedAt.getTime()) {
    blockers.push("SOURCE_RUNTIME_OBSERVATION_STALE");
  }

  if (ev.destinationWritesCompatible !== true) {
    blockers.push("DESTINATION_WRITES_INCOMPATIBLE");
  }

  if (!record.sourceDataFreshThroughAt) {
    blockers.push("SOURCE_FRESHNESS_MISSING");
  } else if (!isValidDate(record.sourceDataFreshThroughAt)) {
    blockers.push("SOURCE_FRESHNESS_INVALID");
  } else if (record.sourceDataFreshThroughAt.getTime() > context.assessedAt.getTime()) {
    blockers.push("SOURCE_FRESHNESS_FUTURE");
  } else if (record.sourceDataFreshThroughAt.getTime() < context.requiredSourceFreshThroughAt.getTime()) {
    blockers.push("SOURCE_FRESHNESS_STALE");
  }

  if (record.destinationWriteStartedAt !== null) {
    if (!isValidDate(record.destinationWriteStartedAt)) {
      blockers.push("DESTINATION_WRITE_START_INVALID");
    } else if (record.destinationWriteStartedAt.getTime() > context.assessedAt.getTime()) {
      blockers.push("DESTINATION_WRITE_START_FUTURE");
    } else if (
      (status === "CUTOVER" || status === "OBSERVING") &&
      context.requiredSourceFreshThroughAt.getTime() < record.destinationWriteStartedAt.getTime()
    ) {
      blockers.push("HORIZON_BEFORE_DESTINATION_WRITES");
    }
  } else if (status === "CUTOVER" || status === "OBSERVING") {
    blockers.push("DESTINATION_WRITE_START_MISSING");
  }

  const rollbackReady = blockers.length === 0;

  return {
    rollbackReady,
    summary: { status, sourceProvider: src, destinationProvider: dst, rollbackReady, blockerCodes: blockers },
  };
}
