import { describe, expect, it } from "vitest";
import {
  amountScaleLabel,
  buildFinanceImportView,
  financeImportCanRetryExactFile,
  financeImportNeedsPolling,
  numericFormatLabel,
  supportsFinanceReportFile,
  type FinanceImportBatchSummary,
} from "./financeReportImportView";

const summary = (stage: FinanceImportBatchSummary["stage"], change: Partial<FinanceImportBatchSummary> = {}): FinanceImportBatchSummary => ({
  id: "batch-1", originalFilename: "Synthetic P&L.csv", stage, reportType: null, basis: null, cadence: null,
  periodStart: null, periodEnd: null, currencyState: "UNRESOLVED", resolvedCurrency: null, safeErrorCode: null,
  safeErrorMessage: null, addCount: 2, updateCount: 1, unchangedCount: 0, duplicateCount: 0, conflictCount: 0,
  warningCount: 0, blockerCount: 0, rejectedCount: 0, appliedCount: 0, version: 1,
  createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z", ...change,
});

describe("Finance report import view", () => {
  it("keeps active work expanded and completed work compact", () => {
    const processing = buildFinanceImportView(summary("CLASSIFYING"));
    expect(processing).toMatchObject({ title: "Processing report", defaultExpanded: true, polling: true });
    expect(processing.steps.map(({ status }) => status)).toEqual(["complete", "complete", "active", "pending", "pending", "pending"]);

    const ready = buildFinanceImportView(summary("READY_FOR_REVIEW"));
    expect(ready).toMatchObject({ title: "Ready for review", summary: "3 proposed changes are ready.", defaultExpanded: false, polling: false });
    expect(ready.steps.every(({ status }) => status === "complete")).toBe(true);
  });

  it("keeps input and safe failure states visible without implying an override", () => {
    const input = buildFinanceImportView(summary("NEEDS_INPUT", { blockerCount: 1 }));
    expect(input).toMatchObject({ title: "Input needed", defaultExpanded: true, polling: false });
    expect(input.steps.at(-2)?.status).toBe("failed");

    const extraction = buildFinanceImportView(summary("FAILED", { safeErrorCode: "FINANCE_REPORT_EXTRACTION_FAILED" }));
    expect(extraction).toMatchObject({ title: "Processing needs attention", className: "failed", defaultExpanded: true });
    expect(extraction.steps[1]).toMatchObject({ label: "Extracting file", status: "failed" });
    expect(buildFinanceImportView(summary("FAILED", { safeErrorCode: "MALFORMED_FILE" })).steps[1]?.status).toBe("failed");
    expect(financeImportCanRetryExactFile("FINANCE_REPORT_STORAGE_UNAVAILABLE")).toBe(true);
    expect(financeImportCanRetryExactFile("MALFORMED_FILE")).toBe(false);
  });

  it("accepts only the three supported report file extensions", () => {
    expect(["report.PDF", "report.csv", "report.xlsx"].every(supportsFinanceReportFile)).toBe(true);
    expect(["report.xlsm", "report.xls", "report.txt", "report.csv.exe"].some(supportsFinanceReportFile)).toBe(false);
  });

  it("renders bounded numeric format and scale confirmation copy", () => {
    expect(amountScaleLabel(1_000_000)).toBe("millions");
    expect(numericFormatLabel({ status: "RESOLVED", decimalSeparator: "COMMA", groupingSeparator: "NARROW_NBSP", amountScale: 1_000 }))
      .toBe("comma decimal, narrow nbsp grouping, amounts in thousands");
    expect(numericFormatLabel({ status: "UNRESOLVED", decimalSeparator: null, groupingSeparator: null, amountScale: null }))
      .toBe("Unresolved numeric format");
  });

  it("polls only while at least one batch is actively progressing", () => {
    expect(financeImportNeedsPolling([summary("READY_FOR_REVIEW"), summary("FAILED")])).toBe(false);
    expect(financeImportNeedsPolling([summary("READY_FOR_REVIEW"), summary("RECONCILING")])).toBe(true);
  });
});
