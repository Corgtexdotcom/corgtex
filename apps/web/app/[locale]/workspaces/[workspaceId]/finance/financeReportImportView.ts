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
  candidates: Array<{ id: string; version: number }>;
  clarification: {
    canConfirm: boolean;
    numericFormat: { status: "RESOLVED"; decimalSeparator: string; groupingSeparator: string;
      amountScale: 1 | 100 | 1_000 | 1_000_000 | 1_000_000_000 }
      | { status: "UNRESOLVED"; decimalSeparator: null; groupingSeparator: null; amountScale: null };
  };
};

const PROCESSING_STAGES = ["UPLOADED", "EXTRACTING", "CLASSIFYING", "MAPPING", "RECONCILING", "READY_FOR_REVIEW"] as const;
const STAGE_LABELS = ["Received", "Extracting file", "Understanding report", "Mapping values", "Reconciling changes", "Ready for review"];
const ACTIVE_STAGES = new Set<FinanceImportStage>(["UPLOADED", "EXTRACTING", "CLASSIFYING", "MAPPING", "RECONCILING", "APPLYING"]);

function failureIndex(code: string | null) {
  if (code?.includes("STORAGE")) return 0;
  if (code?.includes("EXTRACTION") || code?.includes("PDF") || code?.includes("XLSX")) return 1;
  if (code?.includes("AGENT") || code?.includes("MODEL") || code?.includes("PROVIDER")) return 2;
  return 3;
}

export function buildFinanceImportView(batch: Pick<FinanceImportBatchSummary, "stage" | "safeErrorCode" | "addCount" | "updateCount" | "blockerCount">) {
  const stageIndex = PROCESSING_STAGES.indexOf(batch.stage as typeof PROCESSING_STAGES[number]);
  const failedIndex = batch.stage === "FAILED" ? failureIndex(batch.safeErrorCode) : -1;
  const activeIndex = batch.stage === "NEEDS_INPUT" ? 4 : batch.stage === "PARTIALLY_APPLIED" ? 5 : stageIndex;
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
        : batch.stage === "PARTIALLY_APPLIED" ? ["Exceptions remain", `${batch.blockerCount} item${batch.blockerCount === 1 ? "" : "s"} still need review.`, "needs-input"]
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

export function amountScaleLabel(scale: FinanceImportDetail["clarification"]["numericFormat"]["amountScale"]) {
  return ({ 1: "units", 100: "hundreds", 1_000: "thousands", 1_000_000: "millions", 1_000_000_000: "billions" } as Record<number, string>)[scale ?? 0] ?? "unresolved";
}

export function numericFormatLabel(format: FinanceImportDetail["clarification"]["numericFormat"]) {
  if (format.status !== "RESOLVED") return "Unresolved numeric format";
  const decimal = format.decimalSeparator === "NONE" ? "no decimal separator" : `${format.decimalSeparator.toLowerCase()} decimal`;
  const grouping = format.groupingSeparator === "NONE" ? "no grouping separator" : `${format.groupingSeparator.toLowerCase().replace("_", " ")} grouping`;
  return `${decimal}, ${grouping}, amounts in ${amountScaleLabel(format.amountScale)}`;
}
