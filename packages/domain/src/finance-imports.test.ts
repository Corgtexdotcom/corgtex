import { describe, expect, it } from "vitest";
import {
  buildFinanceImportApplicationIdempotencyKey,
  normalizeFinanceImportAmountCents,
  normalizeFinanceImportCurrency,
  normalizeFinanceImportIsoCurrency,
  resolveFinanceImportCurrency,
  validateFinanceImportReportingWindow,
} from "./finance-imports";

const PROPOSAL_HASH = "a".repeat(64);

describe("Finance import safety primitives", () => {
  it("normalizes explicit currencies without supplying a fallback", () => {
    expect(normalizeFinanceImportCurrency(" eur ")).toBe("EUR");
    expect(() => normalizeFinanceImportCurrency("")).toThrow("three-letter code");
    expect(() => normalizeFinanceImportCurrency("US$")).toThrow("three-letter code");
    expect(() => normalizeFinanceImportCurrency("ßd")).toThrow("three-letter code");
    expect(() => normalizeFinanceImportCurrency("uſd")).toThrow("three-letter code");
    expect(normalizeFinanceImportIsoCurrency(" eur ")).toBe("EUR");
    expect(() => normalizeFinanceImportIsoCurrency("ZZZ")).toThrow("ISO 4217");
  });

  it("prioritizes human confirmation, report evidence, then one workspace currency", () => {
    expect(resolveFinanceImportCurrency({
      userConfirmedCurrency: "gbp",
      reportCurrency: "EUR",
      workspaceCurrencies: ["USD"],
    })).toEqual({
      state: "RESOLVED",
      currency: "GBP",
      source: "USER_CONFIRMED",
      unresolvedReason: null,
    });
    expect(resolveFinanceImportCurrency({
      reportCurrency: "eur",
      workspaceCurrencies: ["USD"],
    })).toMatchObject({ currency: "EUR", source: "DOCUMENT" });
    expect(resolveFinanceImportCurrency({
      workspaceCurrencies: [" usd ", "USD", null],
    })).toMatchObject({ currency: "USD", source: "WORKSPACE_SINGLE_CURRENCY" });
  });

  it("keeps missing or multiple workspace currencies unresolved", () => {
    expect(resolveFinanceImportCurrency({ workspaceCurrencies: [] })).toEqual({
      state: "UNRESOLVED",
      currency: null,
      source: null,
      unresolvedReason: "NO_CURRENCY_EVIDENCE",
    });
    expect(resolveFinanceImportCurrency({
      workspaceCurrencies: ["USD", "EUR"],
    })).toMatchObject({
      state: "UNRESOLVED",
      currency: null,
      unresolvedReason: "MULTIPLE_WORKSPACE_CURRENCIES",
    });
  });

  it("rejects malformed non-empty workspace currencies", () => {
    expect(() => resolveFinanceImportCurrency({
      userConfirmedCurrency: "EUR",
      workspaceCurrencies: ["USD", "US"],
    })).toThrow("Workspace currency must be a three-letter code");
  });

  it("accepts signed PostgreSQL integer cents and rejects fractions or overflow", () => {
    expect(normalizeFinanceImportAmountCents(-2147483648)).toBe(-2147483648);
    expect(normalizeFinanceImportAmountCents(0)).toBe(0);
    expect(normalizeFinanceImportAmountCents(2147483647)).toBe(2147483647);
    expect(() => normalizeFinanceImportAmountCents(1.5)).toThrow("whole number of cents");
    expect(() => normalizeFinanceImportAmountCents(2147483648)).toThrow("supported integer-cent range");
    expect(() => normalizeFinanceImportAmountCents(-2147483649)).toThrow("supported integer-cent range");
  });

  it("parses real ISO reporting dates and keeps as-of dates within bounds", () => {
    const result = validateFinanceImportReportingWindow({
      periodStart: "2024-02-01",
      periodEnd: "2024-02-29",
      asOfDate: "2024-02-29",
    });
    expect(result).toEqual({
      periodStart: new Date("2024-02-01T00:00:00.000Z"),
      periodEnd: new Date("2024-02-29T00:00:00.000Z"),
      asOfDate: new Date("2024-02-29T00:00:00.000Z"),
    });
    expect(() => validateFinanceImportReportingWindow({
      periodStart: "2025-02-29",
      periodEnd: "2025-03-01",
    })).toThrow("not a real calendar date");
    expect(() => validateFinanceImportReportingWindow({
      periodStart: "02/01/2026",
      periodEnd: "2026-02-28",
    })).toThrow("must use YYYY-MM-DD");
  });

  it("rejects reversed periods and out-of-range as-of dates", () => {
    expect(() => validateFinanceImportReportingWindow({
      periodStart: "2026-02-01",
      periodEnd: "2026-01-31",
    })).toThrow("must not be after");
    expect(() => validateFinanceImportReportingWindow({
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      asOfDate: "2026-02-01",
    })).toThrow("inside the reporting period");
  });

  it("builds stable, distinct 64-character application keys", () => {
    const base = {
      workspaceId: "workspace-1",
      batchId: "batch-1",
      candidateId: "candidate-1",
      candidateVersion: 1,
      proposalHash: PROPOSAL_HASH,
    };
    const first = buildFinanceImportApplicationIdempotencyKey(base);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(buildFinanceImportApplicationIdempotencyKey(base)).toBe(first);
    expect(new Set([
      first,
      buildFinanceImportApplicationIdempotencyKey({ ...base, candidateId: "candidate-2" }),
      buildFinanceImportApplicationIdempotencyKey({ ...base, candidateVersion: 2 }),
      buildFinanceImportApplicationIdempotencyKey({ ...base, proposalHash: "b".repeat(64) }),
    ])).toHaveLength(4);
  });

  it("rejects incomplete or malformed idempotency inputs", () => {
    const base = {
      workspaceId: "workspace-1",
      batchId: "batch-1",
      candidateId: "candidate-1",
      candidateVersion: 1,
      proposalHash: PROPOSAL_HASH,
    };
    expect(() => buildFinanceImportApplicationIdempotencyKey({
      ...base,
      workspaceId: " ",
    })).toThrow("Workspace ID is required");
    expect(() => buildFinanceImportApplicationIdempotencyKey({
      ...base,
      candidateVersion: 0,
    })).toThrow("positive integer");
    expect(() => buildFinanceImportApplicationIdempotencyKey({
      ...base,
      proposalHash: "not-a-hash",
    })).toThrow("SHA-256");
  });
});
