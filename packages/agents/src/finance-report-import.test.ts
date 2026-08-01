import type { FinanceFileFormat } from "@corgtex/knowledge";
import type { ModelGateway } from "@corgtex/models";
import { describe, expect, it, vi } from "vitest";
import { FinanceReportImportAgentError, financeReportImportProposalV1Schema,
  interpretFinanceReport } from "./finance-report-import";

const sheet = (format: FinanceFileFormat) => format === "CSV" ? "CSV" : "Actuals";
function evidence(format: FinanceFileFormat, amount = "1,250.00", currency = "USD", name = sheet(format)) {
  if (format === "PDF") return JSON.stringify({ page: 1, text: `Revenue ${amount}\n${currency}` });
  return [
    { sheet: name, rowCount: 2, columnCount: 2 },
    { sheet: name, row: 1, column: 1, type: "TEXT", value: currency },
    { sheet: name, row: 2, column: 2, type: "NUMBER",
      value: format === "XLSX" ? (amount.includes("(") ? "-1250" : "1250") : amount,
      ...(format === "XLSX" ? { displayValue: amount } : {}) },
  ].map((value) => JSON.stringify(value)).join("\n");
}
function proposal(format: FinanceFileFormat = "CSV", amount = "1,250.00") {
  const source = format === "PDF" ? { kind: "PDF", page: 1, evidence: `Revenue ${amount}` }
    : { kind: "CELL", sheet: sheet(format), row: 2, column: 2, evidence: amount };
  return { contractVersion: 1, report: { title: "Synthetic actuals", reportType: "PROFIT_AND_LOSS",
    basis: "ACCRUAL", cadence: "MONTHLY", periodStart: "2026-06-01", periodEnd: "2026-06-30",
    asOfDate: null, currency: { state: "UNRESOLVED", code: null, source: null } },
  summary: "Synthetic Reported Actuals proposal.", candidates: [{ target: "REPORTED_ACTUAL", editable: true,
    source, sourceLabel: "Revenue", sourceAccountPath: ["Revenue"], proposedAccountPath: ["Revenue"],
    rowKind: "LEAF", periodStart: "2026-06-01", periodEnd: "2026-06-30", amountCents: 125_000,
    mappingStatus: "MAPPED", confidence: 0.98, reviewStatus: "VERIFIED",
    exceptionCodes: [], reviewReasons: [] }] } as any;
}
function gateway(outputs: unknown[]) {
  const extract = vi.fn();
  outputs.forEach((output) => output instanceof Error ? extract.mockRejectedValueOnce(output)
    : extract.mockResolvedValueOnce({ output, raw: JSON.stringify(output),
      usage: { provider: "synthetic", model: "quality-test" } }));
  return { extract, gateway: { extract } as unknown as Pick<ModelGateway, "extract"> };
}
const params = { workspaceId: "workspace-synthetic", workflowJobId: "job-synthetic",
  agentRunId: "run-synthetic", model: "quality-test" };
async function invalid(output: unknown, format: FinanceFileFormat, source = evidence(format)) {
  const model = gateway([output, output]);
  await expect(interpretFinanceReport({ ...params, format, extractedEvidence: source,
    gateway: model.gateway })).rejects.toBeInstanceOf(FinanceReportImportAgentError);
  expect(model.extract).toHaveBeenCalledTimes(2);
}

describe("Finance report import v1", () => {
  it.each(["PDF", "CSV", "XLSX"] as const)("accepts exact synthetic %s evidence", async (format) => {
    const model = gateway([proposal(format)]);
    const result = await interpretFinanceReport({ ...params, format, extractedEvidence: evidence(format),
      gateway: model.gateway, approvedProfileHints: [{ profileId: "p1", version: 3,
        layoutFingerprint: "layout-v3", approvedMappings: [{ sourceLabel: "Revenue", accountPath: ["Revenue"] }] }] });
    expect(result).toMatchObject({ contractVersion: 1, report: { currency: { state: "UNRESOLVED" } },
      candidates: [{ target: "REPORTED_ACTUAL", editable: true, reviewStatus: "VERIFIED" }] });
    const request = model.extract.mock.calls[0]![0] as any;
    expect(request).not.toHaveProperty("tools");
    expect(request.instruction).toContain("never transactions");
    expect(request.instruction).toContain("never default to USD");
    expect(JSON.parse(request.input).approvedProfileHints[0].version).toBe(3);
  });

  it.each(["PDF", "CSV", "XLSX"] as const)("rejects fabricated %s evidence", async (format) => {
    const value = proposal(format); value.candidates[0].source.evidence += " invented";
    await invalid(value, format);
  });

  it.each(["PDF", "CSV", "XLSX"] as const)("binds currency-decorated negative %s evidence", async (format) => {
    const value = proposal(format, "($1,250.00)"); value.candidates[0].amountCents = -125_000;
    await expect(interpretFinanceReport({ ...params, format, extractedEvidence: evidence(format, "($1,250.00)"),
      gateway: gateway([value]).gateway })).resolves.toHaveProperty("candidates.0.amountCents", -125_000);
  });

  it.each([
    ["unknown field", (value: any) => { value.trace = "private"; }],
    ["invalid classification", (value: any) => { value.report.reportType = "BUDGET"; }],
    ["invalid date", (value: any) => { value.report.periodEnd = "2026-02-30"; }],
    ["outside period", (value: any) => { value.candidates[0].periodStart = "2026-05-31"; }],
    ["fractional cents", (value: any) => { value.candidates[0].amountCents = 1.5; }],
    ["overflow cents", (value: any) => { value.candidates[0].amountCents = 2_147_483_648; }],
    ["missing hierarchy", (value: any) => { value.candidates[0].proposedAccountPath = []; }],
    ["mixed coordinates", (value: any) => { Object.assign(value.candidates[0].source, { page: 1 }); }],
    ["row alias", (value: any) => { value.candidates[0].source = { kind: "CELL", sheet: "CSV",
      row: 2, columnName: "B", evidence: "1,250.00" }; }],
    ["unbounded text", (value: any) => { value.report.title = "x".repeat(201); }],
  ])("strict schema rejects %s", (_label, mutate) => {
    const value = proposal(); mutate(value);
    expect(financeReportImportProposalV1Schema.safeParse(value).success).toBe(false);
  });

  it("preserves exact identifiers and rejects fabricated, duplicate, and overlapping claims", async () => {
    const spaced = proposal("CSV"); spaced.candidates[0].source.sheet = " CSV ";
    await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV", "1,250.00", "USD", " CSV "),
      gateway: gateway([spaced]).gateway })).resolves.toMatchObject({ candidates: [{ source: { sheet: " CSV " } }] });
    const fabricated = proposal(); fabricated.candidates[0].source.evidence = "1250";
    await invalid(fabricated, "CSV");
    const duplicate = proposal(); duplicate.candidates.push(structuredClone(duplicate.candidates[0]));
    await invalid(duplicate, "CSV");
    const overlap = proposal("PDF"); overlap.candidates.push({ ...structuredClone(overlap.candidates[0]),
      source: { kind: "PDF", page: 1, evidence: "1,250.00" } });
    await invalid(overlap, "PDF");
  });

  it.each([
    ["mismatch", proposal(), evidence("CSV")],
    ["fractional source", proposal("CSV", "1.2345"), evidence("CSV", "1.2345")],
    ["ambiguous token", proposal("CSV", "1,250.00 1,250.00"), evidence("CSV", "1,250.00 1,250.00")],
  ])("rejects unsafe amount binding: %s", async (label, value, source) => {
    if (label === "mismatch") value.candidates[0].amountCents = 999;
    await invalid(value, "CSV", source);
  });

  it("binds one uppercase ISO currency token and never derives it from a profile", async () => {
    for (const text of ["USD", "Amounts in USD"]) {
      const value = proposal(); value.report.currency = { state: "EXPLICIT", code: "USD",
        source: { kind: "CELL", sheet: "CSV", row: 1, column: 1, evidence: text } };
      await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV", "1,250.00", text),
        gateway: gateway([value]).gateway })).resolves.toMatchObject({ report: { currency: { code: "USD" } } });
    }
    for (const text of ["usd", "USD / EUR", "USD EUR", "USD (EUR)"]) {
      const value = proposal(); value.report.currency = { state: "EXPLICIT", code: "USD",
        source: { kind: "CELL", sheet: "CSV", row: 1, column: 1, evidence: text } };
      await invalid(value, "CSV", evidence("CSV", "1,250.00", text));
    }
  });

  it.each([
    [{ confidence: 0.5 }, "LOW_CONFIDENCE"],
    [{ mappingStatus: "AMBIGUOUS" }, "AMBIGUOUS_MAPPING"],
    [{ mappingStatus: "UNMAPPED", proposedAccountPath: [] }, "UNMAPPED_ACCOUNT"],
  ])("forces review exceptions", async (change, code) => {
    const value = proposal(); Object.assign(value.candidates[0], change);
    const result = await interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV"),
      gateway: gateway([value]).gateway });
    expect(result.candidates[0]).toMatchObject({ reviewStatus: "WARNING",
      exceptionCodes: expect.arrayContaining([code]), reviewReasons: [expect.any(String)] });
  });

  it("bounds profile hints and never lets them bypass fresh evidence", async () => {
    const mappings = Array.from({ length: 401 }, (_, index) => ({ sourceLabel: `Label ${index}`, accountPath: ["Revenue"] }));
    const hints = Array.from({ length: 5 }, (_, index) => ({ profileId: `p${index}`, version: 1,
      layoutFingerprint: `l${index}`, approvedMappings: mappings }));
    const model = gateway([proposal()]);
    await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV"),
      gateway: model.gateway, approvedProfileHints: hints })).rejects.toHaveProperty("issues");
    await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: "x".repeat(2_000_001),
      gateway: model.gateway })).rejects.toHaveProperty("issues");
    expect(model.extract).not.toHaveBeenCalled();
    const wrong = proposal(); wrong.candidates[0].amountCents = 999;
    await invalid(wrong, "CSV");
  });

  it("retries once, sanitizes invalid output, and preserves transient errors", async () => {
    const bad = { ...proposal(), providerTrace: "private-output" }; const repaired = gateway([bad, proposal()]);
    await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV"),
      gateway: repaired.gateway })).resolves.toHaveProperty("contractVersion", 1);
    expect(repaired.extract).toHaveBeenCalledTimes(2);
    expect((repaired.extract.mock.calls[1]![0] as any).instruction).not.toContain("private-output");
    const exhausted = gateway([bad, bad]);
    const error = await interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV"),
      gateway: exhausted.gateway }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FinanceReportImportAgentError);
    expect(JSON.stringify(error)).not.toContain("private-output");
    const transient = new Error("temporary provider failure"); const unavailable = gateway([transient]);
    await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: evidence("CSV"),
      gateway: unavailable.gateway })).rejects.toBe(transient);
    expect(unavailable.extract).toHaveBeenCalledOnce();
  });

  it("rejects malformed or duplicate JSONL sources before model execution", async () => {
    for (const source of ["{bad", `${evidence("CSV")}\n${evidence("CSV").split("\n")[2]}`]) {
      const model = gateway([proposal()]);
      await expect(interpretFinanceReport({ ...params, format: "CSV", extractedEvidence: source,
        gateway: model.gateway })).rejects.toBeInstanceOf(FinanceReportImportAgentError);
      expect(model.extract).not.toHaveBeenCalled();
    }
  });
});
