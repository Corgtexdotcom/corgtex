import type { ModelGateway } from "@corgtex/models";
import { describe, expect, it, vi } from "vitest";
import { FinanceReportImportAgentError, financeReportImportProposalV1Schema,
  interpretFinanceReport, type FinanceReportImportProposalV1 } from "./finance-report-import";

function proposal(): FinanceReportImportProposalV1 {
  return {
    contractVersion: 1,
    report: { title: "Synthetic monthly actuals", reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL",
      cadence: "MONTHLY", periodStart: "2026-06-01", periodEnd: "2026-06-30", asOfDate: null,
      currency: { state: "UNRESOLVED", code: null, evidence: [] } },
    summary: "Synthetic monthly reported actuals proposal.",
    candidates: [{
      sourceLocation: { page: null, sheet: "June", row: 2, column: 3,
        evidence: "Consulting revenue | 1250.00" },
      sourceLabel: "Consulting revenue", sourceAccountPath: ["Revenue", "Consulting"],
      proposedAccountPath: ["Revenue", "Consulting"], rowKind: "LEAF",
      periodStart: "2026-06-01", periodEnd: "2026-06-30", amountCents: 125_000,
      mappingStatus: "MAPPED", confidence: 0.98, reviewStatus: "VERIFIED",
      exceptionCodes: [], reviewReasons: [],
    }],
  };
}

function gateway(outputs: unknown[]) {
  const extract = vi.fn();
  for (const output of outputs) {
    if (output instanceof Error) extract.mockRejectedValueOnce(output);
    else extract.mockResolvedValueOnce({ output, raw: JSON.stringify(output),
      usage: { provider: "synthetic", model: "quality-test", inputTokens: 10, outputTokens: 20 } });
  }
  return { model: { extract } as unknown as Pick<ModelGateway, "extract">, extract };
}
const params = { workspaceId: "workspace-synthetic", agentRunId: "run-synthetic",
  workflowJobId: "job-synthetic", model: "quality-test", fileName: "synthetic.csv",
  mimeType: "text/csv", extractedEvidence:
    "{\"sheet\":\"June\",\"row\":2,\"column\":3,\"value\":\"Consulting revenue | 1250.00\"}" };

describe("Finance report import proposal contract", () => {
  it("accepts a strict proposal while leaving missing currency unresolved", () => {
    const result = financeReportImportProposalV1Schema.parse(proposal());
    expect(result.report.currency).toEqual({ state: "UNRESOLVED", code: null, evidence: [] });
    expect(JSON.stringify(result)).not.toContain("USD");
  });

  it.each([
    ["unknown fields", () => ({ ...proposal(), providerDetail: "blocked" })],
    ["unstorable specialized report type", () => ({ ...proposal(), report: {
      ...proposal().report, reportType: "BUDGET_VS_ACTUAL",
    } })],
    ["unstorable mixed basis", () => ({ ...proposal(), report: {
      ...proposal().report, basis: "MIXED",
    } })],
    ["invalid date", () => ({ ...proposal(), report: { ...proposal().report, periodEnd: "2026-02-30" } })],
    ["unsupported early year", () => ({ ...proposal(), report: { ...proposal().report, periodStart: "0999-01-01" } })],
    ["as-of outside period", () => ({ ...proposal(), report: { ...proposal().report, asOfDate: "2026-07-01" } })],
    ["reversed candidate period", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0],
      periodStart: "2026-07-01" }] })],
    ["candidate outside report period", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0],
      periodStart: "2026-05-01" }] })],
    ["fractional cents", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0], amountCents: 12.5 }] })],
    ["overflow cents", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0], amountCents: 2_147_483_648 }] })],
    ["empty mapped hierarchy", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0], proposedAccountPath: [] }] })],
    ["missing location", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0],
      sourceLocation: { page: null, sheet: null, row: null, column: null, evidence: "Unlocated" } }] })],
    ["mixed source coordinates", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0],
      sourceLocation: { page: 1, sheet: "June", row: 2, column: 3, evidence: "Unlocated" } }] })],
    ["unproven currency", () => ({ ...proposal(), report: { ...proposal().report,
      currency: { state: "EXPLICIT", code: "EUR", evidence: [] } } })],
    ["invented unresolved evidence", () => ({ ...proposal(), report: { ...proposal().report,
      currency: { state: "UNRESOLVED", code: null, evidence: [proposal().candidates[0].sourceLocation] } } })],
    ["exception without reason", () => ({ ...proposal(), candidates: [{ ...proposal().candidates[0],
      exceptionCodes: ["OTHER"] }] })],
    ["duplicate candidates", () => {
      const value = proposal();
      value.candidates.push({ ...value.candidates[0] });
      return value;
    }],
  ])("rejects unsafe output: %s", (_label, makeInvalid) => {
    expect(financeReportImportProposalV1Schema.safeParse(makeInvalid()).success).toBe(false);
  });
});

describe("interpretFinanceReport", () => {
  it("uses structured extraction and treats approved profiles only as hints", async () => {
    const model = gateway([proposal()]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model, approvedProfileHints: [{
      profileId: "profile-synthetic", version: 3, layoutFingerprint: "layout-v3",
      approvedMappings: [{ sourceLabel: "Consulting revenue", accountPath: ["Revenue", "Consulting"] }],
    }] })).resolves.toMatchObject({ contractVersion: 1,
      candidates: [{ amountCents: 125_000, reviewStatus: "VERIFIED" }] });
    const request = model.extract.mock.calls[0]?.[0];
    expect(request).toMatchObject({ model: "quality-test", workspaceId: "workspace-synthetic",
      agentRunId: "run-synthetic", workflowJobId: "job-synthetic" });
    expect(request).not.toHaveProperty("tools");
    expect(request.instruction).toContain("never default to USD");
    expect(request.instruction).toContain("Profile hints are non-authoritative");
    expect(request.instruction).toContain("budget-versus-actual");
    expect(JSON.parse(request.input).approvedProfileHints).toEqual([expect.objectContaining({ version: 3 })]);
  });

  it("preserves worksheet identifiers verbatim during evidence matching", async () => {
    const output = proposal();
    output.candidates[0].sourceLocation.sheet = " June ";
    const model = gateway([output]);
    const result = await interpretFinanceReport({ ...params, gateway: model.model,
      extractedEvidence:
        "{\"sheet\":\" June \",\"row\":2,\"column\":3,\"value\":\"Consulting revenue | 1250.00\"}",
    });
    expect(result.candidates[0].sourceLocation.sheet).toBe(" June ");
    expect(model.extract).toHaveBeenCalledOnce();
  });

  it("allows a bounded excerpt from PDF page text", async () => {
    const output = proposal();
    output.candidates[0].sourceLocation = {
      page: 2, sheet: null, row: null, column: null, evidence: "Consulting revenue | 1250.00",
    };
    const model = gateway([output]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model,
      extractedEvidence: "{\"page\":2,\"text\":\"Revenue\\nConsulting revenue | 1250.00\\nTotal\"}",
    })).resolves.toMatchObject({ contractVersion: 1 });
  });

  it.each([
    ["low confidence", { confidence: 0.6 }, "LOW_CONFIDENCE"],
    ["ambiguous", { mappingStatus: "AMBIGUOUS" }, "AMBIGUOUS_MAPPING"],
    ["unmapped", { mappingStatus: "UNMAPPED", proposedAccountPath: [] }, "UNMAPPED_ACCOUNT"],
  ])("forces %s into a visible exception", async (_label, candidateOverride, exceptionCode) => {
    const output = proposal();
    Object.assign(output.candidates[0], candidateOverride);
    const model = gateway([output]);
    const result = await interpretFinanceReport({ ...params, gateway: model.model });
    expect(result.candidates[0]).toMatchObject({ reviewStatus: "WARNING",
      exceptionCodes: expect.arrayContaining([exceptionCode]), reviewReasons: [expect.any(String)] });
  });

  it("retries strict validation once without trusting a profile hint", async () => {
    const model = gateway([{ ...proposal(), unknownProviderField: "private-output" }, proposal()]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model, approvedProfileHints: [{
      profileId: "profile-synthetic", version: 1, layoutFingerprint: "layout-v1", approvedMappings: [],
    }] })).resolves.toMatchObject({ contractVersion: 1 });
    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(model.extract.mock.calls[1]?.[0].instruction).toContain("failed validation");
    expect(model.extract.mock.calls[1]?.[0].instruction).not.toContain("private-output");
  });

  it("points report-window retries at the offending start field", async () => {
    const outside = proposal();
    outside.candidates[0].periodStart = "2026-05-01";
    const model = gateway([outside, proposal()]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model })).resolves.toMatchObject({
      contractVersion: 1,
    });
    expect(model.extract.mock.calls[1]?.[0].instruction).toContain("candidates.0.periodStart");
  });

  it("forces a model-supplied review reason out of verified state", async () => {
    const output = proposal();
    output.candidates[0].reviewReasons = ["The source label needs human review."];
    const model = gateway([output]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model })).resolves.toMatchObject({
      candidates: [{ reviewStatus: "WARNING" }],
    });
  });

  it("retries fabricated candidate and currency evidence instead of inferring USD", async () => {
    const fabricated = proposal();
    fabricated.candidates[0].sourceLocation.row = 99;
    fabricated.report.currency = { state: "EXPLICIT", code: "USD", evidence: [{
      page: null, sheet: "June", row: 99, column: 4, evidence: "USD",
    }] };
    const model = gateway([fabricated, proposal()]);
    const result = await interpretFinanceReport({ ...params, gateway: model.model });
    expect(result.report.currency).toEqual({ state: "UNRESOLVED", code: null, evidence: [] });
    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(model.extract.mock.calls[1]?.[0].instruction).toContain("candidates.0.sourceLocation");
    expect(model.extract.mock.calls[1]?.[0].instruction).toContain("report.currency.evidence.0");
  });

  it("accepts explicit currency only when its exact source evidence is present", async () => {
    const output = proposal();
    output.report.currency = { state: "EXPLICIT", code: "EUR", evidence: [{
      page: null, sheet: "June", row: 1, column: 2, evidence: "EUR",
    }] };
    const model = gateway([output]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model,
      extractedEvidence: `${params.extractedEvidence}\n{"sheet":"June","row":1,"column":2,"value":"EUR"}`,
    })).resolves.toMatchObject({ report: { currency: { state: "EXPLICIT", code: "EUR" } } });
    expect(model.extract).toHaveBeenCalledOnce();
  });

  it.each([
    ["U.S. Dollars", "USD"],
    ["Euros", "EUR"],
  ])("accepts unambiguous currency name evidence: %s", async (evidence, code) => {
    const output = proposal();
    output.report.currency = { state: "EXPLICIT", code, evidence: [{
      page: null, sheet: "June", row: 1, column: 2, evidence,
    }] };
    const model = gateway([output]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model,
      extractedEvidence: `${params.extractedEvidence}\n${JSON.stringify({
        sheet: "June", row: 1, column: 2, value: evidence,
      })}`,
    })).resolves.toMatchObject({ report: { currency: { state: "EXPLICIT", code } } });
  });

  it("does not treat extraction metadata as source evidence", async () => {
    const metadataClaim = proposal();
    metadataClaim.candidates[0].sourceLocation.evidence = "TEXT";
    const model = gateway([metadataClaim, proposal()]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model,
      extractedEvidence:
        "{\"sheet\":\"June\",\"row\":2,\"column\":3,\"type\":\"TEXT\",\"value\":\"Consulting revenue | 1250.00\"}",
    })).resolves.toMatchObject({ contractVersion: 1 });
    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(model.extract.mock.calls[1]?.[0].instruction).toContain("candidates.0.sourceLocation");
  });

  it("requires exact spreadsheet cell evidence instead of accepting fragments", async () => {
    const fragmentClaim = proposal();
    fragmentClaim.candidates[0].sourceLocation.evidence = "1250";
    const model = gateway([fragmentClaim, proposal()]);
    await expect(interpretFinanceReport({ ...params, gateway: model.model,
      extractedEvidence:
        "{\"sheet\":\"June\",\"row\":2,\"column\":3,\"value\":\"Consulting revenue | 1250.00\"}",
    })).resolves.toMatchObject({ contractVersion: 1 });
    expect(model.extract).toHaveBeenCalledTimes(2);
  });

  it("rejects profile hints that exceed aggregate mapping or character budgets", async () => {
    const model = gateway([proposal()]);
    const mappings = Array.from({ length: 500 }, (_, index) => ({
      sourceLabel: `${index}-${"x".repeat(490)}`,
      accountPath: ["Revenue"],
    }));
    await expect(interpretFinanceReport({ ...params, gateway: model.model, approvedProfileHints: [{
      profileId: "oversized-profile", version: 1, layoutFingerprint: "oversized-layout",
      approvedMappings: mappings,
    }] })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["approvedProfileHints"] })],
    });

    const tooManyMappings = Array.from({ length: 5 }, (_, profileIndex) => ({
      profileId: `profile-${profileIndex}`, version: 1, layoutFingerprint: `layout-${profileIndex}`,
      approvedMappings: Array.from({ length: 401 }, (_, mappingIndex) => ({
        sourceLabel: `Label ${mappingIndex}`, accountPath: ["Revenue"],
      })),
    }));
    await expect(interpretFinanceReport({ ...params, gateway: model.model,
      approvedProfileHints: tooManyMappings,
    })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["approvedProfileHints"] })],
    });
    expect(model.extract).not.toHaveBeenCalled();
  });

  it("sanitizes terminal invalid output while preserving transient retries", async () => {
    const parseError = Object.assign(new Error("raw provider content"),
      { name: "ExtractionParseError", raw: "private-output" });
    const invalidModel = gateway([parseError, { providerTrace: "private-output" }]);
    const caught = await interpretFinanceReport({ ...params, gateway: invalidModel.model }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(FinanceReportImportAgentError);
    expect(caught).toMatchObject({ code: "FINANCE_REPORT_IMPORT_AGENT_INVALID_OUTPUT",
      message: "The financial report could not be interpreted safely. Please retry." });
    expect(JSON.stringify(caught)).not.toContain("private-output");
    expect(invalidModel.extract).toHaveBeenCalledTimes(2);

    const transient = new Error("temporarily unavailable");
    const transientModel = gateway([transient]);
    await expect(interpretFinanceReport({ ...params, gateway: transientModel.model })).rejects.toBe(transient);
    expect(transientModel.extract).toHaveBeenCalledOnce();
  });
});
