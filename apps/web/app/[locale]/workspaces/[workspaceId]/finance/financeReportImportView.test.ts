import { describe, expect, it } from "vitest";
import {
  amountScaleLabel,
  buildFinanceImportView,
  financeDerivedTotal,
  financeImportCanRetryExactFile,
  financeImportCanWrite,
  financeImportCandidateVersions,
  financeImportHasVerifiedCandidates,
  financeImportNeedsFullDetail,
  financeImportNeedsPolling,
  financeImportReviewAmounts,
  financeImportVisibleCandidates,
  formatFinanceAccountPathInput,
  numericFormatLabel,
  parseFinanceAccountPath,
  parseFinanceAmountInput,
  supportsFinanceReportFile,
  type FinanceImportBatchSummary,
  type FinanceImportCandidateDetail,
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
    const input = buildFinanceImportView(summary("NEEDS_INPUT", { blockerCount: 1, safeErrorCode: "CURRENCY_UNRESOLVED" }));
    expect(input).toMatchObject({ title: "Input needed", defaultExpanded: true, polling: false });
    expect(input.steps.at(-2)?.status).toBe("failed");
    expect(buildFinanceImportView(summary("NEEDS_INPUT", { safeErrorCode: "FINANCE_REPORT_AGENT_UNAVAILABLE" })).steps[2]?.status).toBe("failed");
    expect(buildFinanceImportView(summary("NEEDS_INPUT", { safeErrorCode: "NUMERIC_FORMAT_UNRESOLVED" })).steps[3]?.status).toBe("failed");
    expect(buildFinanceImportView(summary("PARTIALLY_APPLIED", { blockerCount: 0 })))
      .toMatchObject({ title: "Exceptions remain", summary: "Some proposed changes still need review." });

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

  it("loads full detail only for review and receipt stages", () => {
    expect((["READY_FOR_REVIEW", "PARTIALLY_APPLIED", "APPLIED"] as FinanceImportBatchSummary["stage"][])
      .every(financeImportNeedsFullDetail)).toBe(true);
    expect(financeImportNeedsFullDetail("RECONCILING")).toBe(false);
  });

  it("builds exact review/apply versions and defaults to changes-first ordering", () => {
    const rows = [row("unchanged", { action: "UNCHANGED" }), row("approved", { reviewState: "APPROVED", proposedAccountPath: ["B"] }),
      row("add", { action: "ADD", proposedAccountPath: ["A"] }), row("applied", { reviewState: "APPLIED" })];
    expect(financeImportCandidateVersions(rows, "review")).toEqual(rows.slice(0, 3).map(({ id, version }) => ({ id, expectedVersion: version })));
    expect(financeImportCandidateVersions(rows, "apply")).toEqual([{ id: "approved", expectedVersion: 1 }]);
    expect(financeImportVisibleCandidates(rows, false).map(({ id }) => id)).toEqual(["add", "applied", "approved"]);
    expect(financeImportVisibleCandidates(rows, true)).toHaveLength(4);
  });

  it("enables verified bulk review only when a clean candidate is eligible", () => {
    expect(financeImportHasVerifiedCandidates([row("clean")])).toBe(true);
    expect(financeImportHasVerifiedCandidates([row("unchanged", { reviewState: "VERIFIED", action: "UNCHANGED" })])).toBe(true);
    expect(financeImportHasVerifiedCandidates([
      row("warning", { reviewState: "WARNING" }),
      row("historical", { historicalWarning: true }),
      row("blocked", { reviewState: "BLOCKED" }),
      row("approved", { reviewState: "APPROVED" }),
      row("rejected", { reviewState: "REJECTED" }),
      row("applied", { reviewState: "APPLIED" }),
    ])).toBe(false);
  });

  it("parses exact cents and account paths without floating point coercion", () => {
    expect(parseFinanceAmountInput("-1234.5")).toBe(-123450);
    expect(parseFinanceAmountInput("12.345")).toBeNull();
    expect(parseFinanceAmountInput("21474836.48")).toBeNull();
    expect(parseFinanceAccountPath(" Gross contribution / Product revenue ")).toEqual(["Gross contribution", "Product revenue"]);
    expect(parseFinanceAccountPath("Revenue \\/ domestic / Product")).toEqual(["Revenue / domestic", "Product"]);
    expect(formatFinanceAccountPathInput(["Revenue / domestic", "Back\\slash"])).toBe("Revenue \\/ domestic / Back\\\\slash");
    expect(parseFinanceAccountPath(" / ")).toBeNull();
  });

  it("keeps the public demo read-only even when its seeded member can write Finance", () => {
    expect(financeImportCanWrite(true, true)).toBe(false);
    expect(financeImportCanWrite(true, false)).toBe(true);
    expect(financeImportCanWrite(false, false)).toBe(false);
  });

  it("recalculates derived totals from non-rejected descendant leaves", () => {
    const derived = row("total", { factKind: "DERIVED", action: "SKIP", proposedAccountPath: ["Gross contribution"] });
    const rows = [derived, row("revenue", { amountCents: 260_000, proposedAccountPath: ["Gross contribution", "Revenue"] }),
      row("cost", { amountCents: -85_000, proposedAccountPath: ["Gross contribution", "Costs"] }),
      row("rejected", { amountCents: 999, reviewState: "REJECTED", proposedAccountPath: ["Gross contribution", "Other"] })];
    expect(financeDerivedTotal(derived, rows)).toBe(175_000);
    expect(financeDerivedTotal(rows[1]!, rows)).toBeNull();
    expect(financeImportReviewAmounts(derived, rows)).toMatchObject({ current: 100, proposed: 175_000, difference: 174_900, derived: true });
    const largeRows = [derived, row("large-a", { amountCents: 1_500_000_000, proposedAccountPath: ["Gross contribution", "A"] }),
      row("large-b", { amountCents: 1_500_000_000, proposedAccountPath: ["Gross contribution", "B"] })];
    expect(financeImportReviewAmounts(derived, largeRows)).toMatchObject({ current: 100, proposed: 3_000_000_000, difference: 2_999_999_900 });
    expect(financeImportReviewAmounts(row("new", { action: "ADD", amountCents: 250, currentAmountCents: null }), []))
      .toMatchObject({ current: null, proposed: 250, difference: 250, derived: false });
  });
});

function row(id: string, change: Partial<FinanceImportCandidateDetail> = {}): FinanceImportCandidateDetail {
  return { id, sourceKey: id, sourceLabel: id, sourcePath: [id], proposedAccountPath: [id], factKind: "LEAF",
    periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-06-30T00:00:00.000Z", amountCents: 100,
    action: "UPDATE", reviewState: "PROPOSED", currentAmountCents: 50, confidenceBps: 9900, evidenceMd: "Synthetic evidence",
    explanationMd: null, editedByUserId: null, editedAt: null, approvedByUserId: null, approvedAt: null,
    historicalWarning: false, peerConfirmationRequired: false, version: 1, application: null, ...change };
}
