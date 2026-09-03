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
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

export const POSTGRES_CLIENT_IMAGE = "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280";
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SOURCE_TLS_ROOT_CERT_BYTES = 16 * 1024;
const MAX_RESTORE_DIAGNOSTIC_LINE_BYTES = 4 * 1024;
const MAX_COMMAND_STDERR_BYTES = 1024 * 1024;
const FETCH_ROWS = 500;
const LARGE_OBJECT_CHUNK_BYTES = 1024 * 1024;
const MAX_LARGE_OBJECT_BYTES = 4n * 1024n * 1024n * 1024n * 1024n;
const MAX_POSTGRES_OID = 4_294_967_295n;
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const REQUIRED_DOMAINS = new Set(["core", "ops"]);
const TARGET_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;
const TARGET_CONNECTION_RETRY_DELAY_MS = 10 * 1000;
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

const restoreCategory = (errorLine, sqlstate) => {
  if (
    sqlstate === "42501"
    || /\b(?:permission denied|must be (?:a )?(?:superuser|owner)|not a superuser|only superuser)\b/iu.test(errorLine)
  ) return "INSUFFICIENT_PRIVILEGE";
  if (
    /\bextension\b[^\n]*(?:not available|not allow-listed|not supported|control file|installation script)/iu.test(errorLine)
  ) return "EXTENSION_UNAVAILABLE";
  if (["42710", "42P07"].includes(sqlstate) || /\balready exists\b/iu.test(errorLine)) return "DUPLICATE_OBJECT";
  if (
    ["42704", "3F000"].includes(sqlstate)
    || /\b(?:does not exist|required extension|missing dependency)\b/iu.test(errorLine)
  ) return "MISSING_DEPENDENCY";
  if (sqlstate?.startsWith("23") || /\bviolates\b[^\n]*\bconstraint\b|\bduplicate key value\b/iu.test(errorLine)) {
    return "DATA_CONSTRAINT";
  }
  if (
    sqlstate?.startsWith("53")
    || /\b(?:out of memory|disk full|too many connections|insufficient resources)\b/iu.test(errorLine)
  ) return "RESOURCE_EXHAUSTED";
  if (
    sqlstate?.startsWith("08")
    || /\b(?:could not connect|connection to server was lost|server closed the connection unexpectedly|terminating connection)\b/iu.test(errorLine)
  ) return "CONNECTION";
  return "UNKNOWN";
};

const extensionClassFromLine = (line) => {
  if (/(?:^|[.\s"])(?:plpgsql)(?:["\s]|$)/iu.test(line)) return "PLPGSQL";
  if (/(?:^|[.\s"])(?:vector)(?:["\s]|$)/iu.test(line)) return "VECTOR";
  return "OTHER";
};

const verboseOperation = (line) => {
  if (/^pg_restore: processing data for table\b/u.test(line)) {
    return { objectClass: "TABLE_DATA", extensionClass: "UNKNOWN" };
  }
  const match = line.match(/^pg_restore: creating (EXTENSION|COMMENT|SCHEMA|TYPE|TABLE|SEQUENCE|FUNCTION|INDEX|(?:FK |CHECK )?CONSTRAINT|BLOB(?: COMMENTS)?|LARGE OBJECT)\b/u);
  if (!match) {
    return line.startsWith("pg_restore: creating ")
      ? { objectClass: "OTHER", extensionClass: "UNKNOWN" }
      : null;
  }
  const token = match[1];
  let objectClass = token.replaceAll(" ", "_");
  if (["FK_CONSTRAINT", "CHECK_CONSTRAINT"].includes(objectClass)) objectClass = "CONSTRAINT";
  if (["BLOB", "BLOB_COMMENTS", "LARGE_OBJECT"].includes(objectClass)) objectClass = "LARGE_OBJECT";
  return {
    objectClass,
    extensionClass: token === "EXTENSION" || (token === "COMMENT" && /\bEXTENSION\b/u.test(line))
      ? extensionClassFromLine(line)
      : "UNKNOWN",
  };
};

const commandOperation = (line) => {
  const command = line.slice("Command was: ".length);
  if (/^CREATE EXTENSION\b/u.test(command)) {
    return { objectClass: "EXTENSION", extensionClass: extensionClassFromLine(command) };
  }
  if (/^COMMENT ON EXTENSION\b/u.test(command)) {
    return { objectClass: "COMMENT", extensionClass: extensionClassFromLine(command) };
  }
  if (/^CREATE TABLE\b/u.test(command)) return { objectClass: "TABLE", extensionClass: "UNKNOWN" };
  if (/^ALTER TABLE\b/u.test(command)) return { objectClass: "CONSTRAINT", extensionClass: "UNKNOWN" };
  if (/^COPY\b/u.test(command)) return { objectClass: "TABLE_DATA", extensionClass: "UNKNOWN" };
  if (/^CREATE (?:UNIQUE )?INDEX\b/u.test(command)) return { objectClass: "INDEX", extensionClass: "UNKNOWN" };
  if (/^CREATE SEQUENCE\b|^SELECT pg_catalog\.setval\b/u.test(command)) {
    return { objectClass: "SEQUENCE", extensionClass: "UNKNOWN" };
  }
  if (/^CREATE FUNCTION\b/u.test(command)) return { objectClass: "FUNCTION", extensionClass: "UNKNOWN" };
  if (/^CREATE TYPE\b/u.test(command)) return { objectClass: "TYPE", extensionClass: "UNKNOWN" };
  if (/^CREATE SCHEMA\b/u.test(command)) return { objectClass: "SCHEMA", extensionClass: "UNKNOWN" };
  if (/^SELECT pg_catalog\.(?:lo_create|lo_open|lowrite)\b/u.test(command)) {
    return { objectClass: "LARGE_OBJECT", extensionClass: "UNKNOWN" };
  }
  return null;
};

export const createRestoreDiagnosticClassifier = () => {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let discardingLine = false;
  let truncated = false;
  let errorSeen = false;
  let operation = { objectClass: "UNKNOWN", extensionClass: "UNKNOWN" };
  let category = "UNKNOWN";
  let sqlstate = null;

  const processLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!errorSeen) {
      const nextOperation = verboseOperation(line);
      if (nextOperation !== null) operation = nextOperation;
      if (line.startsWith("pg_restore: error:")) {
        errorSeen = true;
        category = restoreCategory(line, null);
      }
      return;
    }
    const sqlstateMatch = line.match(/^SQLSTATE(?:\s*\([^\r\n)]{1,40}\))?\s*[:=]\s*([0-9A-Z]{5})\s*$/u);
    if (sqlstate === null && sqlstateMatch) {
      sqlstate = sqlstateMatch[1];
      if (category === "UNKNOWN") category = restoreCategory("", sqlstate);
      return;
    }
    if (operation.objectClass === "UNKNOWN" && line.startsWith("Command was: ")) {
      operation = commandOperation(line) ?? operation;
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
        return;
      }
      consumeText(decoder.write(chunk));
    },
    finish() {
      consumeText(decoder.end(), true);
      const diagnostic = {
        phase: "DESTINATION_RESTORE",
        category,
        objectClass: operation.objectClass,
        extensionClass: operation.extensionClass,
        sqlstate,
        truncated,
      };
      partial = "";
      return diagnostic;
    },
    discard() {
      decoder.end();
      partial = "";
      discardingLine = false;
    },
  };
};

export const buildRestoreDiagnostic = (chunks) => {
  const classifier = createRestoreDiagnosticClassifier();
  for (const chunk of chunks) classifier.consume(chunk);
  return classifier.finish();
};

const spawnFixed = (command, args, options = {}) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrBytes = 0;
  let settled = false;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    options.stderrClassifier?.consume(chunk);
    if (options.stderrClassifier === undefined && stderrBytes > MAX_COMMAND_STDERR_BYTES) child.kill("SIGKILL");
  });
  child.on("error", () => {
    if (settled) return;
    settled = true;
    options.stderrClassifier?.discard();
    rejectPromise(new RehearsalError(options.code ?? "COMMAND_FAILED"));
  });
  child.on("close", (status, signal) => {
    if (settled) return;
    settled = true;
    if (status === 0 && signal === null) {
      options.stderrClassifier?.discard();
      resolvePromise();
      return;
    }
    try {
      options.onFailure?.(options.stderrClassifier?.finish());
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

export const targetDatabaseConfigFromEnv = (environment, database, dockerHostOverride = null) => {
  const host = assertNoControlCharacters(environment.TARGET_POSTGRES_HOST, "INVALID_TARGET_HOST");
  const dockerHost = dockerHostOverride === null ? host : assertNoControlCharacters(dockerHostOverride, "INVALID_TARGET_DOCKER_HOST");
  const user = assertNoControlCharacters(environment.TARGET_POSTGRES_ADMIN_USER, "INVALID_TARGET_USER");
  const password = assertNoControlCharacters(environment.TARGET_POSTGRES_ADMIN_PASSWORD, "INVALID_TARGET_PASSWORD");
  const port = environment.TARGET_POSTGRES_PORT === undefined ? 5432 : Number(environment.TARGET_POSTGRES_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("INVALID_TARGET_PORT");
  assertNoControlCharacters(database, "INVALID_TARGET_DATABASE");
  return { host, dockerHost, port, user, password, database, sslmode: "verify-full" };
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
      : { rejectUnauthorized: true },
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
    ...(targetServiceSslMode === "disable" ? [] : ["sslrootcert=system"]),
    "connect_timeout=30",
    "",
  ].join("\n");
};

const writeClientFiles = (tempDir, source, target, registerCleanup) => {
  const serviceFile = assertSafePath(`${tempDir}/pg_service.conf`, tempDir, "INVALID_SERVICE_PATH");
  const passFile = assertSafePath(`${tempDir}/pgpass`, tempDir, "INVALID_PASSFILE_PATH");
  const sourceRootCertFile = source.sslmode === "disable"
    ? null
    : assertSafePath(`${tempDir}/source-root.crt`, tempDir, "INVALID_SOURCE_TLS_ROOT_CERT_PATH");
  registerCleanup(serviceFile, passFile, ...(sourceRootCertFile === null ? [] : [sourceRootCertFile]));
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
  chmodSync(serviceFile, 0o600);
  chmodSync(passFile, 0o600);
  return { serviceFile, passFile, sourceRootCertFile };
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
    onFailure,
  });
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
  const majorVersion = Math.floor(Number(row.server_version_num) / 10_000);
  if (majorVersion !== 18) fail("POSTGRES_18_REQUIRED");
  const provider = LOCALE_PROVIDERS.get(row.locale_provider);
  if (provider === undefined) fail("UNSUPPORTED_LOCALE_PROVIDER");
  const providerLocale = nullableText(row.provider_locale, "INVALID_PROVIDER_LOCALE");
  const icuRules = nullableText(row.icu_rules, "INVALID_ICU_RULES");
  if (provider === "libc" && providerLocale !== null) fail("INVALID_LIBC_LOCALE");
  if (provider !== "icu" && icuRules !== null) fail("INVALID_ICU_RULES");
  if (provider !== "libc" && providerLocale === null) fail("MISSING_PROVIDER_LOCALE");
  return {
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

const normalizeSchemaDump = (content) => content
  .split(/\r?\n/u)
  .filter((line) => !line.startsWith("--"))
  .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict "))
  .filter((line) => line.trim() !== "")
  .join("\n")
  .trim();

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

const collectDatabaseEvidence = async (client, schemaDigest, largeObjectIdentities, largeObjectFailureCode) => {
  const settings = await databaseSettings(client);
  const extensionsResult = await client.query("SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname COLLATE \"C\"");
  return {
    server: { majorVersion: settings.majorVersion },
    locale: localeSettings(settings),
    extensions: extensionsResult.rows,
    schema: { digest: schemaDigest },
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
      args: ["pg_dump", "--schema-only", "--format=plain", "--no-owner", "--no-acl", "--snapshot", snapshot, "--file", "/work/source-schema.sql"],
      code: "SOURCE_SCHEMA_DUMP_FAILED",
      network: dockerNetwork,
    });
    const sourceSchemaDigest = sha256(normalizeSchemaDump(readFileSync(sourceSchemaFile, "utf8")));
    const sourceEvidence = await collectDatabaseEvidence(
      sourceClient,
      sourceSchemaDigest,
      sourceLargeObjects,
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
    );
    await sourceClient.query("COMMIT");
    transactionOpen = false;

    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "target",
      args: ["pg_restore", "--verbose", "--exit-on-error", "--no-owner", "--no-acl", "--dbname=service=target", "/work/snapshot.dump"],
      code: "DESTINATION_RESTORE_FAILED",
      network: dockerNetwork,
      stderrClassifier: createRestoreDiagnosticClassifier(),
      onFailure: (diagnostic) => writePrivateJson(`${artifactDir}/restore-diagnostic.json`, diagnostic),
    });
    await dockerClient({
      tempDir,
      ...clientFiles,
      service: "target",
      args: ["pg_dump", "--schema-only", "--format=plain", "--no-owner", "--no-acl", "--file", "/work/destination-schema.sql"],
      code: "DESTINATION_SCHEMA_DUMP_FAILED",
      network: dockerNetwork,
    });
    const destinationSchemaDigest = sha256(normalizeSchemaDump(readFileSync(destinationSchemaFile, "utf8")));
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
      const destinationLargeObjects = await inspectLargeObjectAccess(
        destinationClient,
        "DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED",
      );
      destinationEvidence = await collectDatabaseEvidence(
        destinationClient,
        destinationSchemaDigest,
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
