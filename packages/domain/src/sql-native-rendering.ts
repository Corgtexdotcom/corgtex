import type { SqlNativeDefinition } from "./sql-ingestion-contract";

function nested(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (ArrayBuffer.isView(value)) return JSON.stringify({byteaBase64:
    Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")});
  if (typeof value === "bigint") return JSON.stringify({int8: value.toString()});
  if (Array.isArray(value)) return `[${value.map(nested).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${nested(item)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  return JSON.stringify(value) ?? "null";
}

/** Deterministic rendering of actual trusted native cells in sealed SELECT
 * order. It grants no receipt or access. Provider exact temporal text must be
 * captured by the driver; ISO fallback cannot restore already-lost precision. */
export function renderSqlNativeRow(row: Readonly<Record<string, unknown>>,
  columns: SqlNativeDefinition["columns"]): string {
  const cell = (value: unknown) => value instanceof Date ? value.toISOString()
    : ArrayBuffer.isView(value) ? `bytea(base64):${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")}`
      : value && typeof value === "object" ? nested(value) : String(value);
  return columns.map(column => `${column.name}: ${cell(row[column.name])}`).join("\n");
}
