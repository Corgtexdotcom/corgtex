import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCanonical, hashFrames } from "./shared-tenant-export.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repository, "scripts/migration/shared-tenant-transfer.ts");
const binding = { host: "synthetic.invalid", port: 5432, database: "synthetic", user: "synthetic" };
const secret = "PRIVATE_SENTINEL_password_customer_email_SQL";

// Run the real CLI entry point, replacing only transport. No inherited credentials
// enter a child, and every attempted socket connection fails before network I/O.
const preload = `
const fs = require("node:fs");
const Module = require("node:module");
const record = (operation) => fs.appendFileSync(process.env.CLI_TEST_TRACE, operation + "\\n", { mode: 0o600 });
if (process.env.CLI_TEST_MODE === "copy") {
  const originalSpawn = require("node:child_process").spawn;
  require("node:child_process").spawn = (program, args, options) => {
    if (program !== "docker") return originalSpawn(program, args, options);
    record("spawn:" + JSON.stringify({program,args}));
    const child = new (require("node:events").EventEmitter)();
    child.stdout = new (require("node:stream").PassThrough)();
    child.stderr = new (require("node:stream").PassThrough)();
    child.kill = () => {};
    process.nextTick(() => {
      const value = args[0] === "run" || (args[0] === "ps" && process.env.CLI_TEST_CLEANUP_FAILURE) ? "a".repeat(64) : args[0] === "port" ? "127.0.0.1:54321" : args[0] === "inspect" ? "sha256:" + "b".repeat(64) : "";
      const failed = args.includes("pg_restore") || (process.env.CLI_TEST_CLEANUP_FAILURE && ["stop", "rm"].includes(args[0]));
      child.stdout.end(value);
      child.stderr.end(failed ? process.env.CLI_TEST_SECRET : "");
      child.emit("close", failed ? 1 : 0);
    });
    return child;
  };
  require("node:module").syncBuiltinESMExports();
}
require("node:net").Socket.prototype.connect = function () {
  const options = Array.isArray(arguments[0]) ? arguments[0][0] : arguments[0];
  // tsx probes its own absent IPC pipe; block it without treating it as provider traffic.
  if (!(options?.path?.startsWith(process.env.TMPDIR + "/tsx-") && options.path.endsWith(".pipe"))) record("network");
  throw new Error(process.env.CLI_TEST_SECRET);
};
const originalLoad = Module._load;
Module._load = function (id, ...rest) {
  if (id === "pg") return { Client: class {
    constructor(config) {
      record("construct"); this.config = config;
      if (process.env.CLI_TEST_EXPECT_PORT) {
        record("port:" + config.port);
        if (config.connectionString || config.port !== Number(process.env.CLI_TEST_EXPECT_PORT)) throw new Error(process.env.CLI_TEST_SECRET);
      }
    }
    async connect() {
      record("connect");
      if (process.env.CLI_TEST_FAILURE === "connect") throw new Error(process.env.CLI_TEST_SECRET);
    }
    async query(sql) {
      record("query");
      if (process.env.CLI_TEST_MODE === "prepared") {
        const snapshot = JSON.parse(process.env.CLI_TEST_PUBLICATION);
        if (sql.includes('SELECT enabled, config')) return {rows:[{enabled:true,config:{transferReceipt:{sourceSnapshotSha256:snapshot.sha256,workspaceId:snapshot.manifest.workspaceId,
          tables:snapshot.tables.map(table=>({name:table.name,count:table.rows.length,sha256:table.sha256,primaryKeys:table.rows.map(row=>table.primaryKey.map(name=>row[table.columns.findIndex(column=>column.name===name)]))}))}}}]};
        if (sql.startsWith("SELECT json_build_array")) {
          const table = snapshot.tables.find(table=>sql.includes('FROM public."'+table.name+'"'));
          return {rows:table.rows.map(row=>({row:JSON.stringify(row)}))};
        }
      }
      if (process.env.CLI_TEST_FAILURE === "query") throw new Error("SELECT private_content: " + process.env.CLI_TEST_SECRET);
      if (sql.includes("current_user AS user")) return { rows: [{ database: "wrong-database", user: "wrong-user" }] };
      if (sql.includes("pg_current_snapshot()")) return { rows: [{ database: "synthetic", version: "16", readOnly: "on", snapshot: "1:1:" }] };
      return { rows: [] };
    }
    async end() { record("end"); }
  } };
  return originalLoad.call(this, id, ...rest);
};
`;

function publicationFixture() {
  const specifications = [
    ["Workspace", ["id"], [["ws"]], []],
    ["WorkflowJob", ["id", "workspaceId", "status", "payload"], [["pending", "ws", "PENDING", secret]], []],
    ["WorkspaceBriefing", ["id", "workflowJobId"], [["briefing", "pending"]], [{ columns: ["workflowJobId"], referencedTable: "WorkflowJob", referencedColumns: ["id"] }]],
  ];
  const tables = specifications.map(([name, columns, rows, foreignKeys]) => ({ name, columns: columns.map(name => ({ name, type: "text", nullable: name === "workflowJobId" })), primaryKey: ["id"], foreignKeys, rows, sha256: hashFrames(rows) }));
  const manifest = { formatVersion: 1, transferId: "synthetic", workspaceId: "ws", workspaceSlug: "ws", schemaSha256: "a".repeat(64), tables: Object.fromEntries(tables.map(table => [table.name, { disposition: "copy", reason: "Synthetic explicit test" }])) };
  const body = { formatVersion: 1, manifest, manifestSha256: hashCanonical(manifest), sourceSnapshot: "1:1:", sourceDatabase: "synthetic", schemaSha256: manifest.schemaSha256, tables,
    dispositions: tables.map(table => ({ table: table.name, sourceRows: String(table.rows.length), selectedRows: String(table.rows.length), disposition: "copy", reason: "Synthetic explicit test" })) };
  return { ...body, sha256: hashCanonical(body) };
}

describe("tenant transfer CLI safety boundaries", () => {
  let directory;
  let output;
  let trace;
  let hook;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "corgtex-transfer-cli-"));
    chmodSync(directory, 0o700);
    output = join(directory, "output.json");
    trace = join(directory, "trace.txt");
    hook = join(directory, "transport.cjs");
    writeFileSync(hook, preload, { mode: 0o600 });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function input(name, value, mode = 0o600) {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value), { mode });
    chmodSync(path, mode);
    return path;
  }

  function run(argv, env = {}) {
    const result = spawnSync(process.execPath, ["--require", hook, "--import", "tsx", cli, ...argv], {
      cwd: repository,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        TMPDIR: directory,
        NO_COLOR: "1",
        CLI_TEST_TRACE: trace,
        CLI_TEST_SECRET: secret,
        TRANSFER_SOURCE_DATABASE_URL: "postgresql://synthetic:synthetic@synthetic.invalid:5432/synthetic",
        TRANSFER_TARGET_DATABASE_URL: "postgresql://synthetic:synthetic@synthetic.invalid:5432/synthetic",
        ...env,
      },
    });
    expect(result.error).toBeUndefined();
    const operations = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [];
    expect(operations).not.toContain("network");
    return { ...result, operations };
  }

  function failed(result, code, beforeConnection = true) {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toEqual({ status: "FAILED", code });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    if (beforeConnection) expect(result.operations).toEqual([]);
    expect(existsSync(output)).toBe(false);
  }

  function importArgs(options = { targetBinding: binding }) {
    return ["import", "--execute", "--snapshot", input("snapshot.json", {}),
      "--options", input("options.json", options), "--receipt", input("receipt.json", {}), "--output", output];
  }

  it.each(["import", "copy-objects"])("requires explicit execution for %s before inputs or network", (command) => {
    failed(run([command, "--output", output]), "TRANSFER_EXECUTE_REQUIRED");
  });

  it("rejects unknown arguments before any connection", () => {
    failed(run(["inventory", "--output", output, "--unknown", "value"]), "TRANSFER_ARGUMENT_UNKNOWN");
  });

  it("rejects unknown commands before any connection", () => {
    failed(run(["activate", "--output", output]), "TRANSFER_COMMAND_INVALID");
  });

  it("prepares a private wrapper that verify-inactive accepts directly without exposing staged payloads", () => {
    const snapshot = input("source.json", publicationFixture());
    const policy = input("policy.json", { stagedRows: [{ table: "WorkflowJob", primaryKeys: [["pending"]], reason: "Keep source work privately staged" }],
      detachReferences: [{ table: "WorkspaceBriefing", column: "workflowJobId", primaryKeys: [["briefing"]], reason: "Preserve historical reference privately" }] });
    const result = run(["prepare-publication", "--snapshot", snapshot, "--options", policy, "--output", output]);
    expect(result.status).toBe(0); expect(result.operations).toEqual([]);
    expect(result.stdout).not.toContain(secret);
    const prepared = JSON.parse(readFileSync(output, "utf8"));
    expect(prepared.staging.rows[0].rows[0]).toContain(secret);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const verification = join(directory, "verified.json");
    const verified = run(["verify-inactive", "--snapshot", output, "--output", verification], { CLI_TEST_MODE: "prepared", CLI_TEST_PUBLICATION: JSON.stringify(prepared.publicationSnapshot) });
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "INACTIVE_IMPORT_VERIFIED" });
    expect(verified.stdout).not.toContain(secret);
    expect(statSync(verification).mode & 0o777).toBe(0o600);
  });

  it("rejects a tampered prepared wrapper before target connection", () => {
    const wrapped = input("prepared.json", { publicationSnapshot: publicationFixture(), staging: { sha256: "a".repeat(64) }, sha256: "b".repeat(64) });
    const argv = importArgs(); argv[3] = wrapped;
    failed(run(argv), "TRANSFER_PREPARED_ARTIFACT_DIGEST_MISMATCH");
  });

  it("displays publication failure codes while omitting the identifying table suffix", () => {
    const snapshot = input("source.json", publicationFixture());
    const policy = input("policy.json", { stagedRows: [{ table: "WorkflowJob", primaryKeys: [["pending"]], reason: "Private staging" }], detachReferences: [] });
    const result = run(["prepare-publication", "--snapshot", snapshot, "--options", policy, "--output", output]);
    failed(result, "PUBLICATION_STAGED_REFERENCE_REMAINS");
    expect(result.stderr).not.toContain("WorkspaceBriefing");
  });

  it.each(["15", "19", "16.5"])("rejects unsupported Postgres major %s before copy work", (major) => {
    failed(run(["convert-copy", "--postgres-major", major, "--output", output]), "TRANSFER_COPY_POSTGRES_MAJOR_INVALID");
  });

  it("does not silently apply conversion options to source capture", () => {
    failed(run(["capture-copy", "--postgres-major", "18", "--output", output]), "TRANSFER_ARGUMENT_NOT_APPLICABLE");
  });

  it("rejects repository diagnostics and colliding diagnostic/output files", () => {
    failed(run(["convert-copy", "--diagnostics", join(repository, "private.log"), "--output", output]), "TRANSFER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY");
    const archive = input("archive.dump", {});
    failed(run(["convert-copy", "--archive", archive, "--diagnostics", output, "--output", output]), "TRANSFER_DISTINCT_OUTPUTS_REQUIRED");
  });

  it.each(["convert-copy", "export-copy"])("passes native major and private diagnostics through %s and reports restore failure safely", (command) => {
    const archive = input("archive.dump", {}); const diagnostics = join(directory, "copy.log");
    const manifest = input("manifest.json", {});
    const argv = [command, "--postgres-major", "18", "--archive", archive, "--archive-sha256", hashCanonical({}),
      "--max-bytes", "10000", "--timeout-ms", "10000", "--diagnostics", diagnostics, "--output", output];
    // input() emits compact JSON; its byte digest equals canonical empty JSON.
    if (command === "convert-copy") argv.push("--archive-output", join(directory, "converted.dump"));
    else argv.push("--manifest", manifest, "--max-rows", "100");
    const result = run(argv, { CLI_TEST_MODE: "copy" });
    failed(result, "TRANSFER_COPY_RESTORE_FAILED", false);
    expect(result.operations.some(operation => operation.startsWith("spawn:") && operation.includes("pgvector/pgvector:pg18"))).toBe(true);
    expect(statSync(diagnostics).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostics, "utf8")).toContain(secret);
  });

  it("reports only exact owned cleanup remediation and preserves the safe primary code", () => {
    const archive = input("archive.dump", {});
    const result = run(["convert-copy", "--archive", archive, "--archive-sha256", hashCanonical({}),
      "--max-bytes", "10000", "--timeout-ms", "10000", "--output", output,
      "--archive-output", join(directory, "converted.dump")], { CLI_TEST_MODE: "copy", CLI_TEST_CLEANUP_FAILURE: "1" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ status: "FAILED", code: "TRANSFER_ISOLATED_CLEANUP_FAILED",
      containerId: "a".repeat(64), primaryCode: "TRANSFER_COPY_RESTORE_FAILED", cleanupCommand: `docker rm --force ${"a".repeat(64)}` });
    expect(result.stderr).not.toContain(secret);
    expect(result.operations.some(operation => operation.includes('"rm","--force"'))).toBe(true);
    expect(result.operations).not.toContain("network");
  });

  it("requires an absolute output path", () => {
    failed(run(["inventory", "--output", "relative.json"]), "TRANSFER_ABSOLUTE_PRIVATE_PATH_REQUIRED");
  });

  it("rejects repository output including an external symlink into the repository", () => {
    const alias = join(directory, "repository-link");
    symlinkSync(repository, alias, "dir");
    const name = `.transfer-test-${randomUUID()}.json`;
    for (const base of [repository, alias]) {
      failed(run(["inventory", "--output", join(base, name)]), "TRANSFER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY");
    }
    expect(existsSync(join(repository, name))).toBe(false);
  });

  it("rejects a repository input before target connection", () => {
    const argv = importArgs();
    argv[3] = join(repository, "package.json");
    failed(run(argv), "TRANSFER_ARTIFACT_MUST_BE_OUTSIDE_REPOSITORY");
  });

  it.each(["snapshot.json", "options.json", "receipt.json"])("rejects group-readable %s before target connection", (name) => {
    const argv = importArgs();
    chmodSync(join(directory, name), 0o640);
    failed(run(argv), "TRANSFER_INPUT_MUST_BE_PRIVATE_FILE");
  });

  it.each([
    { host: "another.invalid" }, { port: 6543 }, { database: "another" }, { user: "another" },
  ])("requires exact target database binding before connection: %j", (mismatch) => {
    failed(run(importArgs({ targetBinding: { ...binding, ...mismatch } })), "TRANSFER_EXACT_TARGET_BINDING_REQUIRED");
  });

  it.each(["host=other.invalid", "port=6543", "user=other", "password=other", "database=other", "hostaddr=127.0.0.1", "options=-c%20role%3Dother"])("rejects connection query override %s before client construction", (query) => {
    failed(run(importArgs(), { TRANSFER_TARGET_DATABASE_URL: `postgresql://synthetic:synthetic@synthetic.invalid:5432/synthetic?${query}` }), "TRANSFER_DATABASE_QUERY_OVERRIDE_FORBIDDEN");
  });

  it("rejects duplicate connection parameters before client construction", () => {
    failed(run(importArgs(), { TRANSFER_TARGET_DATABASE_URL: "postgresql://synthetic:synthetic@synthetic.invalid:5432/synthetic?sslmode=verify-full&sslmode=disable" }), "TRANSFER_DATABASE_QUERY_PARAMETER_DUPLICATED");
  });

  it.each(["sslmode=verify-full", "ssl=true&schema=public"])("preserves supported SSL URL settings: %s", (query) => {
    const result = run(importArgs(), { TRANSFER_TARGET_DATABASE_URL: `postgresql://synthetic:synthetic@synthetic.invalid:5432/synthetic?${query}` });
    failed(result, "TRANSFER_TARGET_DATABASE_IDENTITY_MISMATCH", false);
    expect(result.operations).toEqual(["construct", "connect", "query", "end"]);
  });

  it("pins the validated default port instead of using ambient PGPORT", () => {
    const result = run(importArgs(), { TRANSFER_TARGET_DATABASE_URL: "postgresql://synthetic:synthetic@synthetic.invalid/synthetic?sslmode=verify-full",
      PGPORT: "6543", CLI_TEST_EXPECT_PORT: "5432" });
    failed(result, "TRANSFER_TARGET_DATABASE_IDENTITY_MISMATCH", false);
    expect(result.operations).toEqual(["construct", "port:5432", "connect", "query", "end"]);
  });

  it("rejects port zero rather than allowing the driver to fall back to PGPORT", () => {
    failed(run(importArgs({ targetBinding: { ...binding, port: 0 } }), {
      TRANSFER_TARGET_DATABASE_URL: "postgresql://synthetic:synthetic@synthetic.invalid:0/synthetic", PGPORT: "6543",
    }), "TRANSFER_DATABASE_PORT_INVALID");
  });

  it("requires an explicit target database binding", () => {
    failed(run(importArgs({})), "TRANSFER_EXACT_TARGET_BINDING_REQUIRED");
  });

  it("refuses encryption keys in artifacts before target connection", () => {
    failed(run(importArgs({ targetBinding: binding, sourceEncryptionKey: secret })), "TRANSFER_KEYS_MUST_USE_ENVIRONMENT");
  });

  it("verifies connected database identity before import statements", () => {
    const result = run(importArgs());
    failed(result, "TRANSFER_TARGET_DATABASE_IDENTITY_MISMATCH", false);
    expect(result.operations).toEqual(["construct", "connect", "query", "end"]);
  });

  it("writes a private immutable artifact outside the repository", () => {
    const result = run(["inventory", "--output", output]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "INVENTORIED", tables: 0, workspaces: 0 });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const original = readFileSync(output, "utf8");
    expect(JSON.parse(original)).toMatchObject({ formatVersion: 1, identity: { readOnly: "on" } });
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    rmSync(trace);
    const repeat = run(["inventory", "--output", output]);
    expect(repeat.status).toBe(1);
    expect(JSON.parse(repeat.stderr)).toEqual({ status: "FAILED", code: "TRANSFER_OUTPUT_ALREADY_EXISTS" });
    expect(repeat.operations).toEqual([]);
    expect(readFileSync(output, "utf8")).toBe(original);
  });

  it.each(["connect", "query"])("sanitizes %s errors from the external database", (failure) => {
    const result = run(["inventory", "--output", output], { CLI_TEST_FAILURE: failure });
    failed(result, "TRANSFER_FAILED", false);
    expect(result.operations).toContain(failure);
    expect(result.stderr).not.toContain("SELECT private_content");
  });

  it("sanitizes malformed private JSON errors", () => {
    const argv = importArgs();
    writeFileSync(join(directory, "snapshot.json"), `{"private": ${secret}}`);
    failed(run(argv), "TRANSFER_FAILED");
  });

  it("sanitizes storage provider connection parsing errors", () => {
    const manifest = input("objects.json", { manifest: {},
      source: { account: "synthetic", container: "private" }, target: { account: "synthetic", container: "private" } });
    failed(run(["copy-objects", "--execute", "--manifest", manifest, "--output", output], {
      TRANSFER_SOURCE_STORAGE_CONNECTION_STRING: `AccountName=synthetic;AccountKey=${secret};BlobEndpoint=invalid-${secret}`,
    }), "TRANSFER_FAILED");
  });
});
