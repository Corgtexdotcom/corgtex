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

const ALLOWED_PROVIDERS = new Set(["RAILWAY", "AZURE", "SELF_HOSTED"]);
const ALLOWED_STATUSES = new Set([
  "PLANNED",
  "SHADOW",
  "CUTOVER",
  "OBSERVING",
  "ARCHIVE_ONLY",
  "DELETE_ELIGIBLE",
  "DELETED",
  "ROLLED_BACK",
]);

const RFC3339_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-]\d{2}):(\d{2}))$/i;

function parseRFC3339(dateStr: unknown): Date | null {
  if (typeof dateStr !== "string") return null;
  const match = dateStr.match(RFC3339_REGEX);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const min = parseInt(match[5], 10);
  const sec = parseInt(match[6], 10);

  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;

  if (match[7]) {
    const offHour = parseInt(match[7], 10);
    const offMin = parseInt(match[8], 10);
    if (Math.abs(offHour) > 23 || offMin > 59) return null;
  }

  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !isNaN(d.getTime());
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
    blockers.push("INVALID_IDENTITY");
  }

  const status = ALLOWED_STATUSES.has(record.status) ? record.status : null;
  if (status === null && !blockers.includes("INVALID_IDENTITY")) {
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
    return {
      rollbackReady: false,
      summary: { status, sourceProvider: src, destinationProvider: dst, rollbackReady: false, blockerCodes: blockers },
    };
  }

  if (status !== null && status !== "SHADOW" && status !== "CUTOVER" && status !== "OBSERVING") {
    blockers.push("STATUS_NOT_ROLLBACK_ELIGIBLE");
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
  if (!obs) {
    blockers.push("SOURCE_RUNTIME_OBSERVATION_INVALID");
  } else if (obs.getTime() > context.assessedAt.getTime()) {
    blockers.push("SOURCE_RUNTIME_OBSERVATION_FUTURE");
  } else if (obs.getTime() < context.requiredSourceRuntimeObservedAt.getTime()) {
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

  if (status === "CUTOVER" || status === "OBSERVING") {
    if (!record.destinationWriteStartedAt) {
      blockers.push("DESTINATION_WRITE_START_MISSING");
    } else if (!isValidDate(record.destinationWriteStartedAt)) {
      blockers.push("DESTINATION_WRITE_START_INVALID");
    } else if (record.destinationWriteStartedAt.getTime() > context.assessedAt.getTime()) {
      blockers.push("DESTINATION_WRITE_START_FUTURE");
    } else if (context.requiredSourceFreshThroughAt.getTime() < record.destinationWriteStartedAt.getTime()) {
      blockers.push("HORIZON_BEFORE_DESTINATION_WRITES");
    }
  }

  const rollbackReady = blockers.length === 0;

  return {
    rollbackReady,
    summary: { status, sourceProvider: src, destinationProvider: dst, rollbackReady, blockerCodes: blockers },
  };
}
