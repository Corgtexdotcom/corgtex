import type { ModelGateway } from "@corgtex/models";
import { AppError } from "@corgtex/domain";
import { describe, expect, it, vi } from "vitest";
const lifecycle = vi.hoisted(() => ({ claim: vi.fn(), persist: vi.fn(), fail: vi.fn(), execute: vi.fn(), extract: vi.fn() }));
vi.mock("@corgtex/domain", async (load) => ({ ...await load<typeof import("@corgtex/domain")>(), claimFinanceReportImportProposal: lifecycle.claim,
  persistFinanceReportImportProposal: lifecycle.persist, failFinanceReportImportProposal: lifecycle.fail }));
vi.mock("@corgtex/models", async (load) => ({ ...await load<typeof import("@corgtex/models")>(), defaultModelGateway: { extract: lifecycle.extract } }));
vi.mock("./runtime", () => ({ executeAgentRun: lifecycle.execute }));
import {
  financeReportModelProposalSchemaV1,
  proposeFinanceReportImportV1,
  runFinanceReportImportAgentV1,
} from "./finance-report-import";

const lines = ["Profit and Loss", "Accrual", "Monthly", "January 2026", "February 2026", "Revenue", "1.23", "2.34", "USD", "Figures in thousands", "Decimal separator dot"];
const roles = ["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "AMOUNT", "AMOUNT", "ISO_CODE", "TEXT", "TEXT"] as const;
const claimIds = ["type", "basis", "cadence", "jan", "feb", "revenue", "jan-amount", "feb-amount", "currency", "scale", "decimal"];

function source(format: "PDF" | "XLSX" = "PDF", amounts: readonly [string, string] = ["1.23", "2.34"]) {
  const reportLines = [...lines]; [reportLines[6], reportLines[7]] = amounts;
  if (format === "PDF") return {
    format,
    extractedEvidence: JSON.stringify({ page: 1, text: reportLines.join("\n") }),
    claims: reportLines.map((line, lineIndex) => ({ id: claimIds[lineIndex], role: roles[lineIndex], source: { kind: "PDF", page: 1, lineIndex, line, start: 0, end: line.length, text: line } })),
  } as const;
  const records = [{ sheet: "Report", rowCount: reportLines.length, columnCount: 1 }, ...reportLines.map((value, index) => ({ sheet: "Report", row: index + 1, column: 1, type: roles[index] === "AMOUNT" ? "NUMBER" : "TEXT", value }))];
  return {
    format,
    extractedEvidence: records.map((record) => JSON.stringify(record)).join("\n"),
    claims: reportLines.map((value, index) => ({ id: claimIds[index], role: roles[index], source: { kind: "CELL", sheet: "Report", row: index + 1, column: 1, evidence: value } })),
  } as const;
}

function proposal(format: "PDF" | "XLSX" = "PDF", amounts: readonly [string, string] = ["1.23", "2.34"]) {
  const report = source(format, amounts);
  return {
    version: 1,
    classification: { reportType: "PROFIT_AND_LOSS", basis: "ACCRUAL", cadence: "MONTHLY", reportTypeEvidenceClaimIds: ["type"], basisEvidenceClaimIds: ["basis"], cadenceEvidenceClaimIds: ["cadence"], confidence: 0.98 },
    numericFormat: { status: "RESOLVED", version: 1, decimalSeparator: "DOT", groupingSeparator: "NONE", amountScale: 1_000, decimalSeparatorEvidenceClaimIds: [], groupingSeparatorEvidenceClaimIds: [], amountScaleEvidenceClaimIds: ["scale"], confidence: 0.95 },
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

async function run(output: unknown, options: { format?: "PDF" | "XLSX"; currencies?: string[]; second?: unknown; amounts?: readonly [string, string] } = {}) {
  const report = source(options.format, options.amounts);
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

  it("downgrades separator ambiguity unless exact field-specific evidence rules it out", async () => {
    const amounts = ["1.234", "2.345"] as const;
    const ambiguous = proposal("PDF", amounts);
    const unresolved = await run(ambiguous, { amounts });
    expect(unresolved.result).toMatchObject({ kind: "SUCCESS", proposal: { numericFormat: { status: "UNRESOLVED" }, mappings: [{ amountCents: null }, { amountCents: null }], exceptions: [expect.objectContaining({ code: "NUMERIC_FORMAT_UNRESOLVED", severity: "BLOCKER" })] } });
    const evidenced = { ...ambiguous, numericFormat: { ...ambiguous.numericFormat, decimalSeparatorEvidenceClaimIds: ["decimal"] } };
    expect((await run(evidenced, { amounts })).result).toMatchObject({ kind: "SUCCESS", proposal: { numericFormat: { status: "RESOLVED" }, mappings: [{ amountCents: 123_400 }, { amountCents: 234_500 }] } });
    const mixedAmounts = ["1.234", "2,345"] as const;
    const mixed = proposal("PDF", mixedAmounts); mixed.numericFormat.groupingSeparator = "COMMA";
    expect((await run(mixed, { amounts: mixedAmounts })).result).toMatchObject({ kind: "SUCCESS", proposal: { numericFormat: { status: "UNRESOLVED" }, mappings: [{ amountCents: null }, { amountCents: null }] } });
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

describe("runFinanceReportImportAgentV1", () => {
  it("links a sanitized AgentRun and persists only exact blocked candidates", async () => {
    vi.clearAllMocks(); const report = source(); lifecycle.claim.mockResolvedValue({ skipped: false, batchId: "batch-1", version: 4,
      format: report.format, extractedEvidence: report.extractedEvidence, workspaceCurrencyCodes: [] });
    const output = { ...proposal(), exceptions: [{ code: "SOURCE_WARNING", severity: "WARNING", message: "Review source.", evidenceClaimIds: ["jan-amount"] }] };
    lifecycle.extract.mockResolvedValue({ output, raw: "private", usage: {} });
    lifecycle.persist.mockResolvedValue({ batchId: "batch-1", version: 5, stage: "RECONCILING", candidateCount: 2 });
    let recorded: unknown;
    lifecycle.execute.mockImplementation(async (config) => { const context = await config.buildContext({}, "run-1");
      const outcome = await config.execute(context, {}, "run-1", "quality-model"); recorded = { payload: config.payload, context, result: outcome.resultJson };
      return { id: "run-1", status: "COMPLETED", resultJson: outcome.resultJson }; });
    await runFinanceReportImportAgentV1({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-1", attempts: 1, isFinalAttempt: false });
    expect(lifecycle.execute.mock.calls[0][0].triggerRef).toBe("job-1:attempt:1");
    expect(lifecycle.persist.mock.calls[0][0]).toMatchObject({ agentRunId: "run-1", expectedVersion: 4, interpretation: { exceptions: [{ code: "SOURCE_WARNING" }] },
      candidates: [{ amountCents: 123_000, sourceKey: expect.stringMatching(/^[a-f0-9]{64}$/) }, { amountCents: 234_000 }] });
    expect(JSON.stringify(recorded)).not.toMatch(/Profit and Loss|123000|jan-revenue/);
    const currencyOnly = { ...proposal(), currency: { explicitCode: null, evidenceClaimId: null, confidence: 0.5 } };
    lifecycle.extract.mockResolvedValue({ output: currencyOnly, raw: "private", usage: {} });
    lifecycle.persist.mockResolvedValue({ batchId: "batch-1", version: 5, stage: "NEEDS_INPUT", candidateCount: 2 });
    await runFinanceReportImportAgentV1({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-currency", attempts: 1, isFinalAttempt: false });
    expect(lifecycle.persist).toHaveBeenLastCalledWith(expect.objectContaining({ currency: expect.objectContaining({ state: "UNRESOLVED", code: null }),
      blockerCount: 1, candidates: expect.arrayContaining([expect.objectContaining({ amountCents: 123_000 }), expect.objectContaining({ amountCents: 234_000 })]) }));
    lifecycle.persist.mockRejectedValue(new AppError(400, "INVALID_FINANCE_IMPORT_PROPOSAL", "invalid")); lifecycle.fail.mockResolvedValue({ stage: "FAILED" });
    await expect(runFinanceReportImportAgentV1({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-1", attempts: 2, isFinalAttempt: false })).resolves.toMatchObject({ stage: "FAILED" });
    expect(lifecycle.fail).toHaveBeenLastCalledWith(expect.objectContaining({ failureCode: "INVALID_MODEL_OUTPUT" }));
  });

  it("defers policy/provider failures and records bounded final states", async () => {
    vi.clearAllMocks(); lifecycle.execute.mockResolvedValue({ skipped: true, reason: "concurrency_limit" });
    await expect(runFinanceReportImportAgentV1({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-1", attempts: 1, isFinalAttempt: false })).rejects.toThrow("policy deferred");
    expect(lifecycle.fail).not.toHaveBeenCalled();
    lifecycle.fail.mockResolvedValue({ stage: "NEEDS_INPUT", failureCode: "AGENT_UNAVAILABLE" });
    await expect(runFinanceReportImportAgentV1({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-1", attempts: 5, isFinalAttempt: true })).resolves.toMatchObject({ stage: "NEEDS_INPUT" });
    expect(lifecycle.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "AGENT_UNAVAILABLE" }));
    lifecycle.execute.mockImplementation(async (config) => config.execute(await config.buildContext({}, "run-2"), {}, "run-2", "quality-model"));
    lifecycle.claim.mockResolvedValue({ skipped: false, version: 4, format: source().format, extractedEvidence: source().extractedEvidence, workspaceCurrencyCodes: [] });
    lifecycle.extract.mockRejectedValue(new Error("private provider detail")); lifecycle.fail.mockResolvedValue({ stage: "FAILED", failureCode: "PROVIDER_ERROR" });
    await expect(runFinanceReportImportAgentV1({ workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 3,
      workflowJobId: "job-2", attempts: 5, isFinalAttempt: true })).rejects.toThrow("provider failed");
    expect(lifecycle.fail).toHaveBeenLastCalledWith(expect.objectContaining({ failureCode: "PROVIDER_ERROR", agentRunId: "run-2" }));
  });
});
