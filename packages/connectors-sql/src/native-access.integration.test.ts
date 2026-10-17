import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqlTestFixture } from "./postgres-test-fixture";
import type { SqlTestFixture } from "./postgres-test-fixture";
import { connectReadOnly, describeTable, pullPage } from "./postgres";
import { encrypt } from "./encryption";
import { validatePostgresNativeAccess } from "./native-access";
import type { SqlNativeAccessInput } from "./native-access";
import { capturePostgresScan } from "./native-scan";

let fixture: SqlTestFixture;
const role = `pun85_access_${randomBytes(8).toString("hex")}`;
let connectionString: string;

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  fixture = await createSqlTestFixture();
  await fixture.writer.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  await fixture.writer.query(`GRANT USAGE ON SCHEMA "${fixture.schema}" TO "${role}"`);
  const url = new URL(fixture.connectionString);
  url.username = role;
  connectionString = url.toString();
});

afterAll(async () => {
  if (fixture) {
    await fixture.writer.query(`DROP OWNED BY "${role}"`);
    await fixture.writer.query(`DROP ROLE "${role}"`);
    await fixture.close();
  }
  vi.unstubAllEnvs();
});

async function capture(empty = false) {
  const table = fixture.table(`access_${randomBytes(6).toString("hex")}`);
  await fixture.writer.query(`CREATE TABLE ${table} (id bigint PRIMARY KEY, seq bigint NOT NULL, payload text NOT NULL)`);
  await fixture.writer.query(`GRANT SELECT ON ${table} TO "${role}"`);
  if (!empty) await fixture.writer.query(`INSERT INTO ${table} VALUES (9007199254740993, 1, 'original preserved bytes')`);
  const reader = await connectReadOnly(connectionString);
  let input: SqlNativeAccessInput;
  try {
    const definition = await describeTable(reader, table, "seq");
    const page = await pullPage(reader, definition, null, 1000);
    input = {
      source: { id: "synthetic-source", workspaceId: "synthetic-workspace", driverType: "postgres",
        connectionStringEnc: encrypt(connectionString), selectedTables: [table], cursorColumn: "seq",
        lastCursorValue: null, isActive: true, archivedAt: null },
      parents: { rows: page.rows.map(({ values }) => ({ table, definition, values, primaryKey: values[1] })),
        pages: [{ table, definition, previous: null, rowCount: page.rows.length, tail: page.rows.at(-1)?.values ?? null }] },
      assertCurrentSource: vi.fn().mockResolvedValue(undefined),
    };
  } finally { await reader.end(); }
  return { table, input };
}

describe("authenticated PostgreSQL current access", () => {
  it("authenticates the actual role and exact native bigint tuple without changing original parents", async () => {
    const { input } = await capture();
    const before = structuredClone(input.parents);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
    expect(input.parents).toEqual(before);
    expect(input.parents.rows[0].values).toEqual(["1", "9007199254740993"]);
    expect(input.assertCurrentSource).toHaveBeenCalled();
  });

  it("denies revoked SELECT and permits regrant at the provider boundary only", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`REVOKE SELECT ON ${table} FROM "${role}"`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    await fixture.writer.query(`GRANT SELECT ON ${table} TO "${role}"`);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
  });

  it("checks payload-column SELECT instead of treating key-only grants as sufficient", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`REVOKE SELECT ON ${table} FROM "${role}"`);
    await fixture.writer.query(`GRANT SELECT (id, seq) ON ${table} TO "${role}"`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    await fixture.writer.query(`GRANT SELECT (payload) ON ${table} TO "${role}"`);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
  });

  it("enforces RLS row visibility even while SELECT remains granted", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await fixture.writer.query(`CREATE POLICY visible ON ${table} USING (false)`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    await fixture.writer.query(`ALTER POLICY visible ON ${table} USING (true)`);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
  });

  it("denies deleted rows and recognizes restored exact tuples without minting new content", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`DELETE FROM ${table}`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    await fixture.writer.query(`INSERT INTO ${table} VALUES (9007199254740993, 1, 'restored payload differs')`);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
    expect(input.parents.rows[0]).not.toHaveProperty("content");
  });

  it("denies changed cursor values while allowing payload-only changes to the original tuple", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`UPDATE ${table} SET payload = 'changed payload'`);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
    await fixture.writer.query(`UPDATE ${table} SET seq = 2`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
  });

  it("denies a recreated relation with the same name, key and rows but a different OID", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`DROP TABLE ${table}`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    await fixture.writer.query(`CREATE TABLE ${table} (id bigint PRIMARY KEY, seq bigint NOT NULL, payload text NOT NULL)`);
    await fixture.writer.query(`INSERT INTO ${table} VALUES (9007199254740993, 1, 'original preserved bytes')`);
    await fixture.writer.query(`GRANT SELECT ON ${table} TO "${role}"`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
  });

  it("denies changed native types and loss of the captured supported primary key", async () => {
    const changed = await capture();
    await fixture.writer.query(`ALTER TABLE ${changed.table} ALTER COLUMN seq TYPE numeric`);
    expect(await validatePostgresNativeAccess(changed.input)).toBe(false);
    const unsupported = await capture();
    await fixture.writer.query(`ALTER TABLE ${unsupported.table} ALTER COLUMN seq DROP NOT NULL`);
    expect(await validatePostgresNativeAccess(unsupported.input)).toBe(false);
  });

  it("denies dropped payload columns and same-name replacements with different attnum", async () => {
    const { table, input } = await capture();
    expect(await validatePostgresNativeAccess(input)).toBe(true);
    await fixture.writer.query(`ALTER TABLE ${table} DROP COLUMN payload`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    await fixture.writer.query(`ALTER TABLE ${table} ADD COLUMN payload text NOT NULL DEFAULT 'replacement'`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
  });

  it("denies payload type, nullability and SELECT shape changes", async () => {
    const type = await capture();
    await fixture.writer.query(`ALTER TABLE ${type.table} ALTER COLUMN payload TYPE varchar(200)`);
    expect(await validatePostgresNativeAccess(type.input)).toBe(false);
    const nullable = await capture();
    await fixture.writer.query(`ALTER TABLE ${nullable.table} ALTER COLUMN payload DROP NOT NULL`);
    expect(await validatePostgresNativeAccess(nullable.input)).toBe(false);
    const added = await capture();
    await fixture.writer.query(`ALTER TABLE ${added.table} ADD COLUMN extra jsonb`);
    expect(await validatePostgresNativeAccess(added.input)).toBe(false);
  });

  it("captures complete ordered metadata for payload, identity and generated columns", async () => {
    const { table } = await capture();
    await fixture.writer.query(`ALTER TABLE ${table} ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY`);
    await fixture.writer.query(`ALTER TABLE ${table} ADD COLUMN extra jsonb, ADD COLUMN calc bigint GENERATED ALWAYS AS (seq + 1) STORED`);
    const reader = await connectReadOnly(connectionString);
    try {
      const definition = await describeTable(reader, table, "seq");
      expect(definition.columns.map((column) => column.name)).toEqual(["id", "seq", "payload", "extra", "calc"]);
      expect(definition.columns[0]).toMatchObject({ position: 1, isNullable: false, identity: "d", generated: "" });
      expect(definition.columns[3]).toMatchObject({ position: 4, type: "jsonb", typeOid: 3802, isNullable: true });
      expect(definition.columns[4]).toMatchObject({ position: 5, type: "int8", generated: "s" });
      const page = await pullPage(reader, definition, null, 1000);
      expect(Object.keys(page.rows[0].row)).toEqual(definition.columns.map((column) => column.name));
    } finally { await reader.end(); }
  });

  it.each(["type", "replacement"])("rejects native SELECT field metadata changed after describe (%s)", async (change) => {
    const { table } = await capture();
    const reader = await connectReadOnly(connectionString);
    try {
      const definition = await describeTable(reader, table, "seq");
      if (change === "type") {
        await fixture.writer.query(`ALTER TABLE ${table} ALTER COLUMN payload TYPE varchar(200)`);
      } else {
        await fixture.writer.query(`ALTER TABLE ${table} DROP COLUMN payload`);
        await fixture.writer.query(`ALTER TABLE ${table} ADD COLUMN payload text NOT NULL DEFAULT 'replacement'`);
      }
      await expect(pullPage(reader, definition, null, 1000)).rejects.toThrow(/SELECT fields differ/);
    } finally { await reader.end(); }
  });

  it.each([false, true])("captures and reauthorizes domain payloads with resolved wire typmods (nested=%s)", async (nested) => {
    const { table, input } = await capture();
    const domain = fixture.table(`domain_${randomBytes(6).toString("hex")}`);
    const nestedDomain = fixture.table(`nested_${randomBytes(6).toString("hex")}`);
    await fixture.writer.query(`CREATE DOMAIN ${domain} AS varchar(12)`);
    if (nested) await fixture.writer.query(`CREATE DOMAIN ${nestedDomain} AS ${domain}`);
    const declared = nested ? nestedDomain : domain;
    await fixture.writer.query(`UPDATE ${table} SET payload = 'payload'`);
    await fixture.writer.query(`ALTER TABLE ${table} ALTER COLUMN payload TYPE ${declared}`);
    const scanned = await capturePostgresScan(input.source, input.assertCurrentSource);
    try {
      expect(scanned.rows[0].row.payload).toBe("payload");
      const payload = scanned.rows[0].definition.columns.find((column) => column.name === "payload")!;
      expect(payload.typeOid).not.toBe(1043);
      expect(payload.typeModifier).toBe(-1);
      expect(await validatePostgresNativeAccess({ ...input, parents: scanned })).toBe(true);
      await scanned.beforePublication();
    } finally { await scanned.dispose(); }
  });

  it("isolates exact temporal decoding across host timezones, arrays, bytea and domains without changing v1 cursors", async () => {
    const { input } = await capture();
    const table = fixture.table(`temporal_${randomBytes(6).toString("hex")}`);
    const domain = fixture.table(`temporal_domain_${randomBytes(6).toString("hex")}`);
    const arrayDomain = fixture.table(`temporal_array_domain_${randomBytes(6).toString("hex")}`);
    await fixture.writer.query(`CREATE DOMAIN ${domain} AS timestamp`);
    await fixture.writer.query(`CREATE DOMAIN ${arrayDomain} AS timestamptz[]`);
    await fixture.writer.query(`CREATE TABLE ${table} (
      id bigint PRIMARY KEY, changed_at timestamptz NOT NULL, day date, wall timestamp, instant timestamptz,
      days date[], walls timestamp[], instants timestamptz[], "binary" bytea, binaries bytea[], domain_wall ${domain},
      domain_walls ${domain}[], domain_instants ${arrayDomain})`);
    await fixture.writer.query(`INSERT INTO ${table} VALUES (
      9007199254740993, '2026-10-12 23:59:59.123456+00', '2026-10-12',
      '2026-10-12 23:59:59.123456', '2026-10-12 23:59:59.123456+00',
      ARRAY['2026-10-12'::date, NULL], ARRAY['2026-10-12 23:59:59.123456'::timestamp, NULL],
      ARRAY['2026-10-12 23:59:59.123456+00'::timestamptz, NULL],
      decode('00ff4142','hex'), ARRAY[decode('4142','hex'), NULL], '2026-10-12 23:59:59.123456',
      '{"2026-10-12 23:59:59.123456",NULL}', '{"2026-10-12 23:59:59.123456+00",NULL}')`);
    await fixture.writer.query(`GRANT SELECT ON ${table} TO "${role}"`);
    const source = { ...input.source, selectedTables: [table], cursorColumn: "changed_at" };
    const parser = pg.types.getTypeParser(1114);
    const originalTimezone = process.env.TZ;
    const results: Awaited<ReturnType<typeof capturePostgresScan>>[] = [];
    const ordinary = new pg.Client({ connectionString });
    await ordinary.connect();
    await ordinary.query("SET TIME ZONE 'UTC'");
    try {
      for (const timezone of ["UTC", "America/New_York"]) {
        process.env.TZ = timezone;
        const scanned = await capturePostgresScan(source, input.assertCurrentSource);
        results.push(scanned);
        const native = scanned.rows[0].row;
        expect(native).toMatchObject({
          day: "2026-10-12", wall: "2026-10-12 23:59:59.123456", instant: "2026-10-12 23:59:59.123456+00",
          days: "{2026-10-12,NULL}", walls: '{"2026-10-12 23:59:59.123456",NULL}',
          instants: '{"2026-10-12 23:59:59.123456+00",NULL}', domain_wall: "2026-10-12 23:59:59.123456",
          domain_walls: '{"2026-10-12 23:59:59.123456",NULL}', domain_instants: '{"2026-10-12 23:59:59.123456+00",NULL}',
        });
        expect(Buffer.isBuffer(native.binary)).toBe(true);
        expect(native.binary).toEqual(Buffer.from([0, 255, 65, 66]));
        expect(native.binaries).toEqual([Buffer.from("AB"), null]);
        expect(await validatePostgresNativeAccess({ ...input, source, parents: scanned })).toBe(true);
        const defaultCells = (await ordinary.query(`SELECT * FROM ${table}`)).rows[0];
        expect(defaultCells.day).toBeInstanceOf(Date);
        expect(defaultCells.wall).toBeInstanceOf(Date);
        expect(defaultCells.instant).toBeInstanceOf(Date);
        expect(defaultCells.days[0]).toBeInstanceOf(Date);
        expect(defaultCells.walls[0]).toBeInstanceOf(Date);
        expect(defaultCells.instants[0]).toBeInstanceOf(Date);
        expect(pg.types.getTypeParser(1114)).toBe(parser);
        await scanned.beforePublication();
      }
      expect(results[0].rows[0].row).toEqual(results[1].rows[0].row);
      expect(results[0].nextCursor).toBe(results[1].nextCursor);
      const checkpoint = JSON.parse(results[0].nextCursor);
      expect(checkpoint.version).toBe(1);
      expect(checkpoint.tables[table].values).toEqual(["2026-10-12 23:59:59.123456+00", "9007199254740993"]);
      expect(checkpoint.tables[table].definition).not.toHaveProperty("columns");
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
      for (const result of results) await result.dispose();
      await ordinary.end();
    }
  });

  it("preserves legacy identity compatibility using the actual selected identity cell and its domain wire type", async () => {
    const { input } = await capture();
    const domain = fixture.table(`identity_domain_${randomBytes(6).toString("hex")}`);
    const changed = fixture.table(`changed_identity_${randomBytes(6).toString("hex")}`);
    await fixture.writer.query(`CREATE DOMAIN ${domain} AS date`);
    await fixture.writer.query(`CREATE TABLE ${changed} (first_day ${domain}, code text PRIMARY KEY, seq bigint NOT NULL)`);
    await fixture.writer.query(`INSERT INTO ${changed} VALUES ('2026-10-12', '2026-10-12', 1)`);
    await fixture.writer.query(`GRANT SELECT ON ${changed} TO "${role}"`);
    await expect(capturePostgresScan({ ...input.source, selectedTables: [changed] }, input.assertCurrentSource))
      .rejects.toThrow("CURSOR_IDENTITY_CHANGED");

    const compatible = fixture.table(`compatible_identity_${randomBytes(6).toString("hex")}`);
    await fixture.writer.query(`CREATE TABLE ${compatible} (id text, day date PRIMARY KEY, seq bigint NOT NULL)`);
    await fixture.writer.query(`INSERT INTO ${compatible} VALUES ('2026-10-12', '2026-10-12', 1)`);
    await fixture.writer.query(`GRANT SELECT ON ${compatible} TO "${role}"`);
    const scanned = await capturePostgresScan({ ...input.source, selectedTables: [compatible] }, input.assertCurrentSource);
    try { expect(scanned.rows[0].primaryKey).toBe("2026-10-12"); }
    finally { await scanned.dispose(); }
  });

  it("rejects a same-wire domain swap after SELECT before returning any captured rows", async () => {
    const { table, input } = await capture();
    const first = fixture.table(`first_${randomBytes(6).toString("hex")}`);
    const second = fixture.table(`second_${randomBytes(6).toString("hex")}`);
    await fixture.writer.query(`CREATE DOMAIN ${first} AS varchar(40)`);
    await fixture.writer.query(`CREATE DOMAIN ${second} AS varchar(40)`);
    await fixture.writer.query(`ALTER TABLE ${table} ALTER COLUMN payload TYPE ${first}`);
    let switched = false;
    const original = pg.Client.prototype.query;
    const observed = vi.spyOn(pg.Client.prototype, "query").mockImplementation(new Proxy(original, {
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args);
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (!switched && typeof text === "string" && text.startsWith("SELECT r.*")) {
          switched = true;
          return result.then(async (value: pg.QueryResult) => {
            expect(value.fields[2]).toMatchObject({ dataTypeID: 1043, dataTypeModifier: 44 });
            await fixture.writer.query(`ALTER TABLE ${table} ALTER COLUMN payload TYPE ${second}`);
            return value;
          });
        }
        return result;
      },
    }));
    try {
      await expect(capturePostgresScan(input.source, input.assertCurrentSource)).rejects.toThrow("CURSOR_DEFINITION_CHANGED");
      expect(switched).toBe(true);
    } finally { observed.mockRestore(); }
  });

  it("throws for legacy parents missing complete captured column metadata", async () => {
    const { input } = await capture();
    const old = input.parents.rows[0].definition;
    const legacy = { schema: old.schema, name: old.name, relationOid: old.relationOid, cursor: old.cursor, key: old.key };
    await expect(validatePostgresNativeAccess({ ...input, parents: {
      rows: input.parents.rows.map((row) => ({ ...row, definition: legacy })),
      pages: input.parents.pages.map((page) => ({ ...page, definition: legacy })),
    } } as unknown as SqlNativeAccessInput)).rejects.toThrow(/column metadata is unproved/);
  });

  it("checks empty-page SELECT privileges without asserting any row authority", async () => {
    const { table, input } = await capture(true);
    expect(await validatePostgresNativeAccess(input)).toBe(true);
    await fixture.writer.query(`REVOKE SELECT ON ${table} FROM "${role}"`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
    expect(input.parents.rows).toEqual([]);
  });

  it("throws on an unavailable provider and unproved parent metadata", async () => {
    const { input } = await capture();
    const unavailable = new URL(connectionString);
    unavailable.searchParams.set("host", `/tmp/pun85_missing_${randomBytes(8).toString("hex")}`);
    await expect(validatePostgresNativeAccess({ ...input, source: { ...input.source, connectionStringEnc: encrypt(unavailable.toString()) } })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(validatePostgresNativeAccess({ ...input, parents: { rows: [], pages: [] } })).rejects.toThrow(/no authenticated table parents/);
    const parent = input.parents.rows[0];
    await expect(validatePostgresNativeAccess({ ...input, parents: { ...input.parents, rows: [{ ...parent, primaryKey: "invented" }] } })).rejects.toThrow(/identity is unproved/);
  });

  it("throws on authentication failure and provider query failure without treating either as denial", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`ALTER ROLE "${role}" NOLOGIN`);
    try {
      await expect(validatePostgresNativeAccess(input)).rejects.toMatchObject({ code: "28000" });
    } finally { await fixture.writer.query(`ALTER ROLE "${role}" LOGIN`); }
    await fixture.writer.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await fixture.writer.query(`CREATE POLICY unproved ON ${table} USING (1 / (seq - seq) > 0)`);
    await expect(validatePostgresNativeAccess(input)).rejects.toMatchObject({ code: "22012" });
    // An undefined relation inside a policy is not proof that the captured
    // relation disappeared; it must not permanently retire the receipt.
    const policyFunction = fixture.table(`policy_${randomBytes(6).toString("hex")}`);
    const missingRelation = fixture.table("missing_policy_dependency");
    await fixture.writer.query(`CREATE FUNCTION ${policyFunction}() RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN PERFORM * FROM ${missingRelation}; RETURN true; END;
    $$`);
    await fixture.writer.query(`ALTER POLICY unproved ON ${table} USING (${policyFunction}())`);
    await expect(validatePostgresNativeAccess(input)).rejects.toMatchObject({ code: "42P01" });
  });

  it("checks every native parent across the bounded query batches", async () => {
    const { table, input } = await capture();
    await fixture.writer.query(`DELETE FROM ${table}`);
    await fixture.writer.query(`INSERT INTO ${table} SELECT n, n, 'native row' FROM generate_series(1, 1001) n`);
    const reader = await connectReadOnly(connectionString);
    const definition = input.parents.rows[0].definition;
    const mutable = await describeTable(reader, table, "seq");
    try {
      const first = await pullPage(reader, mutable, null, 1000);
      const second = await pullPage(reader, mutable, first.rows.at(-1)!.values, 1000);
      input.parents = {
        rows: [...first.rows, ...second.rows].map(({ values }) => ({ table, definition, values, primaryKey: values[1] })),
        pages: [
          { table, definition, previous: null, rowCount: 1000, tail: first.rows.at(-1)!.values },
          { table, definition, previous: first.rows.at(-1)!.values, rowCount: 1, tail: second.rows.at(-1)!.values },
        ],
      };
    } finally { await reader.end(); }
    expect(await validatePostgresNativeAccess(input)).toBe(true);
    await fixture.writer.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await fixture.writer.query(`CREATE POLICY partial ON ${table} USING (id <> 1001)`);
    expect(await validatePostgresNativeAccess(input)).toBe(false);
  });

  it("checks cancellation before connecting and again after native SELECT resolves", async () => {
    const { input } = await capture();
    const error = new Error("source authority cancelled");
    const beforeConnect = vi.spyOn(pg.Client.prototype, "connect");
    await expect(validatePostgresNativeAccess({ ...input, assertCurrentSource: async () => { throw error; } })).rejects.toBe(error);
    expect(beforeConnect).not.toHaveBeenCalled();
    beforeConnect.mockRestore();

    let cancelled = false;
    const original = pg.Client.prototype.query;
    const observedQuery = vi.spyOn(pg.Client.prototype, "query").mockImplementation(new Proxy(original, {
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args);
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (typeof text === "string" && text.startsWith("SELECT r.*")) {
          return result.then((value: unknown) => { cancelled = true; return value; });
        }
        return result;
      },
    }));
    const ended = vi.spyOn(pg.Client.prototype, "end");
    try {
      await expect(validatePostgresNativeAccess({ ...input, assertCurrentSource: async () => { if (cancelled) throw error; } })).rejects.toBe(error);
      expect(ended).toHaveBeenCalledOnce();
    } finally { observedQuery.mockRestore(); ended.mockRestore(); }
  });
});
