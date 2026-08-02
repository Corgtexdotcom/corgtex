import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { financeImportBatch: { updateMany: vi.fn() } },
}));

vi.mock("@corgtex/shared", () => ({ prisma: prismaMock }));

const textClaim = (id: string) => ({
  id,
  role: "TEXT" as const,
  source: { kind: "CELL" as const, sheet: "Report", row: 1, column: 1, evidence: id },
});
const blocker = (code: string) => ({ code, severity: "BLOCKER" as const, message: "Review required.", evidenceClaimIds: [] });

const resolved = {
  version: 1,
  classification: {
    reportType: "PROFIT_AND_LOSS",
    basis: "ACCRUAL",
    cadence: "MONTHLY",
    reportTypeEvidenceClaimIds: ["report-type"],
    basisEvidenceClaimIds: ["basis"],
    cadenceEvidenceClaimIds: ["cadence"],
    confidence: 0.95,
  },
  numericFormat: {
    status: "RESOLVED",
    version: 1,
    decimalSeparator: "DOT",
    groupingSeparator: "COMMA",
    amountScale: 1_000,
    decimalSeparatorEvidenceClaimIds: ["decimal"],
    groupingSeparatorEvidenceClaimIds: ["grouping"],
    amountScaleEvidenceClaimIds: ["scale"],
    confidence: 0.9,
  },
  evidenceClaims: ["report-type", "basis", "cadence", "decimal", "grouping", "scale", "period"].map(textClaim),
  exceptions: [{ code: "HISTORICAL_ADDITION", severity: "WARNING", message: "Review the historical addition.", evidenceClaimIds: ["period"] }],
} as const;

const unresolved = {
  version: 1,
  classification: {
    reportType: "OTHER",
    basis: "UNSPECIFIED",
    cadence: null,
    reportTypeEvidenceClaimIds: [],
    basisEvidenceClaimIds: [],
    cadenceEvidenceClaimIds: [],
    confidence: 0,
  },
  numericFormat: {
    status: "UNRESOLVED",
    version: 1,
    decimalSeparator: null,
    groupingSeparator: null,
    amountScale: null,
    evidenceClaimIds: ["ambiguous-format"],
    confidence: 0.25,
  },
  evidenceClaims: [textClaim("ambiguous-format")],
  exceptions: ["REPORT_TYPE_UNRESOLVED", "BASIS_UNRESOLVED", "CADENCE_UNRESOLVED", "NUMERIC_FORMAT_UNRESOLVED", "SEMANTIC_PROPOSAL_UNCERTAIN"].map(blocker),
} as const;

describe("Finance import interpretation state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.financeImportBatch.updateMany.mockResolvedValue({ count: 1 });
  });

  it("accepts bounded resolved and unresolved V1 interpretations", async () => {
    const { parseFinanceImportInterpretationV1 } = await import("./finance-import-interpretation");
    expect(parseFinanceImportInterpretationV1(resolved)).toEqual(resolved);
    expect(parseFinanceImportInterpretationV1(unresolved)).toEqual(unresolved);
  });

  it.each([
    { ...resolved, version: 2 },
    { ...resolved, currency: "USD" },
    { ...resolved, classification: { ...resolved.classification, cadenceEvidenceClaimIds: [] } },
    { ...resolved, classification: { ...resolved.classification, reportTypeEvidenceClaimIds: ["same", "same"] } },
    { ...resolved, numericFormat: { ...resolved.numericFormat, groupingSeparator: "DOT" } },
    { ...resolved, numericFormat: { ...resolved.numericFormat, amountScaleEvidenceClaimIds: [] } },
    { ...unresolved, numericFormat: { ...unresolved.numericFormat, amountScale: 1 } },
    { ...resolved, exceptions: [...resolved.exceptions, resolved.exceptions[0]] },
    { ...resolved, numericFormat: { ...resolved.numericFormat, amountScaleEvidenceClaimIds: ["missing"] } },
    { ...resolved, evidenceClaims: [...resolved.evidenceClaims, textClaim("unused")] },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, role: "AMOUNT" } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, id: "basis" } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, source: { ...claim.source, start: 0, end: 3, text: "wrong" } } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, source: { kind: "PDF", page: 1, lineIndex: 0, line: "abc", start: 0, end: 99, text: "abc" } } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, source: { kind: "PDF", page: 1, lineIndex: 0, line: String.fromCharCode(0xd83d, 0xde00), start: 0, end: 1, text: String.fromCharCode(0xd83d) } } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, source: { ...claim.source, evidence: "abc", start: 0, end: 99, text: "abc" } } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim, index) => index === 0 ? { ...claim, source: { ...claim.source, evidence: " " } } : claim) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim) => ({ ...claim, source: { ...claim.source, evidence: `${claim.id}\u0000` } })) }, { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim) => ({ ...claim, source: { ...claim.source, evidence: String.fromCharCode(0xd800) } })) },
    { ...resolved, evidenceClaims: resolved.evidenceClaims.map((claim) => ({ ...claim, source: { ...claim.source, evidence: "x".repeat(800_000) } })) }, { ...resolved, exceptions: [...resolved.exceptions, blocker("REPORT_TYPE_UNRESOLVED")] },
    { ...resolved, nested: Array.from({ length: 200 }).reduce<Record<string, unknown>>((nested) => ({ nested }), {}) },
    { ...unresolved, exceptions: [] },
  ])("fails closed on invalid or expanded state %#", async (value) => {
    const { parseFinanceImportInterpretationV1 } = await import("./finance-import-interpretation");
    expect(() => parseFinanceImportInterpretationV1(value)).toThrow(expect.objectContaining({
      code: "INVALID_FINANCE_IMPORT_INTERPRETATION",
    }));
  });

  it("rejects adversarial and non-JSON shapes without executing input code", async () => {
    const { parseFinanceImportInterpretationV1 } = await import("./finance-import-interpretation");
    let getterCalled = false;
    const accessor = { ...unresolved } as Record<string, unknown>;
    Object.defineProperty(accessor, "version", { enumerable: true, get: () => { getterCalled = true; return 1; } });
    let proxyTrapped = false;
    const proxy = new Proxy(unresolved, { get: (target, key, receiver) => {
      proxyTrapped = true;
      return Reflect.get(target, key, receiver);
    } });
    const hidden = { ...unresolved } as Record<string, unknown>;
    Object.defineProperty(hidden, "currency", { value: "USD" });
    const symbolKey = { ...unresolved, [Symbol("currency")]: "USD" };
    const cyclic = { ...unresolved } as Record<string, unknown>;
    cyclic.self = cyclic;
    const sparse = { ...unresolved, exceptions: new Array(1) };
    const explicitUndefined = structuredClone(resolved) as { evidenceClaims: Array<{ source: Record<string, unknown> }> };
    explicitUndefined.evidenceClaims[0]!.source.start = undefined;
    for (const value of [accessor, proxy, hidden, symbolKey, cyclic, sparse, explicitUndefined]) {
      expect(() => parseFinanceImportInterpretationV1(value)).toThrow(expect.objectContaining({
        code: "INVALID_FINANCE_IMPORT_INTERPRETATION",
      }));
    }
    expect(getterCalled).toBe(false);
    expect(proxyTrapped).toBe(false);
  });

  it("persists only validated JSON under the workspace, batch, and expected version", async () => {
    const { updateFinanceImportInterpretationV1 } = await import("./finance-import-interpretation");
    await expect(updateFinanceImportInterpretationV1({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      expectedVersion: 3,
      interpretation: resolved,
    })).resolves.toEqual({ batchId: "batch-1", version: 4, interpretation: resolved });
    expect(prismaMock.financeImportBatch.updateMany).toHaveBeenCalledWith({
      where: { id: "batch-1", workspaceId: "workspace-1", version: 3 },
      data: { interpretationJson: resolved, version: { increment: 1 } },
    });
  });

  it.each([
    { workspaceId: "", batchId: "batch-1", expectedVersion: 1 }, { workspaceId: "workspace-1", batchId: "", expectedVersion: 1 },
    { workspaceId: " workspace-1", batchId: "batch-1", expectedVersion: 1 }, { workspaceId: "workspace-1", batchId: "batch-1 ", expectedVersion: 1 },
    { workspaceId: "workspace-1\u0000", batchId: "batch-1", expectedVersion: 1 },
    { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 0 },
    { workspaceId: "workspace-1", batchId: "batch-1", expectedVersion: 2_147_483_647 },
  ])("rejects invalid write identity/version before touching storage %#", async (params) => {
    const { updateFinanceImportInterpretationV1 } = await import("./finance-import-interpretation");
    await expect(updateFinanceImportInterpretationV1({ ...params, interpretation: resolved }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(prismaMock.financeImportBatch.updateMany).not.toHaveBeenCalled();
  });

  it("returns a typed conflict for a stale or cross-workspace write", async () => {
    prismaMock.financeImportBatch.updateMany.mockResolvedValueOnce({ count: 0 });
    const { updateFinanceImportInterpretationV1 } = await import("./finance-import-interpretation");
    await expect(updateFinanceImportInterpretationV1({
      workspaceId: "workspace-1",
      batchId: "batch-1",
      expectedVersion: 3,
      interpretation: unresolved,
    })).rejects.toMatchObject({ status: 409, code: "FINANCE_IMPORT_INTERPRETATION_CONFLICT" });
  });
});
