import type { ModelGateway } from "@corgtex/models";
import { describe, expect, it, vi } from "vitest";
import {
  financeReportModelProposalSchemaV1,
  proposeFinanceReportImportV1,
} from "./finance-report-import";

const lines = ["Profit and Loss", "Accrual", "Monthly", "January 2026", "February 2026", "Revenue", "1.23", "2.34", "USD", "Figures in thousands"];
const roles = ["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "AMOUNT", "AMOUNT", "ISO_CODE", "TEXT"] as const;
const claimIds = ["type", "basis", "cadence", "jan", "feb", "revenue", "jan-amount", "feb-amount", "currency", "scale"];

function source(format: "PDF" | "XLSX" = "PDF") {
  if (format === "PDF") return {
    format,
    extractedEvidence: JSON.stringify({ page: 1, text: lines.join("\n") }),
    claims: lines.map((line, lineIndex) => ({ id: claimIds[lineIndex], role: roles[lineIndex], source: { kind: "PDF", page: 1, lineIndex, line, start: 0, end: line.length, text: line } })),
  } as const;
  const records = [{ sheet: "Report", rowCount: lines.length, columnCount: 1 }, ...lines.map((value, index) => ({ sheet: "Report", row: index + 1, column: 1, type: roles[index] === "AMOUNT" ? "NUMBER" : "TEXT", value }))];
  return {
    format,
    extractedEvidence: records.map((record) => JSON.stringify(record)).join("\n"),
    claims: lines.map((value, index) => ({ id: claimIds[index], role: roles[index], source: { kind: "CELL", sheet: "Report", row: index + 1, column: 1, evidence: value } })),
  } as const;
}

function proposal(format: "PDF" | "XLSX" = "PDF") {
  const report = source(format);
  return {
    version: 1,
    classification: { reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 0.98 },
    numericFormat: { status: "RESOLVED", version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1_000, evidenceClaimIds: ["scale"], confidence: 0.95 },
    currency: { explicitCode: "USD", evidenceClaimId: "currency", confidence: 1 },
    periods: [
      { id: "2026-01", label: "January 2026", periodStart: "2026-01-01", periodEnd: "2026-01-31", evidenceClaimIds: ["jan"], confidence: 1 },
      { id: "2026-02", label: "February 2026", periodStart: "2026-02-01", periodEnd: "2026-02-28", evidenceClaimIds: ["feb"], confidence: 1 },
    ],
    hierarchy: [{ id: "revenue", parentId: null, label: "Revenue", evidenceClaimIds: ["revenue"], confidence: 1 }],
    mappings: [
      { id: "jan-revenue", amountClaimId: "jan-amount", periodId: "2026-01", hierarchyId: "revenue", factKind: "LEAF", confidence: 0.99 },
      { id: "feb-revenue", amountClaimId: "feb-amount", periodId: "2026-02", hierarchyId: "revenue", factKind: "LEAF", confidence: 0.99 },
    ],
    evidenceClaims: report.claims,
    exceptions: [],
  };
}

function model(...responses: Array<unknown | Error>) {
  const extract = vi.fn(async (_request: { instruction: string }) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { output: next as Record<string, unknown>, raw: JSON.stringify(next), usage: { provider: "test", model: "test" } };
  });
  return { extract, gateway: { extract } as unknown as ModelGateway };
}

async function run(output: unknown, options: { format?: "PDF" | "XLSX"; currencies?: string[]; second?: unknown } = {}) {
  const report = source(options.format);
  const mocked = model(output, options.second ?? output);
  const result = await proposeFinanceReportImportV1({ workspaceId: "workspace-1", format: report.format, extractedEvidence: report.extractedEvidence, workspaceCurrencyCodes: options.currencies ?? [], gateway: mocked.gateway });
  return { result, extract: mocked.extract };
}

describe("proposeFinanceReportImportV1", () => {
  it("returns an exact, editable multi-period PDF proposal without trusting model arithmetic", async () => {
    const { result, extract } = await run(proposal());
    expect(result).toMatchObject({ kind: "SUCCESS", attempts: 1, proposal: { version: 1, currency: { state: "RESOLVED", code: "USD", source: "DOCUMENT" }, mappings: [{ amountCents: 123_000 }, { amountCents: 234_000 }] } });
    expect(extract).toHaveBeenCalledTimes(1);
    const request = extract.mock.calls[0]?.[0];
    expect(request?.instruction).toMatch(/without a vendor picker/i);
    expect(request?.instruction).toMatch(/never invent transactions/i);
    expect(request?.instruction).toMatch(/never guess or default to USD/i);
    expect(JSON.stringify(result)).not.toContain("extractedEvidence");
  });

  it("binds XLSX cells and resolves only the single workspace currency when the report is silent", async () => {
    const output = { ...proposal("XLSX"), currency: { explicitCode: null, evidenceClaimId: null, confidence: 0.8 } };
    const { result } = await run(output, { format: "XLSX", currencies: [" eur ", "EUR"] });
    expect(result).toMatchObject({ kind: "SUCCESS", proposal: { currency: { state: "RESOLVED", code: "EUR", source: "WORKSPACE_SINGLE_CURRENCY" } } });
    if (result.kind === "SUCCESS") expect(result.proposal.mappings[0]).toMatchObject({ amountCents: 123_000, sourceKey: expect.any(String) });
  });

  it.each([[[]], [["EUR", "USD"]]] as const)("keeps zero or multiple workspace currencies unresolved", async (currencies) => {
    const base = proposal();
    const output = { ...base, currency: { explicitCode: null, evidenceClaimId: null, confidence: 0.5 }, classification: { ...base.classification, reportType: "OTHER", basis: "UNSPECIFIED" }, exceptions: [{ code: "CURRENCY_UNRESOLVED", severity: "WARNING", message: "Model warning", evidenceClaimIds: [] }] };
    const { result } = await run(output, { currencies: [...currencies] });
    expect(result).toMatchObject({ kind: "SUCCESS", proposal: { currency: { state: "UNRESOLVED", code: null, source: null } } });
    if (result.kind === "SUCCESS") expect(result.proposal.exceptions.map(({ code }) => code)).toEqual(expect.arrayContaining(["REPORT_TYPE_UNRESOLVED", "BASIS_UNRESOLVED", "CURRENCY_UNRESOLVED"]));
    if (result.kind === "SUCCESS") expect(result.proposal.exceptions.find(({ code }) => code === "CURRENCY_UNRESOLVED")?.severity).toBe("BLOCKER");
  });

  it("uses one bounded repair for extra model arithmetic, then returns deterministic cents", async () => {
    const invalid = structuredClone(proposal()) as ReturnType<typeof proposal> & { mappings: Array<Record<string, unknown>> };
    invalid.mappings[0]!.amountCents = 999;
    expect(financeReportModelProposalSchemaV1.safeParse(invalid).success).toBe(false);
    const { result, extract } = await run(invalid, { second: proposal() });
    expect(result).toMatchObject({ kind: "SUCCESS", attempts: 2 });
    if (result.kind === "SUCCESS") expect(result.proposal.mappings[0]?.amountCents).toBe(123_000);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1]?.[0]?.instruction).toMatch(/validation feedback/i);
  });

  it("repairs bad references once and fails closed when they remain invalid", async () => {
    const invalid = proposal();
    invalid.mappings[0]!.amountClaimId = "missing";
    const repaired = await run(invalid, { second: proposal() });
    expect(repaired.result).toMatchObject({ kind: "SUCCESS", attempts: 2 });
    const failed = await run(invalid);
    expect(failed.result).toEqual({ version: 1, kind: "FAILURE", attempts: 2, code: "INVALID_MODEL_OUTPUT" });
    expect(failed.extract).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported classification evidence, dates, and duplicate semantic targets", async () => {
    const unsupportedBasis = proposal();
    unsupportedBasis.classification.basisEvidenceClaimIds = ["jan-amount"];
    expect((await run(unsupportedBasis)).result).toMatchObject({ kind: "FAILURE", code: "INVALID_MODEL_OUTPUT" });
    const oldDate = proposal();
    oldDate.periods[0]!.periodStart = "0999-01-01";
    expect((await run(oldDate)).result).toMatchObject({ kind: "FAILURE", code: "INVALID_MODEL_OUTPUT" });
    const duplicateTarget = proposal();
    duplicateTarget.periods[1]!.periodStart = "2026-01-01";
    duplicateTarget.periods[1]!.periodEnd = "2026-01-31";
    expect((await run(duplicateTarget)).result).toMatchObject({ kind: "FAILURE", code: "INVALID_MODEL_OUTPUT" });
  });

  it("returns structural input exceptions without computing guessed cents", async () => {
    const base = proposal();
    expect(financeReportModelProposalSchemaV1.safeParse({ ...base, numericFormat: { ...base.numericFormat, confidence: 0 } }).success).toBe(false);
    const output = { ...base, classification: { ...base.classification, reportType: "OTHER", basis: "UNSPECIFIED", cadence: null, reportTypeEvidenceClaimIds: [], basisEvidenceClaimIds: [], cadenceEvidenceClaimIds: [] }, numericFormat: { status: "UNRESOLVED", version: 1, decimalSeparator: null, groupingSeparator: null, amountScale: null, evidenceClaimIds: [], confidence: 0 }, mappings: base.mappings.map((mapping, index) => ({ ...mapping, confidence: index === 0 ? 0 : mapping.confidence })) };
    const { result } = await run(output);
    expect(result).toMatchObject({ kind: "SUCCESS", proposal: { mappings: [{ amountCents: null }, { amountCents: null }] } });
    if (result.kind === "SUCCESS") expect(result.proposal.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REPORT_TYPE_UNRESOLVED", severity: "BLOCKER" }), expect.objectContaining({ code: "BASIS_UNRESOLVED", severity: "BLOCKER" }), expect.objectContaining({ code: "CADENCE_UNRESOLVED", severity: "BLOCKER" }), expect.objectContaining({ code: "NUMERIC_FORMAT_UNRESOLVED", severity: "BLOCKER" }), expect.objectContaining({ code: "SEMANTIC_PROPOSAL_UNCERTAIN", severity: "BLOCKER" })]));
  });

  it("rejects explicit currency without matching exact ISO evidence", async () => {
    const invalid = proposal();
    invalid.currency.evidenceClaimId = "revenue";
    expect((await run(invalid)).result).toEqual({ version: 1, kind: "FAILURE", attempts: 2, code: "INVALID_MODEL_OUTPUT" });
  });

  it("returns typed provider and input failures without repair or a model call", async () => {
    const report = source();
    const provider = model(new Error("private provider detail"));
    await expect(proposeFinanceReportImportV1({ workspaceId: "workspace-1", format: report.format, extractedEvidence: report.extractedEvidence, workspaceCurrencyCodes: [], gateway: provider.gateway })).resolves.toEqual({ version: 1, kind: "FAILURE", attempts: 1, code: "PROVIDER_ERROR" });
    expect(provider.extract).toHaveBeenCalledTimes(1);
    const unused = model(proposal());
    await expect(proposeFinanceReportImportV1({ workspaceId: "workspace-1", format: report.format, extractedEvidence: report.extractedEvidence, workspaceCurrencyCodes: ["ZZZ"], gateway: unused.gateway })).resolves.toEqual({ version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" });
    await expect(proposeFinanceReportImportV1({ workspaceId: "workspace-1", format: "PDF", extractedEvidence: "not-json", workspaceCurrencyCodes: [], gateway: unused.gateway })).resolves.toEqual({ version: 1, kind: "FAILURE", attempts: 0, code: "INVALID_INPUT" });
    expect(unused.extract).not.toHaveBeenCalled();
  });
});
