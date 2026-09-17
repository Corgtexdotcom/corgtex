import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), manifest: vi.fn(), engine: vi.fn(), ledger: vi.fn(),
  connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.exec }));
vi.mock("pg", () => ({ default: { Client: class {
  connect = mocks.connect; query = mocks.query; end = mocks.end;
} } }));
vi.mock("./accepted-core-baseline.mjs", async (original) => ({ ...await original(),
  migrationManifest: mocks.manifest, preparedSchemaEngine: mocks.engine, verifyLedger: mocks.ledger }));
import { databaseIdentity } from "./accepted-core-baseline.mjs";
import { classifySchemaFailure, reportSchemaFailure, verifySelfserveSchema } from "./selfserve-validation-schema.mjs";
import { loadSelfserveReceipts } from "./selfserve-validation-outcome.mjs";
import { requiresProductionAppRelease } from "./production-validation-context.mjs";

it("keeps schema diagnostics and their tests runner-only", () => {
  expect(requiresProductionAppRelease([
    "scripts/selfserve-validation-schema.mjs", "scripts/selfserve-validation-schema.test.mjs",
  ])).toBe(false);
});

const sha = "a".repeat(40), secret = "postgresql://owner:DO_NOT_EMIT@private.invalid/db?token=PRIVATE";
const poison = () => Object.assign(new Error(`${secret} SELECT customer_content FROM private_table`), {
  stderr: Buffer.from(secret), stdout: secret, detail: secret, query: secret, path: secret,
});
const url = "postgresql://auditor:synthetic@localhost/corgtex?schema=public&sslmode=verify-full";
const env = { SELFSERVE_VALIDATION_EXPECTED_SHA: sha, SELFSERVE_SCHEMA_AUDITOR_URL: url,
  SELFSERVE_DATABASE_IDENTITY_SHA256: databaseIdentity(url), GITHUB_RUN_ID: "12", GITHUB_RUN_ATTEMPT: "1" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.exec.mockImplementation((file, args) => file === "git" ? (args[0] === "rev-parse" ? sha : "") : Buffer.from(""));
  mocks.manifest.mockReturnValue({ manifestSha256: "b".repeat(64), datamodelSha256: "c".repeat(64) });
  mocks.engine.mockResolvedValue("/prepared/schema-engine");
  mocks.ledger.mockReturnValue({ exactLedgerMatch: true });
  mocks.connect.mockResolvedValue(); mocks.end.mockResolvedValue();
  mocks.query.mockImplementation(async (sql) => ({ rows: sql.startsWith("SELECT current_database()")
    ? [{ database: "corgtex", schema: "public", default_read_only: "on", read_only: "on" }]
    : sql.includes("AS can_write") ? [{ can_write: false }] : [] }));
});
afterEach(() => vi.restoreAllMocks());

describe("secret-safe schema failure boundary", () => {
  it.each(["source", "configuration", "prepared-engine", "connection-tls", "read-only-context", "privilege", "ledger", "cleanup"])("bounds %s errors", (stage) => {
    expect(classifySchemaFailure(stage, poison())).toEqual({ schemaVersion: 1, status: "failed", stage, code: "UNCLASSIFIED_FAILURE" });
  });
  it.each(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "28P01", "42501"])("allows exact %s only", (code) => {
    expect(classifySchemaFailure("connection-tls", Object.assign(poison(), { code })).code).toBe(code);
    expect(classifySchemaFailure("connection-tls", Object.assign(poison(), { code: `${code}:${secret}` })).code).toBe("UNCLASSIFIED_FAILURE");
  });
  it("bounds unknown stages and message suffixes", () => {
    expect(classifySchemaFailure(secret, new Error(`SCHEMA_SOURCE_MISMATCH:${secret}`))).toMatchObject({ stage: "unknown", code: "UNCLASSIFIED_FAILURE" });
  });
  it.each(["P1000", "P1001", "P1010", "P1011", "P1012", "P4001", "P4002"])("classifies private Prisma %s without printing stderr", (code) => {
    const error = Object.assign(poison(), { status: 1, stderr: Buffer.from(`Error: ${code}\n${secret}`) });
    expect(classifySchemaFailure("introspection", error).code).toBe(code);
  });
  it("distinguishes diff exit2 from engine failure, timeout and signal", () => {
    expect(classifySchemaFailure("introspection", Object.assign(poison(), { status: 2 })).code).toBe("SCHEMA_DIFF_DETECTED");
    expect(classifySchemaFailure("introspection", Object.assign(poison(), { status: 1 })).code).toBe("ENGINE_FAILURE");
    expect(classifySchemaFailure("introspection", Object.assign(poison(), { code: "ETIMEDOUT" })).code).toBe("ETIMEDOUT");
    expect(classifySchemaFailure("introspection", Object.assign(poison(), { signal: "SIGTERM" })).code).toBe("ENGINE_INTERRUPTED");
  });
});

describe("actual verifier stage routing", () => {
  it("preserves exact error codes from the real baseline helpers", async () => {
    const real = await vi.importActual("./accepted-core-baseline.mjs");
    const directory = await mkdtemp(join(tmpdir(), "schema-helper-"));
    try {
      await mkdir(join(directory, "node_modules/@prisma/engines"), { recursive: true });
      const cases = [
        ["source", "CORE_BASELINE_SOURCE_MIGRATIONS_INVALID", () => real.migrationManifest(directory)],
        ["prepared-engine", "CORE_BASELINE_PRISMA_ENGINE_NOT_PREPARED", () => real.preparedSchemaEngine(directory)],
        ["ledger", "CORE_BASELINE_LEDGER_NOT_EXACT", () => real.verifyLedger({ migrations: [{ name: "expected", checksum: "a" }] }, [], sha)],
        ["ledger", "CORE_BASELINE_LEDGER_UNBOUNDED", () => real.verifyLedger({}, null, sha)],
        ["configuration", "CORE_BASELINE_DATABASE_URL_INVALID", () => real.databaseIdentity("https://localhost/db")],
        ["configuration", "CORE_BASELINE_DATABASE_SCHEMA_UNSUPPORTED", () => real.databaseIdentity("postgresql://localhost/db?schema=private")],
      ];
      for (const [stage, code, invoke] of cases) {
        const error = await Promise.resolve().then(invoke).catch(e => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(code);
        expect(classifySchemaFailure(stage, error)).toMatchObject({ stage, code });
        expect(classifySchemaFailure(stage, new Error(`${code}:${secret}`)).code).toBe("UNCLASSIFIED_FAILURE");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("preserves passing receipt and strict subprocess isolation", async () => {
    expect(await verifySelfserveSchema(env)).toMatchObject({ status: "passed", exactLedgerMatch: true, supportedSchemaMatch: true });
    const call = mocks.exec.mock.calls.find(([file]) => file.endsWith("/prisma"));
    expect(call[2].stdio).toBe("pipe");
    expect(call[2].env.DATABASE_URL).toContain("sslaccept=strict");
    expect(call[1].join(" ")).not.toContain("postgresql:");
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it.each([
    ["source", "SCHEMA_SOURCE_MISMATCH", () => mocks.exec.mockReturnValue("wrong")],
    ["source", "CORE_BASELINE_SOURCE_MIGRATIONS_INVALID", () => mocks.manifest.mockImplementation(() => { throw new Error("CORE_BASELINE_SOURCE_MIGRATIONS_INVALID"); })],
    ["prepared-engine", "ENOENT", () => mocks.engine.mockRejectedValue(Object.assign(poison(), { code: "ENOENT" }))],
    ["connection-tls", "ECONNREFUSED", () => mocks.connect.mockRejectedValue(Object.assign(poison(), { code: "ECONNREFUSED" }))],
    ["connection-tls", "ERR_TLS_CERT_ALTNAME_INVALID", () => mocks.connect.mockRejectedValue(Object.assign(poison(), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))],
    ["read-only-context", "SCHEMA_READ_ONLY_CONTEXT_MISMATCH", () => mocks.query.mockResolvedValue({ rows: [] })],
    ["privilege", "SCHEMA_AUDITOR_HAS_WRITE_PRIVILEGES", () => {
      const original = mocks.query.getMockImplementation();
      mocks.query.mockImplementation(sql => sql.includes("AS can_write") ? { rows: [{ can_write: true }] } : original(sql));
    }],
    ["ledger", "CORE_BASELINE_LEDGER_NOT_EXACT", () => mocks.ledger.mockImplementation(() => { throw new Error("CORE_BASELINE_LEDGER_NOT_EXACT"); })],
    ["introspection", "SCHEMA_DIFF_DETECTED", () => {
      const original = mocks.exec.getMockImplementation();
      mocks.exec.mockImplementation((file, args) => { if (file.endsWith("/prisma")) throw Object.assign(poison(), { status: 2 }); return original(file, args); });
    }],
  ])("reports %s/%s without leaking original exception", async (stage, code, setup) => {
    setup();
    const error = await verifySelfserveSchema(env).catch(e => e);
    expect(error.diagnostic).toMatchObject({ stage, code });
    expect(JSON.stringify(error)).not.toContain("DO_NOT_EMIT");
    expect(String(error)).not.toContain("private_table");
  });
  it("preserves original connection failure if cleanup also fails", async () => {
    mocks.connect.mockRejectedValue(Object.assign(poison(), { code: "28P01" }));
    mocks.end.mockRejectedValue(poison());
    await expect(verifySelfserveSchema(env)).rejects.toMatchObject({ diagnostic: { stage: "connection-tls", code: "28P01" } });
  });
  it("rejects configuration before creating a database connection", async () => {
    await expect(verifySelfserveSchema({ ...env, DATABASE_URL: secret })).rejects.toMatchObject({ diagnostic: { stage: "configuration", code: "SCHEMA_WRITER_ENV_FORBIDDEN" } });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("keeps ledger permission errors distinct from ledger mismatch", async () => {
    const original = mocks.query.getMockImplementation();
    mocks.query.mockImplementation(sql => {
      if (sql.startsWith("SELECT migration_name")) throw Object.assign(poison(), { code: "42501" });
      return original(sql);
    });
    await expect(verifySelfserveSchema(env)).rejects.toMatchObject({ diagnostic: { stage: "ledger", code: "42501" } });
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it("writes only sanitized failure artifact, never acceptance evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schema-diagnostic-"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.engine.mockRejectedValue(poison());
      const error = await verifySelfserveSchema(env).catch(e => e);
      await reportSchemaFailure(error, directory);
      expect(await readdir(directory)).toEqual(["schema.failure.json"]);
      const diagnostic = JSON.parse(await readFile(join(directory, "schema.failure.json"), "utf8"));
      expect(diagnostic).toEqual({ schemaVersion: 1, status: "failed", stage: "prepared-engine", code: "UNCLASSIFIED_FAILURE" });
      expect(log).toHaveBeenCalledWith(JSON.stringify(diagnostic));
      expect(await loadSelfserveReceipts(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("the real CLI exits nonzero and persists a bounded diagnostic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schema-cli-"));
    const { spawnSync } = await vi.importActual("node:child_process");
    try {
      const result = spawnSync(process.execPath, ["scripts/selfserve-validation-schema.mjs"], {
        cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH,
          SELFSERVE_VALIDATION_EXPECTED_SHA: secret, SELFSERVE_VALIDATION_OUT_DIR: directory }, timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      const diagnostic = { schemaVersion: 1, status: "failed", stage: "source", code: "VALIDATION_SHA_REQUIRED" };
      expect(JSON.parse(result.stderr.trim())).toEqual(diagnostic);
      expect(JSON.parse(await readFile(join(directory, "schema.failure.json"), "utf8"))).toEqual(diagnostic);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("does not leak file-system errors when diagnostic persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schema-write-"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await reportSchemaFailure(poison(), join(directory, "missing", "..", "..", "\0"));
      expect(log.mock.calls.map(([value]) => JSON.parse(value))).toEqual([
        { schemaVersion: 1, status: "failed", stage: "unknown", code: "UNCLASSIFIED_FAILURE" },
        { schemaVersion: 1, status: "failed", stage: "receipt", code: "DIAGNOSTIC_WRITE_FAILED" },
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
