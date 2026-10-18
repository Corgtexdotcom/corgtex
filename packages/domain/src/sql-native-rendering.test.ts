import { describe, expect, it } from "vitest";
import { serialize, deserialize } from "node:v8";
import { renderSqlNativeRow } from "./sql-native-rendering";
import type { SqlNativeDefinition } from "./sql-ingestion-contract";

const columns = (...names: string[]): SqlNativeDefinition["columns"] => names.map((name, index) => ({
  name, type: "text", typeOid: 25, typeModifier: -1, collationOid: 100,
  position: index + 1, isNullable: true, identity: "", generated: ""}));

describe("deterministic trusted SQL native rendering", () => {
  it("preserves sealed native order with integer-like JS property names", () => {
    expect(renderSqlNativeRow({"1": "first", "2": "second"}, columns("2", "1"))).toBe("2: second\n1: first");
  });
  it("retains exact temporal text and stable bytea/array/JSON/native Date rendering", () => {
    const row = {timestamp: "2026-10-14 23:59:59.123456", nativeDate: new Date("2026-10-14T00:00:00Z"),
      bytes: Buffer.from([0, 65, 255]), array: [Buffer.from("AB"), null, new Date("2026-10-14T00:00:00Z")],
      json: {z: "last", a: 9223372036854775807n}};
    const before = renderSqlNativeRow(row, columns(...Object.keys(row)));
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(renderSqlNativeRow(deserialize(serialize(row)), columns(...Object.keys(row)))).toBe(before);
    } finally {if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;}
    expect(before).toContain("timestamp: 2026-10-14 23:59:59.123456");
    expect(before).toContain("nativeDate: 2026-10-14T00:00:00.000Z");
    expect(before).toContain("bytes: bytea(base64):AEH/");
    expect(before).toContain('json: {"a":{"int8":"9223372036854775807"},"z":"last"}');
  });
});
