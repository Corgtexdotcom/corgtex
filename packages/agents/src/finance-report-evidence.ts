export const FINANCE_REPORT_EVIDENCE_SOURCE_VERSION = 1 as const;
export type FinanceReportEvidenceCellType = "BOOLEAN" | "DATE" | "ERROR" | "FORMULA" | "NUMBER" | "TEXT";
type NonFormulaCellType = Exclude<FinanceReportEvidenceCellType, "FORMULA">;
type CellValues = { rawValue: string; displayValue?: string };
export type FinanceReportEvidenceCellFact =
  | (CellValues & { type: "FORMULA"; resultType: NonFormulaCellType })
  | (CellValues & { type: NonFormulaCellType; resultType?: never });
const CELL_TYPES = new Set<FinanceReportEvidenceCellType>(["BOOLEAN", "DATE", "ERROR", "FORMULA", "NUMBER", "TEXT"]);
const MAX_TEXT = 2_000_000;
export type FinanceReportEvidenceFormat = "PDF" | "CSV" | "XLSX";
export type FinanceReportEvidenceRole = "TEXT" | "AMOUNT" | "ISO_CODE";
type FinanceReportEvidencePdfSource = { kind: "PDF"; page: number; lineIndex: number; line: string; start: number; end: number; text: string };
type FinanceReportEvidenceCellSource = { kind: "CELL"; sheet: string; row: number; column: number; evidence: string } &
  ({ start?: never; end?: never; text?: never } | { start: number; end: number; text: string });
type FinanceReportEvidenceWholeCellSource = FinanceReportEvidenceCellSource & { start?: never; end?: never; text?: never };
export type FinanceReportEvidenceSource = FinanceReportEvidencePdfSource | FinanceReportEvidenceCellSource;
export type FinanceReportEvidenceClaim = { id: string; role: "AMOUNT"; source: FinanceReportEvidencePdfSource | FinanceReportEvidenceWholeCellSource }
  | { id: string; role: Exclude<FinanceReportEvidenceRole, "AMOUNT">; source: FinanceReportEvidenceSource };
export type FinanceReportEvidenceBlockerCode = "INVALID_INPUT" | "LIMIT_EXCEEDED"
  | "MALFORMED_EVIDENCE" | "SOURCE_NOT_FOUND" | "DUPLICATE_CLAIM"
  | "OVERLAPPING_SOURCE" | "UNSAFE_CELL";
type FinanceReportEvidenceSourceFactBase = { kind: "SOURCE"; claimId: string; role: FinanceReportEvidenceRole; sourceKey: string; selectedText: string };
export type FinanceReportEvidenceSourceFact = (FinanceReportEvidenceSourceFactBase & { source: FinanceReportEvidencePdfSource; cell?: never })
  | (FinanceReportEvidenceSourceFactBase & { source: FinanceReportEvidenceCellSource; cell: FinanceReportEvidenceCellFact });
type FinanceReportEvidenceBlockerFact = { kind: "BLOCKER"; code: FinanceReportEvidenceBlockerCode; claimId?: string };
export type FinanceReportEvidenceSourceResultV1 = { version: typeof FINANCE_REPORT_EVIDENCE_SOURCE_VERSION; kind: "SUCCESS"; facts: FinanceReportEvidenceSourceFact[] }
  | { version: typeof FINANCE_REPORT_EVIDENCE_SOURCE_VERSION; kind: "BLOCKER"; facts: [FinanceReportEvidenceBlockerFact] };
type Cell = { value: string; displayValue?: string } & (
  | { type: "FORMULA"; resultType: NonFormulaCellType }
  | { type: NonFormulaCellType; resultType?: never });
type Index = { pages: Map<number, string[]>; cells: Map<string, Cell> };
type Bound = { fact: FinanceReportEvidenceSourceFact; coordinateKey: string;
  start: number; end: number; wholeAmount: boolean; evidence: string };
class EvidenceError extends Error { constructor(public readonly code: FinanceReportEvidenceBlockerCode, public readonly claimId?: string) { super(code); } }
function fail(code: FinanceReportEvidenceBlockerCode, claimId?: string): never { throw new EvidenceError(code, claimId); }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function exactKeys(value: Record<string, unknown>, allowed: string[], required = allowed, code: FinanceReportEvidenceBlockerCode = "MALFORMED_EVIDENCE") {
  if (!required.every((key) => key in value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}
function integer(value: unknown, min: number, max: number,
  code: FinanceReportEvidenceBlockerCode = "MALFORMED_EVIDENCE") {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(code);
  return value as number;
}
function string(value: unknown, max: number, allowEmpty = false,
  code: FinanceReportEvidenceBlockerCode = "MALFORMED_EVIDENCE", budget?: { total: number }) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) fail(code);
  if (budget && (budget.total += value.length) > MAX_TEXT * 2) fail(code);
  return value;
}
function sheetName(value: unknown, code: FinanceReportEvidenceBlockerCode = "MALFORMED_EVIDENCE", budget?: { total: number }) { const result = string(value, MAX_TEXT, true, code, budget); if (!result) fail(code); return result; }
const cellKey = (sheet: string, row: number, column: number) => JSON.stringify(["CELL", sheet, row, column]);
function validScalar(type: NonFormulaCellType, value: string) { return type === "NUMBER"
  ? Number.isFinite(Number(value)) && String(Number(value)) === value
    : type === "BOOLEAN" ? value === "true" || value === "false"
      : type === "DATE" ? Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
        : type !== "ERROR" || /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|WTF\?)$/.test(value); }
function buildIndex(format: FinanceReportEvidenceFormat, jsonl: string): Index {
  if (!jsonl) fail("INVALID_INPUT");
  if (jsonl.length > MAX_TEXT) fail("LIMIT_EXCEEDED");
  const records = jsonl.split("\n");
  if (records.length > 250_100) fail("LIMIT_EXCEEDED");
  const index: Index = { pages: new Map(), cells: new Map() };
  const sheets = new Map<string, { rows: number; columns: number; observedRows: number; observedColumns: number }>();
  let totalRows = 0, previousRow = 0, previousColumn = 0;
  let activeSheet: string | undefined;
  for (const line of records) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail("MALFORMED_EVIDENCE"); }
    if (!isRecord(value)) fail("MALFORMED_EVIDENCE");
    if (format === "PDF") {
      exactKeys(value, ["page", "text"]);
      const page = integer(value.page, 1, 250);
      const text = string(value.text, MAX_TEXT, true);
      if (page !== index.pages.size + 1) fail("MALFORMED_EVIDENCE");
      const pageLines = text.split("\n"); index.pages.set(page, pageLines);
      continue;
    }
    if (!("row" in value)) {
      exactKeys(value, ["sheet", "rowCount", "columnCount"]);
      const sheet = sheetName(value.sheet);
      const rows = integer(value.rowCount, 0, 20_000);
      const columns = integer(value.columnCount, 0, format === "XLSX" ? 4_294_967_295 : 250_000);
      totalRows += rows;
      if (sheets.has(sheet) || (format === "CSV" && (sheet !== "CSV" || sheets.size > 0 || rows * columns > 250_000))) fail("MALFORMED_EVIDENCE");
      if (sheets.size >= 100 || totalRows > 20_000) fail("LIMIT_EXCEEDED");
      sheets.set(sheet, { rows, columns, observedRows: 0, observedColumns: 0 });
      activeSheet = sheet; previousRow = previousColumn = 0;
      continue;
    }
    exactKeys(value, ["sheet", "row", "column", "type", "value", "displayValue", "formula", "resultType"],
      ["sheet", "row", "column", "type", "value"]);
    const sheet = sheetName(value.sheet);
    const bounds = sheets.get(sheet);
    const row = integer(value.row, 1, 20_000);
    const column = integer(value.column, 1, format === "XLSX" ? 4_294_967_295 : 250_000);
    const rawType = string(value.type, 20);
    const type = rawType as FinanceReportEvidenceCellType;
    const cellValue = string(value.value, MAX_TEXT, true);
    if (!bounds || row > bounds.rows || column > bounds.columns || !CELL_TYPES.has(type)) fail("MALFORMED_EVIDENCE");
    if (sheet !== activeSheet || row < previousRow || (row === previousRow && column <= previousColumn)) fail("MALFORMED_EVIDENCE");
    previousRow = row; previousColumn = column;
    bounds.observedRows = Math.max(bounds.observedRows, row);
    bounds.observedColumns = Math.max(bounds.observedColumns, column);
    const formula = value.formula; const resultType = value.resultType;
    if (type === "FORMULA" ? !(typeof formula === "string" && formula.length > 0 && !/\[[^\]]+\][^!]*!/.test(formula)
      && typeof resultType === "string" && CELL_TYPES.has(resultType as FinanceReportEvidenceCellType)
      && resultType !== "FORMULA")
      : formula !== undefined || resultType !== undefined) fail("MALFORMED_EVIDENCE");
    if (!validScalar(type === "FORMULA" ? resultType as NonFormulaCellType : type, cellValue)) fail("MALFORMED_EVIDENCE");
    if (format === "CSV" && (type !== "TEXT" || value.displayValue !== undefined || !cellValue || cellValue.includes("\0"))) fail("MALFORMED_EVIDENCE");
    const displayValue = value.displayValue === undefined ? undefined
      : string(value.displayValue, MAX_TEXT, true);
    if (displayValue === cellValue || ((type === "BOOLEAN" || (type === "FORMULA" && resultType === "BOOLEAN")) ? displayValue !== (cellValue === "true" ? "TRUE" : "FALSE") : displayValue !== undefined && (type === "ERROR" || type === "TEXT" || (type === "FORMULA" && (resultType === "ERROR" || resultType === "TEXT"))))) fail("MALFORMED_EVIDENCE");
    const key = cellKey(sheet, row, column); if (index.cells.has(key)) fail("MALFORMED_EVIDENCE");
    if (index.cells.size >= 250_000) fail("LIMIT_EXCEEDED");
    index.cells.set(key, type === "FORMULA"
      ? { type, resultType: resultType as NonFormulaCellType, value: cellValue, displayValue }
      : { type: type as NonFormulaCellType, value: cellValue, displayValue });
  }
  if (format === "XLSX" && [...sheets.values()].some((sheet) => sheet.rows !== sheet.observedRows
    || sheet.columns !== sheet.observedColumns)) fail("MALFORMED_EVIDENCE");
  if (format === "PDF" ? ![...index.pages.values()].some((lines) => lines.some((line) => line.trim()))
    : index.cells.size === 0) fail("MALFORMED_EVIDENCE");
  return index;
}
function splitsSurrogate(value: string, offset: number) {
  if (offset <= 0 || offset >= value.length) return false;
  const before = value.charCodeAt(offset - 1); const after = value.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
function span(value: string, start: unknown, end: unknown, selected: unknown, claimId: string) {
  const from = integer(start, 0, value.length, "INVALID_INPUT"); const to = integer(end, 1, value.length, "INVALID_INPUT");
  const text = string(selected, MAX_TEXT, false, "INVALID_INPUT");
  if (from >= to || splitsSurrogate(value, from) || splitsSurrogate(value, to)
    || value.slice(from, to) !== text) fail("SOURCE_NOT_FOUND", claimId);
  return { start: from, end: to, text };
}
function parseClaim(value: unknown, budget: { total: number }): FinanceReportEvidenceClaim {
  if (!isRecord(value)) fail("INVALID_INPUT");
  exactKeys(value, ["id", "role", "source"], undefined, "INVALID_INPUT");
  const id = string(value.id, 100, false, "INVALID_INPUT", budget);
  if (!new Set(["TEXT", "AMOUNT", "ISO_CODE"]).has(value.role as string) || !isRecord(value.source)) fail("INVALID_INPUT");
  const source = value.source;
  if (source.kind === "PDF") {
    exactKeys(source, ["kind", "page", "lineIndex", "line", "start", "end", "text"], undefined, "INVALID_INPUT");
    return { id, role: value.role as FinanceReportEvidenceRole, source: { kind: "PDF",
      page: integer(source.page, 1, 250, "INVALID_INPUT"),
      lineIndex: integer(source.lineIndex, 0, MAX_TEXT, "INVALID_INPUT"),
      line: string(source.line, MAX_TEXT, true, "INVALID_INPUT", budget),
      start: integer(source.start, 0, MAX_TEXT, "INVALID_INPUT"),
      end: integer(source.end, 1, MAX_TEXT, "INVALID_INPUT"),
      text: string(source.text, MAX_TEXT, false, "INVALID_INPUT", budget) } } as FinanceReportEvidenceClaim;
  }
  if (source.kind !== "CELL") fail("INVALID_INPUT");
  exactKeys(source, ["kind", "sheet", "row", "column", "evidence", "start", "end", "text"],
    ["kind", "sheet", "row", "column", "evidence"], "INVALID_INPUT");
  const optional = [source.start, source.end, source.text];
  if ((optional.some((item) => item !== undefined) && optional.some((item) => item === undefined)) || (value.role === "AMOUNT" && source.start !== undefined)) fail("INVALID_INPUT", id);
  return { id, role: value.role as FinanceReportEvidenceRole, source: { kind: "CELL",
    sheet: sheetName(source.sheet, "INVALID_INPUT", budget),
    row: integer(source.row, 1, 20_000, "INVALID_INPUT"),
    column: integer(source.column, 1, 4_294_967_295, "INVALID_INPUT"),
    evidence: string(source.evidence, MAX_TEXT, true, "INVALID_INPUT", budget),
    ...(source.start === undefined ? {} : { start: integer(source.start, 0, MAX_TEXT, "INVALID_INPUT"),
      end: integer(source.end, 1, MAX_TEXT, "INVALID_INPUT"),
      text: string(source.text, MAX_TEXT, false, "INVALID_INPUT", budget) }) } as FinanceReportEvidenceCellSource } as FinanceReportEvidenceClaim;
}
function bind(index: Index, format: FinanceReportEvidenceFormat, claim: FinanceReportEvidenceClaim): Bound {
  const source = claim.source;
  if (source.kind === "PDF") {
    if (format !== "PDF") fail("SOURCE_NOT_FOUND", claim.id);
    const line = index.pages.get(source.page)?.[source.lineIndex];
    if (line === undefined || line !== source.line) fail("SOURCE_NOT_FOUND", claim.id);
    const selected = span(line, source.start, source.end, source.text, claim.id);
    return { fact: { kind: "SOURCE", claimId: claim.id, role: claim.role,
      sourceKey: JSON.stringify(["PDF", source.page, source.lineIndex, selected.start, selected.end]),
      source, selectedText: selected.text }, coordinateKey: JSON.stringify(["PDF", source.page, source.lineIndex]),
      start: selected.start, end: selected.end, wholeAmount: false, evidence: line };
  }
  if (format === "PDF") fail("SOURCE_NOT_FOUND", claim.id);
  const coordinateKey = cellKey(source.sheet, source.row, source.column);
  const cell = index.cells.get(coordinateKey);
  if (!cell) fail("SOURCE_NOT_FOUND", claim.id);
  const wholeAmount = claim.role === "AMOUNT";
  if (wholeAmount && !cell.value.trim()) fail("UNSAFE_CELL", claim.id);
  if (wholeAmount && (source.start !== undefined || source.evidence !== cell.value)) fail("SOURCE_NOT_FOUND", claim.id);
  if (wholeAmount && format === "XLSX"
    && !((cell.type === "NUMBER") || (cell.type === "FORMULA" && cell.resultType === "NUMBER"))) fail("UNSAFE_CELL", claim.id);
  if (wholeAmount && format === "CSV" && cell.type !== "TEXT") fail("UNSAFE_CELL", claim.id);
  if (!wholeAmount && source.evidence !== cell.value && source.evidence !== cell.displayValue) fail("SOURCE_NOT_FOUND", claim.id);
  const selected = wholeAmount ? { start: 0, end: cell.value.length, text: cell.value }
    : source.start === undefined
      ? span(source.evidence, 0, source.evidence.length, source.evidence, claim.id)
      : span(source.evidence, source.start, source.end, source.text, claim.id);
  const sourceKey = wholeAmount ? coordinateKey
    : JSON.stringify(["CELL", source.sheet, source.row, source.column,
      source.evidence === cell.value ? "RAW" : "DISPLAY", selected.start, selected.end]);
  const cellFact: FinanceReportEvidenceCellFact = cell.type === "FORMULA"
    ? { type: cell.type, resultType: cell.resultType, rawValue: cell.value,
      ...(cell.displayValue === undefined ? {} : { displayValue: cell.displayValue }) }
    : { type: cell.type, rawValue: cell.value,
      ...(cell.displayValue === undefined ? {} : { displayValue: cell.displayValue }) };
  return { fact: { kind: "SOURCE", claimId: claim.id, role: claim.role, sourceKey,
    source, selectedText: selected.text, cell: cellFact },
    coordinateKey, start: selected.start, end: selected.end, wholeAmount,
    evidence: wholeAmount ? cell.value : source.evidence };
}
export function validateFinanceReportEvidenceSourcesV1(input: unknown): FinanceReportEvidenceSourceResultV1 {
  try {
    if (!isRecord(input)) fail("INVALID_INPUT");
    exactKeys(input, ["format", "extractedEvidence", "claims"], undefined, "INVALID_INPUT");
    if (!new Set(["PDF", "CSV", "XLSX"]).has(input.format as string)
      || typeof input.extractedEvidence !== "string" || !Array.isArray(input.claims)
      || input.claims.length === 0 || input.claims.length > 1_000 || Object.keys(input.claims).length !== input.claims.length || Object.keys(input.claims).some((key, index) => key !== String(index))) fail("INVALID_INPUT");
    const format = input.format as FinanceReportEvidenceFormat;
    const index = buildIndex(format, input.extractedEvidence);
    const budget = { total: 0 }, claims = input.claims.map((rawClaim) => parseClaim(rawClaim, budget));
    const ids = new Set<string>();
    const groups = new Map<string, Bound[]>();
    const bound = claims.map((claim) => {
      if (ids.has(claim.id)) fail("DUPLICATE_CLAIM", claim.id);
      ids.add(claim.id);
      const item = bind(index, format, claim);
      const group = groups.get(item.coordinateKey);
      if (group) group.push(item); else groups.set(item.coordinateKey, [item]);
      return item;
    });
    for (const items of groups.values()) {
      const wholeIndex = items.findIndex((item) => item.wholeAmount);
      if (wholeIndex >= 0 && items.length > 1) fail("OVERLAPPING_SOURCE",
        items[wholeIndex === 0 ? 1 : wholeIndex]?.fact.claimId);
      const different = items.find((item) => item.evidence !== items[0]?.evidence);
      if (different) fail("OVERLAPPING_SOURCE", different.fact.claimId);
      const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end
        || a.fact.claimId.localeCompare(b.fact.claimId));
      const conflict = sorted.some((item, index) => index > 0 && item.start < sorted[index - 1]!.end) ? items.find((item, index) => items.some((previous, previousIndex) => previousIndex < index
        && previous.start < item.end && item.start < previous.end)) : undefined;
      if (conflict) fail("OVERLAPPING_SOURCE", conflict.fact.claimId);
    }
    return { version: FINANCE_REPORT_EVIDENCE_SOURCE_VERSION, kind: "SUCCESS", facts: bound.map((item) => item.fact) };
  } catch (error) {
    const blocker = error instanceof EvidenceError ? error : new EvidenceError("INVALID_INPUT");
    return { version: FINANCE_REPORT_EVIDENCE_SOURCE_VERSION, kind: "BLOCKER",
      facts: [{ kind: "BLOCKER", code: blocker.code, ...(blocker.claimId ? { claimId: blocker.claimId } : {}) }] };
  }
}
