import { describe, expect, it } from "vitest";
import {
  assertBookmarkDefinition,
  CursorError,
  orderColumns,
  parseCursor,
  serializeCursor,
  SQL_CURSOR_TYPE_OIDS,
  type CursorColumn,
  type CursorState,
  type SqlCursorType,
  type TableBookmark,
  type TableDefinition,
} from "./cursor";

function column(name: string, type: SqlCursorType): CursorColumn {
  return { name, type, typeOid: SQL_CURSOR_TYPE_OIDS[type], typeModifier: -1, collationOid: 0 };
}

function definition(): TableDefinition {
  return {
    schema: "public",
    name: "events",
    relationOid: 12500,
    cursor: column("updated_at", "timestamptz"),
    key: [column("id", "int8")],
  };
}

function bookmark(): TableBookmark {
  return { definition: definition(), values: ["2026-10-13 10:20:30.123456+00", "9007199254740993"] };
}

function state(): CursorState {
  return {
    version: 1,
    scanFingerprint: "a".repeat(64),
    nextTable: "public.events",
    tables: { "public.events": bookmark() },
  };
}

function withBookmark(value: unknown): unknown {
  return { ...state(), tables: { "public.events": value } };
}

function withDefinition(value: unknown): unknown {
  return withBookmark({ ...bookmark(), definition: value });
}

describe("SQL cursor codec", () => {
  it.each([null, "{}", " { } "])("accepts only explicitly empty initial state: %s", (stored) => {
    expect(parseCursor(stored)).toEqual({ version: 1, scanFingerprint: null, nextTable: null, tables: {} });
  });

  it("requires the caller to bind the initial scan before persisting it", () => {
    const fresh = parseCursor(null);
    expect(() => serializeCursor(fresh)).toThrow(/CURSOR_INVALID/);
    fresh.scanFingerprint = "1".repeat(64);
    expect(parseCursor(serializeCursor(fresh))).toEqual(fresh);
  });

  it("round-trips microseconds and bigint values without JavaScript conversion", () => {
    const saved = state();
    const stored = serializeCursor(saved);
    expect(parseCursor(stored)).toEqual(saved);
    expect(serializeCursor(parseCursor(stored))).toBe(stored);
    expect(parseCursor(stored).tables["public.events"].values).toEqual([
      "2026-10-13 10:20:30.123456+00",
      "9007199254740993",
    ]);
  });

  it.each([
    ["int2", "-32768"],
    ["int4", "999"],
    ["int4", "1000"],
    ["int8", "9223372036854775807"],
    ["numeric", "-9999999999999999999999999999.123456789"],
    ["numeric", "999"],
    ["date", "2026-10-13"],
    ["timestamp", "2026-10-13 10:20:30.123457"],
    ["timestamptz", "2026-10-13 10:20:30.123456+00"],
    ["uuid", "00000000-0000-0000-0000-000000000000"],
    ["text", ""],
    ["varchar", "0"],
    ["bpchar", "a "],
  ] as const)("preserves exact %s values", (type, value) => {
    const saved = state();
    saved.tables["public.events"] = {
      definition: { ...definition(), cursor: column("cursor", type) },
      values: [value, "9007199254740993"],
    };
    const stored = serializeCursor(saved);
    expect(parseCursor(stored).tables["public.events"].values[0]).toBe(value);
    expect(serializeCursor(parseCursor(stored))).toBe(stored);
  });

  it.each(["null", "undefined", "__proto__"])("retains the valid text value %s", (value) => {
    const saved = state();
    saved.tables["public.events"].definition.cursor = column("text_cursor", "text");
    saved.tables["public.events"].values[0] = value;
    expect(parseCursor(serializeCursor(saved)).tables["public.events"].values[0]).toBe(value);
  });

  it("retains unselected bookmarks and safely handles prototype-like table tokens", () => {
    const saved = state();
    saved.tables = Object.fromEntries([
      ["__proto__", bookmark()],
      ["constructor", { ...bookmark(), values: ["2026-10-13 00:00:00.000001+00", "0"] }],
      ["toString", bookmark()],
      ["other.unselected", bookmark()],
    ]);
    const parsed = parseCursor(serializeCursor(saved));
    expect(Object.keys(parsed.tables)).toEqual(["__proto__", "constructor", "other.unselected", "toString"]);
    expect(Object.hasOwn(parsed.tables, "__proto__")).toBe(true);
    expect(parsed.tables.constructor).toEqual(saved.tables.constructor);
    expect(Object.getPrototypeOf(parsed.tables)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).values).toBeUndefined();
  });

  it("serializes field and table order deterministically for checkpoint comparisons", () => {
    const expected = serializeCursor(state());
    const table = definition();
    const reordered = {
      tables: {
        "public.events": {
          values: bookmark().values,
          definition: {
            key: table.key,
            cursor: table.cursor,
            relationOid: table.relationOid,
            name: table.name,
            schema: table.schema,
          },
        },
      },
      nextTable: "public.events",
      scanFingerprint: "a".repeat(64),
      version: 1 as const,
    };
    expect(serializeCursor(reordered)).toBe(expected);
  });

  it("allows a fairness pointer to a table with no checkpointed rows yet", () => {
    const saved = state();
    saved.nextTable = "public.empty";
    expect(parseCursor(serializeCursor(saved)).nextTable).toBe("public.empty");
  });

  it.each([
    { "public.events": "999" },
    { "public.events": "Tue Oct 13 2026 10:20:30 GMT+0000 (Coordinated Universal Time)" },
    { "public.events": null },
    { "public.events": "" },
    { "public.events": "null" },
    { "public.events": "undefined" },
    { "public.events": { tuple: ["1000"] } },
  ])("requires historical compatibility review for legacy state without resetting it: %j", (legacy) => {
    expect(() => parseCursor(JSON.stringify(legacy))).toThrow(/CURSOR_LEGACY_REPLAY_REQUIRED/);
    expect(() => parseCursor(JSON.stringify(legacy))).toThrow(/historical connection, table\/cursor ordering, or row-identity metadata/);
    expect(() => parseCursor(JSON.stringify(legacy))).toThrow(/establish a compatible continuation or explicitly authorize recovery/);
    expect(() => parseCursor(JSON.stringify(legacy))).toThrow(/No reset or replay was performed/);
  });

  it.each(["", "{bad", "null", "[]", '"cursor"', "0", "true"])("rejects malformed or nonobject stored JSON: %s", (stored) => {
    expect(() => parseCursor(stored)).toThrow(/CURSOR_INVALID/);
  });

  const invalidStates: Array<[string, unknown]> = [
    ["extra root field", { ...state(), replay: true }],
    ["missing tables", { version: 1, scanFingerprint: "a".repeat(64), nextTable: null }],
    ["missing fingerprint", { version: 1, nextTable: null, tables: {} }],
    ["null fingerprint", { ...state(), scanFingerprint: null }],
    ["short fingerprint", { ...state(), scanFingerprint: "a".repeat(63) }],
    ["nonhex fingerprint", { ...state(), scanFingerprint: "g".repeat(64) }],
    ["null tables", { ...state(), tables: null }],
    ["array tables", { ...state(), tables: [] }],
    ["invalid next table", { ...state(), nextTable: 0 }],
    ["empty next table", { ...state(), nextTable: "" }],
    ["null bookmark", withBookmark(null)],
    ["unknown bookmark field", withBookmark({ ...bookmark(), unsafe: true })],
    ["null tuple", withBookmark({ ...bookmark(), values: null })],
    ["object tuple", withBookmark({ ...bookmark(), values: { 0: "1000", 1: "1" } })],
    ["short tuple", withBookmark({ ...bookmark(), values: ["1000"] })],
    ["long tuple", withBookmark({ ...bookmark(), values: ["1000", "1", "2"] })],
    ["null tuple value", withBookmark({ ...bookmark(), values: [null, "1"] })],
    ["numeric tuple value", withBookmark({ ...bookmark(), values: [1000, "1"] })],
    ["null definition", withDefinition(null)],
    ["unknown definition field", withDefinition({ ...definition(), indexOid: 123 })],
    ["empty schema", withDefinition({ ...definition(), schema: "" })],
    ["NUL name", withDefinition({ ...definition(), name: "events\0" })],
    ["zero relation OID", withDefinition({ ...definition(), relationOid: 0 })],
    ["fractional relation OID", withDefinition({ ...definition(), relationOid: 1.5 })],
    ["overflow relation OID", withDefinition({ ...definition(), relationOid: 4_294_967_296 })],
    ["empty key", withDefinition({ ...definition(), key: [] })],
    ["null key", withDefinition({ ...definition(), key: null })],
    ["duplicate key names", withDefinition({ ...definition(), key: [column("id", "int8"), column("id", "int8")] })],
    ["unsupported SQL type", withDefinition({ ...definition(), cursor: { ...column("cursor", "text"), type: "jsonb", typeOid: 3802 } })],
    ["prototype SQL type", withDefinition({ ...definition(), cursor: { ...column("cursor", "text"), type: "constructor" } })],
    ["type/OID mismatch", withDefinition({ ...definition(), cursor: { ...column("cursor", "int8"), typeOid: 23 } })],
    ["invalid type modifier", withDefinition({ ...definition(), cursor: { ...column("cursor", "int8"), typeModifier: -2 } })],
    ["invalid collation OID", withDefinition({ ...definition(), cursor: { ...column("cursor", "text"), collationOid: -1 } })],
    ["unknown column field", withDefinition({ ...definition(), cursor: { ...column("cursor", "text"), nullable: false } })],
    ["inconsistent overlapping cursor key", withDefinition({ ...definition(), key: [column("updated_at", "timestamp")] })],
  ];

  it.each(invalidStates)("rejects invalid typed state: %s", (_label, invalid) => {
    expect(() => parseCursor(JSON.stringify(invalid))).toThrow(/CURSOR_INVALID/);
  });

  it.each([0, 2, "1", null])("rejects unsupported version %s", (version) => {
    expect(() => parseCursor(JSON.stringify({ ...state(), version }))).toThrow(/CURSOR_VERSION_UNSUPPORTED/);
  });

  it("does not accept inherited required fields or invoke accessors while serializing", () => {
    const inherited = Object.create(state()) as CursorState;
    expect(() => serializeCursor(inherited)).toThrow(/CURSOR_INVALID/);
    const saved = state();
    Object.defineProperty(saved, "tables", { enumerable: true, get: () => { throw new Error("Accessor invoked"); } });
    expect(() => serializeCursor(saved)).toThrow(/CURSOR_INVALID/);
  });

  it("rejects sparse or embellished arrays during serialization with a controlled error", () => {
    const sparse = state();
    sparse.tables["public.events"].values = new Array<string>(2);
    expect(() => serializeCursor(sparse)).toThrow(/CURSOR_INVALID/);
    const embellished = state();
    Object.defineProperty(embellished.tables["public.events"].definition.key, "unsafe", { value: () => {} });
    expect(() => serializeCursor(embellished)).toThrow(/CURSOR_INVALID/);
    const custom = state();
    Object.setPrototypeOf(custom.tables["public.events"].values, { map: () => { throw new Error("Custom map invoked"); } });
    expect(() => serializeCursor(custom)).toThrow(/CURSOR_INVALID/);
  });

  it("rejects a native Date before serialization can turn it into millisecond text", () => {
    const saved = { ...state(), tables: { "public.events": { ...bookmark(), values: [new Date(0), "1"] } } };
    expect(() => serializeCursor(saved as unknown as CursorState)).toThrow(/CURSOR_INVALID/);
  });

  it("exposes an actionable code on controlled errors", () => {
    const error = new CursorError("CURSOR_INVALID", "The stored state is invalid.");
    expect(error.name).toBe("SqlCursorError");
    expect(error.code).toBe("CURSOR_INVALID");
    expect(error.message).toBe("CURSOR_INVALID: The stored state is invalid.");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("SQL ordering definition", () => {
  it("uses the cursor followed by all nonrepeated primary key columns in index order", () => {
    const table = definition();
    table.key = [column("tenant_id", "int4"), table.cursor, column("id", "int8")];
    expect(orderColumns(table).map((component) => component.name)).toEqual(["updated_at", "tenant_id", "id"]);
    expect(table.key.map((component) => component.name)).toEqual(["tenant_id", "updated_at", "id"]);
    const saved = { definition: table, values: ["2026-10-13 10:20:30.123456+00", "0", "9007199254740993"] };
    const encoded = serializeCursor({ ...state(), tables: { "public.events": saved } });
    expect(parseCursor(encoded).tables["public.events"]).toEqual(saved);
  });

  it("accepts the same database fingerprint despite object-property insertion order", () => {
    const table = definition();
    const reordered = {
      key: table.key.map((component) => ({
        collationOid: component.collationOid,
        typeModifier: component.typeModifier,
        typeOid: component.typeOid,
        type: component.type,
        name: component.name,
      })),
      cursor: table.cursor,
      relationOid: table.relationOid,
      name: table.name,
      schema: table.schema,
    };
    expect(() => assertBookmarkDefinition(bookmark(), reordered, "public.events")).not.toThrow();
  });

  it.each([
    ["relation replacement", (table: TableDefinition) => { table.relationOid++; }],
    ["schema", (table: TableDefinition) => { table.schema = "other"; }],
    ["table", (table: TableDefinition) => { table.name = "other"; }],
    ["cursor name", (table: TableDefinition) => { table.cursor.name = "created_at"; }],
    ["cursor type", (table: TableDefinition) => { table.cursor = column("updated_at", "timestamp"); }],
    ["cursor type modifier", (table: TableDefinition) => { table.cursor.typeModifier = 6; }],
    ["cursor collation", (table: TableDefinition) => { table.cursor.collationOid = 100; }],
    ["key name", (table: TableDefinition) => { table.key[0].name = "uuid"; }],
    ["key type", (table: TableDefinition) => { table.key[0] = column("id", "numeric"); }],
    ["key type modifier", (table: TableDefinition) => { table.key[0].typeModifier = 12; }],
    ["key collation", (table: TableDefinition) => { table.key[0].collationOid = 100; }],
    ["key components", (table: TableDefinition) => { table.key.push(column("tenant_id", "int4")); }],
  ] as const)("rejects changed database metadata: %s", (_label, change) => {
    const changed = definition();
    change(changed);
    expect(() => assertBookmarkDefinition(bookmark(), changed, "public.events")).toThrow(/CURSOR_DEFINITION_CHANGED/);
  });

  it("detects a reordered composite key even when its component set stays the same", () => {
    const saved = bookmark();
    saved.definition.key = [column("tenant_id", "int4"), column("id", "int8")];
    saved.values = [saved.values[0], "0", saved.values[1]];
    const changed = { ...saved.definition, key: [...saved.definition.key].reverse() };
    expect(() => assertBookmarkDefinition(saved, changed, "public.events")).toThrow(/CURSOR_DEFINITION_CHANGED/);
  });
});
