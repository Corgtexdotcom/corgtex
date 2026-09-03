import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCreateDatabaseSql,
  buildLocaleDiagnostic,
  buildPgServiceContents,
  buildRestoreDiagnostic,
  buildSequenceUseList,
  classifyCollationVersionRelation,
  collectLargeObjects,
  inspectLargeObjectAccess,
  isCurrentCollationVersion,
  localeDefinitionMismatchFields,
  nodeClientConfig,
  parseSourceDatabaseUrl,
  POSTGRES_CLIENT_IMAGE,
  serializePgServiceValue,
  validateSourceTlsRootCertificate,
  waitForTargetConnection,
} from "./run-postgres-restore-rehearsal.mjs";

const TEST_SOURCE_CA = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVOgAwIBAgIUGqAOm5MYGReJildG1O4p80Jd3z4wCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZQ29yZ3RleCBNaWdyYXRpb24gVGVzdCBDQTAeFw0yNjA5MDIy
MTMxMjVaFw0zNjA4MzAyMTMxMjVaMCQxIjAgBgNVBAMMGUNvcmd0ZXggTWlncmF0
aW9uIFRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATcet6Z6ZVe9rFC
ZqP7N1geOzmJ7NPjr8DmzN+sNjPmwPhH2qzTiAz/t6RaYpnT/RKmJk3eBBROaKaj
VWjo4Bwso2MwYTAdBgNVHQ4EFgQUUKBRyEWB0rKMNcP1z1kPHeicI8MwHwYDVR0j
BBgwFoAUUKBRyEWB0rKMNcP1z1kPHeicI8MwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSQAwRgIhAIOwLRqK4OUmTLOugyuVxdnk
0kZGfb+4eTTgyctrrnv3AiEA1EY3BiiezqB3f2Cc/qWzW+BKADJdAq6S4Hs/wSk6
duI=
-----END CERTIFICATE-----
`;

const TEST_SOURCE_LEAF = `-----BEGIN CERTIFICATE-----
MIIBxDCCAWugAwIBAgIUIVYtJqjZ9sO2s/AhWBbQURQo+uQwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZQ29yZ3RleCBNaWdyYXRpb24gVGVzdCBDQTAeFw0yNjA5MDIy
MTMxMjVaFw0zNjA4MzAyMTMxMjVaMB4xHDAaBgNVBAMME3NvdXJjZS5leGFtcGxl
LnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQaPnSXnM5p32Kqf6wr1q0s
ix4592wRuB1xp/gMZAA7L11YlyQtJtbvn+UmXdDBgsItV0RsiDB+djv38Wuwx1Vf
o4GAMH4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwHgYDVR0RBBcwFYIT
c291cmNlLmV4YW1wbGUudGVzdDAdBgNVHQ4EFgQUN0/RiCeGuPpUvXgLvStQaQ7h
lB0wHwYDVR0jBBgwFoAUUKBRyEWB0rKMNcP1z1kPHeicI8MwCgYIKoZIzj0EAwID
RwAwRAIgQ35C/sj6LKFpq+Ft0UkSrJDQsAkBqEEgMoiPW7+IRv4CIDy6Gh89WxvB
xh2/uXu6vPtzLdW9VbcKqn7DPmGo9gWr
-----END CERTIFICATE-----
`;

const lengthFramedLargeObjectManifest = (objects) => {
  const manifest = createHash("sha256");
  for (const { oid, content } of objects) {
    const digest = createHash("sha256").update(content).digest("hex");
    for (const value of [oid, String(content.length), digest]) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      manifest.update(length);
      manifest.update(bytes);
    }
  }
  return manifest.digest("hex");
};

const largeObjectClient = (objects) => ({
  query: async (sql, values = []) => {
    if (sql.includes("FROM pg_largeobject_metadata")) {
      return {
        rows: objects.map(({ oid, readable = true }) => ({ oid, readable })),
      };
    }
    if (sql.includes("SELECT lo_get")) {
      const [oid, offset, length] = values;
      const object = objects.find((candidate) => candidate.oid === oid);
      if (!object) throw Object.assign(new Error("missing"), { code: "42704" });
      const start = Number(offset);
      return { rows: [{ chunk: object.content.subarray(start, start + length) }] };
    }
    throw new Error("UNEXPECTED_QUERY");
  },
});

describe("PostgreSQL restore rehearsal runner", () => {
  it("pins the immutable PostgreSQL 18.6 client", () => {
    expect(POSTGRES_CLIENT_IMAGE).toBe(
      "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
    );
  });

  it("parses a TLS-required source URL without retaining a raw URL field", () => {
    const config = parseSourceDatabaseUrl("postgresql://reader:p%40ss@db.example.test:5432/core?sslmode=require");
    expect(config).toEqual({
      host: "db.example.test",
      dockerHost: "db.example.test",
      port: 5432,
      user: "reader",
      password: "p@ss",
      database: "core",
      sslmode: "require",
    });
    expect(config).not.toHaveProperty("url");
  });

  it.each([
    "postgresql://reader:secret@db.example.test/core",
    "postgresql://reader:secret@db.example.test/core?sslmode=disable",
    "postgresql://reader:secret@db.example.test/core?sslmode=verify-ca",
    "postgresql://reader:secret@db.example.test/core?sslmode=verify-full",
    "mysql://reader:secret@db.example.test/core?sslmode=require",
  ])("rejects a source URL outside the exact Railway TLS input contract", (value) => {
    expect(() => parseSourceDatabaseUrl(value)).toThrow();
  });

  it("accepts exactly one current CA certificate as the source trust anchor", () => {
    expect(validateSourceTlsRootCertificate(TEST_SOURCE_CA, new Date("2030-01-01T00:00:00Z"))).toBe(TEST_SOURCE_CA);
  });

  it.each([
    ["missing", ""],
    ["malformed", "not a certificate"],
    ["multiple", `${TEST_SOURCE_CA}${TEST_SOURCE_CA}`],
    ["control character", `${TEST_SOURCE_CA}\u0000`],
  ])("rejects a %s source trust anchor", (_label, value) => {
    expect(() => validateSourceTlsRootCertificate(value, new Date("2030-01-01T00:00:00Z")))
      .toThrow("INVALID_SOURCE_TLS_ROOT_CERT");
  });

  it("rejects a non-CA source certificate", () => {
    expect(() => validateSourceTlsRootCertificate(TEST_SOURCE_LEAF, new Date("2030-01-01T00:00:00Z")))
      .toThrow("SOURCE_TLS_ROOT_CERT_NOT_CA");
  });

  it("rejects a source CA outside its validity window", () => {
    expect(() => validateSourceTlsRootCertificate(TEST_SOURCE_CA, new Date("2020-01-01T00:00:00Z")))
      .toThrow("SOURCE_TLS_ROOT_CERT_NOT_YET_VALID");
    expect(() => validateSourceTlsRootCertificate(TEST_SOURCE_CA, new Date("2040-01-01T00:00:00Z")))
      .toThrow("SOURCE_TLS_ROOT_CERT_EXPIRED");
  });

  it("uses exact-CA verification for Node source connections", () => {
    const config = nodeClientConfig({
      host: "source.example.test",
      port: 5432,
      user: "reader",
      password: "secret",
      database: "core",
      sslmode: "require",
      sourceTlsRootCert: TEST_SOURCE_CA,
    }, "source-test");
    expect(config.ssl).toMatchObject({ ca: TEST_SOURCE_CA, rejectUnauthorized: true });
    expect(config.ssl.checkServerIdentity("proxy.example.test", {})).toBeUndefined();
  });

  it("keeps system-root hostname verification for Node target connections", () => {
    const config = nodeClientConfig({
      host: "target.example.test",
      port: 5432,
      user: "admin",
      password: "secret",
      database: "scratch",
      sslmode: "verify-full",
    }, "target-test");
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("fails closed when a source Node connection lacks its exact trust anchor", () => {
    expect(() => nodeClientConfig({
      host: "source.example.test",
      port: 5432,
      user: "reader",
      password: "secret",
      database: "core",
      sslmode: "require",
    }, "source-test")).toThrow("MISSING_SOURCE_TLS_ROOT_CERT");
  });

  it("serializes libpq service values without literal quotes", () => {
    expect(serializePgServiceValue("disable")).toBe("disable");
    expect(serializePgServiceValue("source-db.internal")).toBe("source-db.internal");
    expect(serializePgServiceValue(5432)).toBe("5432");
    expect(`sslmode=${serializePgServiceValue("disable")}`).toBe("sslmode=disable");
    expect(`host=${serializePgServiceValue("source-db.internal")}`).not.toContain("'");
  });

  it("uses the exact source CA with verify-ca and system roots with verify-full for Azure", () => {
    const service = buildPgServiceContents(
      { dockerHost: "source.example.test", port: 5432, user: "reader", database: "core", sslmode: "require" },
      { dockerHost: "target.example.test", port: 5432, user: "admin", database: "scratch", sslmode: "verify-full" },
    );
    expect(service).toContain("sslmode=verify-ca\nsslrootcert=/work/source-root.crt");
    expect(service.match(/sslmode=verify-full\nsslrootcert=system/gu)).toHaveLength(1);
  });

  it("never downgrades a stronger source URL claim to CA-only verification", () => {
    expect(() => buildPgServiceContents(
      { dockerHost: "source.example.test", port: 5432, user: "reader", database: "core", sslmode: "verify-full" },
      { dockerHost: "target.example.test", port: 5432, user: "admin", database: "scratch", sslmode: "verify-full" },
    )).toThrow("INVALID_SOURCE_TLS_MODE");
  });

  it("omits system trust roots only for the synthetic non-TLS services", () => {
    const service = buildPgServiceContents(
      { dockerHost: "source", port: 5432, user: "reader", database: "core", sslmode: "disable" },
      { dockerHost: "target", port: 5432, user: "admin", database: "scratch", sslmode: "disable" },
    );
    expect(service.match(/sslmode=disable/gu)).toHaveLength(2);
    expect(service).not.toContain("sslrootcert");
  });

  it("waits for Azure firewall propagation before continuing", async () => {
    let clock = 0;
    let attempts = 0;
    let queries = 0;
    const result = await waitForTargetConnection({
      targetAdminConfig: {
        host: "target.example.test",
        port: 5432,
        user: "admin",
        password: "secret",
        database: "postgres",
        sslmode: "verify-full",
      },
      timeoutMs: 5_000,
      retryDelayMs: 1_000,
      now: () => clock,
      sleepFn: async (milliseconds) => { clock += milliseconds; },
      clientFactory: () => ({
        connect: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("not ready");
        },
        query: async (sql) => {
          expect(sql).toBe("SELECT 1");
          queries += 1;
        },
        end: async () => {},
      }),
    });
    expect(result).toEqual({ attempts: 3 });
    expect(queries).toBe(1);
  });

  it("fails closed at the bounded firewall propagation deadline", async () => {
    let clock = 0;
    const connectionTimeouts = [];
    const queryTimeouts = [];
    const promise = waitForTargetConnection({
      targetAdminConfig: {
        host: "target.example.test",
        port: 5432,
        user: "admin",
        password: "secret",
        database: "postgres",
        sslmode: "verify-full",
      },
      timeoutMs: 2_500,
      retryDelayMs: 1_000,
      now: () => clock,
      sleepFn: async (milliseconds) => { clock += milliseconds; },
      clientFactory: (config) => {
        connectionTimeouts.push(config.connectionTimeoutMillis);
        queryTimeouts.push(config.query_timeout);
        return {
          connect: async () => { throw new Error("not ready"); },
          query: async () => {},
          end: async () => {},
        };
      },
    });
    await expect(promise).rejects.toThrow("TARGET_FIREWALL_PROPAGATION_TIMEOUT");
    expect(clock).toBe(2_500);
    expect(connectionTimeouts).toEqual([2_500, 1_500, 500]);
    expect(queryTimeouts).toEqual([2_500, 1_500, 500]);
  });

  it("selects only exact sequence-set entries from a PostgreSQL archive TOC", () => {
    const selection = buildSequenceUseList([
      "; Archive created at 2026-09-02 18:00:00 UTC",
      "12; 1259 100 TABLE public Event postgres",
      "13; 0 101 SEQUENCE SET public Event_id_seq postgres",
      "14; 0 102 SEQUENCE SET internal audit_id_seq postgres",
      "15; 0 100 TABLE DATA public Event postgres",
      "",
    ].join("\n"));
    expect(selection).toEqual({
      tocEntryCount: 2,
      contents: [
        "13; 0 101 SEQUENCE SET public Event_id_seq postgres",
        "14; 0 102 SEQUENCE SET internal audit_id_seq postgres",
        "",
      ].join("\n"),
    });
    expect(selection.contents).not.toContain("TABLE DATA");
  });

  it("supports an archive with zero user sequences", () => {
    expect(buildSequenceUseList("12; 1259 100 TABLE public Event postgres\n")).toEqual({
      tocEntryCount: 0,
      contents: "",
    });
  });

  it("proves the empty large-object set without reading the protected page catalog", async () => {
    const client = largeObjectClient([]);
    const identities = await inspectLargeObjectAccess(client, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");
    const evidence = await collectLargeObjects(
      client,
      identities,
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    );

    expect(evidence).toEqual({
      count: 0,
      contentSha256: createHash("sha256").digest("hex"),
    });
  });

  it("hashes authorized large objects in bounded chunks with deterministic framing", async () => {
    const objects = [
      { oid: "101", content: Buffer.alloc((1024 * 1024) + 17, 0x61) },
      { oid: "202", content: Buffer.from("second-object", "utf8") },
    ];
    const client = largeObjectClient(objects);
    const identities = await inspectLargeObjectAccess(client, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");

    await expect(collectLargeObjects(
      client,
      identities,
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).resolves.toEqual({
      count: 2,
      contentSha256: lengthFramedLargeObjectManifest(objects),
    });
  });

  it("binds large-object content and OID into the manifest digest", async () => {
    const evidenceFor = async (oid, content) => collectLargeObjects(
      largeObjectClient([{ oid, content }]),
      [{ oid, readable: true }],
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    );
    const baseline = await evidenceFor("101", Buffer.from("content", "utf8"));
    const changedContent = await evidenceFor("101", Buffer.from("changed", "utf8"));
    const changedOid = await evidenceFor("102", Buffer.from("content", "utf8"));

    expect(changedContent.contentSha256).not.toBe(baseline.contentSha256);
    expect(changedOid.contentSha256).not.toBe(baseline.contentSha256);
  });

  it("fails closed on unreadable or non-deterministically ordered large objects", async () => {
    const client = largeObjectClient([
      { oid: "202", content: Buffer.alloc(0) },
      { oid: "101", content: Buffer.alloc(0) },
    ]);
    await expect(collectLargeObjects(
      client,
      [{ oid: "101", readable: false }],
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).rejects.toThrow("SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING");
    await expect(collectLargeObjects(
      client,
      [{ oid: "202", readable: true }, { oid: "101", readable: true }],
      "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED",
      "SOURCE_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).rejects.toThrow("INVALID_LARGE_OBJECT_ORDER");
  });

  it("maps raw PostgreSQL privilege errors to bounded large-object stage codes", async () => {
    const denied = {
      query: async () => { throw Object.assign(new Error("private database error"), { code: "42501" }); },
    };
    await expect(inspectLargeObjectAccess(denied, "SOURCE_LARGE_OBJECT_EVIDENCE_FAILED"))
      .rejects.toThrow("SOURCE_LARGE_OBJECT_EVIDENCE_FAILED");
    await expect(collectLargeObjects(
      denied,
      [{ oid: "101", readable: true }],
      "DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED",
      "DESTINATION_LARGE_OBJECT_READ_PRIVILEGE_MISSING",
    )).rejects.toThrow("DESTINATION_LARGE_OBJECT_EVIDENCE_FAILED");
  });

  it.each([
    ["pre-data privilege", "pre-data", "ERROR:  42501\n", "0:3", "INSUFFICIENT_PRIVILEGE", "42501"],
    ["data constraint", "data", "ERROR:  23505\n", "0:3", "DATA_CONSTRAINT", "23505"],
    ["post-data duplicate", "post-data", "ERROR:  42P07\n", "0:3", "DUPLICATE_OBJECT", "42P07"],
  ])("reduces %s to server-authored SQLSTATE evidence", (_label, section, stderr, statuses, category, sqlstate) => {
    const diagnostic = buildRestoreDiagnostic({
      section,
      stderrChunks: [Buffer.from(stderr, "utf8")],
      statusChunks: [Buffer.from(`CORGTEX_RESTORE_STATUS:${statuses}\n`, "utf8")],
    });
    expect(diagnostic).toEqual({
      phase: "DESTINATION_RESTORE",
      section: section.replace("-", "_").toUpperCase(),
      processClass: "SCRIPT_ERROR",
      category,
      sqlstate,
      stderrObserved: true,
      stderrTruncated: false,
    });
    expect(Object.keys(diagnostic)).toEqual([
      "phase",
      "section",
      "processClass",
      "category",
      "sqlstate",
      "stderrObserved",
      "stderrTruncated",
    ]);
  });

  it("classifies arbitrary chunk boundaries and a missing final newline", () => {
    const stderrChunks = Array.from(Buffer.from("ERROR:  42501", "utf8"), (byte) => Buffer.from([byte]));
    const statusChunks = Array.from(Buffer.from("CORGTEX_RESTORE_STATUS:141:3", "utf8"), (byte) => Buffer.from([byte]));
    expect(buildRestoreDiagnostic({ section: "pre-data", stderrChunks, statusChunks })).toMatchObject({
      section: "PRE_DATA",
      processClass: "SCRIPT_ERROR",
      category: "INSUFFICIENT_PRIVILEGE",
      sqlstate: "42501",
    });
  });

  it.each([
    ["archive renderer", "1:0", "ARCHIVE_RENDER_FAILED"],
    ["archive renderer with secondary script error", "1:3", "ARCHIVE_RENDER_FAILED"],
    ["connection", "0:2", "CONNECTION_ERROR"],
    ["psql client", "0:1", "PROCESS_ERROR"],
    ["unexpected consumer", "0:9", "PROCESS_ERROR"],
  ])("classifies a %s exit without retaining process output", (_label, statuses, processClass) => {
    const diagnostic = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from("private host password secret\n", "utf8")],
      statusChunks: [Buffer.from(`CORGTEX_RESTORE_STATUS:${statuses}\n`, "utf8")],
    });
    expect(diagnostic).toMatchObject({ processClass, category: "UNKNOWN", sqlstate: null, stderrObserved: true });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|host|password|secret/u);
  });

  it("fails closed when the controlled status marker or process result is unavailable", () => {
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [],
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
      spawnError: true,
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
      signal: "SIGKILL",
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    expect(buildRestoreDiagnostic({
      section: "post-data",
      stderrChunks: [],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:0\n", "utf8")],
      status: 125,
    })).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
  });

  it("rejects message-shaped and malformed SQLSTATE claims", () => {
    const diagnostic = buildRestoreDiagnostic({
      section: "pre-data",
      stderrChunks: [Buffer.from("SQLSTATE: 42501\nERROR: private 42501\n", "utf8")],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(diagnostic).toMatchObject({ processClass: "SCRIPT_ERROR", category: "UNKNOWN", sqlstate: null });
  });

  it("fails closed on truncated or malformed diagnostic streams", () => {
    const diagnostic = buildRestoreDiagnostic({
      section: "pre-data",
      stderrChunks: [Buffer.alloc(5 * 1024, 0x61), Buffer.from("\nERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(diagnostic).toMatchObject({
      processClass: "SCRIPT_ERROR",
      category: "UNKNOWN",
      sqlstate: null,
      stderrTruncated: true,
    });
    const malformedStderr = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("\nERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(malformedStderr).toMatchObject({
      processClass: "SCRIPT_ERROR",
      category: "UNKNOWN",
      sqlstate: null,
      stderrTruncated: true,
    });
    const malformedStatus = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from("ERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.from([0xff]), Buffer.from("CORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(malformedStatus).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
    const oversizedStatus = buildRestoreDiagnostic({
      section: "data",
      stderrChunks: [Buffer.from("ERROR:  42501\n", "utf8")],
      statusChunks: [Buffer.alloc(256, 0x61), Buffer.from("\nCORGTEX_RESTORE_STATUS:0:3\n", "utf8")],
    });
    expect(oversizedStatus).toMatchObject({ processClass: "PROCESS_ERROR", sqlstate: null });
  });

  it("rejects duplicate selected archive entries", () => {
    expect(() => buildSequenceUseList([
      "13; 0 101 SEQUENCE SET public first_seq postgres",
      "13; 0 102 SEQUENCE SET public second_seq postgres",
    ].join("\n"))).toThrow("DUPLICATE_ARCHIVE_SEQUENCE_ENTRY");
  });

  it.each([
    [
      "libc",
      { provider: "libc", providerLocale: null, icuRules: null },
      "LOCALE_PROVIDER 'libc' LC_COLLATE 'C' LC_CTYPE 'C'",
    ],
    [
      "icu",
      { provider: "icu", providerLocale: "en-US", icuRules: "&a < b" },
      "LOCALE_PROVIDER 'icu' LC_COLLATE 'C' LC_CTYPE 'C' ICU_LOCALE 'en-US' ICU_RULES '&a < b'",
    ],
    [
      "builtin",
      { provider: "builtin", providerLocale: "C.UTF-8", icuRules: null },
      "LOCALE_PROVIDER 'builtin' LC_COLLATE 'C' LC_CTYPE 'C' BUILTIN_LOCALE 'C.UTF-8'",
    ],
  ])("builds an exact PostgreSQL 18 %s locale clause", (_label, locale, clause) => {
    const sql = buildCreateDatabaseSql("corgtex_rehearsal_123_core", {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      collationVersion: "1",
      ...locale,
    });
    expect(sql).toContain("TEMPLATE template0 ENCODING 'UTF8'");
    expect(sql).toContain(clause);
    expect(sql).not.toContain("COLLATION_VERSION");
  });

  it("omits ICU rules when the source catalog has none", () => {
    const sql = buildCreateDatabaseSql("corgtex_rehearsal_123_core", {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      provider: "icu",
      providerLocale: "en-US",
      icuRules: null,
      collationVersion: "153.128",
    });
    expect(sql).toContain("ICU_LOCALE 'en-US'");
    expect(sql).not.toContain("ICU_RULES");
  });

  it("treats provider-version drift separately from the exact locale definition", () => {
    const source = {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      provider: "icu",
      providerLocale: "en-US",
      icuRules: null,
      collationVersion: "153.128",
      actualCollationVersion: "153.128",
    };
    const target = { ...source, collationVersion: "154.1", actualCollationVersion: "154.1" };

    expect(localeDefinitionMismatchFields(source, target)).toEqual([]);
    expect(isCurrentCollationVersion(source)).toBe(true);
    expect(isCurrentCollationVersion(target)).toBe(true);
    expect(classifyCollationVersionRelation(source, target)).toBe("DIFFERENT");
    expect(buildLocaleDiagnostic(source, target)).toEqual({
      schemaVersion: "1.0.0",
      definitionMismatchFields: [],
      sourceVersionCurrent: true,
      targetVersionCurrent: true,
      crossRuntimeVersionRelation: "DIFFERENT",
    });
  });

  it("reports only allowlisted field names and fixed statuses in locale diagnostics", () => {
    const source = {
      encoding: "UTF8",
      collation: "private-source-locale",
      ctype: "C",
      provider: "libc",
      providerLocale: null,
      icuRules: null,
      collationVersion: null,
      actualCollationVersion: null,
    };
    const target = { ...source, collation: "private-target-locale" };
    const diagnostic = buildLocaleDiagnostic(source, target);

    expect(diagnostic).toEqual({
      schemaVersion: "1.0.0",
      definitionMismatchFields: ["collation"],
      sourceVersionCurrent: true,
      targetVersionCurrent: true,
      crossRuntimeVersionRelation: "UNVERSIONED",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-source-locale");
    expect(JSON.stringify(diagnostic)).not.toContain("private-target-locale");
  });

  it("detects stale recorded collation versions with null-safe equality", () => {
    expect(isCurrentCollationVersion({ collationVersion: null, actualCollationVersion: null })).toBe(true);
    expect(isCurrentCollationVersion({ collationVersion: "1", actualCollationVersion: "2" })).toBe(false);
    expect(classifyCollationVersionRelation(
      { collationVersion: null },
      { collationVersion: "2" },
    )).toBe("UNVERSIONED");
  });

  it.each([
    { provider: "unknown", providerLocale: null, icuRules: null },
    { provider: "libc", providerLocale: "en-US", icuRules: null },
    { provider: "icu", providerLocale: null, icuRules: null },
    { provider: "builtin", providerLocale: "C.UTF-8", icuRules: "rule" },
  ])("rejects an invalid locale provider contract", (locale) => {
    expect(() => buildCreateDatabaseSql("corgtex_rehearsal_123_core", {
      encoding: "UTF8",
      collation: "C",
      ctype: "C",
      collationVersion: null,
      ...locale,
    })).toThrow();
  });

  it.each(["value with spaces", "value#comment", "value;other", "value='quoted'", "line\nbreak"])(
    "rejects unsafe service-file value %j",
    (value) => {
      expect(() => serializePgServiceValue(value)).toThrow("INVALID_SERVICE_VALUE");
    },
  );
});
