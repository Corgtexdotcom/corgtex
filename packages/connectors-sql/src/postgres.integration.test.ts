import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { orderColumns } from "./cursor";
import type { TableDefinition } from "./cursor";
import { connectReadOnly, describeTable, listTables, pullPage, pullRows } from "./postgres";
import { createSqlTestFixture } from "./postgres-test-fixture";
import type { SqlTestFixture } from "./postgres-test-fixture";

let fixture: SqlTestFixture;
let reader: pg.Client;
let oddSchema: string;
const timestamp = "2026-10-12 23:59:59.123456";
const timestamptz = `${timestamp}+00`;

beforeAll(async () => {
  fixture = await createSqlTestFixture();
  const table = fixture.table;
  oddSchema = await fixture.createSchema('.schema"odd');
  await fixture.writer.query(`
    CREATE TABLE ${table("integer_rows")} (id integer PRIMARY KEY);
    INSERT INTO ${table("integer_rows")} VALUES (998), (999), (1000), (1001);
    CREATE TABLE ${table("bigint_rows")} (id bigint PRIMARY KEY);
    INSERT INTO ${table("bigint_rows")} VALUES
      (999), (1000), (9007199254740992), (9007199254740993),
      (999999999999999999), (1000000000000000000);
    CREATE TABLE ${table("numeric_rows")} (id integer PRIMARY KEY, amount numeric(30,6) NOT NULL);
    INSERT INTO ${table("numeric_rows")} VALUES
      (1, 9.99), (2, 10), (3, 999999999999999999999999.123456);
    CREATE TABLE ${table("temporal_rows")} (
      id bigint PRIMARY KEY, day date NOT NULL, ts timestamp NOT NULL,
      tz timestamptz NOT NULL, "text" text NOT NULL,
      "__proto__" text NOT NULL, "constructor" text NOT NULL
    );
    INSERT INTO ${table("temporal_rows")} VALUES
      (9007199254740992, '2026-10-12', '${timestamp}', '${timestamptz}', 'original text one', 'own proto value', 'own constructor value'),
      (9007199254740993, '2026-10-12', '2026-10-12 23:59:59.123457', '2026-10-12 23:59:59.123457+00', 'original text two', 'own proto value', 'own constructor value'),
      (1000000000000000000, '2026-10-13', '2026-10-13 00:00:00', '2026-10-13 00:00:00+00', 'original text three', 'own proto value', 'own constructor value');
    CREATE TABLE ${table("timestamp_ties")} (id integer PRIMARY KEY, changed_at timestamptz NOT NULL);
    INSERT INTO ${table("timestamp_ties")}
      SELECT n, '${timestamptz}'::timestamptz FROM generate_series(1, 1501) AS n;
    CREATE TABLE ${table("composite_rows")} (
      tenant integer NOT NULL, id bigint NOT NULL, changed_at timestamptz NOT NULL,
      PRIMARY KEY (tenant, id)
    );
    INSERT INTO ${table("composite_rows")} VALUES
      (2, 9007199254740993, '${timestamptz}'), (1, 9007199254740993, '${timestamptz}'),
      (1, 9007199254740992, '${timestamptz}');
    CREATE TABLE ${table("include_key")} (
      id integer, payload text, changed_at integer NOT NULL,
      PRIMARY KEY (id) INCLUDE (payload)
    );
    INSERT INTO ${table("include_key")} VALUES (1, NULL, 1), (2, 'included only', 1);
    CREATE TABLE ${table("text_rows")} (id integer PRIMARY KEY, changed_at text COLLATE "C" NOT NULL);
    CREATE TABLE ${table("nullable_cursor")} (id integer PRIMARY KEY, changed_at integer);
    CREATE TABLE ${table("no_primary_key")} (id integer NOT NULL, changed_at integer NOT NULL);
    CREATE TABLE ${table("unique_only")} (id integer UNIQUE NOT NULL, changed_at integer NOT NULL);
    CREATE TABLE ${table("deferred_key")} (id integer PRIMARY KEY DEFERRABLE INITIALLY DEFERRED, changed_at integer NOT NULL);
    CREATE TABLE ${table("float_cursor")} (id integer PRIMARY KEY, changed_at double precision NOT NULL);
    CREATE TABLE ${table("float_key")} (id double precision PRIMARY KEY, changed_at integer NOT NULL);
    CREATE DOMAIN "${fixture.schema}".cursor_domain AS integer;
    CREATE TABLE ${table("domain_cursor")} (id integer PRIMARY KEY, changed_at "${fixture.schema}".cursor_domain NOT NULL);
    CREATE TABLE ${table("inheritance_parent")} (id integer PRIMARY KEY, changed_at integer NOT NULL);
    CREATE TABLE ${table("inheritance_child")} () INHERITS (${table("inheritance_parent")});
    CREATE TABLE ${table("partitioned_rows")} (
      tenant integer NOT NULL, id integer NOT NULL, changed_at integer NOT NULL,
      PRIMARY KEY (tenant, id)
    ) PARTITION BY RANGE (tenant);
    CREATE TABLE ${table("partition_one")} PARTITION OF ${table("partitioned_rows")} FOR VALUES FROM (1) TO (2);
    CREATE TABLE ${table("partition_two")} PARTITION OF ${table("partitioned_rows")} FOR VALUES FROM (2) TO (3);
    INSERT INTO ${table("partitioned_rows")} VALUES (2, 1, 1), (1, 2, 1), (1, 1, 1);
    CREATE TABLE ${table("recreated")} (id integer PRIMARY KEY);
    CREATE TABLE ${table('table.with"quotes', oddSchema)} (
      "key.with""quote" integer PRIMARY KEY, "cursor.with""quote" integer NOT NULL,
      "text" text NOT NULL
    );
  `);
  await fixture.writer.query(
    `INSERT INTO ${table("text_rows")} VALUES (1, $1), (2, $2), (3, $3)`,
    ["", "a' OR true --", "b"],
  );
  await fixture.writer.query(
    `INSERT INTO ${table('table.with"quotes', oddSchema)} VALUES (1, 1, $1), (2, 2, $2)`,
    ["row one", "row two"],
  );
  reader = await connectReadOnly(fixture.connectionString);
}, 60_000);

afterAll(async () => {
  try {
    if (reader) await reader.end();
  } finally {
    if (fixture) await fixture.close();
  }
}, 30_000);

async function drain(definition: TableDefinition, limit: number) {
  const rows: Awaited<ReturnType<typeof pullPage>>["rows"] = [];
  const sizes: number[] = [];
  let values: string[] | null = null;
  for (let page = 0; page < 20; page++) {
    const next = await pullPage(reader, definition, values, limit);
    sizes.push(next.rows.length);
    if (!next.rows.length) return { rows, sizes };
    rows.push(...next.rows);
    values = next.rows.at(-1)!.values;
  }
  throw new Error("Synthetic fixture scan exceeded its bounded test budget");
}

describe("real pg typed SQL ingestion pages", () => {
  it("advances numeric page tails through 999 to 1000 with one deduplicated key component", async () => {
    const definition = await describeTable(reader, fixture.table("integer_rows"), "id");
    expect(definition.cursor).toMatchObject({ name: "id", type: "int4", typeOid: 23 });
    expect(definition.relationOid).toBeGreaterThan(0);
    expect(orderColumns(definition).map((column) => column.name)).toEqual(["id"]);
    const first = await pullPage(reader, definition, null, 2);
    expect(first.rows.map((entry) => entry.row.id)).toEqual([998, 999]);
    expect(first.rows.at(-1)!.values).toEqual(["999"]);
    const second = await pullPage(reader, definition, first.rows.at(-1)!.values, 2);
    expect(second.rows.map((entry) => entry.row.id)).toEqual([1000, 1001]);
    expect(second.rows.at(-1)!.values).toEqual(["1001"]);
    expect((await pullPage(reader, definition, second.rows.at(-1)!.values, 2)).rows).toEqual([]);
  });

  it("preserves bigint identities and cursor values beyond Number precision and across digit widths", async () => {
    const definition = await describeTable(reader, fixture.table("bigint_rows"), "id");
    expect(definition.cursor).toMatchObject({ type: "int8", typeOid: 20 });
    const result = await drain(definition, 2);
    const expected = ["999", "1000", "9007199254740992", "9007199254740993", "999999999999999999", "1000000000000000000"];
    expect(result.rows.map((entry) => entry.row.id)).toEqual(expected);
    expect(result.rows.map((entry) => entry.values)).toEqual(expected.map((value) => [value]));
    expect(result.sizes).toEqual([2, 2, 2, 0]);
  });

  it("preserves exact numeric scale and orders decimal digit-width boundaries in PostgreSQL", async () => {
    const definition = await describeTable(reader, fixture.table("numeric_rows"), "amount");
    expect(definition.cursor).toMatchObject({ type: "numeric", typeOid: 1700 });
    const result = await drain(definition, 1);
    expect(result.rows.map((entry) => entry.values)).toEqual([
      ["9.990000", "1"], ["10.000000", "2"], ["999999999999999999999999.123456", "3"],
    ]);
    expect(result.rows.map((entry) => entry.row.amount)).toEqual(result.rows.map((entry) => entry.values[0]));
  });

  it.each(["ts", "tz"])("retains exact %s microseconds in both native cells and cursor tuples", async (column) => {
    const definition = await describeTable(reader, fixture.table("temporal_rows"), column);
    expect(definition.cursor.typeOid).toBe(column === "ts" ? 1114 : 1184);
    const first = await pullPage(reader, definition, null, 1);
    const exact = column === "ts" ? timestamp : timestamptz;
    expect(first.rows[0].row[column]).toBe(exact);
    expect(first.rows[0].values).toEqual([exact, "9007199254740992"]);
    const second = await pullPage(reader, definition, first.rows[0].values, 1);
    expect(second.rows[0].row.id).toBe("9007199254740993");
    expect(second.rows[0].values[0]).toContain(".123457");
  });

  it("keeps native temporal cells and cursor tuples independent of process timezone", async () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const timestampDefinition = await describeTable(reader, fixture.table("temporal_rows"), "ts");
      const timestampPage = await pullPage(reader, timestampDefinition, null, 1);
      const instantDefinition = await describeTable(reader, fixture.table("temporal_rows"), "tz");
      const instantPage = await pullPage(reader, instantDefinition, null, 1);
      expect(timestampPage.rows[0].values).toEqual([timestamp, "9007199254740992"]);
      expect(instantPage.rows[0].values).toEqual([timestamptz, "9007199254740992"]);
      expect(timestampPage.rows[0].row.ts).toBe(timestamp);
      expect(instantPage.rows[0].row.tz).toBe(timestamptz);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("uses exact date text and unique key order to drain ties on a date cursor", async () => {
    const definition = await describeTable(reader, fixture.table("temporal_rows"), "day");
    expect(definition.cursor).toMatchObject({ type: "date", typeOid: 1082 });
    const result = await drain(definition, 1);
    expect(result.rows.map((entry) => entry.values)).toEqual([
      ["2026-10-12", "9007199254740992"], ["2026-10-12", "9007199254740993"], ["2026-10-13", "1000000000000000000"],
    ]);
    expect(result.rows[0].row.day).toBe("2026-10-12");
  });

  it("drains all 1501 identical timestamps across the 1000-row page boundary exactly once", async () => {
    const definition = await describeTable(reader, fixture.table("timestamp_ties"), "changed_at");
    const result = await drain(definition, 1000);
    expect(result.sizes).toEqual([1000, 501, 0]);
    expect(result.rows.map((entry) => entry.row.id)).toEqual(Array.from({ length: 1501 }, (_, index) => index + 1));
    expect(new Set(result.rows.map((entry) => entry.row.id)).size).toBe(1501);
    expect(result.rows.at(-1)!.values).toEqual([timestamptz, "1501"]);
  });

  it("uses every composite primary-key component and deduplicates a cursor already in that key", async () => {
    const definition = await describeTable(reader, fixture.table("composite_rows"), "changed_at");
    expect(definition.key.map((column) => column.name)).toEqual(["tenant", "id"]);
    const result = await drain(definition, 1);
    expect(result.rows.map((entry) => entry.values)).toEqual([
      [timestamptz, "1", "9007199254740992"], [timestamptz, "1", "9007199254740993"], [timestamptz, "2", "9007199254740993"],
    ]);
    const overlap = await describeTable(reader, fixture.table("composite_rows"), "tenant");
    expect(orderColumns(overlap).map((column) => column.name)).toEqual(["tenant", "id"]);
    expect((await drain(overlap, 1)).rows.map((entry) => entry.values)).toEqual([
      ["1", "9007199254740992"], ["1", "9007199254740993"], ["2", "9007199254740993"],
    ]);
  });

  it("excludes INCLUDE attributes from the enforced primary key and accepts default key ordering", async () => {
    const definition = await describeTable(reader, fixture.table("include_key"), "changed_at");
    expect(definition.key.map((column) => column.name)).toEqual(["id"]);
    const result = await drain(definition, 1);
    expect(result.rows.map((entry) => entry.values)).toEqual([["1", "1"], ["1", "2"]]);
    expect(result.rows[0].row.payload).toBeNull();
    const index = await reader.query("SELECT i.indimmediate, i.indisvalid, i.indnkeyatts, i.indnatts FROM pg_index i WHERE i.indrelid = $1::oid AND i.indisprimary", [definition.relationOid]);
    expect(index.rows[0]).toMatchObject({ indimmediate: true, indisvalid: true, indnkeyatts: 1, indnatts: 2 });
  });

  it("reads a partitioned parent in one global composite-key order", async () => {
    const definition = await describeTable(reader, fixture.table("partitioned_rows"), "changed_at");
    expect(definition.key.map((column) => column.name)).toEqual(["tenant", "id"]);
    const result = await drain(definition, 1);
    expect(result.rows.map((entry) => entry.values)).toEqual([["1", "1", "1"], ["1", "1", "2"], ["1", "2", "1"]]);
  });

  it("preserves original fields and object-safe names when cursor suffix labels duplicate original names", async () => {
    const definition = await describeTable(reader, fixture.table("temporal_rows"), "ts");
    const page = await pullPage(reader, definition, null, 1);
    expect(page.rows[0].row.text).toBe("original text one");
    expect(page.rows[0].row.ts).toBe(timestamp);
    expect(Object.hasOwn(page.rows[0].row, "__proto__")).toBe(true);
    expect(page.rows[0].row.__proto__).toBe("own proto value");
    expect(page.rows[0].row.constructor).toBe("own constructor value");
    expect(Object.getPrototypeOf(page.rows[0].row)).toBe(Object.prototype);
    expect(page.rows[0].values).toEqual([timestamp, "9007199254740992"]);
  });

  it("binds injection-shaped text and resumes a valid empty text cursor", async () => {
    const definition = await describeTable(reader, fixture.table("text_rows"), "changed_at");
    const first = await pullPage(reader, definition, null, 1);
    expect(first.rows[0].values).toEqual(["", "1"]);
    const second = await pullPage(reader, definition, first.rows[0].values, 1);
    expect(second.rows[0].values).toEqual(["a' OR true --", "2"]);
    const third = await pullPage(reader, definition, second.rows[0].values, 1);
    expect(third.rows.map((entry) => entry.row.id)).toEqual([3]);
    expect(third.rows[0].values).toEqual(["b", "3"]);
  });

  it("keeps exact text and native tuple paging under a hostile search_path without changing it", async () => {
    const shadow = await fixture.createSchema("_shadow");
    await fixture.writer.query(`
      CREATE DOMAIN "${shadow}".text AS pg_catalog.int4;
      CREATE FUNCTION ${fixture.table("never_greater", shadow)}(pg_catalog.int4, pg_catalog.int4)
        RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE STRICT AS 'SELECT false';
      CREATE OPERATOR "${shadow}".> (
        FUNCTION = ${fixture.table("never_greater", shadow)},
        LEFTARG = pg_catalog.int4, RIGHTARG = pg_catalog.int4
      );
    `);
    const previous = await reader.query("SELECT pg_catalog.current_setting('search_path') AS value");
    const shadowDomain = await fixture.writer.query("SELECT oid FROM pg_catalog.pg_type WHERE typnamespace = $1::pg_catalog.regnamespace AND typname = 'text'", [shadow]);
    const hostilePath = `"${shadow}", pg_catalog`;
    try {
      await reader.query("SELECT pg_catalog.set_config('search_path', $1, false)", [hostilePath]);
      const control = await reader.query(`
        SELECT pg_catalog.pg_typeof('12'::text)::pg_catalog.oid AS resolved_type_oid,
          '12'::text AS shadowed_text, '12'::pg_catalog.text AS native_text,
          2::pg_catalog.int4 > 1::pg_catalog.int4 AS shadowed_comparison,
          2::pg_catalog.int4 OPERATOR(pg_catalog.>) 1::pg_catalog.int4 AS native_comparison
      `);
      expect(control.rows[0].resolved_type_oid).toBe(shadowDomain.rows[0].oid);
      expect(control.rows[0]).toMatchObject({ shadowed_text: 12, native_text: "12", shadowed_comparison: false, native_comparison: true });

      const integers = await describeTable(reader, fixture.table("integer_rows"), "id");
      const first = await pullPage(reader, integers, null, 2);
      expect(first.rows.at(-1)!.values).toEqual(["999"]);
      const second = await pullPage(reader, integers, first.rows.at(-1)!.values, 2);
      expect(second.rows.map((entry) => entry.row.id)).toEqual([1000, 1001]);
      expect(second.rows.at(-1)!.values).toEqual(["1001"]);

      const temporal = await describeTable(reader, fixture.table("temporal_rows"), "ts");
      const temporalFirst = await pullPage(reader, temporal, null, 1);
      expect(temporalFirst.rows[0].values).toEqual([timestamp, "9007199254740992"]);
      const temporalSecond = await pullPage(reader, temporal, temporalFirst.rows[0].values, 1);
      expect(temporalSecond.rows[0].values).toEqual(["2026-10-12 23:59:59.123457", "9007199254740993"]);
      expect((await reader.query("SELECT pg_catalog.current_setting('search_path') AS value")).rows[0].value)
        .toBe(hostilePath);
    } finally {
      await reader.query("SELECT pg_catalog.set_config('search_path', $1, false)", [previous.rows[0].value]);
    }
  });

  it("round trips listed quoted schema/table tokens and embedded cursor identifier quotes", async () => {
    const name = 'table.with"quotes';
    const key = 'key.with"quote';
    const cursor = 'cursor.with"quote';
    const token = fixture.table(name, oddSchema);
    expect(await listTables(reader)).toContain(token);
    const definition = await describeTable(reader, token, cursor);
    expect(definition).toMatchObject({ schema: oddSchema, name, cursor: { name: cursor }, key: [{ name: key }] });
    const first = await pullPage(reader, definition, null, 1);
    const second = await pullPage(reader, definition, first.rows[0].values, 1);
    expect(first.rows[0].row[key]).toBe(1);
    expect(second.rows[0].row[key]).toBe(2);
    expect(second.rows[0].row.text).toBe("row two");
    expect(await pullRows(reader, token, cursor, "1", 1000)).toEqual([{ [key]: 2, [cursor]: 2, text: "row two" }]);
  });

  it.each([
    "nullable_cursor", "no_primary_key", "unique_only", "deferred_key", "float_cursor", "float_key", "domain_cursor", "inheritance_parent",
  ])("rejects unsupported %s configuration with an explicit diagnostic", async (name) => {
    await expect(describeTable(reader, fixture.table(name), "changed_at"))
      .rejects.toThrow(/Unsupported SQL ingestion configuration.*NOT NULL.*primary key/i);
  });

  it("detects relation recreation through changed relation OID despite the same declared key", async () => {
    const before = await describeTable(reader, fixture.table("recreated"), "id");
    await fixture.writer.query(`DROP TABLE ${fixture.table("recreated")}; CREATE TABLE ${fixture.table("recreated")} (id integer PRIMARY KEY)`);
    const after = await describeTable(reader, fixture.table("recreated"), "id");
    expect(after.relationOid).not.toBe(before.relationOid);
    expect(after.cursor).toEqual(before.cursor);
    expect(after.key).toEqual(before.key);
  });

  it("enforces read-only timeout/ISO/UTC settings and rejects a synthetic write", async () => {
    const settings = await reader.query("SELECT current_setting('statement_timeout') AS timeout, current_setting('default_transaction_read_only') AS readonly, current_setting('TimeZone') AS timezone, current_setting('DateStyle') AS datestyle");
    expect(settings.rows[0]).toMatchObject({ timeout: "30s", readonly: "on", timezone: "UTC" });
    expect(settings.rows[0].datestyle).toContain("ISO");
    await expect(reader.query(`INSERT INTO ${fixture.table("integer_rows")} VALUES (2000)`))
      .rejects.toMatchObject({ code: "25006" });
    expect((await reader.query(`SELECT count(*)::integer AS count FROM ${fixture.table("integer_rows")}`)).rows[0].count).toBe(4);
  });
});
