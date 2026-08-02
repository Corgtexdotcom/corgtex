import { createHash } from "node:crypto";
import { invariant } from "./errors";

const POSTGRES_INT_MIN = -2147483648;
const POSTGRES_INT_MAX = 2147483647;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
export const FINANCE_REPORT_ISO_4217_VERSION = "2026-01-01" as const;
// SIX ISO 4217 Maintenance Agency, List One, published 2026-01-01.
export const FINANCE_REPORT_ISO_4217_CODES: readonly string[] = Object.freeze("AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG".split(" "));
const ISO_4217_CODES = new Set(FINANCE_REPORT_ISO_4217_CODES);

export type FinanceImportCurrencySource =
  | "DOCUMENT"
  | "WORKSPACE_SINGLE_CURRENCY"
  | "USER_CONFIRMED";

export type FinanceImportCurrencyResolution =
  | {
    state: "RESOLVED";
    currency: string;
    source: FinanceImportCurrencySource;
    unresolvedReason: null;
  }
  | {
    state: "UNRESOLVED";
    currency: null;
    source: null;
    unresolvedReason: "NO_CURRENCY_EVIDENCE" | "MULTIPLE_WORKSPACE_CURRENCIES";
  };

export function normalizeFinanceImportCurrency(value: string, label = "Currency") {
  const currency = value.trim();
  invariant(/^[A-Za-z]{3}$/.test(currency), 400, "INVALID_INPUT", `${label} must be a three-letter code.`);
  return currency.toUpperCase();
}

export function normalizeFinanceImportIsoCurrency(value: string, label = "Currency") {
  const currency = normalizeFinanceImportCurrency(value, label);
  invariant(ISO_4217_CODES.has(currency), 400, "INVALID_INPUT", `${label} must be an ISO 4217 code.`);
  return currency;
}

function optionalCurrency(value: string | null | undefined, label: string) {
  return value?.trim() ? normalizeFinanceImportIsoCurrency(value, label) : null;
}

export function resolveFinanceImportCurrency(params: {
  userConfirmedCurrency?: string | null;
  reportCurrency?: string | null;
  workspaceCurrencies?: readonly (string | null | undefined)[];
}): FinanceImportCurrencyResolution {
  const workspaceCurrencies = new Set(
    (params.workspaceCurrencies ?? [])
      .filter((currency): currency is string => Boolean(currency?.trim()))
      .map((currency) => normalizeFinanceImportIsoCurrency(currency, "Workspace currency")),
  );
  const userConfirmedCurrency = optionalCurrency(params.userConfirmedCurrency, "Confirmed currency");
  if (userConfirmedCurrency) {
    return {
      state: "RESOLVED",
      currency: userConfirmedCurrency,
      source: "USER_CONFIRMED",
      unresolvedReason: null,
    };
  }

  const reportCurrency = optionalCurrency(params.reportCurrency, "Report currency");
  if (reportCurrency) {
    return {
      state: "RESOLVED",
      currency: reportCurrency,
      source: "DOCUMENT",
      unresolvedReason: null,
    };
  }

  if (workspaceCurrencies.size === 1) {
    return {
      state: "RESOLVED",
      currency: [...workspaceCurrencies][0],
      source: "WORKSPACE_SINGLE_CURRENCY",
      unresolvedReason: null,
    };
  }
  return {
    state: "UNRESOLVED",
    currency: null,
    source: null,
    unresolvedReason: workspaceCurrencies.size === 0
      ? "NO_CURRENCY_EVIDENCE"
      : "MULTIPLE_WORKSPACE_CURRENCIES",
  };
}

export function normalizeFinanceImportAmountCents(value: number) {
  invariant(Number.isInteger(value), 400, "INVALID_INPUT", "Reported amount must be a whole number of cents.");
  invariant(
    value >= POSTGRES_INT_MIN && value <= POSTGRES_INT_MAX,
    400,
    "INVALID_INPUT",
    "Reported amount is outside the supported integer-cent range.",
  );
  return value;
}

export function parseFinanceImportDate(value: string, label: string) {
  const match = ISO_DATE_PATTERN.exec(value);
  invariant(match, 400, "INVALID_INPUT", `${label} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  invariant(year >= 1000, 400, "INVALID_INPUT", `${label} is not a supported calendar date.`);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  invariant(
    parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day,
    400,
    "INVALID_INPUT",
    `${label} is not a real calendar date.`,
  );
  return parsed;
}

export function validateFinanceImportReportingWindow(params: {
  periodStart: string;
  periodEnd: string;
  asOfDate?: string | null;
}) {
  const periodStart = parseFinanceImportDate(params.periodStart, "Period start");
  const periodEnd = parseFinanceImportDate(params.periodEnd, "Period end");
  invariant(periodStart <= periodEnd, 400, "INVALID_INPUT", "Period start must not be after period end.");
  const asOfDate = params.asOfDate == null
    ? null
    : parseFinanceImportDate(params.asOfDate, "As-of date");
  invariant(
    !asOfDate || (asOfDate >= periodStart && asOfDate <= periodEnd),
    400,
    "INVALID_INPUT",
    "As-of date must be inside the reporting period.",
  );
  return { periodStart, periodEnd, asOfDate };
}

function stableKeyPart(value: string, label: string) {
  const normalized = value.trim();
  invariant(normalized.length > 0, 400, "INVALID_INPUT", `${label} is required.`);
  return normalized;
}

export function buildFinanceImportApplicationIdempotencyKey(params: {
  workspaceId: string;
  batchId: string;
  candidateId: string;
  candidateVersion: number;
  proposalHash: string;
}) {
  invariant(
    Number.isInteger(params.candidateVersion) && params.candidateVersion > 0,
    400,
    "INVALID_INPUT",
    "Candidate version must be a positive integer.",
  );
  const proposalHash = params.proposalHash.trim().toLowerCase();
  invariant(SHA256_PATTERN.test(proposalHash), 400, "INVALID_INPUT", "Proposal hash must be a SHA-256 value.");
  const identity = [
    "finance-report-import/v1",
    stableKeyPart(params.workspaceId, "Workspace ID"),
    stableKeyPart(params.batchId, "Batch ID"),
    stableKeyPart(params.candidateId, "Candidate ID"),
    params.candidateVersion,
    proposalHash,
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
