#!/usr/bin/env node

import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

export const POSTGRES_CLIENT_IMAGE = "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SOURCE_TLS_ROOT_CERT_BYTES = 16 * 1024;
const MAX_TARGET_TLS_ROOT_CERT_BYTES = 32 * 1024;
const MAX_RESTORE_DIAGNOSTIC_LINE_BYTES = 4 * 1024;
const MAX_RESTORE_STATUS_LINE_BYTES = 128;
const MAX_COMMAND_STDERR_BYTES = 1024 * 1024;
const MAX_SCHEMA_DIAGNOSTIC_COUNT = 1_000_000;
const MAX_CONSTRAINT_CATALOG_ROWS = 100_000;
const MAX_CHECK_EDIT_TOKENS = 1024;
const MAX_CONSTRAINT_TEXT_BYTES = 65_536;
const MAX_CHECK_TREE_BYTES = 262_144;
const MAX_CHECK_DEPENDENCIES = 256;
const MAX_CHECK_DEPENDENCY_FIELD_BYTES = 4096;
const MAX_CHECK_DEPENDENCY_TOTAL_BYTES = 65_536;
const MAX_CHECK_NODE_TAGS = 4096;
const FETCH_ROWS = 500;
const LARGE_OBJECT_CHUNK_BYTES = 1024 * 1024;
const MAX_LARGE_OBJECT_BYTES = 4n * 1024n * 1024n * 1024n * 1024n;
const MAX_POSTGRES_OID = 4_294_967_295n;
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const REQUIRED_DOMAINS = new Set(["core", "ops"]);
const TARGET_TLS_ROOT_CERT_PATH = fileURLToPath(new URL(
  "../../infra/azure/migration-foundation/azure-postgres-root-ca.pem",
  import.meta.url,
));
const TARGET_TLS_ROOT_CERT_SHA256 = "00aa10fc3c32eb0d024cd4262dac3d4466dd44aed87fa24d9f2d3fb49977601c";
const TARGET_TLS_ROOT_CERT_FINGERPRINTS = new Set([
  "CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F",
  "C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0",
]);
const TARGET_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;
const TARGET_CONNECTION_RETRY_DELAY_MS = 10 * 1000;
export const SCHEMA_TOKEN_ALGORITHM = "PG_DUMP_SQL_TOKENS_V1";
export const SCHEMA_RESTRICT_KEY = "CorgtexSchemaParityV1";
const SCHEMA_STATEMENT_CLASSES = [
  "EXTENSION",
  "TYPE",
  "FUNCTION",
  "TABLE",
  "CONSTRAINT",
  "INDEX",
  "TRIGGER",
  "POLICY",
  "VIEW",
  "COMMENT",
  "OTHER",
];
const SCHEMA_TOKEN_DOMAINS = ["DDL_TOKEN", "STRING_LITERAL", "DOLLAR_BODY", "META_COMMAND"];
const CONSTRAINT_TYPES = new Map([
  ["c", "CHECK"],
  ["f", "FOREIGN_KEY"],
  ["n", "NOT_NULL"],
  ["p", "PRIMARY_KEY"],
  ["t", "CONSTRAINT_TRIGGER"],
  ["u", "UNIQUE"],
  ["x", "EXCLUSION"],
]);
const CONSTRAINT_MISMATCH_FIELDS = [
  "IDENTITY_SET",
  "TYPE",
  "VALIDATION",
  "ENFORCEMENT",
  "INHERITANCE",
  "DEFERRABILITY",
  "PERIOD",
  "FK_ACTION",
  "PARENTAGE",
  "BINDING",
  "DEFINITION",
  "CHECK_EXPRESSION",
  "EXTENSION_OWNERSHIP",
];
const CHECK_EDIT_CATEGORIES = [
  "CAST_OPERATOR",
  "BUILTIN_TYPE",
  "PARENTHESIS",
  "COLLATION",
  "OPERATOR",
  "FUNCTION",
  "COLUMN_REFERENCE",
  "STRING_LITERAL",
  "OTHER",
];
const CHECK_NODE_TAGS = [
  "ARRAYCOERCEEXPR",
  "ARRAYEXPR",
  "BOOLEXPR",
  "BOOLEANTEST",
  "CASEEXPR",
  "CASETESTEXPR",
  "CASEWHEN",
  "COALESCEEXPR",
  "COERCETODOMAIN",
  "COERCETODOMAINVALUE",
  "COERCEVIAIO",
  "COLLATEEXPR",
  "CONST",
  "CONVERTROWTYPEEXPR",
  "DISTINCTEXPR",
  "FIELDSELECT",
  "FUNCEXPR",
  "MINMAXEXPR",
  "NAMEDARGEXPR",
  "NEXTVALUEEXPR",
  "NULLIFEXPR",
  "NULLTEST",
  "OPEXPR",
  "PARAM",
  "RELABELTYPE",
  "ROWCOMPAREEXPR",
  "ROWEXPR",
  "SCALARARRAYOPEXPR",
  "SETTODEFAULT",
  "SQLVALUEFUNCTION",
  "VAR",
  "XMLEXPR",
  "OTHER",
];
const CHECK_DEPENDENCY_CLASSES = [
  "COLLATION",
  "FUNCTION",
  "OPERATOR",
  "RELATION",
  "TYPE",
  "OTHER",
];
const BUILTIN_TYPE_NAMES = new Set([
  "bigint", "bigserial", "bit", "boolean", "bpchar", "bytea", "char", "character",
  "date", "decimal", "double", "float4", "float8", "inet", "int", "int2", "int4",
  "int8", "integer", "interval", "json", "jsonb", "money", "name", "numeric", "oid",
  "real", "record", "regclass", "regproc", "serial", "smallint", "smallserial", "text",
  "time", "timestamp", "timestamptz", "timetz", "uuid", "varchar",
]);
const CHECK_OPERATOR_WORDS = new Set([
  "all", "and", "any", "between", "false", "ilike", "in", "is", "like", "not",
  "null", "operator", "or", "similar", "true",
]);
const LOCALE_PROVIDERS = new Map([
  ["b", "builtin"],
  ["c", "libc"],
  ["i", "icu"],
]);
const LOCALE_DEFINITION_FIELDS = ["encoding", "collation", "ctype", "provider", "providerLocale", "icuRules"];
class RehearsalError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => { throw new RehearsalError(code); };
const isRehearsalError = (error) => error instanceof RehearsalError;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const opaqueRef = (value) => `sha256:${sha256(value).slice(0, 16)}`;
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

const assertNoControlCharacters = (value, code) => {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
};

const nullableText = (value, code) => value === null ? null : assertNoControlCharacters(value, code);

const assertSafePath = (path, root, code) => {
  const resolvedPath = resolve(path);
  const resolvedRoot = `${resolve(root)}/`;
  if (!resolvedPath.startsWith(resolvedRoot) || resolvedPath === resolve(root)) fail(code);
  return resolvedPath;
};

const readBoundedJson = (filePath) => {
  let descriptor = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_STATE_BYTES) fail("INVALID_STATE_FILE");
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) fail("TRUNCATED_STATE_FILE");
      offset += count;
    }
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (error?.code) throw error;
    fail("INVALID_STATE_FILE");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

const writePrivateJson = (filePath, value) => {
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
};

const secureDelete = async (filePath) => {
  if (!existsSync(filePath)) return true;
  try {
    await spawnFixed("shred", ["-u", "--", filePath], { code: "CREDENTIAL_SHRED_FAILED" });
    return !existsSync(filePath);
  } catch {
    try {
      const size = statSync(filePath).size;
      writeFileSync(filePath, Buffer.alloc(size), { mode: 0o600 });
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
};

const categoryFromSqlstate = (sqlstate) => {
  if (sqlstate === "42501") return "INSUFFICIENT_PRIVILEGE";
  if (["42710", "42723", "42P06", "42P07"].includes(sqlstate)) return "DUPLICATE_OBJECT";
  if (["3F000", "42704", "42P01"].includes(sqlstate)) return "MISSING_DEPENDENCY";
  if (sqlstate?.startsWith("23")) return "DATA_CONSTRAINT";
  if (sqlstate?.startsWith("53")) return "RESOURCE_EXHAUSTED";
  if (sqlstate?.startsWith("08")) return "CONNECTION";
  if (sqlstate?.startsWith("28")) return "AUTHENTICATION";
  if (sqlstate?.startsWith("0A")) return "UNSUPPORTED_FEATURE";
  if (sqlstate?.startsWith("42")) return "SYNTAX_OR_ACCESS_RULE";
  if (sqlstate?.startsWith("XX")) return "INTERNAL_ERROR";
  return "UNKNOWN";
};

export const createSqlstateClassifier = () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let partial = "";
  let discardingLine = false;
  let invalid = false;
  let truncated = false;
  let observed = false;
  let sqlstate = null;

  const processLine = (rawLine) => {
    observed = true;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = line.match(/^(?:ERROR|FATAL|PANIC):\s+([0-9A-Z]{5})\s*$/u);
    if (sqlstate === null && match !== null) sqlstate = match[1];
  };

  const consumeText = (text, final = false) => {
    let remaining = text;
    while (remaining.length > 0) {
      if (discardingLine) {
        const newline = remaining.indexOf("\n");
        if (newline === -1) return;
        remaining = remaining.slice(newline + 1);
        discardingLine = false;
        continue;
      }
      const newline = remaining.indexOf("\n");
      const segment = newline === -1 ? remaining : remaining.slice(0, newline);
      if (Buffer.byteLength(partial) + Buffer.byteLength(segment) > MAX_RESTORE_DIAGNOSTIC_LINE_BYTES) {
        partial = "";
        truncated = true;
        if (newline === -1) {
          discardingLine = true;
          return;
        }
      } else {
        partial += segment;
        if (newline === -1) return;
        processLine(partial);
        partial = "";
      }
      remaining = remaining.slice(newline + 1);
    }
    if (final && partial) {
      processLine(partial);
      partial = "";
    }
  };

  return {
    consume(chunk) {
      if (!Buffer.isBuffer(chunk)) {
        truncated = true;
        invalid = true;
        return;
      }
      if (invalid) return;
      try {
        consumeText(decoder.decode(chunk, { stream: true }));
      } catch {
        partial = "";
        truncated = true;
        invalid = true;
      }
    },
    finish() {
      if (!invalid) {
        try {
          consumeText(decoder.decode(), true);
        } catch {
          truncated = true;
          invalid = true;
        }
      }
      partial = "";
      return { sqlstate, observed, truncated };
    },
    discard() {
      if (!invalid) {
        try { decoder.decode(); } catch { /* Discarded success-path diagnostics never broaden output. */ }
      }
      partial = "";
      discardingLine = false;
    },
  };
};

export const createRestoreStatusClassifier = () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let partial = "";
  let discardingLine = false;
  let invalid = false;
  let truncated = false;
  let statuses = null;

  const processLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = line.match(/^CORGTEX_RESTORE_STATUS:([0-9]{1,3}):([0-9]{1,3})$/u);
    if (statuses === null && match !== null) {
      statuses = { producer: Number(match[1]), consumer: Number(match[2]) };
    }
  };

  const consumeText = (text, final = false) => {
    let remaining = text;
    while (remaining.length > 0) {
      if (discardingLine) {
        const newline = remaining.indexOf("\n");
        if (newline === -1) return;
        remaining = remaining.slice(newline + 1);
        discardingLine = false;
        continue;
      }
      const newline = remaining.indexOf("\n");
      const segment = newline === -1 ? remaining : remaining.slice(0, newline);
      if (Buffer.byteLength(partial) + Buffer.byteLength(segment) > MAX_RESTORE_STATUS_LINE_BYTES) {
        partial = "";
        truncated = true;
        if (newline === -1) {
          discardingLine = true;
          return;
        }
      } else {
        partial += segment;
        if (newline === -1) return;
        processLine(partial);
        partial = "";
      }
      remaining = remaining.slice(newline + 1);
    }
    if (final && partial) {
      processLine(partial);
      partial = "";
    }
  };

  return {
    consume(chunk) {
      if (!Buffer.isBuffer(chunk)) {
        truncated = true;
        invalid = true;
        return;
      }
      if (invalid) return;
      try {
        consumeText(decoder.decode(chunk, { stream: true }));
      } catch {
        partial = "";
        truncated = true;
        invalid = true;
      }
    },
    finish() {
      if (!invalid) {
        try {
          consumeText(decoder.decode(), true);
        } catch {
          truncated = true;
          invalid = true;
        }
      }
      partial = "";
      return { statuses, truncated };
    },
    discard() {
      if (!invalid) {
        try { decoder.decode(); } catch { /* Discarded success-path diagnostics never broaden output. */ }
      }
      partial = "";
      discardingLine = false;
    },
  };
};

const restoreProcessClass = ({ statuses, status, spawnError, signal }) => {
  if (spawnError || signal !== null || statuses === null) return "PROCESS_ERROR";
  if (statuses.producer !== 0 && !(statuses.producer === 141 && statuses.consumer !== 0)) {
    return "ARCHIVE_RENDER_FAILED";
  }
  if (statuses.consumer === 3) return "SCRIPT_ERROR";
  if (statuses.consumer === 2) return "CONNECTION_ERROR";
  if (statuses.consumer !== 0) return "PROCESS_ERROR";
  return statuses.producer === 0 && status === 0 ? "OK" : "PROCESS_ERROR";
};

const restoreDiagnosticFromResults = ({
  section,
  sqlstateResult,
  statusResult,
  status = 1,
  spawnError = false,
  signal = null,
}) => {
  const sectionName = new Map([
    ["pre-data", "PRE_DATA"],
    ["data", "DATA"],
    ["post-data", "POST_DATA"],
  ]).get(section);
  if (sectionName === undefined) fail("INVALID_RESTORE_SECTION");
  const processClass = restoreProcessClass({
    statuses: statusResult.truncated ? null : statusResult.statuses,
    status,
    spawnError,
    signal,
  });
  const sqlstate = processClass === "SCRIPT_ERROR" && !sqlstateResult.truncated
    ? sqlstateResult.sqlstate
    : null;
  return {
    phase: "DESTINATION_RESTORE",
    section: sectionName,
    processClass,
    category: categoryFromSqlstate(sqlstate),
    sqlstate,
    stderrObserved: sqlstateResult.observed,
    stderrTruncated: sqlstateResult.truncated,
  };
};

export const buildRestoreDiagnostic = ({
  section,
  stderrChunks,
  statusChunks,
  status = 1,
  spawnError = false,
  signal = null,
}) => {
  const sqlstateClassifier = createSqlstateClassifier();
  const statusClassifier = createRestoreStatusClassifier();
  for (const chunk of stderrChunks) sqlstateClassifier.consume(chunk);
  for (const chunk of statusChunks) statusClassifier.consume(chunk);
  return restoreDiagnosticFromResults({
    section,
    sqlstateResult: sqlstateClassifier.finish(),
    statusResult: statusClassifier.finish(),
    status,
    spawnError,
    signal,
  });
};

const spawnFixed = (command, args, options = {}) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", options.stdoutClassifier === undefined ? "ignore" : "pipe", "pipe"],
  });
  let stderrBytes = 0;
  let settled = false;
  child.stdout?.on("data", (chunk) => options.stdoutClassifier.consume(chunk));
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    options.stderrClassifier?.consume(chunk);
    if (options.stderrClassifier === undefined && stderrBytes > MAX_COMMAND_STDERR_BYTES) child.kill("SIGKILL");
  });
  child.on("error", () => {
    if (settled) return;
    settled = true;
    try {
      options.onFailure?.({
        stderr: options.stderrClassifier?.finish() ?? null,
        stdout: options.stdoutClassifier?.finish() ?? null,
        status: null,
        signal: null,
        spawnError: true,
      });
    } catch {
      // Preserve the fixed public command failure; diagnostics are best-effort and never broaden output.
    }
    rejectPromise(new RehearsalError(options.code ?? "COMMAND_FAILED"));
  });
  child.on("close", (status, signal) => {
    if (settled) return;
    settled = true;
    if (status === 0 && signal === null) {
      options.stderrClassifier?.discard();
      options.stdoutClassifier?.discard();
      resolvePromise();
      return;
    }
    try {
      options.onFailure?.({
        stderr: options.stderrClassifier?.finish() ?? null,
        stdout: options.stdoutClassifier?.finish() ?? null,
        status,
        signal,
        spawnError: false,
      });
    } catch {
      // Preserve the fixed public command failure; diagnostics are best-effort and never broaden output.
    }
    rejectPromise(new RehearsalError(options.code ?? "COMMAND_FAILED"));
  });
});

const decodeUrlPart = (value, code) => {
  try {
    return assertNoControlCharacters(decodeURIComponent(value), code);
  } catch (error) {
    if (error?.code) throw error;
    fail(code);
  }
};

export const parseSourceDatabaseUrl = (rawUrl, dockerHostOverride = null) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("INVALID_SOURCE_DATABASE_URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) fail("INVALID_SOURCE_DATABASE_URL");
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode !== "require") fail("SOURCE_TLS_REQUIRE_MODE_REQUIRED");
  const host = assertNoControlCharacters(parsed.hostname, "INVALID_SOURCE_HOST");
  const dockerHost = dockerHostOverride === null ? host : assertNoControlCharacters(dockerHostOverride, "INVALID_SOURCE_DOCKER_HOST");
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("INVALID_SOURCE_PORT");
  const user = decodeUrlPart(parsed.username, "INVALID_SOURCE_USER");
  const password = decodeUrlPart(parsed.password, "INVALID_SOURCE_PASSWORD");
  const database = decodeUrlPart(parsed.pathname.replace(/^\//u, ""), "INVALID_SOURCE_DATABASE");
  return { host, dockerHost, port, user, password, database, sslmode };
};

export const validateSourceTlsRootCertificate = (rawCertificate, now = new Date()) => {
  if (
    typeof rawCertificate !== "string"
    || rawCertificate.length === 0
    || Buffer.byteLength(rawCertificate, "utf8") > MAX_SOURCE_TLS_ROOT_CERT_BYTES
    || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/u.test(rawCertificate)
  ) fail("INVALID_SOURCE_TLS_ROOT_CERT");
  const normalized = rawCertificate.replaceAll("\r\n", "\n");
  const pem = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = pem.split("\n");
  if (
    lines[0] !== "-----BEGIN CERTIFICATE-----"
    || lines.at(-1) !== "-----END CERTIFICATE-----"
    || lines.slice(1, -1).length === 0
    || lines.slice(1, -1).some((line) => !/^[A-Za-z0-9+/]+={0,2}$/u.test(line))
    || (pem.match(/-----BEGIN CERTIFICATE-----/gu) ?? []).length !== 1
    || (pem.match(/-----END CERTIFICATE-----/gu) ?? []).length !== 1
  ) fail("INVALID_SOURCE_TLS_ROOT_CERT");
  let certificate;
  try {
    certificate = new X509Certificate(`${pem}\n`);
  } catch {
    fail("INVALID_SOURCE_TLS_ROOT_CERT");
  }
  if (!certificate.ca) fail("SOURCE_TLS_ROOT_CERT_NOT_CA");
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const validFromMs = Date.parse(certificate.validFrom);
  const validToMs = Date.parse(certificate.validTo);
  if (!Number.isFinite(nowMs)) fail("INVALID_CERTIFICATE_VALIDATION_TIME");
  if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs)) fail("INVALID_SOURCE_TLS_ROOT_CERT");
  if (validFromMs > nowMs) fail("SOURCE_TLS_ROOT_CERT_NOT_YET_VALID");
  if (validToMs <= nowMs) fail("SOURCE_TLS_ROOT_CERT_EXPIRED");
  return `${pem}\n`;
};

export const validateTargetTlsRootCertificate = (
  rawCertificate,
  expectedFingerprints = TARGET_TLS_ROOT_CERT_FINGERPRINTS,
  now = new Date(),
) => {
  if (
    typeof rawCertificate !== "string"
    || rawCertificate.length === 0
    || Buffer.byteLength(rawCertificate, "utf8") > MAX_TARGET_TLS_ROOT_CERT_BYTES
  ) fail("INVALID_TARGET_TLS_ROOT_CERT");
  const expected = new Set(expectedFingerprints);
  if (expected.size === 0 || [...expected].some((fingerprint) => typeof fingerprint !== "string")) {
    fail("INVALID_TARGET_TLS_ROOT_CERT_FINGERPRINTS");
  }
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) fail("INVALID_CERTIFICATE_VALIDATION_TIME");
  const normalized = rawCertificate.replaceAll("\r\n", "\n");
  const blocks = normalized.match(/-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/]+={0,2}\n)+-----END CERTIFICATE-----\n/gu);
  if (blocks === null || blocks.length !== expected.size || blocks.join("") !== normalized) {
    fail("INVALID_TARGET_TLS_ROOT_CERT");
  }
  const fingerprints = new Set();
  for (const block of blocks) {
    let certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      fail("INVALID_TARGET_TLS_ROOT_CERT");
    }
    const validFromMs = Date.parse(certificate.validFrom);
    const validToMs = Date.parse(certificate.validTo);
    if (
      !certificate.ca
      || !certificate.checkIssued(certificate)
      || !certificate.verify(certificate.publicKey)
      || !Number.isFinite(validFromMs)
      || !Number.isFinite(validToMs)
      || validFromMs > nowMs
      || validToMs <= nowMs
    ) {
      fail("INVALID_TARGET_TLS_ROOT_CERT");
    }
    fingerprints.add(certificate.fingerprint256);
  }
  if (
    fingerprints.size !== expected.size
    || [...expected].some((fingerprint) => !fingerprints.has(fingerprint))
  ) fail("TARGET_TLS_ROOT_CERT_FINGERPRINT_MISMATCH");
  return normalized;
};

export const loadTargetTlsRootCertificate = (path = TARGET_TLS_ROOT_CERT_PATH) => {
  let certificate;
  try {
    certificate = readFileSync(path, "utf8");
  } catch {
    fail("TARGET_TLS_ROOT_CERT_UNAVAILABLE");
  }
  if (sha256(certificate) !== TARGET_TLS_ROOT_CERT_SHA256) fail("TARGET_TLS_ROOT_CERT_DIGEST_MISMATCH");
  return validateTargetTlsRootCertificate(certificate);
};

export const targetDatabaseConfigFromEnv = (environment, database, dockerHostOverride = null) => {
  const host = assertNoControlCharacters(environment.TARGET_POSTGRES_HOST, "INVALID_TARGET_HOST");
  const dockerHost = dockerHostOverride === null ? host : assertNoControlCharacters(dockerHostOverride, "INVALID_TARGET_DOCKER_HOST");
  const user = assertNoControlCharacters(environment.TARGET_POSTGRES_ADMIN_USER, "INVALID_TARGET_USER");
  const password = assertNoControlCharacters(environment.TARGET_POSTGRES_ADMIN_PASSWORD, "INVALID_TARGET_PASSWORD");
  const port = environment.TARGET_POSTGRES_PORT === undefined ? 5432 : Number(environment.TARGET_POSTGRES_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("INVALID_TARGET_PORT");
  assertNoControlCharacters(database, "INVALID_TARGET_DATABASE");
  return {
    host,
    dockerHost,
    port,
    user,
    password,
    database,
    sslmode: "verify-full",
    targetTlsRootCert: loadTargetTlsRootCertificate(),
  };
};

export const nodeClientConfig = (config, applicationName, connectionTimeoutMillis = 30_000, queryTimeoutMillis = null) => ({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  application_name: applicationName,
  connectionTimeoutMillis,
  ...(queryTimeoutMillis === null ? {} : { query_timeout: queryTimeoutMillis }),
  keepAlive: true,
  ssl: config.sslmode === "disable"
    ? false
    : config.sslmode === "require"
      ? {
          ca: config.sourceTlsRootCert ?? fail("MISSING_SOURCE_TLS_ROOT_CERT"),
          rejectUnauthorized: true,
          checkServerIdentity: () => undefined,
        }
      : {
          ca: config.targetTlsRootCert ?? fail("MISSING_TARGET_TLS_ROOT_CERT"),
          rejectUnauthorized: true,
        },
});

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export async function waitForTargetConnection(options) {
  const {
    targetAdminConfig,
    timeoutMs = TARGET_CONNECTION_TIMEOUT_MS,
    retryDelayMs = TARGET_CONNECTION_RETRY_DELAY_MS,
    now = () => Date.now(),
    sleepFn = sleep,
    clientFactory = (config) => new Client(config),
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("INVALID_TARGET_CONNECTION_TIMEOUT");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) fail("INVALID_TARGET_CONNECTION_RETRY_DELAY");
  const deadline = now() + timeoutMs;
  let attempts = 0;
  while (now() < deadline) {
    attempts += 1;
    const remainingMs = deadline - now();
    let client = null;
    try {
      client = clientFactory(nodeClientConfig(
        targetAdminConfig,
        "corgtex_rehearsal_firewall_probe",
        Math.max(1, Math.min(30_000, remainingMs)),
        Math.max(1, remainingMs),
      ));
      await client.connect();
      await client.query("SELECT 1");
      return { attempts };
    } catch {
      // Azure PostgreSQL firewall changes are asynchronous; retry without exposing connection details.
    } finally {
      if (client !== null) await client.end().catch(() => {});
    }
    const delayMs = Math.min(retryDelayMs, Math.max(0, deadline - now()));
    if (delayMs > 0) await sleepFn(delayMs);
  }
  fail("TARGET_FIREWALL_PROPAGATION_TIMEOUT");
}

export const serializePgServiceValue = (value) => {
  const normalized = assertNoControlCharacters(String(value), "INVALID_SERVICE_VALUE");
  if (!/^[A-Za-z0-9._:-]+$/u.test(normalized)) fail("INVALID_SERVICE_VALUE");
  return normalized;
};

const pgPassEscape = (value) => assertNoControlCharacters(String(value), "INVALID_PASSFILE_VALUE")
  .replaceAll("\\", "\\\\")
  .replaceAll(":", "\\:");

export const buildPgServiceContents = (source, target) => {
  if (!new Set(["disable", "require"]).has(source.sslmode)) fail("INVALID_SOURCE_TLS_MODE");
  if (!new Set(["disable", "verify-full"]).has(target.sslmode)) fail("INVALID_TARGET_TLS_MODE");
  const sourceServiceSslMode = source.sslmode === "disable" ? "disable" : "verify-ca";
  const targetServiceSslMode = target.sslmode === "disable" ? "disable" : "verify-full";
  return [
    "[source]",
    `host=${serializePgServiceValue(source.dockerHost)}`,
    `port=${serializePgServiceValue(source.dockerPort ?? source.port)}`,
    `user=${serializePgServiceValue(source.user)}`,
    `dbname=${serializePgServiceValue(source.database)}`,
    `sslmode=${serializePgServiceValue(sourceServiceSslMode)}`,
    ...(sourceServiceSslMode === "disable" ? [] : ["sslrootcert=/work/source-root.crt"]),
    "connect_timeout=30",
    "",
    "[target]",
    `host=${serializePgServiceValue(target.dockerHost)}`,
    `port=${serializePgServiceValue(target.dockerPort ?? target.port)}`,
    `user=${serializePgServiceValue(target.user)}`,
    `dbname=${serializePgServiceValue(target.database)}`,
    `sslmode=${serializePgServiceValue(targetServiceSslMode)}`,
    ...(targetServiceSslMode === "disable" ? [] : ["sslrootcert=/work/target-root.crt"]),
    "connect_timeout=30",
    "",
  ].join("\n");
};

export const writeClientFiles = (tempDir, source, target, registerCleanup) => {
  const serviceFile = assertSafePath(`${tempDir}/pg_service.conf`, tempDir, "INVALID_SERVICE_PATH");
  const passFile = assertSafePath(`${tempDir}/pgpass`, tempDir, "INVALID_PASSFILE_PATH");
  const sourceRootCertFile = source.sslmode === "disable"
    ? null
    : assertSafePath(`${tempDir}/source-root.crt`, tempDir, "INVALID_SOURCE_TLS_ROOT_CERT_PATH");
  const targetRootCertFile = target.sslmode === "disable"
    ? null
    : assertSafePath(`${tempDir}/target-root.crt`, tempDir, "INVALID_TARGET_TLS_ROOT_CERT_PATH");
  registerCleanup(
    serviceFile,
    passFile,
    ...(sourceRootCertFile === null ? [] : [sourceRootCertFile]),
    ...(targetRootCertFile === null ? [] : [targetRootCertFile]),
  );
  const service = buildPgServiceContents(source, target);
  const pass = [
    [source.dockerHost, source.dockerPort ?? source.port, source.database, source.user, source.password].map(pgPassEscape).join(":"),
    [target.dockerHost, target.dockerPort ?? target.port, target.database, target.user, target.password].map(pgPassEscape).join(":"),
    "",
  ].join("\n");
  writeFileSync(serviceFile, service, { mode: 0o600, flag: "wx" });
  writeFileSync(passFile, pass, { mode: 0o600, flag: "wx" });
  if (sourceRootCertFile !== null) {
    writeFileSync(sourceRootCertFile, source.sourceTlsRootCert ?? fail("MISSING_SOURCE_TLS_ROOT_CERT"), { mode: 0o600, flag: "wx" });
    chmodSync(sourceRootCertFile, 0o600);
  }
  if (targetRootCertFile !== null) {
    writeFileSync(
      targetRootCertFile,
      validateTargetTlsRootCertificate(
        target.targetTlsRootCert ?? fail("MISSING_TARGET_TLS_ROOT_CERT"),
        target.targetTlsRootCertFingerprints ?? TARGET_TLS_ROOT_CERT_FINGERPRINTS,
      ),
      { mode: 0o600, flag: "wx" },
    );
    chmodSync(targetRootCertFile, 0o600);
  }
  chmodSync(serviceFile, 0o600);
  chmodSync(passFile, 0o600);
  return { serviceFile, passFile, sourceRootCertFile, targetRootCertFile };
};

const dockerClient = async ({
  tempDir,
  serviceFile,
  passFile,
  sourceRootCertFile,
  service,
  args,
  code,
  network = null,
  stderrClassifier = null,
  stdoutClassifier = null,
  onFailure = null,
}) => {
  const dockerArgs = ["run", "--rm"];
  if (network !== null) {
    assertNoControlCharacters(network, "INVALID_DOCKER_NETWORK");
    dockerArgs.push("--network", network);
  }
  dockerArgs.push(
    "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--mount", `type=bind,source=${tempDir},target=/work`,
    ...(sourceRootCertFile === null
      ? []
      : ["--mount", `type=bind,source=${sourceRootCertFile},target=/work/source-root.crt,readonly`]),
    "--env", "PGSERVICEFILE=/work/pg_service.conf",
    "--env", "PGPASSFILE=/work/pgpass",
    "--env", `PGSERVICE=${service}`,
    "--env", service === "source"
      ? "PGOPTIONS=-c default_transaction_read_only=on -c lock_timeout=5s -c statement_timeout=0 -c transaction_timeout=0 -c idle_in_transaction_session_timeout=20min"
      : "PGOPTIONS=-c lock_timeout=5s -c statement_timeout=0 -c transaction_timeout=0 -c idle_in_transaction_session_timeout=20min",
    POSTGRES_CLIENT_IMAGE,
    ...args,
  );
  if (basename(serviceFile) !== "pg_service.conf" || basename(passFile) !== "pgpass") fail("INVALID_CLIENT_FILE_NAME");
  if (sourceRootCertFile !== null && basename(sourceRootCertFile) !== "source-root.crt") fail("INVALID_CLIENT_FILE_NAME");
  await spawnFixed("docker", dockerArgs, {
    code,
    stderrClassifier: stderrClassifier ?? undefined,
    stdoutClassifier: stdoutClassifier ?? undefined,
    onFailure,
  });
};

const targetConnectionProbeDiagnosticFromResults = ({
  sqlstateResult,
  status = 1,
  spawnError = false,
  signal = null,
}) => {
  const processClass = spawnError || signal !== null
    ? "PROCESS_ERROR"
    : status === 2
      ? "CONNECTION_ERROR"
      : status === 3
        ? "SCRIPT_ERROR"
        : "PROCESS_ERROR";
  const sqlstate = processClass === "SCRIPT_ERROR" && !sqlstateResult.truncated
    ? sqlstateResult.sqlstate
    : null;
  return {
    phase: "TARGET_CLIENT_CONNECTION_PROBE",
    processClass,
    category: categoryFromSqlstate(sqlstate),
    sqlstate,
    stderrObserved: sqlstateResult.observed,
    stderrTruncated: sqlstateResult.truncated,
  };
};

export const buildTargetConnectionProbeDiagnostic = ({
  stderrChunks,
  status = 1,
  spawnError = false,
  signal = null,
}) => {
  const sqlstateClassifier = createSqlstateClassifier();
  for (const chunk of stderrChunks) sqlstateClassifier.consume(chunk);
  return targetConnectionProbeDiagnosticFromResults({
    sqlstateResult: sqlstateClassifier.finish(),
    status,
    spawnError,
    signal,
  });
};

export const probeTargetClientConnection = async ({
  tempDir,
  clientFiles,
  network,
  artifactDir,
}) => dockerClient({
  tempDir,
  ...clientFiles,
  service: "target",
  args: [
    "psql",
    "-X",
    "--quiet",
    "--set=ON_ERROR_STOP=1",
    "--set=VERBOSITY=sqlstate",
    "--set=SHOW_CONTEXT=never",
    "--set=ECHO=none",
    "--dbname=service=target",
    "--command=SELECT 1",
  ],
  code: "TARGET_CLIENT_CONNECTION_PROBE_FAILED",
  network,
  stderrClassifier: createSqlstateClassifier(),
  onFailure: ({ stderr, status, spawnError, signal }) => writePrivateJson(
    `${artifactDir}/connection-probe-diagnostic.json`,
    targetConnectionProbeDiagnosticFromResults({
      sqlstateResult: stderr ?? { sqlstate: null, observed: false, truncated: false },
      status,
      spawnError,
      signal,
    }),
  ),
});

const RESTORE_SECTIONS = ["pre-data", "data", "post-data"];
const RESTORE_SECTION_SCRIPT = `
case "$1" in
  pre-data|data|post-data) ;;
  *) exit 64 ;;
esac
pg_restore --section="$1" --no-owner --no-acl --file=- /work/snapshot.dump 2>/dev/null \
  | psql -X --quiet --set=ON_ERROR_STOP=1 --set=VERBOSITY=sqlstate --set=SHOW_CONTEXT=never --set=ECHO=none \
      --dbname=service=target >/dev/null
statuses=("\${PIPESTATUS[@]}")
printf 'CORGTEX_RESTORE_STATUS:%s:%s\\n' "\${statuses[0]}" "\${statuses[1]}"
if (( statuses[1] != 0 || statuses[0] != 0 )); then
  exit 1
fi
`;

const restoreArchiveSections = async ({
  tempDir,
  clientFiles,
  network,
  artifactDir,
}) => {
  for (const section of RESTORE_SECTIONS) {
    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "target",
      args: ["bash", "-c", RESTORE_SECTION_SCRIPT, "corgtex-restore-section", section],
      code: "DESTINATION_RESTORE_FAILED",
      network,
      stderrClassifier: createSqlstateClassifier(),
      stdoutClassifier: createRestoreStatusClassifier(),
      onFailure: ({ stderr, stdout, status, spawnError, signal }) => writePrivateJson(
        `${artifactDir}/restore-diagnostic.json`,
        restoreDiagnosticFromResults({
          section,
          sqlstateResult: stderr ?? { sqlstate: null, observed: false, truncated: false },
          statusResult: stdout ?? { statuses: null, truncated: false },
          status,
          spawnError,
          signal,
        }),
      ),
    });
  }
};

const querySingle = async (client, text, values, code) => {
  const result = await client.query(text, values);
  if (result.rows.length !== 1) fail(code);
  return result.rows[0];
};

const databaseSettings = async (client) => {
  const row = await querySingle(client, `
    SELECT
      current_setting('server_version_num')::integer AS server_version_num,
      pg_encoding_to_char(encoding) AS encoding,
      datcollate AS collation,
      datctype AS ctype,
      datlocprovider::text AS locale_provider,
      datlocale AS provider_locale,
      daticurules AS icu_rules,
      datcollversion AS collation_version,
      pg_database_collation_actual_version(oid) AS actual_collation_version
    FROM pg_database
    WHERE datname = current_database()
  `, [], "DATABASE_SETTINGS_UNAVAILABLE");
  const serverVersionNumber = Number(row.server_version_num);
  if (!Number.isInteger(serverVersionNumber)) fail("INVALID_POSTGRES_VERSION");
  const majorVersion = Math.floor(serverVersionNumber / 10_000);
  if (majorVersion !== 18) fail("POSTGRES_18_REQUIRED");
  const provider = LOCALE_PROVIDERS.get(row.locale_provider);
  if (provider === undefined) fail("UNSUPPORTED_LOCALE_PROVIDER");
  const providerLocale = nullableText(row.provider_locale, "INVALID_PROVIDER_LOCALE");
  const icuRules = nullableText(row.icu_rules, "INVALID_ICU_RULES");
  if (provider === "libc" && providerLocale !== null) fail("INVALID_LIBC_LOCALE");
  if (provider !== "icu" && icuRules !== null) fail("INVALID_ICU_RULES");
  if (provider !== "libc" && providerLocale === null) fail("MISSING_PROVIDER_LOCALE");
  return {
    serverVersionNumber,
    majorVersion,
    encoding: assertNoControlCharacters(row.encoding, "INVALID_DATABASE_ENCODING"),
    collation: assertNoControlCharacters(row.collation, "INVALID_DATABASE_COLLATION"),
    ctype: assertNoControlCharacters(row.ctype, "INVALID_DATABASE_CTYPE"),
    provider,
    providerLocale,
    icuRules,
    collationVersion: nullableText(row.collation_version, "INVALID_COLLATION_VERSION"),
    actualCollationVersion: nullableText(row.actual_collation_version, "INVALID_ACTUAL_COLLATION_VERSION"),
  };
};

const writeState = (stateFile, value) => writePrivateJson(stateFile, value);

export const buildCreateDatabaseSql = (scratchName, settings) => {
  if (!SAFE_NAME.test(scratchName) || !scratchName.startsWith("corgtex_rehearsal_")) fail("INVALID_SCRATCH_DATABASE_NAME");
  const common = [
    `CREATE DATABASE ${quoteIdentifier(scratchName)}`,
    "TEMPLATE template0",
    `ENCODING ${quoteLiteral(settings.encoding)}`,
    `LOCALE_PROVIDER ${quoteLiteral(settings.provider)}`,
    `LC_COLLATE ${quoteLiteral(settings.collation)}`,
    `LC_CTYPE ${quoteLiteral(settings.ctype)}`,
  ];
  if (settings.provider === "libc") {
    if (settings.providerLocale !== null || settings.icuRules !== null) fail("INVALID_LIBC_LOCALE");
  } else if (settings.provider === "icu") {
    if (typeof settings.providerLocale !== "string" || settings.providerLocale.length === 0) fail("MISSING_PROVIDER_LOCALE");
    common.push(`ICU_LOCALE ${quoteLiteral(settings.providerLocale)}`);
    if (settings.icuRules !== null) common.push(`ICU_RULES ${quoteLiteral(settings.icuRules)}`);
  } else if (settings.provider === "builtin") {
    if (typeof settings.providerLocale !== "string" || settings.providerLocale.length === 0 || settings.icuRules !== null) {
      fail("INVALID_BUILTIN_LOCALE");
    }
    common.push(`BUILTIN_LOCALE ${quoteLiteral(settings.providerLocale)}`);
  } else {
    fail("UNSUPPORTED_LOCALE_PROVIDER");
  }
  return common.join(" ");
};

const localeSettings = (settings) => ({
  encoding: settings.encoding,
  collation: settings.collation,
  ctype: settings.ctype,
  provider: settings.provider,
  providerLocale: settings.providerLocale,
  icuRules: settings.icuRules,
  collationVersion: settings.collationVersion,
  actualCollationVersion: settings.actualCollationVersion,
});

export const localeDefinitionMismatchFields = (source, target) => LOCALE_DEFINITION_FIELDS
  .filter((field) => source[field] !== target[field]);

export const isCurrentCollationVersion = (settings) =>
  settings.collationVersion === settings.actualCollationVersion;

export const classifyCollationVersionRelation = (source, target) => {
  if (source.collationVersion === null || target.collationVersion === null) return "UNVERSIONED";
  return source.collationVersion === target.collationVersion ? "MATCH" : "DIFFERENT";
};

export const buildLocaleDiagnostic = (source, target = null) => ({
  schemaVersion: "1.0.0",
  definitionMismatchFields: target === null ? [] : localeDefinitionMismatchFields(source, target),
  sourceVersionCurrent: isCurrentCollationVersion(source),
  targetVersionCurrent: target === null ? null : isCurrentCollationVersion(target),
  crossRuntimeVersionRelation: target === null ? "UNAVAILABLE" : classifyCollationVersionRelation(source, target),
});

const createScratchDatabase = async ({ adminConfig, scratchName, settings, stateFile, targetRef, artifactDir }) => {
  const createSql = buildCreateDatabaseSql(scratchName, settings);
  const client = new Client(nodeClientConfig(adminConfig, "corgtex_rehearsal_create"));
  await client.connect();
  try {
    writeState(stateFile, { schemaVersion: "1.0.0", scratchName, targetRef, phase: "INTENT" });
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [scratchName]);
    if (existing.rowCount !== 0) fail("SCRATCH_DATABASE_ALREADY_EXISTS");
    writeState(stateFile, { schemaVersion: "1.0.0", scratchName, targetRef, phase: "ABSENCE_VERIFIED" });
    await client.query(createSql);
    writeState(stateFile, { schemaVersion: "1.0.0", scratchName, targetRef, phase: "CREATED" });
  } finally {
    await client.end().catch(() => {});
  }
  const readbackClient = new Client(nodeClientConfig({ ...adminConfig, database: scratchName }, "corgtex_rehearsal_locale_readback"));
  await readbackClient.connect();
  try {
    const readback = await databaseSettings(readbackClient);
    const diagnostic = buildLocaleDiagnostic(settings, readback);
    if (diagnostic.definitionMismatchFields.length > 0) {
      writePrivateJson(`${artifactDir}/locale-diagnostic.json`, diagnostic);
      fail("SCRATCH_DATABASE_LOCALE_MISMATCH");
    }
    if (!diagnostic.targetVersionCurrent) {
      writePrivateJson(`${artifactDir}/locale-diagnostic.json`, diagnostic);
      fail("TARGET_COLLATION_VERSION_STALE");
    }
  } finally {
    await readbackClient.end().catch(() => {});
  }
};

const legacyNormalizeSchemaDump = (content) => content
  .split(/\r?\n/u)
  .filter((line) => !line.startsWith("--"))
  .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict "))
  .filter((line) => line.trim() !== "")
  .join("\n")
  .trim();

const schemaFail = (code) => fail(code);
const isSchemaWhitespace = (character) => character === " "
  || character === "\t"
  || character === "\r"
  || character === "\n"
  || character === "\f";
const isSchemaOperator = (character) => /[~!@#%^&|`?+*/<>=:-]/u.test(character);
const isSchemaPunctuation = (character) => /[()[\]{},.;]/u.test(character);

const readQuotedSchemaToken = (content, start, quote, backslashEscapes, code) => {
  let index = start + 1;
  while (index < content.length) {
    if (backslashEscapes && content[index] === "\\") {
      if (index + 1 >= content.length) schemaFail(code);
      index += 2;
      continue;
    }
    if (content[index] === quote) {
      if (content[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  schemaFail(code);
};

export const tokenizeSchemaDump = (content) => {
  if (typeof content !== "string" || content.length === 0 || content.includes("\u0000")) {
    schemaFail("INVALID_SCHEMA_DUMP");
  }
  const tokens = [];
  const push = (domain, value) => tokens.push({ domain, value });
  let index = 0;
  let lineOnlyWhitespace = true;
  while (index < content.length) {
    const character = content[index];
    if (isSchemaWhitespace(character)) {
      if (character === "\n" || character === "\r") lineOnlyWhitespace = true;
      index += 1;
      continue;
    }
    if (content.startsWith("--", index)) {
      const newline = content.indexOf("\n", index + 2);
      index = newline === -1 ? content.length : newline + 1;
      lineOnlyWhitespace = true;
      continue;
    }
    if (content.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < content.length && depth > 0) {
        if (content.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (content.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          if (content[index] === "\n" || content[index] === "\r") lineOnlyWhitespace = true;
          index += 1;
        }
      }
      if (depth !== 0) schemaFail("UNTERMINATED_SCHEMA_COMMENT");
      continue;
    }
    if (character === "\\") {
      if (!lineOnlyWhitespace) schemaFail("UNEXPECTED_SCHEMA_META_COMMAND");
      const newline = content.indexOf("\n", index);
      const end = newline === -1 ? content.length : newline;
      const command = content.slice(index, end).replace(/\r$/u, "");
      if (!new Set([
        `\\restrict ${SCHEMA_RESTRICT_KEY}`,
        `\\unrestrict ${SCHEMA_RESTRICT_KEY}`,
      ]).has(command)) schemaFail("UNEXPECTED_SCHEMA_META_COMMAND");
      push("META_COMMAND", command);
      index = newline === -1 ? content.length : newline + 1;
      lineOnlyWhitespace = true;
      continue;
    }
    lineOnlyWhitespace = false;

    const unicodePrefix = content.slice(index, index + 3).toUpperCase();
    if (unicodePrefix === "U&'" || unicodePrefix === 'U&"') {
      const quote = content[index + 2];
      const end = readQuotedSchemaToken(content, index + 2, quote, quote === "'", "UNTERMINATED_SCHEMA_QUOTE");
      push(quote === "'" ? "STRING_LITERAL" : "DDL_TOKEN", content.slice(index, end));
      index = end;
      continue;
    }
    if (/[EBXN]/iu.test(character) && content[index + 1] === "'") {
      const end = readQuotedSchemaToken(
        content,
        index + 1,
        "'",
        character.toUpperCase() === "E",
        "UNTERMINATED_SCHEMA_STRING",
      );
      push("STRING_LITERAL", content.slice(index, end));
      index = end;
      continue;
    }
    if (character === "'") {
      const end = readQuotedSchemaToken(content, index, "'", false, "UNTERMINATED_SCHEMA_STRING");
      push("STRING_LITERAL", content.slice(index, end));
      index = end;
      continue;
    }
    if (character === '"') {
      const end = readQuotedSchemaToken(content, index, '"', false, "UNTERMINATED_SCHEMA_IDENTIFIER");
      push("DDL_TOKEN", content.slice(index, end));
      index = end;
      continue;
    }
    if (character === "$") {
      const delimiterMatch = content.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u);
      if (delimiterMatch !== null) {
        const delimiter = delimiterMatch[0];
        const endStart = content.indexOf(delimiter, index + delimiter.length);
        if (endStart === -1) schemaFail("UNTERMINATED_SCHEMA_DOLLAR_BODY");
        const end = endStart + delimiter.length;
        push("DOLLAR_BODY", content.slice(index, end));
        index = end;
        continue;
      }
    }
    if (isSchemaOperator(character)) {
      let end = index + 1;
      while (end < content.length && isSchemaOperator(content[end])) {
        if (content.startsWith("--", end) || content.startsWith("/*", end)) break;
        end += 1;
      }
      push("DDL_TOKEN", content.slice(index, end));
      index = end;
      continue;
    }
    if (isSchemaPunctuation(character)) {
      push("DDL_TOKEN", character);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < content.length) {
      const next = content[end];
      if (
        isSchemaWhitespace(next)
        || next === "'"
        || next === '"'
        || next === "\\"
        || next === "$"
        || isSchemaOperator(next)
        || isSchemaPunctuation(next)
        || content.startsWith("--", end)
        || content.startsWith("/*", end)
      ) break;
      end += 1;
    }
    push("DDL_TOKEN", content.slice(index, end));
    index = end;
  }
  if (tokens.length === 0) schemaFail("EMPTY_SCHEMA_TOKEN_STREAM");
  return tokens;
};

const updateLengthFramed = (hash, value) => {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
};

export const schemaTokenDigest = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length === 0) schemaFail("EMPTY_SCHEMA_TOKEN_STREAM");
  const hash = createHash("sha256");
  for (const token of tokens) {
    if (!SCHEMA_TOKEN_DOMAINS.includes(token?.domain) || typeof token.value !== "string" || token.value.length === 0) {
      schemaFail("INVALID_SCHEMA_TOKEN");
    }
    updateLengthFramed(hash, token.domain);
    updateLengthFramed(hash, token.value);
  }
  return hash.digest("hex");
};

export const analyzeSchemaDump = (content) => {
  const tokens = tokenizeSchemaDump(content);
  return {
    algorithm: SCHEMA_TOKEN_ALGORITHM,
    digest: schemaTokenDigest(tokens),
    legacyDigest: sha256(legacyNormalizeSchemaDump(content)),
    tokens,
  };
};

const schemaStatements = (tokens) => {
  const statements = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) statements.push(current);
    current = [];
  };
  for (const token of tokens) {
    if (token.domain === "META_COMMAND") {
      flush();
      statements.push([token]);
    } else {
      current.push(token);
      if (token.domain === "DDL_TOKEN" && token.value === ";") flush();
    }
  }
  flush();
  return statements;
};

const schemaStatementClass = (tokens) => {
  if (tokens.length === 1 && tokens[0].domain === "META_COMMAND") return "OTHER";
  const words = tokens
    .filter((token) => token.domain === "DDL_TOKEN" && /^[A-Za-z_]+$/u.test(token.value))
    .map((token) => token.value.toUpperCase());
  const first = words[0];
  const second = words[1];
  const third = words[2];
  const fourth = words[3];
  if ((first === "CREATE" || first === "ALTER" || first === "DROP") && second === "EXTENSION") return "EXTENSION";
  if ((first === "CREATE" || first === "ALTER" || first === "DROP") && second === "TYPE") return "TYPE";
  if (
    (first === "CREATE" && second === "FUNCTION")
    || (first === "CREATE" && second === "OR" && third === "REPLACE" && fourth === "FUNCTION")
    || ((first === "ALTER" || first === "DROP") && second === "FUNCTION")
  ) return "FUNCTION";
  if (
    ((first === "CREATE" || first === "ALTER" || first === "DROP") && second === "INDEX")
    || (first === "CREATE" && second === "UNIQUE" && third === "INDEX")
  ) return "INDEX";
  if ((first === "CREATE" || first === "ALTER" || first === "DROP") && second === "TRIGGER") return "TRIGGER";
  if ((first === "CREATE" || first === "ALTER" || first === "DROP") && second === "POLICY") return "POLICY";
  if (
    ((first === "CREATE" || first === "ALTER" || first === "DROP") && ["VIEW", "MATERIALIZED"].includes(second))
    || (first === "CREATE" && second === "OR" && third === "REPLACE" && ["VIEW", "MATERIALIZED"].includes(fourth))
  ) return "VIEW";
  if (first === "COMMENT" && second === "ON") return "COMMENT";
  if ((first === "CREATE" || first === "ALTER" || first === "DROP") && ["TABLE", "SEQUENCE"].includes(second)) {
    return words.includes("CONSTRAINT") ? "CONSTRAINT" : "TABLE";
  }
  return "OTHER";
};

const emptySchemaDiagnosticSide = () => ({
  statementClasses: Object.fromEntries(SCHEMA_STATEMENT_CLASSES.map((name) => [name, 0])),
  tokenDomains: Object.fromEntries(SCHEMA_TOKEN_DOMAINS.map((name) => [name, 0])),
});

const boundedDiagnosticAdd = (diagnostic, key, count, state) => {
  const next = diagnostic[key] + count;
  if (next > MAX_SCHEMA_DIAGNOSTIC_COUNT) {
    diagnostic[key] = MAX_SCHEMA_DIAGNOSTIC_COUNT;
    state.truncated = true;
  } else {
    diagnostic[key] = next;
  }
};

export const buildSchemaDifferenceDiagnostic = (sourceTokens, destinationTokens) => {
  const statementMap = (tokens) => {
    const map = new Map();
    for (const statement of schemaStatements(tokens)) {
      const digest = schemaTokenDigest(statement);
      const entry = map.get(digest) ?? { count: 0, statement };
      entry.count += 1;
      map.set(digest, entry);
    }
    return map;
  };
  const source = statementMap(sourceTokens);
  const destination = statementMap(destinationTokens);
  const sourceOnly = emptySchemaDiagnosticSide();
  const destinationOnly = emptySchemaDiagnosticSide();
  const state = { truncated: false };
  const addUnmatched = (side, entry, count) => {
    boundedDiagnosticAdd(side.statementClasses, schemaStatementClass(entry.statement), count, state);
    for (const token of entry.statement) {
      boundedDiagnosticAdd(side.tokenDomains, token.domain, count, state);
    }
  };
  for (const [digest, entry] of source) {
    const count = Math.max(0, entry.count - (destination.get(digest)?.count ?? 0));
    if (count > 0) addUnmatched(sourceOnly, entry, count);
  }
  for (const [digest, entry] of destination) {
    const count = Math.max(0, entry.count - (source.get(digest)?.count ?? 0));
    if (count > 0) addUnmatched(destinationOnly, entry, count);
  }
  return {
    schemaVersion: "1.0.0",
    classification: "EXECUTABLE_SCHEMA_DIFFERENCE",
    sourceOnly,
    destinationOnly,
    truncated: state.truncated,
  };
};

const constraintCatalogQueryBase = `
  SELECT
    constraint_row.oid::text AS constraint_oid,
    constraint_namespace.nspname AS namespace_name,
    constraint_row.conname AS constraint_name,
    CASE WHEN constraint_row.conrelid <> 0 THEN 'TABLE' ELSE 'DOMAIN' END AS object_kind,
    relation_namespace.nspname AS relation_namespace_name,
    relation.relname AS relation_name,
    domain_namespace.nspname AS domain_namespace_name,
    domain_type.typname AS domain_name,
    constraint_row.contype::text AS type,
    constraint_row.condeferrable AS deferrable,
    constraint_row.condeferred AS initially_deferred,
    constraint_row.convalidated AS validated,
    constraint_row.conenforced AS enforced,
    constraint_row.conislocal AS locally_defined,
    constraint_row.coninhcount::text AS inheritance_count,
    constraint_row.connoinherit AS no_inherit,
    constraint_row.conperiod AS period,
    constraint_row.confupdtype::text AS foreign_key_update_action,
    constraint_row.confdeltype::text AS foreign_key_delete_action,
    constraint_row.confmatchtype::text AS foreign_key_match_type,
    constraint_row.conparentid <> 0 AS has_parent,
    parent_constraint.conname AS parent_constraint_name,
    parent_relation_namespace.nspname AS parent_relation_namespace_name,
    parent_relation.relname AS parent_relation_name,
    parent_domain_namespace.nspname AS parent_domain_namespace_name,
    parent_domain.typname AS parent_domain_name,
    constraint_row.confrelid <> 0 AS has_referenced_relation,
    referenced_namespace.nspname AS referenced_namespace_name,
    referenced_relation.relname AS referenced_relation_name,
    constraint_row.conindid <> 0 AS has_supporting_index,
    supporting_index_namespace.nspname AS supporting_index_namespace_name,
    supporting_index.relname AS supporting_index_name,
    extension_row.extname AS extension_name,
    COALESCE(pg_catalog.cardinality(constraint_row.conkey), 0)::text AS key_column_count,
    COALESCE(pg_catalog.cardinality(constraint_row.confkey), 0)::text AS referenced_key_column_count,
    COALESCE(pg_catalog.cardinality(constraint_row.confdelsetcols), 0)::text AS delete_set_column_count,
    COALESCE(pg_catalog.cardinality(constraint_row.conpfeqop), 0)::text AS primary_foreign_operator_count,
    COALESCE(pg_catalog.cardinality(constraint_row.conppeqop), 0)::text AS primary_primary_operator_count,
    COALESCE(pg_catalog.cardinality(constraint_row.conffeqop), 0)::text AS foreign_foreign_operator_count,
    COALESCE(pg_catalog.cardinality(constraint_row.conexclop), 0)::text AS exclusion_operator_count,
    COALESCE((
      SELECT jsonb_agg(
        CASE
          WHEN key_column.attribute_number = 0 THEN pg_catalog.to_jsonb('<EXPRESSION>'::text)
          ELSE pg_catalog.to_jsonb(attribute.attname)
        END
        ORDER BY key_column.ordinality
      )
      FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attribute_number, ordinality)
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attribute_number
       AND NOT attribute.attisdropped
    ), '[]'::jsonb) AS key_columns,
    COALESCE((
      SELECT jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
      FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attribute_number, ordinality)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.confrelid
       AND attribute.attnum = key_column.attribute_number
       AND NOT attribute.attisdropped
    ), '[]'::jsonb) AS referenced_key_columns,
    COALESCE((
      SELECT jsonb_agg(attribute.attname ORDER BY key_column.ordinality)
      FROM unnest(constraint_row.confdelsetcols) WITH ORDINALITY AS key_column(attribute_number, ordinality)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attribute_number
       AND NOT attribute.attisdropped
    ), '[]'::jsonb) AS delete_set_columns,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_array(
        operator_namespace.nspname,
        operator_row.oprname,
        left_type_namespace.nspname,
        left_type.typname,
        right_type_namespace.nspname,
        right_type.typname
      ) ORDER BY operator_identity.ordinality)
      FROM unnest(constraint_row.conpfeqop) WITH ORDINALITY AS operator_identity(operator_oid, ordinality)
      JOIN pg_catalog.pg_operator AS operator_row ON operator_row.oid = operator_identity.operator_oid
      JOIN pg_catalog.pg_namespace AS operator_namespace ON operator_namespace.oid = operator_row.oprnamespace
      JOIN pg_catalog.pg_type AS left_type ON left_type.oid = operator_row.oprleft
      JOIN pg_catalog.pg_namespace AS left_type_namespace ON left_type_namespace.oid = left_type.typnamespace
      JOIN pg_catalog.pg_type AS right_type ON right_type.oid = operator_row.oprright
      JOIN pg_catalog.pg_namespace AS right_type_namespace ON right_type_namespace.oid = right_type.typnamespace
    ), '[]'::jsonb) AS primary_foreign_operators,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_array(
        operator_namespace.nspname,
        operator_row.oprname,
        left_type_namespace.nspname,
        left_type.typname,
        right_type_namespace.nspname,
        right_type.typname
      ) ORDER BY operator_identity.ordinality)
      FROM unnest(constraint_row.conppeqop) WITH ORDINALITY AS operator_identity(operator_oid, ordinality)
      JOIN pg_catalog.pg_operator AS operator_row ON operator_row.oid = operator_identity.operator_oid
      JOIN pg_catalog.pg_namespace AS operator_namespace ON operator_namespace.oid = operator_row.oprnamespace
      JOIN pg_catalog.pg_type AS left_type ON left_type.oid = operator_row.oprleft
      JOIN pg_catalog.pg_namespace AS left_type_namespace ON left_type_namespace.oid = left_type.typnamespace
      JOIN pg_catalog.pg_type AS right_type ON right_type.oid = operator_row.oprright
      JOIN pg_catalog.pg_namespace AS right_type_namespace ON right_type_namespace.oid = right_type.typnamespace
    ), '[]'::jsonb) AS primary_primary_operators,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_array(
        operator_namespace.nspname,
        operator_row.oprname,
        left_type_namespace.nspname,
        left_type.typname,
        right_type_namespace.nspname,
        right_type.typname
      ) ORDER BY operator_identity.ordinality)
      FROM unnest(constraint_row.conffeqop) WITH ORDINALITY AS operator_identity(operator_oid, ordinality)
      JOIN pg_catalog.pg_operator AS operator_row ON operator_row.oid = operator_identity.operator_oid
      JOIN pg_catalog.pg_namespace AS operator_namespace ON operator_namespace.oid = operator_row.oprnamespace
      JOIN pg_catalog.pg_type AS left_type ON left_type.oid = operator_row.oprleft
      JOIN pg_catalog.pg_namespace AS left_type_namespace ON left_type_namespace.oid = left_type.typnamespace
      JOIN pg_catalog.pg_type AS right_type ON right_type.oid = operator_row.oprright
      JOIN pg_catalog.pg_namespace AS right_type_namespace ON right_type_namespace.oid = right_type.typnamespace
    ), '[]'::jsonb) AS foreign_foreign_operators,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_array(
        operator_namespace.nspname,
        operator_row.oprname,
        left_type_namespace.nspname,
        left_type.typname,
        right_type_namespace.nspname,
        right_type.typname
      ) ORDER BY operator_identity.ordinality)
      FROM unnest(constraint_row.conexclop) WITH ORDINALITY AS operator_identity(operator_oid, ordinality)
      JOIN pg_catalog.pg_operator AS operator_row ON operator_row.oid = operator_identity.operator_oid
      JOIN pg_catalog.pg_namespace AS operator_namespace ON operator_namespace.oid = operator_row.oprnamespace
      JOIN pg_catalog.pg_type AS left_type ON left_type.oid = operator_row.oprleft
      JOIN pg_catalog.pg_namespace AS left_type_namespace ON left_type_namespace.oid = left_type.typnamespace
      JOIN pg_catalog.pg_type AS right_type ON right_type.oid = operator_row.oprright
      JOIN pg_catalog.pg_namespace AS right_type_namespace ON right_type_namespace.oid = right_type.typnamespace
    ), '[]'::jsonb) AS exclusion_operators,
    CASE WHEN pg_catalog.octet_length(CASE
      WHEN constraint_row.contype = 't'
      THEN pg_catalog.pg_get_triggerdef(constraint_trigger.oid, false)
      ELSE pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    END) <= ${MAX_CONSTRAINT_TEXT_BYTES} THEN CASE
      WHEN constraint_row.contype = 't'
      THEN pg_catalog.pg_get_triggerdef(constraint_trigger.oid, false)
      ELSE pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    END ELSE NULL END AS definition,
    pg_catalog.octet_length(CASE
      WHEN constraint_row.contype = 't'
      THEN pg_catalog.pg_get_triggerdef(constraint_trigger.oid, false)
      ELSE pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
    END) <= ${MAX_CONSTRAINT_TEXT_BYTES} AS definition_within_limit,
    CASE WHEN constraint_row.contype <> 'c' THEN NULL
      WHEN pg_catalog.octet_length(pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        false
      )) <= ${MAX_CONSTRAINT_TEXT_BYTES}
      THEN pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)
      ELSE NULL
    END AS check_expression,
    CASE
      WHEN constraint_row.contype <> 'c' THEN true
      WHEN constraint_row.contype = 'c'
      THEN pg_catalog.octet_length(pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        false
      )) <= ${MAX_CONSTRAINT_TEXT_BYTES}
    END AS check_expression_within_limit
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_namespace AS constraint_namespace ON constraint_namespace.oid = constraint_row.connamespace
  LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
  LEFT JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_type AS domain_type ON domain_type.oid = constraint_row.contypid
  LEFT JOIN pg_catalog.pg_namespace AS domain_namespace ON domain_namespace.oid = domain_type.typnamespace
  LEFT JOIN pg_catalog.pg_class AS referenced_relation ON referenced_relation.oid = constraint_row.confrelid
  LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace
  LEFT JOIN pg_catalog.pg_class AS supporting_index ON supporting_index.oid = constraint_row.conindid
  LEFT JOIN pg_catalog.pg_namespace AS supporting_index_namespace ON supporting_index_namespace.oid = supporting_index.relnamespace
  LEFT JOIN pg_catalog.pg_constraint AS parent_constraint ON parent_constraint.oid = constraint_row.conparentid
  LEFT JOIN pg_catalog.pg_trigger AS constraint_trigger
    ON constraint_row.contype = 't'
   AND constraint_trigger.tgconstraint = constraint_row.oid
   AND NOT constraint_trigger.tgisinternal
  LEFT JOIN pg_catalog.pg_class AS parent_relation ON parent_relation.oid = parent_constraint.conrelid
  LEFT JOIN pg_catalog.pg_namespace AS parent_relation_namespace ON parent_relation_namespace.oid = parent_relation.relnamespace
  LEFT JOIN pg_catalog.pg_type AS parent_domain ON parent_domain.oid = parent_constraint.contypid
  LEFT JOIN pg_catalog.pg_namespace AS parent_domain_namespace ON parent_domain_namespace.oid = parent_domain.typnamespace
  LEFT JOIN pg_catalog.pg_depend AS extension_dependency
    ON extension_dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
   AND extension_dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
   AND extension_dependency.objid = constraint_row.oid
   AND extension_dependency.objsubid = 0
   AND extension_dependency.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension AS extension_row ON extension_row.oid = extension_dependency.refobjid
  WHERE constraint_namespace.nspname <> 'information_schema'
    AND constraint_namespace.nspname !~ '^pg_'
    AND (constraint_row.conrelid <> 0 OR constraint_row.contypid <> 0)
`;

const constraintCatalogOrder = `
  ORDER BY
    constraint_namespace.nspname COLLATE "C",
    object_kind,
    COALESCE(relation.relname, domain_type.typname) COLLATE "C",
    constraint_row.conname COLLATE "C"
`;

const constraintCatalogQuery = `${constraintCatalogQueryBase}
  ${constraintCatalogOrder}
  LIMIT ${MAX_CONSTRAINT_CATALOG_ROWS + 1}
`;

const constraintCatalogIdentityQuery = `${constraintCatalogQueryBase}
    AND constraint_namespace.nspname = $1
    AND constraint_row.conname = $2
    AND (
      ($3 = 'TABLE' AND constraint_row.conrelid <> 0 AND relation.relname = $4)
      OR ($3 = 'DOMAIN' AND constraint_row.contypid <> 0 AND domain_type.typname = $4)
    )
  ${constraintCatalogOrder}
  LIMIT 2
`;

const checkConstraintPreflightQuery = `
  SELECT
    constraint_namespace.nspname AS namespace_name,
    constraint_row.conname AS constraint_name,
    CASE WHEN constraint_row.conrelid <> 0 THEN 'TABLE' ELSE 'DOMAIN' END AS object_kind,
    relation_namespace.nspname AS relation_namespace_name,
    relation.relname AS relation_name,
    domain_namespace.nspname AS domain_namespace_name,
    domain_type.typname AS domain_name,
    constraint_row.contype::text AS type,
    pg_catalog.octet_length(pg_catalog.pg_get_expr(
      constraint_row.conbin,
      constraint_row.conrelid,
      false
    ))::text AS expression_bytes,
    pg_catalog.octet_length(constraint_row.conbin::text)::text AS tree_bytes,
    (SELECT pg_catalog.count(*)::text
      FROM pg_catalog.pg_depend AS dependency
      WHERE dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
        AND dependency.objid = constraint_row.oid
        AND dependency.objsubid = 0) AS dependency_count,
    (SELECT pg_catalog.count(*)::text
      FROM pg_catalog.regexp_matches(
        CASE WHEN pg_catalog.octet_length(constraint_row.conbin::text) <= ${MAX_CHECK_TREE_BYTES}
          THEN constraint_row.conbin::text ELSE '' END,
        '\\{([A-Z][A-Z0-9_]*)[[:space:]}]',
        'g'
      )) AS node_count
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_namespace AS constraint_namespace ON constraint_namespace.oid = constraint_row.connamespace
  LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
  LEFT JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_type AS domain_type ON domain_type.oid = constraint_row.contypid
  LEFT JOIN pg_catalog.pg_namespace AS domain_namespace ON domain_namespace.oid = domain_type.typnamespace
  WHERE constraint_row.oid = $1::pg_catalog.oid
    AND constraint_row.contype = 'c'
`;

const checkConstraintDependencyPreflightQuery = `
  WITH dependency_identity AS MATERIALIZED (
    SELECT
      dependency.deptype::text AS dependency_type,
      identified.type,
      identified.schema,
      identified.name,
      identified.identity
    FROM pg_catalog.pg_depend AS dependency
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(
      dependency.refclassid,
      dependency.refobjid,
      dependency.refobjsubid
    ) AS identified
    WHERE dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
      AND dependency.objid = $1::pg_catalog.oid
      AND dependency.objsubid = 0
    LIMIT ${MAX_CHECK_DEPENDENCIES + 1}
  )
  SELECT
    COALESCE(pg_catalog.max(GREATEST(
      pg_catalog.octet_length(dependency_type),
      pg_catalog.octet_length(type),
      pg_catalog.octet_length(COALESCE(schema, '')),
      pg_catalog.octet_length(COALESCE(name, '')),
      pg_catalog.octet_length(identity)
    )), 0)::text AS max_field_bytes,
    COALESCE(pg_catalog.sum(
      pg_catalog.octet_length(dependency_type)
      + pg_catalog.octet_length(type)
      + pg_catalog.octet_length(COALESCE(schema, ''))
      + pg_catalog.octet_length(COALESCE(name, ''))
      + pg_catalog.octet_length(identity)
    ), 0)::text AS total_bytes
  FROM dependency_identity
`;

const checkConstraintExpressionQuery = `
  SELECT pg_catalog.pg_get_expr(conbin, conrelid, false) AS check_expression
  FROM pg_catalog.pg_constraint
  WHERE oid = $1::pg_catalog.oid AND contype = 'c'
`;

const checkConstraintDependencyQuery = `
  SELECT
    dependency.deptype::text AS dependency_type,
    identified.type,
    identified.schema,
    identified.name,
    identified.identity
  FROM pg_catalog.pg_depend AS dependency
  CROSS JOIN LATERAL pg_catalog.pg_identify_object(
    dependency.refclassid,
    dependency.refobjid,
    dependency.refobjsubid
  ) AS identified
  WHERE dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
    AND dependency.objid = $1::pg_catalog.oid
    AND dependency.objsubid = 0
  ORDER BY
    dependency.deptype::text COLLATE "C",
    identified.type COLLATE "C",
    COALESCE(identified.schema, '') COLLATE "C",
    COALESCE(identified.name, '') COLLATE "C",
    identified.identity COLLATE "C"
  LIMIT ${MAX_CHECK_DEPENDENCIES + 1}
`;

const checkConstraintNodeQuery = `
  SELECT node_match[1] AS node_tag, pg_catalog.count(*)::text AS node_count
  FROM pg_catalog.pg_constraint AS constraint_row
  CROSS JOIN LATERAL pg_catalog.regexp_matches(
    constraint_row.conbin::text,
    '\\{([A-Z][A-Z0-9_]*)[[:space:]}]',
    'g'
  ) AS node_match
  WHERE constraint_row.oid = $1::pg_catalog.oid AND constraint_row.contype = 'c'
  GROUP BY node_match[1]
`;

const isBoolean = (value) => typeof value === "boolean";
const isNullableString = (value) => value === null || typeof value === "string";
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isOperatorIdentityArray = (value) => Array.isArray(value) && value.every(
  (entry) => Array.isArray(entry) && entry.length === 6 && entry.every((part) => typeof part === "string"),
);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const dependencyClass = (type) => {
  const normalized = type.toLowerCase();
  if (normalized === "collation") return "COLLATION";
  if (normalized === "function") return "FUNCTION";
  if (normalized === "operator") return "OPERATOR";
  if (normalized === "table" || normalized === "table column" || normalized === "relation") return "RELATION";
  if (normalized === "type") return "TYPE";
  return "OTHER";
};

const normalizeConstraintCatalogRow = (row) => {
  const requiredStrings = [
    "namespace_name",
    "constraint_name",
    "object_kind",
    "type",
    "definition",
    "foreign_key_update_action",
    "foreign_key_delete_action",
    "foreign_key_match_type",
  ];
  const requiredBooleans = [
    "deferrable",
    "initially_deferred",
    "validated",
    "enforced",
    "locally_defined",
    "no_inherit",
    "period",
    "has_parent",
    "has_referenced_relation",
    "has_supporting_index",
    "definition_within_limit",
    "check_expression_within_limit",
  ];
  const nullableStrings = [
    "relation_namespace_name",
    "relation_name",
    "domain_namespace_name",
    "domain_name",
    "parent_constraint_name",
    "parent_relation_namespace_name",
    "parent_relation_name",
    "parent_domain_namespace_name",
    "parent_domain_name",
    "referenced_namespace_name",
    "referenced_relation_name",
    "supporting_index_namespace_name",
    "supporting_index_name",
    "extension_name",
    "check_expression",
  ];
  const countedArrays = [
    ["key_column_count", "key_columns"],
    ["referenced_key_column_count", "referenced_key_columns"],
    ["delete_set_column_count", "delete_set_columns"],
    ["primary_foreign_operator_count", "primary_foreign_operators"],
    ["primary_primary_operator_count", "primary_primary_operators"],
    ["foreign_foreign_operator_count", "foreign_foreign_operators"],
    ["exclusion_operator_count", "exclusion_operators"],
  ];
  if (
    row === null
    || typeof row !== "object"
    || requiredStrings.some((field) => typeof row[field] !== "string" || row[field].length === 0)
    || requiredBooleans.some((field) => !isBoolean(row[field]))
    || nullableStrings.some((field) => !isNullableString(row[field]))
    || !/^(?:0|[1-9][0-9]{0,4})$/u.test(row.inheritance_count)
    || !CONSTRAINT_TYPES.has(row.type)
    || !isStringArray(row.key_columns)
    || !isStringArray(row.referenced_key_columns)
    || !isStringArray(row.delete_set_columns)
    || !isOperatorIdentityArray(row.primary_foreign_operators)
    || !isOperatorIdentityArray(row.primary_primary_operators)
    || !isOperatorIdentityArray(row.foreign_foreign_operators)
    || !isOperatorIdentityArray(row.exclusion_operators)
    || !/^(?:0|[1-9][0-9]{0,9})$/u.test(row.constraint_oid)
    || BigInt(row.constraint_oid) > MAX_POSTGRES_OID
    || countedArrays.some(([countField, arrayField]) => (
      !/^(?:0|[1-9][0-9]{0,4})$/u.test(row[countField])
      || Number(row[countField]) !== row[arrayField].length
    ))
    || !/^[ arcdn]$/u.test(row.foreign_key_update_action)
    || !/^[ arcdn]$/u.test(row.foreign_key_delete_action)
    || !/^[ fps]$/u.test(row.foreign_key_match_type)
  ) fail("INVALID_CONSTRAINT_CATALOG_ROW");
  const tableIdentity = [row.relation_namespace_name, row.relation_name];
  const domainIdentity = [row.domain_namespace_name, row.domain_name];
  const objectIdentity = row.object_kind === "TABLE" ? tableIdentity : domainIdentity;
  if (
    !["TABLE", "DOMAIN"].includes(row.object_kind)
    || objectIdentity.some((part) => typeof part !== "string" || part.length === 0)
    || (row.object_kind === "TABLE" && domainIdentity.some((part) => part !== null))
    || (row.object_kind === "DOMAIN" && tableIdentity.some((part) => part !== null))
    || row.namespace_name !== objectIdentity[0]
    || row.initially_deferred && !row.deferrable
    || (row.type === "c") !== (row.check_expression !== null)
    || (row.type === "f") !== row.has_referenced_relation
  ) fail("INVALID_CONSTRAINT_CATALOG_ROW");
  const referencedIdentity = row.has_referenced_relation
    ? [row.referenced_namespace_name, row.referenced_relation_name]
    : null;
  const supportingIndexIdentity = row.has_supporting_index
    ? [row.supporting_index_namespace_name, row.supporting_index_name]
    : null;
  const parentIdentity = row.has_parent
    ? [
        row.parent_relation_name === null ? "DOMAIN" : "TABLE",
        row.parent_relation_name === null ? row.parent_domain_namespace_name : row.parent_relation_namespace_name,
        row.parent_relation_name === null ? row.parent_domain_name : row.parent_relation_name,
        row.parent_constraint_name,
      ]
    : null;
  if (
    (referencedIdentity === null
      ? [row.referenced_namespace_name, row.referenced_relation_name].some((part) => part !== null)
      : referencedIdentity.some((part) => typeof part !== "string" || part.length === 0))
    || (supportingIndexIdentity === null
      ? [row.supporting_index_namespace_name, row.supporting_index_name].some((part) => part !== null)
      : supportingIndexIdentity.some((part) => typeof part !== "string" || part.length === 0))
    || (parentIdentity === null
      ? [
          row.parent_constraint_name,
          row.parent_relation_namespace_name,
          row.parent_relation_name,
          row.parent_domain_namespace_name,
          row.parent_domain_name,
        ].some((part) => part !== null)
      : parentIdentity.slice(1).some((part) => typeof part !== "string" || part.length === 0))
  ) fail("INVALID_CONSTRAINT_CATALOG_ROW");
  const identity = [row.object_kind, ...objectIdentity, row.constraint_name];
  const definitionTokens = tokenizeSchemaDump(row.definition);
  const checkExpressionTokens = row.check_expression === null ? null : tokenizeSchemaDump(row.check_expression);
  return {
    key: JSON.stringify(identity),
    type: CONSTRAINT_TYPES.get(row.type),
    semantics: {
      TYPE: row.type,
      VALIDATION: row.validated,
      ENFORCEMENT: row.enforced,
      INHERITANCE: [row.locally_defined, Number(row.inheritance_count), row.no_inherit],
      DEFERRABILITY: [row.deferrable, row.initially_deferred],
      PERIOD: row.period,
      FK_ACTION: [row.foreign_key_match_type, row.foreign_key_update_action, row.foreign_key_delete_action],
      PARENTAGE: parentIdentity,
      BINDING: [
        row.key_columns,
        referencedIdentity,
        row.referenced_key_columns,
        row.delete_set_columns,
        row.primary_foreign_operators,
        row.primary_primary_operators,
        row.foreign_foreign_operators,
        row.exclusion_operators,
        supportingIndexIdentity,
      ],
      DEFINITION: schemaTokenDigest(definitionTokens),
      CHECK_EXPRESSION: row.check_expression === null
        ? null
        : schemaTokenDigest(checkExpressionTokens),
      EXTENSION_OWNERSHIP: row.extension_name,
    },
    diagnostic: {
      constraintOid: row.constraint_oid,
    },
  };
};

const normalizeBoundedConstraintCatalogRow = (rawRow) => {
  if (rawRow.definition_within_limit !== true || rawRow.check_expression_within_limit !== true) {
    fail("CONSTRAINT_TEXT_LIMIT_EXCEEDED");
  }
  return normalizeConstraintCatalogRow(rawRow);
};

export const collectConstraintCatalogManifest = async (client, failureCode) => {
  try {
    const result = await client.query(constraintCatalogQuery);
    if (result.rows.length > MAX_CONSTRAINT_CATALOG_ROWS) fail("CONSTRAINT_CATALOG_LIMIT_EXCEEDED");
    const manifest = new Map();
    for (const rawRow of result.rows) {
      const row = normalizeBoundedConstraintCatalogRow(rawRow);
      if (manifest.has(row.key)) fail("DUPLICATE_CONSTRAINT_CATALOG_IDENTITY");
      manifest.set(row.key, row);
    }
    return manifest;
  } catch (error) {
    if (isRehearsalError(error)) throw error;
    fail(failureCode);
  }
};

const parseDiagnosticCount = (value) => {
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) throw new Error("INVALID_DIAGNOSTIC_COUNT");
  return Number(value);
};

const checkConstraintIdentityKey = (row) => {
  if (
    row === null
    || typeof row !== "object"
    || !["TABLE", "DOMAIN"].includes(row.object_kind)
    || typeof row.namespace_name !== "string"
    || typeof row.constraint_name !== "string"
    || row.type !== "c"
  ) return null;
  const objectIdentity = row.object_kind === "TABLE"
    ? [row.relation_namespace_name, row.relation_name]
    : [row.domain_namespace_name, row.domain_name];
  if (
    objectIdentity.some((part) => typeof part !== "string" || part.length === 0)
    || row.namespace_name !== objectIdentity[0]
  ) return null;
  return JSON.stringify([row.object_kind, ...objectIdentity, row.constraint_name]);
};

const checkDetailFailure = (status, stage, limitKind = null) => ({
  ok: false,
  status,
  stage,
  limitKind,
});

export const collectCheckConstraintDetail = async (client, manifestEntry) => {
  let stage = "REBIND";
  try {
    if (
      manifestEntry?.type !== "CHECK"
      || !/^(?:0|[1-9][0-9]{0,9})$/u.test(manifestEntry?.diagnostic?.constraintOid)
      || BigInt(manifestEntry.diagnostic.constraintOid) > MAX_POSTGRES_OID
    ) return checkDetailFailure("IDENTITY_REBIND_FAILED", stage);
    const oid = manifestEntry.diagnostic.constraintOid;
    stage = "PREFLIGHT";
    const preflight = await client.query(checkConstraintPreflightQuery, [oid]);
    if (preflight.rowCount !== 1 || checkConstraintIdentityKey(preflight.rows[0]) !== manifestEntry.key) {
      return checkDetailFailure("IDENTITY_REBIND_FAILED", "REBIND");
    }
    const expressionBytes = parseDiagnosticCount(preflight.rows[0].expression_bytes);
    const treeBytes = parseDiagnosticCount(preflight.rows[0].tree_bytes);
    const dependencyCount = parseDiagnosticCount(preflight.rows[0].dependency_count);
    const nodeCount = parseDiagnosticCount(preflight.rows[0].node_count);
    if (expressionBytes > MAX_CONSTRAINT_TEXT_BYTES) return checkDetailFailure("LIMIT_EXCEEDED", stage, "EXPRESSION_BYTES");
    if (treeBytes > MAX_CHECK_TREE_BYTES) return checkDetailFailure("LIMIT_EXCEEDED", stage, "TREE_BYTES");
    if (dependencyCount > MAX_CHECK_DEPENDENCIES) return checkDetailFailure("LIMIT_EXCEEDED", stage, "DEPENDENCY_COUNT");
    if (nodeCount > MAX_CHECK_NODE_TAGS) return checkDetailFailure("LIMIT_EXCEEDED", stage, "NODE_COUNT");

    stage = "DEPENDENCY_PREFLIGHT";
    const dependencyPreflight = await client.query(checkConstraintDependencyPreflightQuery, [oid]);
    if (dependencyPreflight.rowCount !== 1) return checkDetailFailure("COLLECTION_UNAVAILABLE", stage);
    const maxFieldBytes = parseDiagnosticCount(dependencyPreflight.rows[0].max_field_bytes);
    const totalBytes = parseDiagnosticCount(dependencyPreflight.rows[0].total_bytes);
    if (maxFieldBytes > MAX_CHECK_DEPENDENCY_FIELD_BYTES) {
      return checkDetailFailure("LIMIT_EXCEEDED", stage, "DEPENDENCY_BYTES");
    }
    if (totalBytes > MAX_CHECK_DEPENDENCY_TOTAL_BYTES) {
      return checkDetailFailure("LIMIT_EXCEEDED", stage, "DEPENDENCY_BYTES");
    }

    stage = "EXPRESSION_FETCH";
    const expressionResult = await client.query(checkConstraintExpressionQuery, [oid]);
    if (
      expressionResult.rowCount !== 1
      || typeof expressionResult.rows[0].check_expression !== "string"
      || Buffer.byteLength(expressionResult.rows[0].check_expression, "utf8") !== expressionBytes
    ) return checkDetailFailure("COLLECTION_UNAVAILABLE", stage);
    stage = "TOKENIZE";
    const tokens = tokenizeSchemaDump(expressionResult.rows[0].check_expression);
    if (tokens.length > MAX_CHECK_EDIT_TOKENS) return checkDetailFailure("LIMIT_EXCEEDED", stage, "TOKENS");

    stage = "DEPENDENCY_FETCH";
    const dependencyResult = await client.query(checkConstraintDependencyQuery, [oid]);
    if (dependencyResult.rows.length !== dependencyCount) return checkDetailFailure("COLLECTION_UNAVAILABLE", stage);
    const dependencies = dependencyResult.rows.map((row) => {
      const identity = [row.dependency_type, row.type, row.schema, row.name, row.identity];
      if (
        typeof identity[0] !== "string"
        || identity[0].length !== 1
        || typeof identity[1] !== "string"
        || identity[1].length === 0
        || !isNullableString(identity[2])
        || !isNullableString(identity[3])
        || typeof identity[4] !== "string"
        || identity[4].length === 0
      ) throw new Error("INVALID_DEPENDENCY_IDENTITY");
      return identity;
    });

    stage = "NODE_COUNT";
    const nodeResult = await client.query(checkConstraintNodeQuery, [oid]);
    const nodeTagCounts = Object.fromEntries(CHECK_NODE_TAGS.map((tag) => [tag, 0]));
    let observedNodeCount = 0;
    for (const row of nodeResult.rows) {
      if (typeof row.node_tag !== "string") throw new Error("INVALID_NODE_TAG");
      const count = parseDiagnosticCount(row.node_count);
      const tag = CHECK_NODE_TAGS.includes(row.node_tag) ? row.node_tag : "OTHER";
      nodeTagCounts[tag] += count;
      observedNodeCount += count;
    }
    if (observedNodeCount !== nodeCount) return checkDetailFailure("COLLECTION_UNAVAILABLE", "NODE_COUNT");
    return { ok: true, tokens, dependencies, nodeTagCounts };
  } catch {
    return checkDetailFailure("COLLECTION_UNAVAILABLE", stage);
  }
};

export const collectReboundSourceCheckDetail = async (
  sourceConfig,
  manifestEntry,
  createClient = (config) => new Client(config),
) => {
  let client;
  let transactionOpen = false;
  try {
    const identity = JSON.parse(manifestEntry?.key ?? "null");
    if (
      !Array.isArray(identity)
      || identity.length !== 4
      || !["TABLE", "DOMAIN"].includes(identity[0])
      || identity.slice(1).some((part) => typeof part !== "string" || part.length === 0)
    ) return checkDetailFailure("IDENTITY_REBIND_FAILED", "REBIND");
    client = createClient(nodeClientConfig(sourceConfig, "corgtex_rehearsal_source_check_rebind"));
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL transaction_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query("SET LOCAL search_path = pg_catalog");
    const reboundResult = await client.query(constraintCatalogIdentityQuery, [
      identity[1],
      identity[3],
      identity[0],
      identity[2],
    ]);
    if (reboundResult.rowCount !== 1) return checkDetailFailure("IDENTITY_REBIND_FAILED", "REBIND");
    let rebound;
    try {
      rebound = normalizeBoundedConstraintCatalogRow(reboundResult.rows[0]);
    } catch {
      return checkDetailFailure("SOURCE_REBIND_DRIFT", "REBIND");
    }
    if (rebound.key !== manifestEntry.key || rebound.type !== "CHECK") {
      return checkDetailFailure("IDENTITY_REBIND_FAILED", "REBIND");
    }
    if (
      rebound.diagnostic.constraintOid !== manifestEntry.diagnostic.constraintOid
      || !same(rebound.semantics, manifestEntry.semantics)
    ) return checkDetailFailure("SOURCE_REBIND_DRIFT", "REBIND");
    const detail = await collectCheckConstraintDetail(client, rebound);
    if (detail.ok !== true) return detail;
    await client.query("COMMIT");
    transactionOpen = false;
    return detail;
  } catch {
    return checkDetailFailure("COLLECTION_UNAVAILABLE", "REBIND");
  } finally {
    if (transactionOpen) await client?.query("ROLLBACK").catch(() => {});
    await client?.end().catch(() => {});
  }
};

const emptyConstraintCounts = () => Object.fromEntries([...CONSTRAINT_TYPES.values()].map((type) => [type, 0]));

const emptyCheckEditCounts = () => Object.fromEntries(CHECK_EDIT_CATEGORIES.map((category) => [category, 0]));

const sameSchemaToken = (left, right) => left?.domain === right?.domain && left?.value === right?.value;

const isCheckIdentifierToken = (token) => token?.domain === "DDL_TOKEN"
  && (/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(token.value) || /^"(?:[^"]|"")+"$/u.test(token.value));

const setCheckContextCategory = (categories, indexes, category) => {
  const resolvedCategory = indexes.some((index) => categories.has(index) && categories.get(index) !== category)
    ? "OTHER"
    : category;
  for (const index of indexes) categories.set(index, resolvedCategory);
};

const checkContextualTokenCategories = (tokens) => {
  const categories = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.domain !== "DDL_TOKEN" || !/^collate$/iu.test(token.value)) continue;
    if (!isCheckIdentifierToken(tokens[index + 1])) {
      setCheckContextCategory(categories, [index], "OTHER");
      continue;
    }
    if (tokens[index + 2]?.value !== ".") {
      setCheckContextCategory(categories, [index, index + 1], "COLLATION");
      continue;
    }
    const span = [index, index + 1, index + 2];
    if (isCheckIdentifierToken(tokens[index + 3])) span.push(index + 3);
    if (!isCheckIdentifierToken(tokens[index + 3]) || tokens[index + 4]?.value === ".") {
      let cursor = index + 4;
      while (tokens[cursor]?.value === "." || isCheckIdentifierToken(tokens[cursor])) {
        span.push(cursor);
        cursor += 1;
      }
      setCheckContextCategory(categories, span, "OTHER");
      continue;
    }
    setCheckContextCategory(categories, span, "COLLATION");
  }
  for (let parenthesisIndex = 0; parenthesisIndex < tokens.length; parenthesisIndex += 1) {
    if (tokens[parenthesisIndex]?.domain !== "DDL_TOKEN" || tokens[parenthesisIndex].value !== "(") continue;
    const terminalIndex = parenthesisIndex - 1;
    if (!isCheckIdentifierToken(tokens[terminalIndex])) {
      if (tokens[terminalIndex]?.value !== ".") continue;
      const span = [terminalIndex];
      let cursor = terminalIndex - 1;
      while (cursor >= 0 && (tokens[cursor]?.value === "." || isCheckIdentifierToken(tokens[cursor]))) {
        span.unshift(cursor);
        cursor -= 1;
      }
      setCheckContextCategory(categories, span, "OTHER");
      continue;
    }
    const terminal = tokens[terminalIndex];
    const terminalNormalized = terminal.value.toLowerCase();
    const terminalIsKeyword = !terminal.value.startsWith('"')
      && (CHECK_OPERATOR_WORDS.has(terminalNormalized) || BUILTIN_TYPE_NAMES.has(terminalNormalized));
    if (tokens[terminalIndex - 1]?.value !== ".") {
      if (!terminalIsKeyword) setCheckContextCategory(categories, [terminalIndex], "FUNCTION");
      continue;
    }
    const span = [terminalIndex - 1, terminalIndex];
    if (isCheckIdentifierToken(tokens[terminalIndex - 2])) span.unshift(terminalIndex - 2);
    if (
      terminalIsKeyword
      || !isCheckIdentifierToken(tokens[terminalIndex - 2])
      || tokens[terminalIndex - 3]?.value === "."
    ) {
      let cursor = terminalIndex - 3;
      while (cursor >= 0 && (tokens[cursor]?.value === "." || isCheckIdentifierToken(tokens[cursor]))) {
        span.unshift(cursor);
        cursor -= 1;
      }
      setCheckContextCategory(categories, span, "OTHER");
      continue;
    }
    setCheckContextCategory(categories, span, "FUNCTION");
  }
  return categories;
};

const checkEditCategory = (tokens, contextualTokenCategories, index) => {
  const token = tokens[index];
  if (token.domain === "STRING_LITERAL") return "STRING_LITERAL";
  if (token.domain !== "DDL_TOKEN") return "OTHER";
  if (token.value === "(" || token.value === ")") return "PARENTHESIS";
  if (token.value === "::") return "CAST_OPERATOR";
  if (contextualTokenCategories.has(index)) return contextualTokenCategories.get(index);
  if (/^"(?:[^"]|"")+"$/u.test(token.value)) {
    return tokens[index + 1]?.value === "(" ? "FUNCTION" : "COLUMN_REFERENCE";
  }
  const normalized = token.value.replace(/^"|"$/gu, "").toLowerCase();
  if (BUILTIN_TYPE_NAMES.has(normalized)) return "BUILTIN_TYPE";
  if (isSchemaOperator(token.value) || CHECK_OPERATOR_WORDS.has(normalized)) return "OPERATOR";
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(token.value)) {
    return tokens[index + 1]?.value === "(" ? "FUNCTION" : "COLUMN_REFERENCE";
  }
  return "OTHER";
};

const unwrapCheckExpression = (tokens) => {
  let current = tokens;
  let layers = 0;
  while (current.length >= 3 && current[0]?.value === "(" && current.at(-1)?.value === ")") {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index].domain === "DDL_TOKEN" && current[index].value === "(") depth += 1;
      if (current[index].domain === "DDL_TOKEN" && current[index].value === ")") depth -= 1;
      if (depth < 0 || (depth === 0 && index < current.length - 1)) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression || depth !== 0) break;
    current = current.slice(1, -1);
    layers += 1;
  }
  return { tokens: current, layers };
};

export const buildUniqueCheckTokenEdit = (sourceTokens, destinationTokens) => {
  if (!Array.isArray(sourceTokens) || !Array.isArray(destinationTokens)) fail("INVALID_CHECK_TOKEN_STREAM");
  if (sourceTokens.length > MAX_CHECK_EDIT_TOKENS || destinationTokens.length > MAX_CHECK_EDIT_TOKENS) {
    return { status: "LIMIT_EXCEEDED", sourceOnly: null, destinationOnly: null };
  }
  schemaTokenDigest(sourceTokens);
  schemaTokenDigest(destinationTokens);
  const sourceContextualTokenCategories = checkContextualTokenCategories(sourceTokens);
  const destinationContextualTokenCategories = checkContextualTokenCategories(destinationTokens);
  const sourceUnwrapped = unwrapCheckExpression(sourceTokens);
  const destinationUnwrapped = unwrapCheckExpression(destinationTokens);
  if (
    sourceUnwrapped.layers !== destinationUnwrapped.layers
    && sourceUnwrapped.tokens.length === destinationUnwrapped.tokens.length
    && sourceUnwrapped.tokens.every((token, index) => sameSchemaToken(token, destinationUnwrapped.tokens[index]))
  ) {
    const sourceOnly = emptyCheckEditCounts();
    const destinationOnly = emptyCheckEditCounts();
    if (sourceUnwrapped.layers > destinationUnwrapped.layers) {
      sourceOnly.PARENTHESIS = (sourceUnwrapped.layers - destinationUnwrapped.layers) * 2;
    } else {
      destinationOnly.PARENTHESIS = (destinationUnwrapped.layers - sourceUnwrapped.layers) * 2;
    }
    return { status: "UNIQUE", sourceOnly, destinationOnly };
  }
  const rows = sourceTokens.length + 1;
  const columns = destinationTokens.length + 1;
  const costs = Array.from({ length: rows }, () => new Uint16Array(columns));
  const ways = Array.from({ length: rows }, () => new Uint8Array(columns));
  ways[0][0] = 1;
  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    costs[sourceIndex][0] = sourceIndex;
    ways[sourceIndex][0] = 1;
  }
  for (let destinationIndex = 1; destinationIndex < columns; destinationIndex += 1) {
    costs[0][destinationIndex] = destinationIndex;
    ways[0][destinationIndex] = 1;
  }
  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    for (let destinationIndex = 1; destinationIndex < columns; destinationIndex += 1) {
      const candidates = [
        { cost: costs[sourceIndex - 1][destinationIndex] + 1, ways: ways[sourceIndex - 1][destinationIndex] },
        { cost: costs[sourceIndex][destinationIndex - 1] + 1, ways: ways[sourceIndex][destinationIndex - 1] },
      ];
      if (sameSchemaToken(sourceTokens[sourceIndex - 1], destinationTokens[destinationIndex - 1])) {
        candidates.push({
          cost: costs[sourceIndex - 1][destinationIndex - 1],
          ways: ways[sourceIndex - 1][destinationIndex - 1],
        });
      } else {
        candidates.push({
          cost: costs[sourceIndex - 1][destinationIndex - 1] + 1,
          ways: ways[sourceIndex - 1][destinationIndex - 1],
        });
      }
      const minimum = Math.min(...candidates.map(({ cost }) => cost));
      costs[sourceIndex][destinationIndex] = minimum;
      ways[sourceIndex][destinationIndex] = Math.min(
        2,
        candidates.filter(({ cost }) => cost === minimum).reduce((sum, candidate) => sum + candidate.ways, 0),
      );
    }
  }
  if (ways.at(-1).at(-1) !== 1) {
    return { status: "AMBIGUOUS", sourceOnly: null, destinationOnly: null };
  }
  const sourceOnly = emptyCheckEditCounts();
  const destinationOnly = emptyCheckEditCounts();
  let sourceIndex = sourceTokens.length;
  let destinationIndex = destinationTokens.length;
  while (sourceIndex > 0 || destinationIndex > 0) {
    if (
      sourceIndex > 0
      && destinationIndex > 0
      && sameSchemaToken(sourceTokens[sourceIndex - 1], destinationTokens[destinationIndex - 1])
      && costs[sourceIndex][destinationIndex] === costs[sourceIndex - 1][destinationIndex - 1]
    ) {
      sourceIndex -= 1;
      destinationIndex -= 1;
    } else if (
      sourceIndex > 0
      && destinationIndex > 0
      && costs[sourceIndex][destinationIndex] === costs[sourceIndex - 1][destinationIndex - 1] + 1
    ) {
      sourceOnly[checkEditCategory(sourceTokens, sourceContextualTokenCategories, sourceIndex - 1)] += 1;
      destinationOnly[checkEditCategory(destinationTokens, destinationContextualTokenCategories, destinationIndex - 1)] += 1;
      sourceIndex -= 1;
      destinationIndex -= 1;
    } else if (
      sourceIndex > 0
      && costs[sourceIndex][destinationIndex] === costs[sourceIndex - 1][destinationIndex] + 1
    ) {
      sourceOnly[checkEditCategory(sourceTokens, sourceContextualTokenCategories, sourceIndex - 1)] += 1;
      sourceIndex -= 1;
    } else if (
      destinationIndex > 0
      && costs[sourceIndex][destinationIndex] === costs[sourceIndex][destinationIndex - 1] + 1
    ) {
      destinationOnly[checkEditCategory(destinationTokens, destinationContextualTokenCategories, destinationIndex - 1)] += 1;
      destinationIndex -= 1;
    } else {
      fail("CHECK_TOKEN_EDIT_BACKTRACK_FAILED");
    }
  }
  return { status: "UNIQUE", sourceOnly, destinationOnly };
};

const countDifference = (source, destination, keys) => ({
  sourceOnly: Object.fromEntries(keys.map((key) => [key, Math.max(0, source[key] - destination[key])])),
  destinationOnly: Object.fromEntries(keys.map((key) => [key, Math.max(0, destination[key] - source[key])])),
});

const dependencyDifference = (source, destination) => {
  const groups = (dependencies) => {
    const result = Object.fromEntries(CHECK_DEPENDENCY_CLASSES.map((kind) => [kind, new Map()]));
    for (const dependency of dependencies) {
      const kind = dependencyClass(dependency[1]);
      const key = JSON.stringify(dependency);
      result[kind].set(key, (result[kind].get(key) ?? 0) + 1);
    }
    return result;
  };
  const sourceGroups = groups(source);
  const destinationGroups = groups(destination);
  const changedClasses = CHECK_DEPENDENCY_CLASSES.filter((kind) => {
    const keys = new Set([...sourceGroups[kind].keys(), ...destinationGroups[kind].keys()]);
    return [...keys].some((key) => sourceGroups[kind].get(key) !== destinationGroups[kind].get(key));
  });
  return {
    identitySetEqual: same(source, destination),
    changedClasses,
  };
};

const emptyCheckExpressionDifference = (status, limitKind = null, side = null, stage = null) => ({
  status,
  limitKind,
  side,
  stage,
  tokenEdit: null,
  nodeTagDeltas: null,
  dependencies: null,
});

const buildCheckExpressionDifference = (source, destination) => {
  if (source?.ok !== true) {
    return emptyCheckExpressionDifference(
      source?.status ?? "COLLECTION_UNAVAILABLE",
      source?.limitKind,
      "SOURCE",
      source?.stage ?? null,
    );
  }
  if (destination?.ok !== true) {
    return emptyCheckExpressionDifference(
      destination?.status ?? "COLLECTION_UNAVAILABLE",
      destination?.limitKind,
      "DESTINATION",
      destination?.stage ?? null,
    );
  }
  const tokenEdit = buildUniqueCheckTokenEdit(source.tokens, destination.tokens);
  if (tokenEdit.status === "LIMIT_EXCEEDED") return emptyCheckExpressionDifference("LIMIT_EXCEEDED", "TOKENS");
  if (tokenEdit.status !== "UNIQUE") return emptyCheckExpressionDifference("AMBIGUOUS");
  return {
    status: "UNIQUE",
    limitKind: null,
    side: null,
    stage: null,
    tokenEdit,
    nodeTagDeltas: countDifference(source.nodeTagCounts, destination.nodeTagCounts, CHECK_NODE_TAGS),
    dependencies: dependencyDifference(source.dependencies, destination.dependencies),
  };
};

const analyzeConstraintSemanticManifests = (
  sourceManifest,
  destinationManifest,
  serverVersionRelation = "UNAVAILABLE",
  checkDetails = null,
) => {
  if (!(sourceManifest instanceof Map) || !(destinationManifest instanceof Map)) {
    fail("INVALID_CONSTRAINT_CATALOG_MANIFEST");
  }
  if (!["MATCH", "DIFFERENT", "UNAVAILABLE"].includes(serverVersionRelation)) {
    fail("INVALID_CONSTRAINT_SERVER_VERSION_RELATION");
  }
  const countsFor = (manifest) => {
    const counts = emptyConstraintCounts();
    for (const entry of manifest.values()) {
      if (
        !Object.hasOwn(counts, entry?.type)
        || entry.semantics === null
        || typeof entry.semantics !== "object"
        || CONSTRAINT_MISMATCH_FIELDS.slice(1).some((field) => !Object.hasOwn(entry.semantics, field))
      ) fail("INVALID_CONSTRAINT_CATALOG_MANIFEST");
      counts[entry.type] += 1;
    }
    return counts;
  };
  const sourceKeys = [...sourceManifest.keys()].sort();
  const destinationKeys = [...destinationManifest.keys()].sort();
  const identitySetEqual = same(sourceKeys, destinationKeys);
  const mismatchFields = new Set(identitySetEqual ? [] : ["IDENTITY_SET"]);
  let mismatchCount = 0;
  let truncated = false;
  let checkCandidate = null;
  const addMismatch = () => {
    if (mismatchCount === MAX_SCHEMA_DIAGNOSTIC_COUNT) truncated = true;
    else mismatchCount += 1;
  };
  for (const key of new Set([...sourceKeys, ...destinationKeys])) {
    const source = sourceManifest.get(key);
    const destination = destinationManifest.get(key);
    if (source === undefined || destination === undefined) {
      addMismatch();
      continue;
    }
    let constraintMismatch = false;
    const constraintMismatchFields = [];
    for (const field of CONSTRAINT_MISMATCH_FIELDS.slice(1)) {
      if (!same(source.semantics?.[field], destination.semantics?.[field])) {
        mismatchFields.add(field);
        constraintMismatchFields.push(field);
        constraintMismatch = true;
      }
    }
    if (constraintMismatch) {
      addMismatch();
      if (
        checkCandidate === null
        && source.type === "CHECK"
        && destination.type === "CHECK"
        && constraintMismatchFields.includes("CHECK_EXPRESSION")
      ) {
        checkCandidate = { source, destination };
      } else {
        checkCandidate = false;
      }
    }
  }
  const singleCheckCandidate = mismatchCount === 1 && checkCandidate !== false ? checkCandidate : null;
  return { candidate: singleCheckCandidate, diagnostic: {
    schemaVersion: "1.0.0",
    serverVersionRelation,
    identitySetEqual,
    counts: {
      source: countsFor(sourceManifest),
      destination: countsFor(destinationManifest),
    },
    semanticEqual: identitySetEqual && mismatchCount === 0,
    mismatchCount,
    mismatchFields: CONSTRAINT_MISMATCH_FIELDS.filter((field) => mismatchFields.has(field)),
    checkExpressionDifference: singleCheckCandidate !== null && checkDetails !== null
      ? buildCheckExpressionDifference(checkDetails.source, checkDetails.destination)
      : null,
    truncated,
  } };
};

export const findSingleCheckExpressionMismatch = (sourceManifest, destinationManifest) => (
  analyzeConstraintSemanticManifests(sourceManifest, destinationManifest).candidate
);

export const buildConstraintSemanticDiagnostic = (
  sourceManifest,
  destinationManifest,
  serverVersionRelation = "UNAVAILABLE",
  checkDetails = null,
) => analyzeConstraintSemanticManifests(
  sourceManifest,
  destinationManifest,
  serverVersionRelation,
  checkDetails,
).diagnostic;

export const buildSequenceUseList = (content) => {
  if (typeof content !== "string") fail("INVALID_ARCHIVE_TOC");
  const selected = [];
  const dumpIds = new Set();
  const entries = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^([1-9][0-9]*); [0-9]+ [0-9]+ SEQUENCE SET .+$/u);
    if (match === null) continue;
    if (dumpIds.has(match[1]) || entries.has(line)) fail("DUPLICATE_ARCHIVE_SEQUENCE_ENTRY");
    dumpIds.add(match[1]);
    entries.add(line);
    selected.push(line);
  }
  return {
    tocEntryCount: selected.length,
    contents: selected.length === 0 ? "" : `${selected.join("\n")}\n`,
  };
};

const hashRowsWithCursor = async (client, cursorName, selectSql) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(cursorName)) fail("INVALID_CURSOR_NAME");
  const hash = createHash("sha256");
  let rowCount = 0;
  await client.query(`DECLARE ${quoteIdentifier(cursorName)} NO SCROLL CURSOR FOR ${selectSql}`);
  try {
    while (true) {
      const page = await client.query(`FETCH FORWARD ${FETCH_ROWS} FROM ${quoteIdentifier(cursorName)}`);
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        if (typeof row.canonical_row !== "string") fail("NON_TEXT_CANONICAL_ROW");
        const bytes = Buffer.from(row.canonical_row, "utf8");
        const length = Buffer.allocUnsafe(8);
        length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(length);
        hash.update(bytes);
        rowCount += 1;
      }
    }
  } finally {
    await client.query(`CLOSE ${quoteIdentifier(cursorName)}`).catch(() => {});
  }
  return { rowCount, rowSha256: hash.digest("hex") };
};

const tablePrimaryKey = async (client, schema, table) => {
  const result = await client.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
    ORDER BY k.ordinality
  `, [schema, table]);
  return result.rows.map((row) => assertNoControlCharacters(row.attname, "INVALID_PRIMARY_KEY_COLUMN"));
};

const collectTables = async (client) => {
  const identities = await client.query(`
    SELECT schemaname AS schema, tablename AS name
    FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND schemaname !~ '^pg_toast'
    ORDER BY schemaname COLLATE "C", tablename COLLATE "C"
  `);
  const tables = [];
  for (let index = 0; index < identities.rows.length; index += 1) {
    const schema = assertNoControlCharacters(identities.rows[index].schema, "INVALID_TABLE_SCHEMA");
    const name = assertNoControlCharacters(identities.rows[index].name, "INVALID_TABLE_NAME");
    const primaryKey = await tablePrimaryKey(client, schema, name);
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const order = primaryKey.length > 0
      ? `${primaryKey.map((column) => `t.${quoteIdentifier(column)}`).join(", ")}, to_jsonb(t)::text COLLATE "C"`
      : `to_jsonb(t)::text COLLATE "C"`;
    const manifest = await hashRowsWithCursor(
      client,
      `table_manifest_${index}`,
      `SELECT to_jsonb(t)::text AS canonical_row FROM ${qualified} AS t ORDER BY ${order}`,
    );
    tables.push({ schema, name, ...manifest });
  }
  return tables;
};

const collectSequences = async (client) => {
  const identities = await client.query(`
    SELECT sequence_schema AS schema, sequence_name AS name
    FROM information_schema.sequences
    WHERE sequence_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY sequence_schema COLLATE "C", sequence_name COLLATE "C"
  `);
  const sequences = [];
  for (const identity of identities.rows) {
    const schema = assertNoControlCharacters(identity.schema, "INVALID_SEQUENCE_SCHEMA");
    const name = assertNoControlCharacters(identity.name, "INVALID_SEQUENCE_NAME");
    const row = await querySingle(
      client,
      `SELECT last_value::text AS last_value, is_called FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`,
      [],
      "SEQUENCE_STATE_UNAVAILABLE",
    );
    sequences.push({ schema, name, lastValue: row.last_value, isCalled: row.is_called === true });
  }
  return sequences;
};

const lengthFrame = (value) => {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return [length, bytes];
};

const normalizeLargeObjectOid = (value) => {
  const text = String(value);
  if (!/^[1-9][0-9]{0,9}$/u.test(text)) fail("INVALID_LARGE_OBJECT_OID");
  const oid = BigInt(text);
  if (oid > MAX_POSTGRES_OID) fail("INVALID_LARGE_OBJECT_OID");
  return text;
};

export const inspectLargeObjectAccess = async (client, failureCode) => {
  try {
    const result = await client.query(`
      SELECT oid::text AS oid, has_largeobject_privilege(oid, 'SELECT') AS readable
      FROM pg_largeobject_metadata
      ORDER BY oid
    `);
    const identities = [];
    let previousOid = null;
    for (const row of result.rows) {
      const oid = normalizeLargeObjectOid(row.oid);
      if (row.readable !== true && row.readable !== false) fail("INVALID_LARGE_OBJECT_PRIVILEGE_STATUS");
      if (previousOid !== null && BigInt(oid) <= BigInt(previousOid)) fail("INVALID_LARGE_OBJECT_ORDER");
      identities.push({ oid, readable: row.readable });
      previousOid = oid;
    }
    return identities;
  } catch (error) {
    if (isRehearsalError(error)) throw error;
    fail(failureCode);
  }
};

export const collectLargeObjects = async (client, identities, failureCode, privilegeFailureCode) => {
  try {
    const manifestHash = createHash("sha256");
    let previousOid = null;
    for (const identity of identities) {
      if (identity.readable !== true) fail(privilegeFailureCode);
      const oid = normalizeLargeObjectOid(identity.oid);
      if (previousOid !== null && BigInt(oid) <= BigInt(previousOid)) fail("INVALID_LARGE_OBJECT_ORDER");
      const contentHash = createHash("sha256");
      let offset = 0n;
      while (true) {
        const row = await querySingle(
          client,
          "SELECT lo_get($1::oid, $2::bigint, $3::integer) AS chunk",
          [oid, offset.toString(), LARGE_OBJECT_CHUNK_BYTES],
          "LARGE_OBJECT_CHUNK_UNAVAILABLE",
        );
        if (!Buffer.isBuffer(row.chunk)) fail("INVALID_LARGE_OBJECT_CHUNK");
        if (row.chunk.length === 0) break;
        contentHash.update(row.chunk);
        offset += BigInt(row.chunk.length);
        if (offset > MAX_LARGE_OBJECT_BYTES) fail("LARGE_OBJECT_SIZE_EXCEEDED");
      }
      const digest = contentHash.digest("hex");
      for (const value of [oid, offset.toString(), digest]) {
        for (const frame of lengthFrame(value)) manifestHash.update(frame);
      }
      previousOid = oid;
    }
    return { count: identities.length, contentSha256: manifestHash.digest("hex") };
  } catch (error) {
    if (isRehearsalError(error)) throw error;
    fail(failureCode);
  }
};

const collectMigrations = async (client) => {
  const result = await client.query(`
    SELECT
      migration_name AS name,
      checksum,
      CASE
        WHEN rolled_back_at IS NOT NULL THEN 'ROLLED_BACK'
        WHEN finished_at IS NOT NULL THEN 'FINISHED'
        ELSE 'INCOMPLETE'
      END AS state,
      applied_steps_count
    FROM public._prisma_migrations
    ORDER BY migration_name COLLATE "C"
  `);
  const rows = result.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    state: row.state,
    appliedStepsCount: Number(row.applied_steps_count),
  }));
  const counts = { finished: 0, rolledBack: 0, incomplete: 0 };
  for (const row of rows) {
    if (row.state === "FINISHED") counts.finished += 1;
    if (row.state === "ROLLED_BACK") counts.rolledBack += 1;
    if (row.state === "INCOMPLETE") counts.incomplete += 1;
  }
  return { rows, counts };
};

const collectQueue = async (client, table, statuses) => {
  const values = statuses.map((status, index) => `($${index + 1}::text)`).join(", ");
  const result = await client.query(`
    WITH expected(status) AS (VALUES ${values})
    SELECT expected.status, count(actual.status)::text AS count
    FROM expected
    LEFT JOIN ${quoteIdentifier("public")}.${quoteIdentifier(table)} actual ON actual.status::text = expected.status
    GROUP BY expected.status
    ORDER BY expected.status COLLATE "C"
  `, statuses);
  const lockRow = await querySingle(
    client,
    `SELECT count(*)::text AS count FROM ${quoteIdentifier("public")}.${quoteIdentifier(table)} WHERE ${quoteIdentifier("lockedAt")} IS NOT NULL OR ${quoteIdentifier("lockedBy")} IS NOT NULL`,
    [],
    "QUEUE_LOCK_COUNT_UNAVAILABLE",
  );
  return {
    statuses: result.rows.map((row) => ({ status: row.status, count: Number(row.count) })),
    lockedCount: Number(lockRow.count),
  };
};

const collectDatabaseEvidence = async (client, schemaEvidence, largeObjectIdentities, largeObjectFailureCode) => {
  const settings = await databaseSettings(client);
  const extensionsResult = await client.query("SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname COLLATE \"C\"");
  return {
    server: { majorVersion: settings.majorVersion },
    locale: localeSettings(settings),
    extensions: extensionsResult.rows,
    schema: schemaEvidence,
    tables: await collectTables(client),
    largeObjects: await collectLargeObjects(
      client,
      largeObjectIdentities,
      largeObjectFailureCode,
      largeObjectFailureCode.replace("_EVIDENCE_FAILED", "_READ_PRIVILEGE_MISSING"),
    ),
    migrations: await collectMigrations(client),
    queues: {
      event: await collectQueue(client, "Event", ["PENDING", "DISPATCHED", "FAILED"]),
      workflowJob: await collectQueue(client, "WorkflowJob", ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
    },
  };
};

export async function runPostgresRestoreRehearsal(options) {
  const {
    domain,
    sourceConfig,
    targetAdminConfig,
    scratchName,
    artifactDir,
    tempDir,
    stateFile,
    dockerNetwork = null,
    afterSnapshot = null,
    afterArchive = null,
  } = options;
  if (!REQUIRED_DOMAINS.has(domain)) fail("INVALID_DOMAIN");
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const sourceRef = opaqueRef(`${sourceConfig.host}\0${sourceConfig.database}`);
  const targetRef = opaqueRef(`${targetAdminConfig.host}\0${scratchName}`);
  const sourceClient = new Client(nodeClientConfig(sourceConfig, `corgtex_rehearsal_${domain}_snapshot`));
  const temporaryFiles = [];
  let transactionOpen = false;
  let credentialsShredded = false;
  try {
    await waitForTargetConnection({ targetAdminConfig });
    await sourceClient.connect();
    await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await sourceClient.query("SET LOCAL lock_timeout = '5s'");
    await sourceClient.query("SET LOCAL statement_timeout = '0'");
    await sourceClient.query("SET LOCAL transaction_timeout = '0'");
    await sourceClient.query("SET LOCAL idle_in_transaction_session_timeout = '0'");
    await sourceClient.query("SET LOCAL timezone = 'UTC'");
    await sourceClient.query("SET LOCAL search_path = pg_catalog");
    const timeouts = await querySingle(sourceClient, `
      SELECT
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('transaction_timeout') AS transaction_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_timeout
    `, [], "SOURCE_TIMEOUT_BOUNDARY_UNPROVEN");
    if (timeouts.statement_timeout !== "0" || timeouts.transaction_timeout !== "0" || timeouts.idle_timeout !== "0") {
      fail("SOURCE_TIMEOUT_BOUNDARY_UNPROVEN");
    }
    const readOnly = await querySingle(sourceClient, "SHOW transaction_read_only", [], "SOURCE_READ_ONLY_UNPROVEN");
    if (readOnly.transaction_read_only !== "on") fail("SOURCE_READ_ONLY_UNPROVEN");
    const snapshotRow = await querySingle(sourceClient, "SELECT pg_export_snapshot() AS snapshot", [], "SNAPSHOT_EXPORT_FAILED");
    const snapshot = assertNoControlCharacters(snapshotRow.snapshot, "INVALID_SNAPSHOT_ID");
    const sourceSettings = await databaseSettings(sourceClient);
    if (!isCurrentCollationVersion(sourceSettings)) {
      writePrivateJson(`${artifactDir}/locale-diagnostic.json`, buildLocaleDiagnostic(sourceSettings));
      fail("SOURCE_COLLATION_VERSION_STALE");
    }
    const sourceLargeObjects = await inspectLargeObjectAccess(sourceClient, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");
    const unreadableLargeObjectCount = sourceLargeObjects.filter(({ readable }) => !readable).length;
    if (unreadableLargeObjectCount > 0) {
      writePrivateJson(`${artifactDir}/large-object-diagnostic.json`, {
        schemaVersion: "1.0.0",
        unreadableCount: unreadableLargeObjectCount,
      });
      fail("SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING");
    }
    const sourceConstraintManifest = await collectConstraintCatalogManifest(
      sourceClient,
      "SOURCE_CONSTRAINT_CATALOG_EVIDENCE_FAILED",
    );
    if (afterSnapshot !== null) await afterSnapshot({ snapshot });

    await createScratchDatabase({
      adminConfig: targetAdminConfig,
      scratchName,
      settings: sourceSettings,
      stateFile,
      targetRef,
      artifactDir,
    });
    const targetConfig = { ...targetAdminConfig, database: scratchName };
    const clientFiles = writeClientFiles(
      tempDir,
      sourceConfig,
      targetConfig,
      (...paths) => temporaryFiles.push(...paths),
    );
    await probeTargetClientConnection({
      tempDir,
      clientFiles,
      network: dockerNetwork,
      artifactDir,
    });
    const dumpFile = assertSafePath(`${tempDir}/snapshot.dump`, tempDir, "INVALID_DUMP_PATH");
    const archiveTocFile = assertSafePath(`${tempDir}/snapshot.toc`, tempDir, "INVALID_TOC_PATH");
    const sequenceUseListFile = assertSafePath(`${tempDir}/sequence-set.list`, tempDir, "INVALID_SEQUENCE_LIST_PATH");
    const sourceSchemaFile = assertSafePath(`${tempDir}/source-schema.sql`, tempDir, "INVALID_SCHEMA_PATH");
    const destinationSchemaFile = assertSafePath(`${tempDir}/destination-schema.sql`, tempDir, "INVALID_SCHEMA_PATH");
    temporaryFiles.push(dumpFile, archiveTocFile, sequenceUseListFile, sourceSchemaFile, destinationSchemaFile);

    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "source",
      args: ["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--snapshot", snapshot, "--file", "/work/snapshot.dump"],
      code: "SOURCE_DUMP_FAILED",
      network: dockerNetwork,
    });
    if (afterArchive !== null) await afterArchive();
    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "source",
      args: ["pg_restore", "--list", "--file", "/work/snapshot.toc", "/work/snapshot.dump"],
      code: "ARCHIVE_TOC_FAILED",
      network: dockerNetwork,
    });
    chmodSync(archiveTocFile, 0o600);
    const sequenceSelection = buildSequenceUseList(readFileSync(archiveTocFile, "utf8"));
    writeFileSync(sequenceUseListFile, sequenceSelection.contents, { mode: 0o600, flag: "wx" });
    chmodSync(sequenceUseListFile, 0o600);
    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "source",
      args: [
        "pg_dump",
        "--schema-only",
        "--format=plain",
        "--no-owner",
        "--no-acl",
        `--restrict-key=${SCHEMA_RESTRICT_KEY}`,
        "--snapshot",
        snapshot,
        "--file",
        "/work/source-schema.sql",
      ],
      code: "SOURCE_SCHEMA_DUMP_FAILED",
      network: dockerNetwork,
    });
    const sourceSchema = analyzeSchemaDump(readFileSync(sourceSchemaFile, "utf8"));
    const sourceEvidence = await collectDatabaseEvidence(
      sourceClient,
      { algorithm: sourceSchema.algorithm, digest: sourceSchema.digest },
      sourceLargeObjects,
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
    );
    await sourceClient.query("COMMIT");
    transactionOpen = false;
    await restoreArchiveSections({
      tempDir,
      clientFiles,
      network: dockerNetwork,
      artifactDir,
    });
    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "target",
      args: [
        "pg_dump",
        "--schema-only",
        "--format=plain",
        "--no-owner",
        "--no-acl",
        `--restrict-key=${SCHEMA_RESTRICT_KEY}`,
        "--file",
        "/work/destination-schema.sql",
      ],
      code: "DESTINATION_SCHEMA_DUMP_FAILED",
      network: dockerNetwork,
    });
    const destinationSchema = analyzeSchemaDump(readFileSync(destinationSchemaFile, "utf8"));
    const schemaDifferenceDiagnostic = sourceSchema.digest !== destinationSchema.digest
      ? buildSchemaDifferenceDiagnostic(sourceSchema.tokens, destinationSchema.tokens)
      : sourceSchema.legacyDigest !== destinationSchema.legacyDigest
        ? { classification: "NON_EXECUTABLE_DUMP_TEXT_ONLY" }
        : null;
    const destinationClient = new Client(nodeClientConfig(targetConfig, `corgtex_rehearsal_${domain}_readback`));
    await destinationClient.connect();
    let destinationEvidence;
    try {
      await destinationClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await destinationClient.query("SET LOCAL lock_timeout = '5s'");
      await destinationClient.query("SET LOCAL statement_timeout = '0'");
      await destinationClient.query("SET LOCAL transaction_timeout = '0'");
      await destinationClient.query("SET LOCAL idle_in_transaction_session_timeout = '20min'");
      await destinationClient.query("SET LOCAL timezone = 'UTC'");
      await destinationClient.query("SET LOCAL search_path = pg_catalog");
      const destinationLargeObjects = await inspectLargeObjectAccess(
        destinationClient,
        "DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED",
      );
      const destinationConstraintManifest = await collectConstraintCatalogManifest(
        destinationClient,
        "DESTINATION_CONSTRAINT_CATALOG_EVIDENCE_FAILED",
      );
      const destinationSettings = await databaseSettings(destinationClient);
      if (schemaDifferenceDiagnostic?.classification === "EXECUTABLE_SCHEMA_DIFFERENCE") {
        const checkCandidate = findSingleCheckExpressionMismatch(
          sourceConstraintManifest,
          destinationConstraintManifest,
        );
        const checkDetails = checkCandidate === null ? null : {
          source: await collectReboundSourceCheckDetail(sourceConfig, checkCandidate.source),
          destination: await collectCheckConstraintDetail(destinationClient, checkCandidate.destination),
        };
        writePrivateJson(`${artifactDir}/schema-diagnostic.json`, {
          ...schemaDifferenceDiagnostic,
          constraintSemantics: buildConstraintSemanticDiagnostic(
            sourceConstraintManifest,
            destinationConstraintManifest,
            sourceSettings.serverVersionNumber === destinationSettings.serverVersionNumber
              ? "MATCH"
              : "DIFFERENT",
            checkDetails,
          ),
        });
      } else if (schemaDifferenceDiagnostic !== null) {
        writePrivateJson(`${artifactDir}/schema-diagnostic.json`, schemaDifferenceDiagnostic);
      }
      destinationEvidence = await collectDatabaseEvidence(
        destinationClient,
        { algorithm: destinationSchema.algorithm, digest: destinationSchema.digest },
        destinationLargeObjects,
        "DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED",
      );
      const beforeReplay = await collectSequences(destinationClient);
      await destinationClient.query("COMMIT");
      if (beforeReplay.length !== sequenceSelection.tocEntryCount) fail("ARCHIVE_SEQUENCE_COVERAGE_MISMATCH");

      if (sequenceSelection.tocEntryCount > 0) {
        await dockerClient({
          tempDir,
          ...clientFiles,
          service: "target",
          args: [
            "pg_restore",
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            "--use-list=/work/sequence-set.list",
            "--dbname=service=target",
            "/work/snapshot.dump",
          ],
          code: "ARCHIVE_SEQUENCE_REPLAY_FAILED",
          network: dockerNetwork,
        });
      }

      await destinationClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await destinationClient.query("SET LOCAL lock_timeout = '5s'");
      await destinationClient.query("SET LOCAL statement_timeout = '0'");
      await destinationClient.query("SET LOCAL transaction_timeout = '0'");
      await destinationClient.query("SET LOCAL idle_in_transaction_session_timeout = '20min'");
      await destinationClient.query("SET LOCAL timezone = 'UTC'");
      const afterReplay = await collectSequences(destinationClient);
      await destinationClient.query("COMMIT");
      if (afterReplay.length !== sequenceSelection.tocEntryCount) fail("ARCHIVE_SEQUENCE_COVERAGE_MISMATCH");
      if (JSON.stringify(beforeReplay) !== JSON.stringify(afterReplay)) fail("ARCHIVE_SEQUENCE_REPLAY_MISMATCH");
      destinationEvidence.archiveSequences = {
        tocEntryCount: sequenceSelection.tocEntryCount,
        beforeReplay,
        afterReplay,
      };
    } catch (error) {
      await destinationClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await destinationClient.end().catch(() => {});
    }

    const evidence = {
      schemaVersion: "1.0.0",
      domain,
      sourceRef,
      targetRef,
      source: sourceEvidence,
      destination: {
        server: destinationEvidence.server,
        locale: destinationEvidence.locale,
        extensions: destinationEvidence.extensions,
        schema: destinationEvidence.schema,
        tables: destinationEvidence.tables,
        largeObjects: destinationEvidence.largeObjects,
        migrations: destinationEvidence.migrations,
        queues: destinationEvidence.queues,
      },
      archiveSequences: destinationEvidence.archiveSequences,
    };
    writePrivateJson(`${artifactDir}/postgres-restore-evidence.json`, evidence);
    return { sourceRef, targetRef, evidence };
  } catch (error) {
    if (transactionOpen) await sourceClient.query("ROLLBACK").catch(() => {});
    if (isRehearsalError(error)) throw error;
    fail("REHEARSAL_FAILED");
  } finally {
    await sourceClient.end().catch(() => {});
    const results = await Promise.all(temporaryFiles.map(secureDelete));
    credentialsShredded = results.every(Boolean);
    writePrivateJson(`${artifactDir}/runner-cleanup.json`, { credentials: { shredded: credentialsShredded } });
    if (!credentialsShredded) fail("CREDENTIAL_SHRED_FAILED");
  }
}

export async function cleanupScratchDatabase({ targetAdminConfig, stateFile, artifactDir, expectedScratchName }) {
  if (!SAFE_NAME.test(expectedScratchName) || !expectedScratchName.startsWith("corgtex_rehearsal_")) {
    fail("INVALID_SCRATCH_DATABASE_NAME");
  }
  const client = new Client(nodeClientConfig(targetAdminConfig, "corgtex_rehearsal_cleanup"));
  await client.connect();
  try {
    if (!existsSync(stateFile)) {
      const unexpected = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [expectedScratchName]);
      if (unexpected.rowCount !== 0) fail("DATABASE_OWNERSHIP_UNPROVEN");
      const receipt = { scratchDatabase: { nameRef: opaqueRef(expectedScratchName), dropped: true } };
      writePrivateJson(`${artifactDir}/database-cleanup.json`, receipt);
      return receipt;
    }
    const state = readBoundedJson(stateFile);
    if (
      state?.schemaVersion !== "1.0.0"
      || state.scratchName !== expectedScratchName
      || !new Set(["INTENT", "ABSENCE_VERIFIED", "CREATED"]).has(state.phase)
      || state.targetRef !== opaqueRef(`${targetAdminConfig.host}\0${state.scratchName}`)
    ) fail("INVALID_CLEANUP_STATE");
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [state.scratchName]);
    if (existing.rowCount > 0) {
      if (state.phase === "INTENT") fail("DATABASE_OWNERSHIP_UNPROVEN");
      await client.query(`DROP DATABASE ${quoteIdentifier(state.scratchName)} WITH (FORCE)`);
    }
    const remaining = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [state.scratchName]);
    if (remaining.rowCount !== 0) fail("DATABASE_CLEANUP_FAILED");
    const receipt = { scratchDatabase: { nameRef: opaqueRef(state.scratchName), dropped: true } };
    writePrivateJson(`${artifactDir}/database-cleanup.json`, receipt);
    return receipt;
  } finally {
    await client.end().catch(() => {});
  }
}

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) fail(`MISSING_${name}`);
  return value;
};

const parseArgs = (tokens) => {
  const values = new Map();
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (!token.startsWith("--") || separator < 3) fail("INVALID_ARGS");
    const key = token.slice(2, separator);
    const value = token.slice(separator + 1);
    if (!value || values.has(key)) fail("INVALID_ARGS");
    values.set(key, value);
  }
  return values;
};

export async function main(tokens = process.argv.slice(2)) {
  const args = parseArgs(tokens);
  const mode = args.get("mode");
  const artifactDir = args.get("artifact-dir");
  const tempDir = args.get("temp-dir");
  const stateFile = args.get("state-file");
  if (!artifactDir || !tempDir || !stateFile) fail("INVALID_ARGS");
  const scratchName = requiredEnvironment("SCRATCH_DATABASE_NAME");
  const targetAdminConfig = targetDatabaseConfigFromEnv(process.env, "postgres", process.env.TARGET_POSTGRES_DOCKER_HOST ?? null);
  if (mode === "run" && args.size === 5 && args.has("domain") && args.has("artifact-dir") && args.has("temp-dir") && args.has("state-file")) {
    const domain = args.get("domain");
    const sourceConfig = {
      ...parseSourceDatabaseUrl(requiredEnvironment("SOURCE_DATABASE_URL"), process.env.SOURCE_POSTGRES_DOCKER_HOST ?? null),
      sourceTlsRootCert: validateSourceTlsRootCertificate(requiredEnvironment("SOURCE_TLS_ROOT_CERT")),
    };
    await runPostgresRestoreRehearsal({
      domain,
      sourceConfig,
      targetAdminConfig,
      scratchName,
      artifactDir,
      tempDir,
      stateFile,
      dockerNetwork: process.env.POSTGRES_CLIENT_DOCKER_NETWORK ?? null,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, status: "POSTGRES_REHEARSAL_CAPTURED" })}\n`);
  } else if (mode === "cleanup" && args.size === 4 && args.has("artifact-dir") && args.has("temp-dir") && args.has("state-file")) {
    await cleanupScratchDatabase({ targetAdminConfig, stateFile, artifactDir, expectedScratchName: scratchName });
    process.stdout.write(`${JSON.stringify({ ok: true, status: "SCRATCH_DATABASE_ABSENT" })}\n`);
  } else {
    fail("INVALID_ARGS");
  }
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedScriptUrl) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: isRehearsalError(error) ? error.code : "REHEARSAL_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
