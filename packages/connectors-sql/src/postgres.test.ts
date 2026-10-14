import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { connectReadOnly, describeTable, listTables, pullPage, pullRows } from "./postgres";
import type { CursorColumn, TableDefinition } from "./cursor";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), setTypeParser: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Client: class {
      constructor(options: unknown) { mocks.construct(options); }
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
      setTypeParser = mocks.setTypeParser;
    },
  },
}));

const timestamp: CursorColumn = {
  name: "updated_at", type: "timestamptz", typeOid: 1184,
  typeModifier: -1, collationOid: 0,
};
const primaryKey: CursorColumn = {
  name: "id", type: "int8", typeOid: 20, typeModifier: -1, collationOid: 0,
};
const table: TableDefinition = {
  schema: "public", name: "events", relationOid: 1234, cursor: timestamp, key: [primaryKey],
};
const capturedColumns = [primaryKey, timestamp].map((column, index) => ({ ...column,
  position: index + 1, isNullable: false, identity: "", generated: "" }));
const client = { query: mocks.query } as unknown as pg.Client;

function metadata(overrides: Record<string, unknown> = {}) {
  const value = {
    relation_oid: "1234", schema_name: "public", table_name: "events",
    cursor_name: "updated_at", cursor_type: "timestamptz", cursor_type_oid: "1184",
    cursor_type_mod: -1, cursor_collation_oid: "0",
    key_columns: [{ column: "id", type: "int8", typeOid: "20", typeMod: -1, collationOid: "0" }],
    captured_columns: capturedColumns,
    ...overrides,
  };
  return { ...value, wire_columns: value.captured_columns.map((column) => ({
    position: column.position, typeOid: column.typeOid, typeModifier: column.typeModifier,
  })) };
}

function page(rows: unknown[][] = [], names = ["id", "updated_at", "updated_at", "id"]) {
  return { rows, fields: names.map((name) => ({ name })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue(page());
});

describe("read-only PostgreSQL connection", () => {
  it("sets safety guards and stable timestamp formatting on its own connection", async () => {
    const connected = await connectReadOnly("postgresql://localhost/synthetic");
    expect(mocks.construct).toHaveBeenCalledWith({ connectionString: "postgresql://localhost/synthetic" });
    expect(mocks.query.mock.calls.map(([query]) => query)).toEqual([
      "SET statement_timeout = 30000", "SET default_transaction_read_only = on",
      "SET TIME ZONE 'UTC'", "SET DateStyle = ISO",
    ]);
    expect(connected).toHaveProperty("end", mocks.end);
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("closes a connection when guard setup fails and preserves the original error", async () => {
    const failure = new Error("read-only setup failed");
    mocks.query.mockRejectedValueOnce(failure);
    mocks.end.mockRejectedValueOnce(new Error("end failed"));
    await expect(connectReadOnly("postgresql://localhost/synthetic")).rejects.toBe(failure);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("closes a client that fails to connect", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("connection failed"));
    await expect(connectReadOnly("postgresql://localhost/synthetic")).rejects.toThrow("connection failed");
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("lists canonical qualified names without losing quoted dots or case", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ full_name: '"Schema.With.Dot"."Quoted.Table"' }] });
    await expect(listTables(client)).resolves.toEqual(['"Schema.With.Dot"."Quoted.Table"']);
    expect(mocks.query.mock.calls[0][0]).toContain("pg_catalog.quote_ident(table_schema)");
    expect(mocks.query.mock.calls[0][0]).toContain("pg_catalog.quote_ident(table_name)");
  });
});

describe("table ordering discovery", () => {
  it("normalizes exact OID strings and keeps every composite key component in catalog order", async () => {
    const tenant = { name: "tenant_id", type: "int4", typeOid: 23, typeModifier: -1, collationOid: 0 };
    const columns = [...capturedColumns, { ...tenant, position: 3, isNullable: false, identity: "", generated: "" }];
    mocks.query.mockResolvedValueOnce({ rows: [metadata({ captured_columns: columns, key_columns: [
      { column: "tenant_id", type: "int4", typeOid: 23, typeMod: -1, collationOid: 0 },
      { column: "id", type: "int8", typeOid: "20", typeMod: -1, collationOid: "0" },
    ] })] });
    expect(await describeTable(client, "public.events", "updated_at")).toEqual({
      ...table,
      columns,
      key: [{ name: "tenant_id", type: "int4", typeOid: 23, typeModifier: -1, collationOid: 0 }, primaryKey],
    });
    expect(mocks.query.mock.calls[0][1]).toEqual(["public", "events", "updated_at"]);
    const query = mocks.query.mock.calls[0][0] as string;
    for (const guard of [
      "i.indisprimary", "i.indisunique", "i.indisvalid", "i.indisready", "i.indislive",
      "i.indimmediate", "i.indpred IS NULL", "i.indexprs IS NULL", "a.attnotnull",
      "am.amname = 'btree'", "k.position <= i.indnkeyatts", "oc.opcdefault",
      "k.collation_oid = a.attcollation", "pg_catalog.pg_inherits",
      "pg_catalog.jsonb_agg", "pg_catalog.jsonb_build_object", "pg_catalog.unnest",
      "pg_catalog.count(*)", "pg_catalog.bool_and",
    ]) expect(query).toContain(guard);
  });

  it.each([
    ["Events", "public", "Events"],
    ["Sales.Events", "Sales", "Events"],
    ['"Schema.With.Dot"."Event""Rows"', "Schema.With.Dot", 'Event"Rows'],
    ['"public" . "events"', "public", "events"],
    ['" public "." events "', " public ", " events "],
    ['"public"."events; SELECT 1"', "public", "events; SELECT 1"],
  ])("resolves complete qualified token %s without SQL case folding", async (token, schema, name) => {
    mocks.query.mockResolvedValueOnce({ rows: [metadata({ schema_name: schema, table_name: name })] });
    const definition = await describeTable(client, token, "updated_at");
    expect(definition).toMatchObject({ schema, name });
    expect(mocks.query.mock.calls[0][1]).toEqual([schema, name, "updated_at"]);
  });

  it.each(["", ".events", "public.", "schema.with.dot.events", '"public"."events',
    '"public"."events"; SELECT 1', 'public.ev"ents', '"".events', "public.\0events",
    " public.events", "public.events ", "public. events", "public .events",
    "public.event-rows", "public.events; SELECT 1", "public.events\n"])(
    "rejects ambiguous or malformed token %s before source I/O", async (token) => {
      await expect(describeTable(client, token, "updated_at")).rejects.toThrow("identifier");
      expect(mocks.query).not.toHaveBeenCalled();
    }
  );

  it("does not fall back to a nonunique column when metadata has no eligible PK", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(describeTable(client, "public.events", "updated_at")).rejects.toThrow("Unsupported SQL ingestion configuration");
  });

  it.each([
    { relation_oid: "9007199254740993" },
    { cursor_type_oid: "20" },
    { cursor_type_mod: 2_147_483_648 },
    { cursor_type: "float8" },
    { key_columns: [] },
    { key_columns: [null] },
    { cursor_collation_oid: "not-an-oid" },
  ])("rejects unsupported or inconsistent decoded metadata %j", async (override) => {
    mocks.query.mockResolvedValueOnce({ rows: [metadata(override)] });
    await expect(describeTable(client, "public.events", "updated_at")).rejects.toThrow("Invalid PostgreSQL cursor metadata");
  });
});

describe("typed stable SQL pages", () => {
  it("preserves bigint and timestamp text while keeping decoded row content", async () => {
    const decodedDate = new Date("2026-10-13T10:20:30.123Z");
    const exact = ["2026-10-13 10:20:30.123456+00", "9007199254740993"];
    mocks.query.mockResolvedValueOnce(page([[exact[1], decodedDate, ...exact]]));
    expect(await pullPage(client, table, exact, 1000)).toEqual({
      rows: [{ row: { id: exact[1], updated_at: decodedDate }, values: exact }],
    });
    expect(mocks.query).toHaveBeenCalledWith({
      text: 'SELECT r.*, r."updated_at"::pg_catalog.text, r."id"::pg_catalog.text FROM "public"."events" AS r' +
        ' WHERE (r."updated_at", r."id") OPERATOR(pg_catalog.>) ($1::pg_catalog.timestamptz, $2::pg_catalog.int8)' +
        ' ORDER BY r."updated_at" ASC, r."id" ASC LIMIT $3',
      values: [...exact, 1000], rowMode: "array",
    });
  });

  it("advances using the final database tuple even where lexical numeric order differs", async () => {
    const numeric: CursorColumn = { name: "position", type: "numeric", typeOid: 1700, typeModifier: -1, collationOid: 0 };
    mocks.query.mockResolvedValueOnce(page([
      ["a", "999", "999", "a"], ["b", "1000", "1000", "b"],
    ], ["id", "position", "position", "id"]));
    const result = await pullPage(client, { ...table, cursor: numeric }, null, 1000);
    expect(result.rows.map((row) => row.values[0])).toEqual(["999", "1000"]);
    expect(result.rows.at(-1)?.values).toEqual(["1000", "b"]);
    expect(mocks.query.mock.calls[0][0].text).not.toContain(" WHERE ");
  });

  it("includes every composite key component and avoids repeating the cursor column", async () => {
    const tenant: CursorColumn = { ...primaryKey, name: "tenant_id" };
    mocks.query.mockResolvedValueOnce(page([], ["id", "tenant_id", "id", "tenant_id"]));
    await pullPage(client, { ...table, cursor: primaryKey, key: [tenant, primaryKey] }, ["0", "7"], 3);
    const query = mocks.query.mock.calls[0][0];
    expect(query.text).toContain('WHERE (r."id", r."tenant_id") OPERATOR(pg_catalog.>) ($1::pg_catalog.int8, $2::pg_catalog.int8)');
    expect(query.text).toContain('ORDER BY r."id" ASC, r."tenant_id" ASC LIMIT $3');
    expect(query.values).toEqual(["0", "7", 3]);
  });

  it("uses positional projections when source columns collide or contain __proto__", async () => {
    mocks.query.mockResolvedValueOnce(page([["data", "ordinary", "bigint", "precise", "id"]],
      ["__proto__", "updated_at", "id", "updated_at", "id"]));
    const result = await pullPage(client, table, null, 1);
    expect(Object.hasOwn(result.rows[0].row, "__proto__")).toBe(true);
    expect(result.rows[0].row.__proto__).toBe("data");
    expect(Object.getPrototypeOf(result.rows[0].row)).toBe(Object.prototype);
    expect(result.rows[0].row.updated_at).toBe("ordinary");
    expect(result.rows[0].values).toEqual(["precise", "id"]);
  });

  it("quotes embedded identifier punctuation and binds empty cursor text", async () => {
    const quoted: TableDefinition = {
      ...table, schema: 'Schema".Name', name: "Table; SELECT 1",
      cursor: { name: 'Cur"sor', type: "text", typeOid: 25, typeModifier: -1, collationOid: 100 },
    };
    await pullPage(client, quoted, ["", "0"], 1);
    const query = mocks.query.mock.calls[0][0];
    expect(query.text).toContain('FROM "Schema"".Name"."Table; SELECT 1" AS r');
    expect(query.text).toContain('r."Cur""sor"');
    expect(query.values).toEqual(["", "0", 1]);
  });

  it("qualifies transport casts and tuple comparison independently of the source search path", async () => {
    const numeric: CursorColumn = {
      name: "sequence", type: "numeric", typeOid: 1700, typeModifier: -1, collationOid: 0,
    };
    const exact = ["1000.12345678901234567890", "9007199254740993"];
    mocks.query.mockResolvedValueOnce(page([[exact[1], exact[0], ...exact]],
      ["id", "sequence", "sequence", "id"]));
    const result = await pullPage(client, { ...table, cursor: numeric }, exact, 1);
    const query = mocks.query.mock.calls[0][0];
    expect(query.text).toContain('r."sequence"::pg_catalog.text, r."id"::pg_catalog.text');
    expect(query.text).toContain('OPERATOR(pg_catalog.>) ($1::pg_catalog.numeric, $2::pg_catalog.int8)');
    expect(query.text).not.toContain("::text");
    expect(query.text).not.toContain("SET search_path");
    expect(query.values).toEqual([...exact, 1]);
    expect(result.rows[0].values).toEqual(exact);
  });

  it.each([0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unbounded page limit %s before querying", async (limit) => {
      await expect(pullPage(client, table, null, limit)).rejects.toThrow("page limit");
      expect(mocks.query).not.toHaveBeenCalled();
    }
  );

  it.each([["only-one"], ["too", "many", "values"], [null, "1"], ["date", 1]])(
    "rejects a malformed cursor tuple %j before querying", async (...values) => {
      await expect(pullPage(client, table, values as string[], 1)).rejects.toThrow("cursor tuple");
      expect(mocks.query).not.toHaveBeenCalled();
    }
  );

  it.each([null, undefined, 9007199254740992, new Date("2026-10-13T00:00:00Z")])(
    "rejects a null/missing/decoded cursor projection %s", async (badValue) => {
      mocks.query.mockResolvedValueOnce(page([["1", new Date(), badValue, "1"]]));
      await expect(pullPage(client, table, null, 1)).rejects.toThrow("non-null PostgreSQL text");
    }
  );

  it("rejects a row with missing projection positions", async () => {
    mocks.query.mockResolvedValueOnce(page([["1", new Date(), "timestamp"]]));
    await expect(pullPage(client, table, null, 1)).rejects.toThrow("page row");
  });

  it("rejects a non-allowlisted cast even if a caller supplies invalid runtime metadata", async () => {
    const invalid = { ...table, cursor: { ...timestamp, type: "text); SELECT 1" } } as unknown as TableDefinition;
    await expect(pullPage(client, invalid, null, 1)).rejects.toThrow("unsupported SQL type");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    { ...table, key: [primaryKey, primaryKey] },
    { ...table, cursor: primaryKey, key: [primaryKey, primaryKey] },
    { ...table, cursor: { ...timestamp, typeOid: 20 } },
    { ...table, cursor: primaryKey, key: [{ ...primaryKey, typeModifier: 1 }] },
  ])("rejects inconsistent caller-supplied table definitions before querying %j", async (definition) => {
    await expect(pullPage(client, definition, null, 1)).rejects.toThrow("CURSOR_INVALID");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("legacy pullRows export", () => {
  it("retains bound strict paging and quotes complete identifiers", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await expect(pullRows(client, '"Odd.Schema"."Table""Name"', 'Cur"sor', "1000", 1000)).resolves.toEqual([{ id: 1 }]);
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT * FROM "Odd.Schema"."Table""Name" WHERE "Cur""sor" > $1 ORDER BY "Cur""sor" ASC LIMIT $2',
      ["1000", 1000]
    );
  });

  it("rejects an ambiguous old three-component table token", async () => {
    await expect(pullRows(client, "schema.with.dot", "updated_at", null, 1000)).rejects.toThrow("identifier");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
