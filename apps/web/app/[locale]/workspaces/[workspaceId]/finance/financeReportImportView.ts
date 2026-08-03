export type FinanceImportStage = "UPLOADED" | "EXTRACTING" | "CLASSIFYING" | "MAPPING" | "RECONCILING"
  | "READY_FOR_REVIEW" | "APPLYING" | "APPLIED" | "NEEDS_INPUT" | "PARTIALLY_APPLIED" | "FAILED" | "CANCELLED";

export type FinanceImportBatchSummary = {
  id: string;
  originalFilename: string;
  stage: FinanceImportStage;
  reportType: string | null;
  basis: string | null;
  cadence: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currencyState: "RESOLVED" | "UNRESOLVED";
  resolvedCurrency: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  addCount: number;
  updateCount: number;
  unchangedCount: number;
  duplicateCount: number;
  conflictCount: number;
  warningCount: number;
  blockerCount: number;
  rejectedCount: number;
  appliedCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FinanceImportDetail = FinanceImportBatchSummary & {
  uploadedByUserId: string;
  documentId: string | null;
  brainSourceId: string | null;
  workflowJobId: string | null;
  agentRunId: string | null;
  title: string | null;
  asOfDate: string | null;
  currencyResolutionSource: string | null;
  currencyConfirmedByUserId: string | null;
  currencyConfirmedAt: string | null;
  skippedCount: number;
  approvedByUserId: string | null;
  approvedAt: string | null;
  appliedByUserId: string | null;
  appliedAt: string | null;
  warnings: Array<{ code: string; severity: "WARNING"; message: string; evidenceClaimIds: string[] }>;
  candidates: FinanceImportCandidateDetail[];
  clarification: {
    canConfirm: boolean;
    numericFormat: { status: "RESOLVED"; decimalSeparator: string; groupingSeparator: string;
      amountScale: 1 | 100 | 1_000 | 1_000_000 | 1_000_000_000 }
      | { status: "UNRESOLVED"; decimalSeparator: null; groupingSeparator: null; amountScale: null };
  };
};

export type FinanceImportCandidateDetail = {
  id: string;
  sourceKey: string;
  sourceLabel: string;
  sourcePath: string[];
  proposedAccountPath: string[];
  factKind: "LEAF" | "DERIVED";
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  action: "ADD" | "UPDATE" | "UNCHANGED" | "DUPLICATE" | "CONFLICT" | "SKIP";
  reviewState: "PROPOSED" | "VERIFIED" | "WARNING" | "BLOCKED" | "APPROVED" | "REJECTED" | "APPLIED";
  currentAmountCents: number | null;
  confidenceBps: number;
  evidenceMd: string;
  explanationMd: string | null;
  editedByUserId: string | null;
  editedAt: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  historicalWarning: boolean;
  peerConfirmationRequired: boolean;
  version: number;
  application: { id: string; outcome: string; targetFactId: string | null; appliedByUserId: string; appliedAt: string } | null;
};

const PROCESSING_STAGES = ["UPLOADED", "EXTRACTING", "CLASSIFYING", "MAPPING", "RECONCILING", "READY_FOR_REVIEW"] as const;
const STAGE_LABELS = ["Received", "Extracting file", "Understanding report", "Mapping values", "Reconciling changes", "Ready for review"];
const ACTIVE_STAGES = new Set<FinanceImportStage>(["UPLOADED", "EXTRACTING", "CLASSIFYING", "MAPPING", "RECONCILING", "APPLYING"]);
const EXTRACTION_FAILURE_CODES = new Set(["EMPTY_FILE", "FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE", "FILE_TYPE_MISMATCH", "MALFORMED_FILE",
  "EMPTY_EXTRACTION", "SCANNED_PDF_UNSUPPORTED", "UNSUPPORTED_PDF_FEATURE", "UNSUPPORTED_XLSX_FEATURE", "EXTRACTION_LIMIT_EXCEEDED", "FINANCE_REPORT_EXTRACTION_FAILED"]);
const EXACT_FILE_RETRY_CODES = new Set(["FINANCE_REPORT_STORAGE_PENDING", "FINANCE_REPORT_STORAGE_UNAVAILABLE", "FINANCE_REPORT_EXTRACTION_FAILED"]);

function failureIndex(code: string | null) {
  if (code?.includes("STORAGE")) return 0;
  if (code && EXTRACTION_FAILURE_CODES.has(code)) return 1;
  if (code?.includes("AGENT") || code?.includes("MODEL") || code?.includes("PROVIDER")) return 2;
  return 3;
}

function needsInputIndex(code: string | null) {
  if (code === "CURRENCY_UNRESOLVED") return 4;
  if (code === "FINANCE_REPORT_AGENT_UNAVAILABLE") return 2;
  return 3;
}

export function buildFinanceImportView(batch: Pick<FinanceImportBatchSummary, "stage" | "safeErrorCode" | "addCount" | "updateCount" | "blockerCount">) {
  const stageIndex = PROCESSING_STAGES.indexOf(batch.stage as typeof PROCESSING_STAGES[number]);
  const failedIndex = batch.stage === "FAILED" ? failureIndex(batch.safeErrorCode) : -1;
  const activeIndex = batch.stage === "NEEDS_INPUT" ? needsInputIndex(batch.safeErrorCode) : batch.stage === "PARTIALLY_APPLIED" ? 5 : stageIndex;
  const complete = ["READY_FOR_REVIEW", "APPLYING", "APPLIED", "PARTIALLY_APPLIED"].includes(batch.stage);
  const steps = PROCESSING_STAGES.map((stage, index) => ({
    stage,
    label: STAGE_LABELS[index]!,
    status: failedIndex === index ? "failed" : index < (failedIndex >= 0 ? failedIndex : activeIndex) || complete ? "complete"
      : index === activeIndex && ACTIVE_STAGES.has(batch.stage) ? "active" : index === activeIndex && batch.stage === "NEEDS_INPUT" ? "failed" : "pending",
  }));
  if (batch.stage === "CANCELLED") steps.forEach((step) => { step.status = "pending"; });
  const changeCount = batch.addCount + batch.updateCount;
  const copy = batch.stage === "NEEDS_INPUT" ? ["Input needed", "Confirm the report settings before reconciliation can continue.", "needs-input"]
    : batch.stage === "FAILED" ? ["Processing needs attention", "The report stopped safely. Review the message and retry the exact file when supported.", "failed"]
      : batch.stage === "CANCELLED" ? ["Import cancelled", "No Reported Actuals were changed.", "cancelled"]
        : batch.stage === "PARTIALLY_APPLIED" ? ["Exceptions remain", "Some proposed changes still need review.", "needs-input"]
          : batch.stage === "APPLIED" ? ["Import complete", "Verified Reported Actuals were applied with an audit receipt.", "complete"]
            : batch.stage === "READY_FOR_REVIEW" ? ["Ready for review", `${changeCount} proposed change${changeCount === 1 ? "" : "s"} are ready.`, "complete"]
              : ["Processing report", "Completed stages stay quiet while the current stage remains visible.", "processing"];
  return { title: copy[0], summary: copy[1], className: copy[2], defaultExpanded: !["READY_FOR_REVIEW", "APPLIED"].includes(batch.stage),
    polling: ACTIVE_STAGES.has(batch.stage), steps };
}

export function supportsFinanceReportFile(fileName: string) {
  return /\.(pdf|csv|xlsx)$/i.test(fileName.trim()) && !/\.xlsm$/i.test(fileName.trim());
}

export function financeImportNeedsPolling(batches: FinanceImportBatchSummary[]) {
  return batches.some((batch) => ACTIVE_STAGES.has(batch.stage));
}

export function financeImportCanRetryExactFile(code: string | null) {
  return code !== null && EXACT_FILE_RETRY_CODES.has(code);
}

export function financeImportNeedsFullDetail(stage: FinanceImportStage) {
  return ["READY_FOR_REVIEW", "PARTIALLY_APPLIED", "APPLIED"].includes(stage);
}

export function financeImportCandidateVersions(candidates: FinanceImportCandidateDetail[], scope: "review" | "apply") {
  return candidates.filter(({ reviewState }) => scope === "review" ? reviewState !== "APPLIED" : reviewState === "APPROVED")
    .map(({ id, version }) => ({ id, expectedVersion: version }));
}

export function financeImportHasVerifiedCandidates(candidates: FinanceImportCandidateDetail[]) {
  return candidates.some(({ historicalWarning, reviewState }) => !historicalWarning
    && !["WARNING", "BLOCKED", "APPROVED", "REJECTED", "APPLIED"].includes(reviewState));
}

export function financeImportCanWrite(canWrite: boolean, demoReadOnly: boolean) {
  return canWrite && !demoReadOnly;
}

export function financeImportVisibleCandidates(candidates: FinanceImportCandidateDetail[], showAll: boolean) {
  return [...candidates].filter((candidate) => showAll || candidate.factKind === "DERIVED"
    || ["ADD", "UPDATE", "CONFLICT"].includes(candidate.action) || ["WARNING", "BLOCKED", "APPROVED"].includes(candidate.reviewState))
    .sort((left, right) => left.proposedAccountPath.join("\0").localeCompare(right.proposedAccountPath.join("\0"))
      || left.periodStart.localeCompare(right.periodStart) || left.sourceKey.localeCompare(right.sourceKey));
}

export function parseFinanceAmountInput(value: string) {
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0") || "0");
  const signed = match[1] ? -cents : cents;
  return signed >= -2_147_483_648n && signed <= 2_147_483_647n ? Number(signed) : null;
}

export function parseFinanceAccountPath(value: string) {
  const path: string[] = [];
  let part = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      part += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "/") {
      path.push(part.trim());
      part = "";
    } else {
      part += character;
    }
  }
  if (escaped) return null;
  path.push(part.trim());
  return path.length > 0 && path.length <= 100 && path.every((component) => component.length > 0 && component.length <= 500) ? path : null;
}

export function formatFinanceAccountPathInput(path: string[]) {
  return path.map((part) => part.replaceAll("\\", "\\\\").replaceAll("/", "\\/")).join(" / ");
}

export function financeDerivedTotal(candidate: FinanceImportCandidateDetail, candidates: FinanceImportCandidateDetail[]) {
  if (candidate.factKind !== "DERIVED") return null;
  const descendants = candidates.filter((row) => row.factKind === "LEAF" && row.reviewState !== "REJECTED"
    && row.periodStart === candidate.periodStart && row.periodEnd === candidate.periodEnd
    && row.proposedAccountPath.length > candidate.proposedAccountPath.length
    && candidate.proposedAccountPath.every((part, index) => row.proposedAccountPath[index] === part));
  if (descendants.length === 0) return null;
  const total = descendants.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  return Number(total);
}

export function financeImportReviewAmounts(candidate: FinanceImportCandidateDetail, candidates: FinanceImportCandidateDetail[]) {
  const derived = candidate.factKind === "DERIVED";
  const recalculated = financeDerivedTotal(candidate, candidates);
  const current = derived ? candidate.amountCents : candidate.currentAmountCents;
  const proposed = derived ? recalculated : candidate.amountCents;
  const difference = derived ? (recalculated === null ? null : recalculated - candidate.amountCents)
    : candidate.action === "ADD" ? candidate.amountCents
      : candidate.currentAmountCents === null ? null : candidate.amountCents - candidate.currentAmountCents;
  return { current, proposed, difference, derived };
}

export function amountScaleLabel(scale: FinanceImportDetail["clarification"]["numericFormat"]["amountScale"]) {
  return ({ 1: "units", 100: "hundreds", 1_000: "thousands", 1_000_000: "millions", 1_000_000_000: "billions" } as Record<number, string>)[scale ?? 0] ?? "unresolved";
}

export function numericFormatLabel(format: FinanceImportDetail["clarification"]["numericFormat"]) {
  if (format.status !== "RESOLVED") return "Unresolved numeric format";
  const decimal = format.decimalSeparator === "NONE" ? "no decimal separator" : `${format.decimalSeparator.toLowerCase()} decimal`;
  const grouping = format.groupingSeparator === "NONE" ? "no grouping separator" : `${format.groupingSeparator.toLowerCase().replace("_", " ")} grouping`;
  return `${decimal}, ${grouping}, amounts in ${amountScaleLabel(format.amountScale)}`;
}
